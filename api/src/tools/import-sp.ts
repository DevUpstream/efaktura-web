/**
 * Uvoz na podatoci od SharePoint (izvoz od scripts/13-ExportForOracle.ps1) vo novata baza.
 *
 *   node dist/tools/import-sp.js <izvoz.json> [--dry-run] [--include-test]
 *
 * - Se izvrsuva vo EDNA transakcija: ili se, ili nisto. --dry-run pravi se i na krajot vrakja nazad.
 * - Test klienti (EDB 99999999999xx) se preskoknuvaat, osven so --include-test.
 * - Stavkite se presmetuvaat odnovo na 4 decimali (SharePoint gi cuvase na 2); zaglavjeto MORA da se sovpadne
 *   so SharePoint, inaku uvozot zapira.
 * - Odbiva ako nekoj od klientite vekje postoi (uvozot ne se povtoruva).
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import * as s from "../db/schema.js";
import type { Db } from "../db/types.js";
import { calcLine, calcTotals } from "../domain/calc.js";

type Row = Record<string, any>;
type DocType = (typeof s.docType.enumValues)[number];
type Status = (typeof s.invoiceStatus.enumValues)[number];

const DOC: Record<string, DocType> = { "Фактура": "INV", "Авансна фактура": "AV", "Книжно одобрение": "OD",
  "Книжно задолжување": "KZ", "Сторно": "ST", "Корекција": "KR" };
const STATUS: Record<string, Status> = { "Нацрт": "draft", "За издавање": "to_issue", "Издадена": "issued",
  "JSON извезен": "json_exported", "Качена на УЈП": "sent_to_ujp", "Одбиена": "rejected", "Сторнирана": "voided",
  "Корегирана": "corrected", "Откажан нацрт": "cancelled_draft" };
const PAY: Record<string, (typeof s.paymentMethod.enumValues)[number]> = { "Трансакциска сметка": "bank", "Готовина": "cash",
  "Платежна картичка": "card", "Компензација": "compensation", "Друго": "other" };
const REASON: Record<string, "void" | "correction"> = { "Сторно": "void", "Корекција": "correction" };
const ITEM: Record<string, "goods" | "service"> = { "Услуга": "service", "Производ": "goods", "Стока": "goods" };

/** Datum od SP ("2026-11-03T00:00:00+01:00", lokalno vreme) -> "2026-11-03". */
const day = (v: string | null | undefined) => (v ? v.slice(0, 10) : null);
const ts = (v: string | null | undefined) => (v ? new Date(v) : null);
const num = (v: unknown) => (v === null || v === undefined ? null : String(v));
const int = (v: unknown) => (v === null || v === undefined ? null : Math.trunc(Number(v)));
const str = (v: unknown, max?: number) => (v === null || v === undefined || v === "" ? null : max ? String(v).slice(0, max) : String(v));

export interface ImportReport { lines: string[]; counts: Record<string, number> }

export async function importSharePoint(db: Db, json: string, opts: { includeTest?: boolean } = {}): Promise<ImportReport> {
  const L = JSON.parse(json.replace(/^﻿/, "")).lists as Record<string, { items: Row[] }>;
  const items = (n: string) => L[n]?.items ?? [];
  const out: string[] = [];
  const counts: Record<string, number> = {};
  const inc = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const isTest = (edb: string) => /^99999999999\d\d$/.test(edb);

  const spClients = items("Clients").filter((c) => opts.includeTest || !isTest(c.Edb));
  const keep = new Set(spClients.map((c) => c.ID as number));
  const clientNo = (r: Row) => int(r.ClientNo ?? r.ClientRef?.id)!;

  // 1) shifri na pricini (globalni)
  for (const r of items("UjpReasons")) {
    const kind = REASON[r.Kind]; if (!kind) throw new Error(`Nepoznat vid na pricina: ${r.Kind}`);
    await db.insert(s.ujpReasons).values({ code: r.Code, name: r.Title, kind, isActive: r.IsActive !== false })
      .onConflictDoUpdate({ target: s.ujpReasons.code, set: { name: r.Title, kind, isActive: r.IsActive !== false } });
    inc("ujp_reasons");
  }

  // 2) DDV stapki: po shifra (pocetnite se vekje vo bazata)
  const vatBySp = new Map<number, number>();
  for (const v of items("VatRates")) {
    const [ex] = await db.select().from(s.vatRates).where(eq(s.vatRates.code, v.Code));
    const vals = { name: v.Title, ujpCode: str(v.UjpCode, 20), vatGroup: v.VatGroup ?? null, vatImpact: v.VatImpact ?? null,
      ratePct: String(v.RatePct), isExempt: !!v.IsExempt, legalBasis: str(v.LegalBasis), validFrom: day(v.ValidFrom)!,
      validTo: day(v.ValidTo), isActive: v.IsActive !== false, legacySpId: v.ID };
    const [row] = ex
      ? await db.update(s.vatRates).set(vals).where(eq(s.vatRates.id, ex.id)).returning()
      : await db.insert(s.vatRates).values({ code: v.Code, ...vals }).returning();
    vatBySp.set(v.ID, row!.id); inc("vat_rates");
  }

  // 3) klienti
  const clientBySp = new Map<number, number>();
  for (const c of spClients) {
    const [dup] = await db.select({ id: s.clients.id }).from(s.clients).where(eq(s.clients.edb, c.Edb));
    if (dup) throw new Error(`Klientot ${c.Title} (${c.Edb}) vekje postoi - uvozot ne se povtoruva.`);
    const [row] = await db.insert(s.clients).values({
      legacySpId: c.ID, name: c.Title, edb: c.Edb, embs: str(c.Embs, 8), vatNumber: str(c.VatNumber, 20), vatPayer: !!c.VatPayer,
      address: c.Address ?? "", city: c.City ?? "", postalCode: str(c.PostalCode, 10), country: (c.Country || "MK").slice(0, 2),
      iban: str(c.Iban, 34), bankName: str(c.BankName), email: str(c.Email, 254), phone: str(c.Phone, 50),
      invoicePrefix: c.InvoicePrefix, invoiceClauses: str(c.InvoiceClauses), isActive: c.IsActive !== false,
      ujpRegistryAt: ts(c.UjpRegistryAt), ujpRegistryNote: str(c.UjpRegistryNote),
      createdAt: ts(c.Created) ?? undefined,
    }).returning();
    clientBySp.set(c.ID, row!.id); inc("clients");
    out.push(`klient  ${c.InvoicePrefix.padEnd(7)} ${c.Title}`);
  }

  // 4) korisnici (Microsoft smetki po e-posta) i pristap
  const userByEmail = new Map<string, number>();
  for (const u of await db.select().from(s.users)) userByEmail.set(u.email.toLowerCase(), u.id);
  const ensureUser = async (p: Row | null | undefined) => {
    const email = String(p?.email ?? "").toLowerCase();
    if (!email) return null;
    if (!userByEmail.has(email)) {
      const [u] = await db.insert(s.users).values({ email, displayName: p?.name || email, provider: "entra", role: "accountant" }).returning();
      userByEmail.set(email, u!.id); inc("users");
      out.push(`korisnik ${email} (Microsoft, smetkovoditel)`);
    }
    return userByEmail.get(email)!;
  };
  for (const a of items("ClientAccess")) {
    const cid = clientBySp.get(clientNo(a)); if (!cid) continue;
    const uid = await ensureUser(a.Accountant); if (!uid) continue;
    await db.insert(s.clientAccess).values({ clientId: cid, userId: uid, isActive: a.IsActive !== false, note: str(a.Title) })
      .onConflictDoNothing();
    inc("client_access");
  }

  // 5) kupuvaci i artikli
  const partnerBySp = new Map<number, number>();
  for (const p of items("Partners")) {
    const cid = clientBySp.get(clientNo(p)); if (!cid) continue;
    const [row] = await db.insert(s.partners).values({
      legacySpId: p.ID, clientId: cid, name: p.Title, edb: str(p.Edb, 13), embs: str(p.Embs, 8), vatNumber: str(p.VatNumber, 20),
      address: str(p.Address), city: str(p.City), postalCode: str(p.PostalCode, 10), country: (p.Country || "MK").slice(0, 2),
      email: str(p.Email, 254), phone: str(p.Phone, 50), isActive: p.IsActive !== false,
      ujpRegistryAt: ts(p.UjpRegistryAt), ujpRegistryNote: str(p.UjpRegistryNote), createdAt: ts(p.Created) ?? undefined,
    }).returning();
    partnerBySp.set(p.ID, row!.id); inc("partners");
  }
  const itemBySp = new Map<number, number>();
  for (const it of items("Items")) {
    const cid = clientBySp.get(clientNo(it)); if (!cid) continue;
    const vat = vatBySp.get(it.VatRateId?.id); if (!vat) throw new Error(`Artikl ${it.Code}: nepoznata DDV stapka`);
    const [row] = await db.insert(s.items).values({
      legacySpId: it.ID, clientId: cid, code: it.Code, name: it.Title, type: ITEM[it.ItemType] ?? "service", unit: it.Unit,
      unitPrice: String(it.UnitPrice), vatRateId: vat, isActive: it.IsActive !== false, createdAt: ts(it.Created) ?? undefined,
    }).returning();
    itemBySp.set(it.ID, row!.id); inc("items");
  }
  for (const pp of items("PartnerPrices")) {
    const cid = clientBySp.get(clientNo(pp)); if (!cid) continue;
    await db.insert(s.partnerPrices).values({
      legacySpId: pp.ID, clientId: cid, partnerId: partnerBySp.get(int(pp.PartnerNo)!)!, itemId: itemBySp.get(int(pp.ItemNo)!)!,
      price: String(pp.Price), validFrom: day(pp.ValidFrom)!, validTo: day(pp.ValidTo) ?? "2099-12-31", note: str(pp.Note),
    });
    inc("partner_prices");
  }

  // 6) fakturi: kako nacrt -> stavki -> konecen status (taka vazat istite triggeri kako vo aplikacijata)
  const invBySp = new Map<number, number>();
  const spInvoices = items("Invoices").filter((i) => clientBySp.has(clientNo(i))).sort((a, b) => a.ID - b.ID);
  for (const i of spInvoices) {
    const cid = clientBySp.get(clientNo(i))!;
    const docType = DOC[i.DocType]; const status = STATUS[i.Status];
    if (!docType || !status) throw new Error(`${i.Title}: nepoznat vid/status ${i.DocType}/${i.Status}`);
    const partnerId = partnerBySp.get(i.PartnerId?.id ?? -1);
    if (!partnerId) throw new Error(`${i.Title}: kupuvacot ne e pronajden`);
    const relSp = int(i.RelatedNo) ?? i.RelatedInvoiceId?.id ?? null;
    const advSp = int(i.AdvanceInvoiceNo);

    const [draft] = await db.insert(s.invoices).values({
      legacySpId: i.ID, clientId: cid, partnerId, docType, status: "draft", year: int(i.InvoiceYear)!,
      issueDate: day(i.IssueDate)!, supplyDate: docType === "AV" ? null : day(i.SupplyDate), dueDate: day(i.DueDate),
      currency: (i.Currency || "MKD").slice(0, 3), exchangeRate: num(i.ExchangeRate) ?? "1", paymentMethod: PAY[i.PaymentMethod] ?? "bank",
      relatedInvoiceId: relSp ? invBySp.get(relSp) ?? null : null, advanceInvoiceId: advSp ? invBySp.get(advSp) ?? null : null,
      advanceAmount: advSp ? num(i.AdvanceAmount) : null,
      correctionReason: str(i.CorrectionReason), voidReasonCode: str(i.VoidReasonCode, 10), correctionReasonCode: str(i.CorrectionReasonCode, 10),
      clauses: str(i.Clauses), note: str(i.Note), createdAt: ts(i.Created) ?? undefined,
    }).returning();
    if (relSp && !draft!.relatedInvoiceId) throw new Error(`${i.Title}: povrzanata faktura (SP ${relSp}) ne e uvezena`);

    const spLines = items("InvoiceLines").filter((l) => int(l.InvoiceNo ?? l.InvoiceId?.id) === i.ID).sort((a, b) => a.LineNo - b.LineNo);
    const calc = [];
    for (const l of spLines) {
      const vat = vatBySp.get(l.VatRateId?.id); if (!vat) throw new Error(`${i.Title}/${l.LineNo}: DDV stapka`);
      const qty = Number(l.Qty);
      const r = calcLine({ qty: Math.abs(qty), unitPrice: l.UnitPrice, discountPct: l.DiscountPct ?? 0, vatRatePct: l.VatRatePct }, qty < 0 ? -1 : 1);
      if (Math.abs(Number(r.netAmount) - l.NetAmount) > 0.005 || Math.abs(Number(r.vatAmount) - l.VatAmount) > 0.005)
        throw new Error(`${i.Title}/${l.LineNo}: stavkata ne se sovpagja (SP ${l.NetAmount}/${l.VatAmount}, nov ${r.netAmount}/${r.vatAmount})`);
      await db.insert(s.invoiceLines).values({
        legacySpId: l.ID, invoiceId: draft!.id, lineNo: int(l.LineNo)!, itemId: itemBySp.get(int(l.ItemNo ?? l.ItemId?.id) ?? -1) ?? null,
        description: l.Title, unit: l.Unit, qty: String(qty), unitPrice: String(l.UnitPrice), discountPct: String(l.DiscountPct ?? 0),
        vatRateId: vat, vatRatePct: String(l.VatRatePct), netAmount: r.netAmount, vatAmount: r.vatAmount, priceSource: str(l.PriceSource, 80),
      });
      calc.push({ ...r, vatRatePct: l.VatRatePct }); inc("invoice_lines");
    }
    const t = calcTotals(calc, i.AdvanceAmount ?? 0);
    const same = [t.netTotal, t.vatTotal, t.grossTotal].map(Number).every((v, k) => v === [i.NetTotal, i.VatTotal, i.GrossTotal][k])
      && (i.PayableAmount == null || Number(t.payableAmount) === i.PayableAmount);
    if (!same) throw new Error(`${i.Title}: zaglavjeto ne se sovpagja (SP ${i.NetTotal}/${i.VatTotal}/${i.GrossTotal}, nov ${t.netTotal}/${t.vatTotal}/${t.grossTotal})`);

    const issuedBy = await ensureUser(i.IssuedBy);
    await db.update(s.invoices).set({
      status, seqNo: int(i.SeqNo), number: str(i.Title, 40),
      netTotal: t.netTotal, vatTotal: t.vatTotal, grossTotal: t.grossTotal, payableAmount: t.payableAmount, lineCount: spLines.length,
      buyerName: str(i.BuyerName), buyerEdb: str(i.BuyerEdb, 13), buyerVatNumber: str(i.BuyerVatNumber, 20), buyerAddress: str(i.BuyerAddress),
      buyerCity: str(i.BuyerCity), buyerCountry: str(i.BuyerCountry, 2),
      sellerName: str(i.SellerName), sellerEdb: str(i.SellerEdb, 13), sellerVatNumber: str(i.SellerVatNumber, 20),
      sellerAddress: str(i.SellerAddress), sellerIban: str(i.SellerIban, 34), sellerBank: str(i.SellerBank),
      issuedBy, issuedAt: ts(i.IssuedAt), statusMessage: str(i.StatusMessage),
      ujpId: str(i.UjpId, 40), ujpTimestamp: ts(i.UjpTimestamp), ujpQrLink: str(i.UjpQrLink, 255), ujpStatusCode: str(i.UjpStatusCode, 5),
      ujpStatusName: str(i.UjpStatusName, 60), ujpSentAt: ts(i.UjpSentAt), ujpError: str(i.UjpError),
    }).where(eq(s.invoices.id, draft!.id));
    invBySp.set(i.ID, draft!.id); inc("invoices");
    out.push(`faktura ${String(i.Title).padEnd(20)} ${status.padEnd(10)} ${t.netTotal} + ${t.vatTotal} = ${t.grossTotal} (za plakjanje ${t.payableAmount})  OK`);
  }

  // 7) brojaci: najgolemiot od SP brojacot i najgolemiot uvezen broj
  const max = new Map<string, number>();
  const key = (c: number, d: DocType, y: number) => `${c}|${d}|${y}`;
  for (const k of items("Counters")) {
    const cid = clientBySp.get(clientNo(k)); const d = DOC[k.DocType];
    if (cid && d) max.set(key(cid, d, int(k.Year)!), Math.max(max.get(key(cid, d, int(k.Year)!)) ?? 0, int(k.LastNo)!));
  }
  for (const i of spInvoices) if (i.SeqNo) {
    const k = key(clientBySp.get(clientNo(i))!, DOC[i.DocType]!, int(i.InvoiceYear)!);
    max.set(k, Math.max(max.get(k) ?? 0, int(i.SeqNo)!));
  }
  for (const [k, lastNo] of max) {
    const [c, d, y] = k.split("|");
    await db.insert(s.counters).values({ clientId: Number(c), docType: d as DocType, year: Number(y), lastNo })
      .onConflictDoUpdate({ target: [s.counters.clientId, s.counters.docType, s.counters.year], set: { lastNo: sql`greatest(${s.counters.lastNo}, ${lastNo})` } });
    inc("counters");
  }

  const skipped = items("Clients").length - spClients.length;
  out.push(`preskoknati test klienti: ${skipped}`);
  await db.insert(s.auditLog).values({ entity: "import", entityId: "sharepoint", action: "import",
    changes: { sha256: createHash("sha256").update(json).digest("hex"), counts, skippedTestClients: skipped } });
  return { lines: out, counts };
}

/* ------------------------------------------------------------------ CLI */
if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, ...flags] = process.argv.slice(2);
  if (!file) { console.error("Upotreba: node dist/tools/import-sp.js <izvoz.json> [--dry-run] [--include-test]"); process.exit(1); }
  const { connect } = await import("../db/client.js");
  const { db, sql: pg, migrate } = connect(process.env.DATABASE_URL!, process.env.DATABASE_PASSWORD_FILE);
  await migrate();
  const json = readFileSync(file, "utf8");
  console.log(`Datoteka: ${file}\nSHA-256:  ${createHash("sha256").update(json).digest("hex")}\n`);
  const DRY = Symbol("dry");
  try {
    await db.transaction(async (tx) => {
      const r = await importSharePoint(tx as unknown as Db, json, { includeTest: flags.includes("--include-test") });
      r.lines.forEach((l) => console.log(l));
      console.log("\nZapisi:", JSON.stringify(r.counts));
      if (flags.includes("--dry-run")) throw DRY;
    });
    console.log("\nUVOZOT E ZAPISAN.");
  } catch (e) {
    if (e === DRY) console.log("\nPROBA (--dry-run): nisto ne e zapisano.");
    else { console.error("\n!! UVOZOT E PREKINAT, nisto ne e zapisano:", (e as Error).message); process.exitCode = 1; }
  } finally {
    await pg.end({ timeout: 5 });
  }
}
