/**
 * Фактура -> JSON за УЈП е-Фактура (docs/15). Превод на ConvertTo-UjpPayload / Test-UjpPayload од агентот (UjpAgent.psm1).
 *
 * Извор: официјалните примери на УЈП (json_primeri_21.10.2026, primer_za_json_2) и api-documentation.
 * Не се додаваат полиња што ги нема во официјалните примери. Исклучок (одземање): docItemTotalOriginalPriceWoVat –
 * тест-серверот на УЈП го одбива (E4018, 12.11.2026), па се користи само за збирот.
 *
 * Серверот го гради документот; агентот на компјутерот со токенот ги освежува продавачот/купувачот од регистарот на УЈП,
 * додава requestTimestamp, потпишува (JWS RS256) и праќа. Затоа овде нема мрежа ни потпис.
 */
import { Decimal } from "decimal.js";
import { and, eq, inArray } from "drizzle-orm";
import { clients, invoiceLines, invoices, items, partners, ujpReasons, vatRates } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "./errors.js";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
/** HALF_UP (away from zero) – правило на УЈП; резултат како JSON број (300, не 300.00; 45.76, не 45.7600). */
const r = (v: Decimal.Value, dp = 2) => Number(new D(v).toDecimalPlaces(dp, D.ROUND_HALF_UP).toFixed(dp));
const rd = (v: Decimal.Value, dp: number) => new D(v).toDecimalPlaces(dp, D.ROUND_HALF_UP);

export type UjpDocKind = "INV" | "ST" | "KR" | "OD" | "KZ" | "AV";
interface DocTypeInfo { code: string; name: string; storno: 0 | 1 | 2; sign: 1 | -1; refType: string | null; refName: string | null }
/** Наш вид -> тип кај УЈП. Сторно = 100 со docStorno 1 (ST); корекција = 100 со docStorno 2 (KR);
 *  книжно одобрение (110): кај нас со минус, кон УЈП позитивно (пример 589 / 106,02 / 695,02). */
export const UJP_DOC_TYPES: Record<UjpDocKind, DocTypeInfo> = {
  INV: { code: "100", name: "Фактура", storno: 0, sign: 1, refType: null, refName: null },
  ST: { code: "100", name: "Фактура", storno: 1, sign: 1, refType: "ST", refName: "Сторно" },
  KR: { code: "100", name: "Фактура", storno: 2, sign: 1, refType: "KR", refName: "Корекција" },
  OD: { code: "110", name: "Книжно одобрение", storno: 0, sign: -1, refType: "SYS", refName: "Фактура" },
  KZ: { code: "120", name: "Книжно задолжение", storno: 0, sign: 1, refType: "SYS", refName: "Фактура" },
  AV: { code: "130", name: "Авансна фактура", storno: 0, sign: 1, refType: null, refName: null },
};

/** Наш начин на плаќање -> шифра на УЈП (GET /api/v1/payment-types). */
export const UJP_PAYMENT: Record<string, { code: string; name: string }> = {
  cash: { code: "P10", name: "Готовина" }, card: { code: "P11", name: "Платежна картичка" }, bank: { code: "P12", name: "Трансакциска сметка" },
  compensation: { code: "P17", name: "Компензација" }, other: { code: "P19", name: "Друго" },
};

export interface UjpParty { cCode: string; cName: string; tin: string; vatNumber: string | null; name: string; street: string; number: string; postalCode: string; city: string; email: string | null }
export interface UjpLineIn { title: string; itemCode: string | null; unit: string; qty: Decimal.Value; unitPrice: Decimal.Value; discountPct: Decimal.Value; vatPct: Decimal.Value;
  taxIndicator: string | null; vatGroup: string | null; vatImpact?: string | null }
export interface UjpInvoiceIn { kind: UjpDocKind; number: string; docId: string; issueDate: string; supplyDate: string | null; dueDate: string | null; currency: string;
  paymentMethod: string; clauses: string | null; correctionReason: string | null; voidReasonCode: string | null; correctionReasonCode: string | null;
  advanceAmount?: Decimal.Value | null; advanceDate?: string | null; advanceDesc?: string | null }
export interface UjpNames { void?: Record<string, string>; correction?: Record<string, string>; payment?: Record<string, string>; indicators?: Set<string> }

/** „ул. Тестна бр. 1, Скопје“ -> { street: „ул. Тестна“, number: „1“ } (само кога нема податоци од регистарот). */
export function splitAddress(address: string | null | undefined) {
  let a = String(address ?? "").trim();
  const city = /^(.*\d.*?),\s*[^\d,]+$/u.exec(a);
  if (city) a = city[1]!.trim();
  const m = /^(.*?)[\s,]+(?:бр\.?\s*)?(\d+[\p{L}\d/-]*|бб|б\.б\.?)$/iu.exec(a);   // „бб“ = без број
  return m ? { street: m[1]!.trim().replace(/,$/, ""), number: m[2]! } : { street: a, number: "" };
}

const party = (p: UjpParty, role: "seller" | "buyer") => ({
  [`${role}CCode`]: p.cCode, [`${role}CName`]: p.cName, [`${role}Tin`]: p.tin, [`${role}ForeignTin`]: null, [`${role}VatNumber`]: p.vatNumber || null,
  [`${role}Name`]: p.name, [`${role}Address`]: { streetAddress: p.street, streetNumber: p.number, postalCode: p.postalCode, city: p.city },
  [`${role}Contact`]: null, [`${role}Email`]: p.email || null,
});

/** Една ставка: единечните износи и тоталите по ставка до 4 децимали, без заокружување на 2. */
function item(l: UjpLineIn, lineNo: number, sign: 1 | -1) {
  const qty = new D(l.qty).times(sign), price = new D(l.unitPrice).abs(), disc = new D(l.discountPct || 0), vat = new D(l.vatPct);
  const unitDisc = rd(price.times(disc).div(100), 4), unitNet = price.minus(unitDisc), unitVat = rd(unitNet.times(vat).div(100), 4);
  const totOrig = rd(qty.times(price), 4), totNet = rd(qty.times(unitNet), 4), totVat = rd(qty.times(unitVat), 4);
  return {
    json: {
      docItemLineNo: lineNo, docItemSku: null, docItemSenderCode: l.itemCode || null, docItemReceiverCode: null, docItemDesc: l.title, docItemMUnit: l.unit,
      docItemQty: r(qty, 4), docItemUnitOriginalPriceWoVat: r(price, 4), docItemUnitDiscountAmount: r(unitDisc, 4), docItemUnitPriceWoVat: r(unitNet, 4),
      docItemUnitItemDiscountAmount: 0, docItemUnitVat: r(unitVat, 4), docItemVat: r(vat, 2), docItemVatGroup: l.vatGroup ?? "",
      // docItemTotalOriginalPriceWoVat: НЕ се праќа (E4018 од тест-серверот, 12.11.2026)
      docItemTotalPriceWoVat: r(totNet, 4), docItemTotalVat: r(totVat, 4), docItemTotalPriceWVat: r(totNet.plus(totVat), 4),
      docItemTaxIndicator: l.taxIndicator ?? "", docItemDomesticProduct: null,
    },
    totOrig, totNet, totVat,
  };
}

export type UjpPayload = { document: Record<string, any>; voidReason?: Record<string, unknown>; correctionReason?: Record<string, unknown> };

export function toUjpPayload(inv: UjpInvoiceIn, lines: UjpLineIn[], seller: UjpParty, buyer: UjpParty, ref: { euid: string; date: string } | null, names: UjpNames = {}): UjpPayload {
  const t = UJP_DOC_TYPES[inv.kind];
  if (!t) throw new DomainError("validation", `Видот „${inv.kind}“ не се праќа на УЈП.`, 422);
  for (const l of lines) if (l.vatImpact === "PRENESEN")
    throw new DomainError("validation", `Ставка „${l.title}“: пренесена даночна обврска засега не се праќа на УЈП.`, 422);
  const its = lines.map((l, i) => item(l, i + 1, t.sign));
  let sOrig = new D(0), sNet = new D(0), sVat = new D(0);
  const groups = new Map<string, { ind: string; grp: string; pct: number; net: Decimal; vat: Decimal }>();
  for (const i of its) {
    sOrig = sOrig.plus(i.totOrig); sNet = sNet.plus(i.totNet); sVat = sVat.plus(i.totVat);
    const k = `${i.json.docItemTaxIndicator}|${i.json.docItemVatGroup}|${i.json.docItemVat}`;
    const g = groups.get(k) ?? { ind: i.json.docItemTaxIndicator, grp: i.json.docItemVatGroup, pct: i.json.docItemVat, net: new D(0), vat: new D(0) };
    g.net = g.net.plus(i.totNet); g.vat = g.vat.plus(i.totVat); groups.set(k, g);
  }
  const net = rd(sOrig, 2), netDisc = rd(sNet, 2), vatAmt = rd(sVat, 2), gross = rd(netDisc.plus(vatAmt), 2), grossR = rd(gross, 0);
  const discount = rd(net.minus(netDisc), 2);
  const avans = inv.advanceAmount ? rd(inv.advanceAmount, 2) : new D(0);
  if (t.refType && !ref?.euid) throw new DomainError("validation", "Недостасува EUID на оригиналната фактура (прво таа мора да е испратена на УЈП).", 422);
  const payCode = t.storno === 1 ? null : (UJP_PAYMENT[inv.paymentMethod] ?? UJP_PAYMENT.bank!).code;
  const payName = payCode ? (names.payment?.[payCode] ?? Object.values(UJP_PAYMENT).find((p) => p.code === payCode)!.name) : null;

  const document = {
    header: {
      docStorno: t.storno, docType: t.code, docAlt: false, docTypeName: t.name, docDate: inv.issueDate, docDeliveryDate: null, docDelivery: null,
      docTurnoverDate: t.code === "130" ? null : inv.supplyDate, docPeriodStartDate: null, docPeriodEndDate: null,
      docNumber: inv.number, docId: inv.docId, docNotes: null, docIndicator: null, docHeader: null, docFooter: inv.clauses || null,
    },
    docReferences: t.refType ? [{ docNumberRef: ref!.euid, docTypeRef: t.refType, docDateRef: ref!.date, docNameRef: t.refName }] : [],
    docAttributes: [],
    seller: party(seller, "seller"),
    buyer: party(buyer, "buyer"),
    docPayment: {
      docPaymentTypeCode: payCode, docPaymentTypeDesc: payName, docPaymentTypeDueDays: null,
      docPaymentTypeDueDate: payCode && inv.dueDate ? inv.dueDate : null, docPaymentTerms: null, docPaymentNote: null,
      docPaymentInterest: null, docPaymentDiscount: null, docCurrency: inv.currency,
    },
    docItems: its.map((i) => i.json),
    docTotals: {
      docNetAmount: r(net), docDiscountAmount: r(discount), docNetAmountDisc: r(netDisc), docVatAmount: r(vatAmt), docGrossAmount: r(gross), docGrossAmountR: r(grossR, 0),
      docAvansDate: avans.gt(0) ? inv.advanceDate ?? null : null, docAvansDesc: avans.gt(0) ? inv.advanceDesc ?? null : null, docAvansAmount: r(avans),
      docAmountIncrease: 0, docAmountDecrease: 0, docFinalAmount: r(grossR.minus(avans)),
      docGlobalDiscountAmount: r(discount),   // како во примерот „со попуст“ на УЈП
    },
    vatTotals: [...groups.values()].map((g) => {
      const gn = rd(g.net, 2), gv = rd(g.vat, 2);
      return { vatTaxIndicator: g.ind, vatTaxIndicatorNote: null, vatCode: g.grp, vatPercent: g.pct, vatTaxableAmount: r(gn), vatAmount: r(gv), vatTotalAmount: r(gn.plus(gv)) };
    }),
  };
  const out: UjpPayload = { document };
  if (t.storno === 1) {
    const c = inv.voidReasonCode ?? "";
    out.voidReason = { voidCode: c, voidReason: names.void?.[c] ?? null, voidComment: inv.correctionReason || null };
  }
  if (t.storno === 2) {
    const c = inv.correctionReasonCode ?? "";
    out.correctionReason = { correctionReasonCode: c, correctionReason: names.correction?.[c] ?? null, correctionReasonComment: inv.correctionReason || null };
  }
  return out;
}

/** Проверки пред праќање; празно = во ред. stored = износите зачувани кај нас (со нашиот знак). */
export function checkUjpPayload(p: UjpPayload, stored?: { net?: Decimal.Value; vat?: Decimal.Value; gross?: Decimal.Value; payable?: Decimal.Value | null }, tolerance = 0.05, names: UjpNames = {},
  addressOut?: string[]): string[] {
  const out: string[] = [];
  const d = p.document, h = d.header, tt = d.docTotals;
  if (!h.docNumber) out.push("Нема број на документ.");
  if (!h.docId) out.push("Нема docId.");
  if (!h.docDate) out.push("Нема датум на издавање.");
  if (h.docType === "100" && !h.docTurnoverDate) out.push("Нема датум на промет.");
  if (tt.docAvansAmount > 0) {
    if (h.docType !== "100" || h.docStorno === 1) out.push("Аванс може да се одбие само на фактура или корекција.");
    if (tt.docAvansAmount > tt.docGrossAmountR) out.push("Авансот е поголем од износот на фактурата.");
    if (!tt.docAvansDesc || !tt.docAvansDate) out.push("Аванс: недостасува број/датум на авансната фактура.");
  }
  if (d.docPayment.docCurrency !== "MKD") out.push("Засега се праќаат само фактури во MKD.");
  for (const role of ["seller", "buyer"] as const) {
    const x = d[role], who = role === "seller" ? "Продавач" : "Купувач";
    if (!x[`${role}CCode`] || !x[`${role}Tin`] || !x[`${role}Name`]) out.push(`${who}: недостасува држава, ЕДБ или назив.`);
    if (x[`${role}CCode`] && x[`${role}CCode`] !== "MK") out.push(`${who}: засега се поддржани само субјекти од Македонија.`);
    const a = x[`${role}Address`], lbl: Record<string, string> = { streetAddress: "улица", streetNumber: "број", postalCode: "поштенски број", city: "град" };
    for (const f of Object.keys(lbl)) if (!a[f]) (addressOut ?? out).push(`${who}: адресата нема ${lbl[f]} (се пополнува од регистарот на УЈП или во податоците на ${role === "seller" ? "фирмата" : "купувачот"}).`);
  }
  if (!d.docItems.length) out.push("Нема ставки.");
  for (const i of d.docItems) {
    if (!i.docItemTaxIndicator) out.push(`Ставка ${i.docItemLineNo}: ДДВ стапката нема даночен индикатор (УЈП).`);
    if (!i.docItemVatGroup) out.push(`Ставка ${i.docItemLineNo}: ДДВ стапката нема даночна група.`);
    if (!i.docItemMUnit) out.push(`Ставка ${i.docItemLineNo}: нема единица мерка.`);
    if (names.indicators && i.docItemTaxIndicator && !names.indicators.has(i.docItemTaxIndicator))
      out.push(`Ставка ${i.docItemLineNo}: индикаторот „${i.docItemTaxIndicator}“ не е дозволен за тип ${h.docType} (шифрарник на УЈП).`);
  }
  if (h.docStorno === 1) {
    const v = p.voidReason as { voidCode?: string } | undefined;
    if (!v?.voidCode) out.push("Сторно: нема шифра на причина за сторно (УЈП).");
    else if (names.void && Object.keys(names.void).length && !(v.voidCode in names.void)) out.push(`Сторно: шифрата „${v.voidCode}“ не е во шифрарникот на УЈП.`);
    if (d.docReferences[0]?.docTypeRef !== "ST") out.push("Сторно: нема референца ST кон оригиналот.");
    if (tt.docGrossAmount >= 0) out.push("Сторно: износот мора да е негативен.");
  } else if (h.docStorno === 2) {
    const c = p.correctionReason as { correctionReasonCode?: string } | undefined;
    if (!c?.correctionReasonCode) out.push("Корекција: нема шифра на причина (C…).");
    else if (names.correction && Object.keys(names.correction).length && !(c.correctionReasonCode in names.correction)) out.push(`Корекција: шифрата „${c.correctionReasonCode}“ не е во шифрарникот на УЈП.`);
    if (d.docReferences[0]?.docTypeRef !== "KR") out.push("Корекција: нема референца KR кон оригиналот.");
    if (tt.docGrossAmount <= 0) out.push("Корекција: износот мора да е позитивен (ги содржи ставките што остануваат).");
  } else if (tt.docGrossAmount <= 0) out.push(`Износот мора да е позитивен за тип ${h.docType}.`);
  if (["110", "120"].includes(h.docType) && !d.docReferences.length) out.push(`Тип ${h.docType}: референцата кон фактурата е задолжителна.`);
  if (stored) {
    const sign = h.docType === "110" ? -1 : 1;
    const chk: [string, Decimal.Value | null | undefined, number][] = [["Основица", stored.net, tt.docNetAmountDisc], ["ДДВ", stored.vat, tt.docVatAmount],
      ["Вкупно", stored.gross, tt.docGrossAmount], ["За плаќање", stored.payable, tt.docFinalAmount]];
    for (const [k, ours, ujp] of chk) {
      if (ours === null || ours === undefined) continue;
      const diff = new D(ours).times(sign).minus(ujp).abs();
      if (diff.gt(tolerance)) out.push(`${k} кај нас (${new D(ours).toFixed(2)}) се разликува од пресметката по правилата на УЈП (${ujp}) за ${diff.toFixed(2)}.`);
    }
  }
  return out;
}

const day = (v: string | Date | null) => (v === null ? null : typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10));

/**
 * JSON за УЈП од фактура во базата. problems = што мора да се поправи; waitFor = оригинал/аванс што прво треба да оди на УЈП.
 */
export async function buildInvoiceUjp(db: Db, invoiceId: number): Promise<{ payload: UjpPayload | null; problems: string[]; warnings: string[]; waitFor: string | null; sellerEdb: string; docTypeCode: string | null }> {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) throw new DomainError("not_found", "Фактурата не постои.", 404);
  const kind = inv.docType as UjpDocKind;
  const problems: string[] = [];
  const sellerEdb = inv.sellerEdb ?? "";
  if (!(kind in UJP_DOC_TYPES)) return { payload: null, problems: ["Понудата/профактурата не е даночен документ и не се праќа на УЈП."], warnings: [], waitFor: null, sellerEdb, docTypeCode: null };
  if (inv.source !== "app") problems.push("Пренесена фактура (ERPNext) – не се праќа на УЈП.");
  // и сторнирана/корегирана: оригиналот мора да оди на УЈП пред сторното/корекцијата
  if (inv.ujpId) problems.push(`Веќе е испратена на УЈП (EUID ${inv.ujpId}).`);
  else if (!["issued", "json_exported", "rejected", "voided", "corrected"].includes(inv.status)) problems.push(`Статус „${inv.status}“ – се праќаат само издадени документи.`);
  if (!inv.buyerEdb) problems.push("Купувачот нема ЕДБ.");

  const [client] = await db.select().from(clients).where(eq(clients.id, inv.clientId));
  const [partner] = await db.select().from(partners).where(eq(partners.id, inv.partnerId));
  const rows = await db.select({ l: invoiceLines, v: vatRates, code: items.code }).from(invoiceLines)
    .innerJoin(vatRates, eq(vatRates.id, invoiceLines.vatRateId)).leftJoin(items, eq(items.id, invoiceLines.itemId))
    .where(eq(invoiceLines.invoiceId, inv.id)).orderBy(invoiceLines.lineNo);
  const lines: UjpLineIn[] = rows.map(({ l, v, code }) => ({ title: l.description, itemCode: code, unit: l.unit, qty: l.qty, unitPrice: l.unitPrice,
    discountPct: l.discountPct, vatPct: l.vatRatePct, taxIndicator: v.ujpCode, vatGroup: v.vatGroup, vatImpact: v.vatImpact }));
  // Фирма што НЕ е ДДВ обврзник: целиот промет е DDV-G (член 51 став 3 ЗДДВ), без ДДВ
  if (!client!.vatPayer) for (const l of lines) {
    if (!new D(l.vatPct).isZero()) problems.push(`Фирмата не е ДДВ обврзник, а ставката „${l.title}“ има ДДВ ${l.vatPct} %.`);
    l.taxIndicator = "DDV-G"; l.vatGroup = "DDV-G"; l.vatImpact = "NULA";
  }

  let ref: { euid: string; date: string } | null = null, waitFor: string | null = null;
  if (UJP_DOC_TYPES[kind].refType) {
    const [rel] = inv.relatedInvoiceId ? await db.select().from(invoices).where(eq(invoices.id, inv.relatedInvoiceId)) : [];
    if (!rel) problems.push("Нема поврзана (оригинална) фактура.");
    else if (!rel.ujpId) waitFor = `Оригиналот ${rel.number} уште не е на УЈП – прво него.`;
    else ref = { euid: rel.ujpId, date: day(rel.issueDate)! };
  }
  let adv: { amount: string; date: string; desc: string } | null = null;
  if (inv.advanceInvoiceId && inv.advanceAmount && Number(inv.advanceAmount) > 0) {
    const [a] = await db.select().from(invoices).where(eq(invoices.id, inv.advanceInvoiceId));
    if (!a) problems.push("Авансната фактура не постои.");
    else { if (!a.ujpId) waitFor ??= `Авансната фактура ${a.number} уште не е на УЈП – прво неа.`; adv = { amount: inv.advanceAmount, date: day(a.issueDate)!, desc: a.number ?? "" }; }
  }
  const reasons = await db.select().from(ujpReasons).where(and(eq(ujpReasons.isActive, true), inArray(ujpReasons.kind, ["void", "correction"])));
  const names: UjpNames = { void: Object.fromEntries(reasons.filter((x) => x.kind === "void").map((x) => [x.code, x.name])),
    correction: Object.fromEntries(reasons.filter((x) => x.kind === "correction").map((x) => [x.code, x.name])) };

  const sa = splitAddress(inv.sellerAddress), ba = splitAddress(inv.buyerAddress);
  const seller: UjpParty = { cCode: "MK", cName: "Северна Македонија", tin: sellerEdb, vatNumber: inv.sellerVatNumber, name: inv.sellerName ?? "",
    street: sa.street, number: sa.number, postalCode: client!.postalCode ?? "", city: inv.sellerCity ?? "", email: client!.email };
  const buyer: UjpParty = { cCode: inv.buyerCountry ?? "MK", cName: "Северна Македонија", tin: inv.buyerEdb ?? "", vatNumber: inv.buyerVatNumber, name: inv.buyerName ?? "",
    street: ba.street, number: ba.number, postalCode: partner?.postalCode ?? "", city: inv.buyerCity ?? "", email: partner?.email ?? null };
  const fake = { euid: "EUID-NA-ORIGINALOT", date: day(inv.issueDate)! };   // само за преглед додека оригиналот чека
  const payload = toUjpPayload({
    kind, number: inv.number ?? "", docId: String(inv.id), issueDate: day(inv.issueDate)!, supplyDate: day(inv.supplyDate), dueDate: day(inv.dueDate),
    currency: inv.currency, paymentMethod: inv.paymentMethod, clauses: inv.clauses, correctionReason: inv.correctionReason,
    voidReasonCode: inv.voidReasonCode, correctionReasonCode: inv.correctionReasonCode,
    advanceAmount: adv?.amount ?? null, advanceDate: adv?.date ?? null, advanceDesc: adv?.desc ?? null,
  }, lines, seller, buyer, ref ?? (UJP_DOC_TYPES[kind].refType ? fake : null), names);
  // адреса: агентот ги зема продавачот и купувачот од регистарот на УЈП пред праќање -> тука само предупредување
  const warnings: string[] = [];
  problems.push(...checkUjpPayload(payload, { net: inv.netTotal, vat: inv.vatTotal, gross: inv.grossTotal, payable: inv.payableAmount }, 0.05, names, warnings));
  return { payload, problems, warnings, waitFor, sellerEdb, docTypeCode: UJP_DOC_TYPES[kind].code };
}
