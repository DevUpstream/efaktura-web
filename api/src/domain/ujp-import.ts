/**
 * Uvoz na vlezna e-faktura vo formatot na UJP (JSON, tip 100) - docs/09.
 *
 * Prifakja: cist JSON ({requestTimestamp, document} ili samo document), obvivka {requestTimestamp, jws}
 * ili potpisan JWS (header.payload.signature) - se cita payload-ot (potpisot ne se proveruva tuka).
 *
 * Pravila:
 *  - Kupuvacot (buyerTin) mora da e izbranata firma; prodavacot ne smee da e ista firma.
 *  - Dobavuvacot se naogja po EDB; ako go nema, se kreira od podatocite vo dokumentot.
 *  - IZNOSITE SE OD DOKUMENTOT (zakonski dokument), ne se presmetuvaat odnovo. Razlika so nasata presmetka
 *    (na pr. DDV zaokruzen na cel denar po stavka) e samo predupreduvanje.
 *  - Stavkite se povrzuvaat so artikl spored nauceno: dobavuvac + opis -> artikl (supplier_item_map).
 *  - Ista faktura (EDB na dobavuvac + broj) ne se uvezuva dvapati.
 *  - Zasega samo tip 100 (faktura) vo MKD; drugite jasno se odbivaat.
 */
import { createHash } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { z } from "zod";
import { clients, partners, purchaseFiles, purchaseInvoices, purchaseLines, supplierItemMap, vatRates } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "./errors.js";
import { audit, type Actor } from "./audit.js";
import { calcLine, calcTotals } from "./calc.js";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const num = z.union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/)]).transform((v) => new D(v));
const optNum = z.union([num, z.literal(""), z.null()]).optional().transform((v) => (v === "" || v == null ? null : v));
const str = z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v == null ? "" : String(v).trim()));
const Address = z.object({ streetAddress: str, streetNumber: str, postalCode: str, city: str }).partial().optional();

const UjpDoc = z.object({
  header: z.object({ docType: str, docTypeName: str, docDate: z.string(), docNumber: z.string().trim().min(1, "Нема број на фактура"),
    docTurnoverDate: str, docNotes: str, docPeriodStartDate: str, docPeriodEndDate: str }),
  seller: z.object({ sellerTin: str, sellerName: str, sellerVatNumber: str, sellerCCode: str, sellerAddress: Address, sellerEmail: str }),
  buyer: z.object({ buyerTin: str, buyerName: str }),
  docItems: z.array(z.object({
    docItemLineNo: optNum, docItemDesc: z.string().trim().min(1, "Ставка без опис"), docItemQty: num, docItemMUnit: str,
    docItemUnitOriginalPriceWoVat: optNum, docItemUnitDiscountAmount: optNum, docItemUnitPriceWoVat: num,
    docItemVat: num, docItemTaxIndicator: str, docItemTotalPriceWoVat: num, docItemTotalVat: num, docItemTotalPriceWVat: optNum,
  })).min(1, "Фактурата нема ставки").max(500),
  docTotals: z.object({ docNetAmountDisc: optNum, docNetAmount: optNum, docVatAmount: num, docGrossAmount: num, docFinalAmount: optNum,
    docAvansAmount: optNum }),
  docPayment: z.object({ docPaymentTypeDueDays: optNum, docPaymentTypeDueDate: str, docCurrency: str, docCurrencyCode: str }).partial().optional(),
});
export type UjpDocument = z.infer<typeof UjpDoc>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const digits = (s: string) => s.replace(/\D/g, "");
const fail = (msg: string, status = 422, code = "validation") => new DomainError(code, msg, status);
const CYR: Record<string, string> = { А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", У: "Y", Ј: "J", Ѕ: "S", І: "I" };
/** "МК" (кирилица, како во примерите на УЈП) -> "MK". */
export const countryCode = (s: string) => { const c = s.toUpperCase().replace(/./g, (ch) => CYR[ch] ?? ch); return /^[A-Z]{2}$/.test(c) ? c : "MK"; };
/** Клуч за учење: мали букви, едно празно место. */
export const descKey = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 300);
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** Чита JSON / обвивка со jws / JWS и го враќа делот document. */
export function parseUjpText(text: string): UjpDocument {
  let raw: unknown;
  const t = text.replace(/^﻿/, "").trim();
  try {
    if (/^[\w-]+\.[\w-]+\.[\w-]*$/.test(t)) raw = JSON.parse(fromB64url(t.split(".")[1]!));
    else raw = JSON.parse(t);
  } catch { throw fail("Датотеката не е JSON (ни потпишан JWS) во форматот на УЈП е-Фактура."); }
  let o = raw as Record<string, unknown>;
  if (o && typeof o.jws === "string") {
    try { o = JSON.parse(fromB64url(o.jws.split(".")[1] ?? "")); } catch { throw fail("Полето jws не може да се прочита."); }
  }
  const doc = (o?.document ?? o) as unknown;
  const r = UjpDoc.safeParse(doc);
  if (!r.success) {
    const i = r.error.issues[0]!;
    throw fail(`Не е е-фактура во форматот на УЈП: ${i.path.join(".") || "документ"} – ${i.message}.`);
  }
  return r.data;
}

const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const todaySkopje = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Skopje" });
const fmt = (v: Decimal) => v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ".").replace(/\.(\d{2})$/, ",$1");

export interface ImportResult {
  id: number; supplierNumber: string; supplier: { id: number; name: string; created: boolean };
  grossTotal: string; payableAmount: string; lines: number; mapped: number; warnings: string[];
}

export async function importUjpPurchase(db: Db, clientId: number, input: { text: string; fileName?: string | null;
  pdf?: { name: string; data: Buffer } | null }, actor: Actor & { userId: number }): Promise<ImportResult> {
  const doc = parseUjpText(input.text);
  const h = doc.header;
  const warnings: string[] = [];

  if (h.docType !== "100") throw fail(`Засега се увезуваат само фактури (тип 100); овој документ е тип ${h.docType || "?"}${h.docTypeName ? ` (${h.docTypeName})` : ""}. Внесете го рачно.`);
  const cur = (doc.docPayment?.docCurrencyCode || doc.docPayment?.docCurrency || "MKD").toUpperCase();
  if (cur !== "MKD") throw fail(`Фактурата е во ${cur}; девизни влезни фактури уште не се поддржани. Внесете ја рачно.`);
  if (!DAY.test(h.docDate)) throw fail("Датумот на фактурата не е во формат ГГГГ-ММ-ДД.");
  if (doc.docTotals.docAvansAmount && !doc.docTotals.docAvansAmount.isZero()) warnings.push("Фактурата има одбиен аванс: за плаќање е износот по авансот.");

  const sellerEdb = digits(doc.seller.sellerTin);
  const buyerEdb = digits(doc.buyer.buyerTin);
  const hash = createHash("sha256").update(input.text).digest("hex");

  return db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const [client] = await tx.select().from(clients).where(eq(clients.id, clientId));
    if (!client) throw fail("Фирмата не постои.", 404, "not_found");
    if (buyerEdb !== digits(client.edb)) throw fail(`Купувач на фактурата е ${doc.buyer.buyerName || "друга фирма"} (ЕДБ ${buyerEdb || "–"}), не ${client.name}. Изберете ја таа фирма и увезете повторно.`);
    if (!/^\d{13}$/.test(sellerEdb)) throw fail("ЕДБ на продавачот недостасува или не е 13 цифри.");
    if (sellerEdb === buyerEdb) throw fail("Продавачот и купувачот се иста фирма – ова е излезна, не влезна фактура.");

    // --- dobavuvac
    let created = false;
    let [sup] = await tx.select().from(partners).where(and(eq(partners.clientId, clientId), eq(partners.edb, sellerEdb)));
    if (sup && !sup.isActive) throw fail(`Добавувачот ${sup.name} е исклучен. Вклучете го во „Купувачи и добавувачи“ и увезете повторно.`);
    if (!sup) {
      const a = doc.seller.sellerAddress ?? {};
      const email = doc.seller.sellerEmail.match(/[^\s<>"',;]+@[^\s<>"',;]+\.[a-z]{2,}/i)?.[0] ?? null;
      [sup] = await tx.insert(partners).values({ clientId, name: doc.seller.sellerName || `Добавувач ${sellerEdb}`, edb: sellerEdb,
        vatNumber: doc.seller.sellerVatNumber ? countryCode(doc.seller.sellerVatNumber.slice(0, 2)) + doc.seller.sellerVatNumber.slice(2) : null,
        address: [a.streetAddress, a.streetNumber].filter(Boolean).join(" ") || null, city: a.city || null,
        postalCode: a.postalCode?.slice(0, 10) || null, country: countryCode(doc.seller.sellerCCode || "MK"), email: email?.slice(0, 254) ?? null }).returning();
      created = true;
    }

    // --- duplikat
    const [dup] = await tx.select({ id: purchaseInvoices.id, number: purchaseInvoices.number }).from(purchaseInvoices)
      .where(and(eq(purchaseInvoices.clientId, clientId), eq(purchaseInvoices.partnerId, sup!.id), eq(purchaseInvoices.supplierNumber, h.docNumber.slice(0, 60)),
        ne(purchaseInvoices.status, "voided")));
    if (dup) throw new DomainError("duplicate", `Фактура ${h.docNumber} од ${sup!.name} е веќе внесена (${dup.number ?? "нацрт"}).`, 409);

    // --- stavki
    const rates = (await tx.select().from(vatRates)).filter((r) => r.isActive && r.validFrom <= h.docDate && (!r.validTo || r.validTo >= h.docDate));
    const learned = new Map((await tx.select().from(supplierItemMap).where(and(eq(supplierItemMap.clientId, clientId), eq(supplierItemMap.partnerId, sup!.id))))
      .map((m) => [m.descKey, m.itemId]));
    let sumNet = new D(0), sumVat = new D(0), mapped = 0;
    const calc: { netAmount: string; vatAmount: string; unitNet: string; vatRatePct: string }[] = [];
    const rows = doc.docItems.map((it, i) => {
      const n = i + 1;
      if (!it.docItemQty.gt(0)) throw fail(`Ставка ${n}: количината мора да е поголема од 0 (негативни ставки → внесете рачно).`);
      const cands = rates.filter((r) => new D(r.ratePct).eq(it.docItemVat));
      const rate = (it.docItemTaxIndicator && cands.find((r) => r.ujpCode === it.docItemTaxIndicator)) || cands.find((r) => !r.isExempt) || cands[0];
      if (!rate) throw fail(`Ставка ${n}: нема ДДВ стапка ${it.docItemVat.toFixed(2)}% во шифрарникот.`);
      const orig = it.docItemUnitOriginalPriceWoVat ?? it.docItemUnitPriceWoVat;
      const disc = orig.gt(0) ? D.max(0, orig.minus(it.docItemUnitPriceWoVat)).div(orig).times(100).toDecimalPlaces(2) : new D(0);
      const itemId = learned.get(descKey(it.docItemDesc)) ?? null;
      if (itemId) mapped++;
      sumNet = sumNet.plus(it.docItemTotalPriceWoVat); sumVat = sumVat.plus(it.docItemTotalVat);
      calc.push({ ...calcLine({ qty: it.docItemQty, unitPrice: orig, discountPct: disc, vatRatePct: rate.ratePct }), vatRatePct: rate.ratePct });
      return { lineNo: n, itemId, description: it.docItemDesc.slice(0, 500), unit: (it.docItemMUnit || "ком").slice(0, 10),
        qty: it.docItemQty.toFixed(4), unitPrice: orig.toFixed(4), discountPct: disc.toFixed(2), vatRateId: rate.id, vatRatePct: rate.ratePct,
        netAmount: it.docItemTotalPriceWoVat.toFixed(4), vatAmount: it.docItemTotalVat.toFixed(4) };
    });

    // --- zbirovi od dokumentot + proverki
    const t = doc.docTotals;
    const net = (t.docNetAmountDisc ?? t.docNetAmount ?? sumNet).toDecimalPlaces(2);
    const vat = t.docVatAmount.toDecimalPlaces(2), gross = t.docGrossAmount.toDecimalPlaces(2);
    const payable = (t.docFinalAmount ?? gross).toDecimalPlaces(2);
    const off = (a: Decimal, b: Decimal) => a.minus(b).abs().gt("0.05");
    if (off(sumNet, net)) throw fail(`Документот не е усогласен: збирот на ставките без ДДВ (${fmt(sumNet)}) ≠ основица (${fmt(net)}).`);
    if (off(sumVat, vat)) throw fail(`Документот не е усогласен: збирот на ДДВ по ставки (${fmt(sumVat)}) ≠ ДДВ (${fmt(vat)}).`);
    if (net.plus(vat).minus(gross).abs().gt(1)) throw fail(`Документот не е усогласен: основица + ДДВ (${fmt(net.plus(vat))}) ≠ вкупно (${fmt(gross)}).`);
    const ours = calcTotals(calc);
    if (off(new D(ours.vatTotal), vat) || off(new D(ours.netTotal), net))
      warnings.push(`Кај добавувачот износите се заокружени поинаку: по нашата пресметка основица ${fmt(new D(ours.netTotal))}, ДДВ ${fmt(new D(ours.vatTotal))}; ` +
        `на фактурата ${fmt(net)} и ${fmt(vat)}. Се зачувува износот од фактурата.`);

    const issueDate = h.docDate;
    const today = todaySkopje();
    const receivedDate = today < issueDate ? issueDate : today;
    const pay = doc.docPayment ?? {};
    const dueDate = DAY.test(pay.docPaymentTypeDueDate ?? "") ? pay.docPaymentTypeDueDate!
      : pay.docPaymentTypeDueDays && pay.docPaymentTypeDueDays.gt(0) ? addDays(issueDate, pay.docPaymentTypeDueDays.toNumber()) : null;
    if (dueDate && dueDate < issueDate) warnings.push("Рокот за плаќање е пред датумот на фактурата.");
    const period = DAY.test(h.docPeriodStartDate) && DAY.test(h.docPeriodEndDate) ? `Период ${h.docPeriodStartDate} – ${h.docPeriodEndDate}` : "";
    const note = [h.docNotes, period].filter(Boolean).join("\n").slice(0, 2000) || null;

    const [p] = await tx.insert(purchaseInvoices).values({ clientId, partnerId: sup!.id, year: Number(receivedDate.slice(0, 4)),
      supplierNumber: h.docNumber.slice(0, 60), issueDate, receivedDate, dueDate, note, createdBy: actor.userId,
      netTotal: net.toFixed(2), vatTotal: vat.toFixed(2), grossTotal: gross.toFixed(2), payableAmount: payable.toFixed(2),
      source: "ujp_json", fixedAmounts: true, ujpDocType: h.docType, turnoverDate: DAY.test(h.docTurnoverDate) ? h.docTurnoverDate : null,
      sourceJson: doc, sourceHash: hash }).returning();
    for (const r of rows) await tx.insert(purchaseLines).values({ purchaseInvoiceId: p!.id, ...r });
    if (input.pdf) await addFile(tx, p!.id, input.pdf.name, input.pdf.data, actor.userId);
    await audit(tx, actor, { clientId, entity: "purchase_invoice", entityId: p!.id, action: "import_ujp_json",
      changes: { fileName: input.fileName ?? null, supplier: sellerEdb, number: h.docNumber, gross: gross.toFixed(2), supplierCreated: created } });
    return { id: p!.id, supplierNumber: h.docNumber, supplier: { id: sup!.id, name: sup!.name, created }, grossTotal: gross.toFixed(2),
      payableAmount: payable.toFixed(2), lines: rows.length, mapped, warnings };
  });
}

export const MAX_FILE = 8 * 1024 * 1024;
/** Прилог (PDF или слика) кон влезна фактура. */
export async function addFile(tx: Db, purchaseId: number, name: string, data: Buffer, userId: number) {
  if (!data.length) throw fail("Празна датотека.");
  if (data.length > MAX_FILE) throw fail("Прилогот е поголем од 8 MB.");
  const type = data.subarray(0, 5).toString("latin1") === "%PDF-" ? "application/pdf"
    : data[0] === 0xff && data[1] === 0xd8 ? "image/jpeg" : data.subarray(1, 4).toString("latin1") === "PNG" ? "image/png" : null;
  if (!type) throw fail("Прилогот мора да е PDF, JPG или PNG.");
  const fileName = name.replace(/[\\/:*?"<>|\r\n]/g, "_").slice(0, 200) || "prilog";
  const [f] = await tx.insert(purchaseFiles).values({ purchaseInvoiceId: purchaseId, fileName, contentType: type, size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"), data, createdBy: userId })
    .returning({ id: purchaseFiles.id, fileName: purchaseFiles.fileName, contentType: purchaseFiles.contentType, size: purchaseFiles.size });
  return f!;
}

/** Учење при книжење: добавувач + опис -> артикл. */
export async function learnItems(tx: Db, clientId: number, partnerId: number, lines: { itemId: number | null; description: string }[]) {
  for (const l of lines) {
    if (!l.itemId) continue;
    await tx.insert(supplierItemMap).values({ clientId, partnerId, descKey: descKey(l.description), itemId: l.itemId })
      .onConflictDoUpdate({ target: [supplierItemMap.clientId, supplierItemMap.partnerId, supplierItemMap.descKey], set: { itemId: l.itemId, updatedAt: new Date() } });
  }
}
