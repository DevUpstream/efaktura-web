/**
 * Uvoz na dokumenti od Excel/PDF (docs/20): vlezni i izlezni fakturi SO ZALIHA, po red na datumot.
 *
 *   node dist/tools/import-docs.js <datoteka.json | -> --client <EDB> --user <e-poshta> [--dry-run]
 *
 * - Format "docs/1" (go pravi scripts/docs-json.py od Excel/PDF; podatocite gi proveruva chovek).
 * - Artiklite od "items" se dodavaat ako ja nema shifrata (postoecki artikl ne se menuva).
 * - Partner: po EDB, pa po naziv (i "aliases"); ako go nema, se dodava od podatocite vo dokumentot.
 * - Vlezna faktura: se knizi SO ZALIHA (priemnica). Valuta (USD...) -> denari po sreden kurs na NBRM na datumot.
 *   Iznosite (zbirovi) se od dokumentot (fixed_amounts). PDF-ot se dodava kako prilog.
 * - Izlezna faktura: IZDADENA so brojot od dokumentot (source = excel), ispratnica za stokata;
 *   zaliha vo minus = predupreduvanje (ne se prekinuva). NIKOGASH ne odi kon UJP.
 * - Dokumentite odat po datum (vleznite pred izleznite na ist den), za zalihata da e tocna niz vremeto.
 * - Izvodi (na pr. PDF od Stopanska, pretvoreni vo JSON): po dokumentite; proverka pocetna + priliv - odliv = nova;
 *   sekoja stavka: knizenje (partner + raspored po broj na faktura; prazen = avans/nema faktura), kategorija (provizija,
 *   pozajmica, prenos...) ili ostanuva otvorena.
 * - EDNA transakcija; povtoren uvoz preskoknuva se shto vekje e vneseno.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { and, eq, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { z } from "zod";
import * as s from "../db/schema.js";
import type { Db } from "../db/types.js";
import { normalizeName } from "../domain/bank-import.js";
import { postPurchase } from "../domain/purchase.js";
import { addFile } from "../domain/ujp-import.js";
import { calcLine, calcTotals } from "../domain/calc.js";
import { defaultWarehouse, postStockDoc } from "../domain/stock.js";
import { getNbrmRate } from "../domain/fx.js";
import { bookLine, clientOwnAccounts, setCategory } from "../domain/statements.js";
import { createPayment } from "../domain/payments.js";
import { mkAccount } from "../domain/bank-mt940.js";
import { normAccount } from "../domain/bank-txt.js";

const SOURCE = "excel";
const Partner = z.object({ edb: z.string().regex(/^\d{13}$/).nullable().optional(), name: z.string().min(1), aliases: z.array(z.string()).optional(),
  address: z.string().nullable().optional(), city: z.string().nullable().optional(), country: z.string().length(2).optional(), vatNumber: z.string().nullable().optional() });
const Line = z.object({ itemCode: z.string().max(30).nullable(), description: z.string().min(1), unit: z.string().min(1).max(10), qty: z.number().positive(),
  unitPrice: z.number().nonnegative(), discountPct: z.number().min(0).max(100).default(0), vatPct: z.number(),
  /** shifra na DDV stapka (na pr. Z0 za oslobodeno so pravo na odbivka); bez nea - po procentot */
  vatCode: z.string().max(10).optional() });
const Doc = z.object({
  kind: z.enum(["purchase", "sale"]), ref: z.string().min(1), date: z.string().date(), dueDate: z.string().date().nullable(),
  supplyDate: z.string().date().optional(),   // datum na prometot ako e razlicen od datumot na izdavanje
  /** plateno nadvor od izvodot (na pr. so kartica na datumot na fakturata): plakjanje za celiot iznos */
  paid: z.object({ date: z.string().date(), method: z.enum(["card", "cash", "other"]) }).optional(),
  number: z.string().min(1).max(60), partner: Partner, currency: z.string().length(3).default("MKD"),
  net: z.number(), vat: z.number(), gross: z.number(), note: z.string().nullable().optional(), lines: z.array(Line).min(1),
  files: z.array(z.object({ name: z.string(), data: z.string() })).optional(),
});
const Item = z.object({ code: z.string().min(1).max(30), name: z.string().min(1), type: z.enum(["goods", "service", "material", "product"]),
  unit: z.string().min(1).max(10), vatPct: z.number(), price: z.number().nonnegative() });
const CATEGORY = z.enum(Object.keys(s.EXPENSE_CATEGORIES) as [s.ExpenseCategory, ...s.ExpenseCategory[]]);
const StLine = z.object({ lineNo: z.number().int().positive(), direction: z.enum(["in", "out"]), amount: z.number().positive(), name: z.string(),
  account: z.string(), paymentCode: z.string(), purpose: z.string(), key: z.string().min(1).max(64),
  /** knizenje: partner + raspored (izlezni po broj, vlezni po broj na dobavuvacot); prazen raspored = nerasporedeno (avans / nema faktura) */
  book: z.object({ partner: Partner, invoices: z.array(z.object({ number: z.string(), amount: z.number().positive() })).default([]) }).optional(),
  category: CATEGORY.optional(), note: z.string().optional() });
const Statement = z.object({ no: z.string(), date: z.string().date(), account: z.string(), opening: z.number(), closing: z.number(), fileName: z.string(),
  lines: z.array(StLine) });
const File = z.object({ format: z.literal("docs/1"), label: z.string(), company: z.object({ edb: z.string() }), items: z.array(Item), docs: z.array(Doc),
  statements: z.array(Statement).default([]) });
type DocT = z.infer<typeof Doc>;

export interface DocsReport { lines: string[]; counts: Record<string, number> }
const d2 = (n: number | Decimal) => new Decimal(n).toDecimalPlaces(2).toFixed(2);
const d4 = (n: number | Decimal) => new Decimal(n).toDecimalPlaces(4).toFixed(4);
function inc(c: Record<string, number>, k: string) { c[k] = (c[k] ?? 0) + 1; }

export async function importDocs(db: Db, json: string, clientEdb: string, userEmail: string, fetcher?: Parameters<typeof getNbrmRate>[3]): Promise<DocsReport> {
  const data = File.parse(JSON.parse(json));
  if (data.company.edb !== clientEdb) throw new Error(`Датотеката е за ЕДБ ${data.company.edb}, а е избрана ${clientEdb}.`);
  const [client] = await db.select().from(s.clients).where(eq(s.clients.edb, clientEdb));
  if (!client) throw new Error(`Нема фирма со ЕДБ ${clientEdb}.`);
  const [user] = await db.select().from(s.users).where(sql`lower(${s.users.email}) = ${userEmail.toLowerCase()}`);
  if (!user) throw new Error(`Нема корисник ${userEmail}.`);
  const actor = { userId: user.id, ip: "import-docs" };
  const out: string[] = [`Фирма: ${client.name}. Увоз: ${data.label}.`];
  const counts: Record<string, number> = { items_new: 0, partners_new: 0, purchases_new: 0, purchases_existing: 0, sales_new: 0, sales_existing: 0,
    files_new: 0, stock_warnings: 0,
    statements_new: 0, statements_existing: 0, lines_booked: 0, lines_categorized: 0, lines_open: 0 };
  if (!client.modules.includes("warehouse")) out.push("!! Модулот Магацин не е вклучен – залихата НЕ се води.");

  // DDV: 18/10/5 -> aktivna stapka; 0 -> NP (dobavuvach ne e DDV obvrznik / bez DDV vo dokumentot)
  const today = new Date().toISOString().slice(0, 10);
  const rates = await db.select().from(s.vatRates).where(and(eq(s.vatRates.isActive, true), lte(s.vatRates.validFrom, today),
    or(isNull(s.vatRates.validTo), gte(s.vatRates.validTo, today))));
  const vatOf = (pct: number, sale: boolean, code?: string) => {
    if (code) {
      const r = rates.find((x) => x.code === code);
      if (!r || Number(r.ratePct) !== pct) throw new Error(`ДДВ шифра ${code} не постои или не е ${pct}%.`);
      return { id: r.id, pct: r.ratePct };
    }
    const m = pct === 0 && !sale ? rates.filter((r) => r.code === "NP") : rates.filter((r) => !r.isExempt && Number(r.ratePct) === pct);
    if (m.length !== 1) throw new Error(`ДДВ ${pct}%: ${m.length ? "повеќе" : "нема"} соодветни стапки${sale && pct === 0 ? " (излезна 0 % бара правен основ – рачно)" : ""}.`);
    return { id: m[0]!.id, pct: m[0]!.ratePct };
  };

  // artikli
  const itemRows = await db.select().from(s.items).where(eq(s.items.clientId, client.id));
  const items = new Map(itemRows.map((i) => [i.code.toUpperCase(), i]));
  for (const it of data.items) {
    if (items.has(it.code.toUpperCase())) continue;
    const [row] = await db.insert(s.items).values({ clientId: client.id, code: it.code, name: it.name, type: it.type, unit: it.unit,
      unitPrice: d4(it.price), vatRateId: vatOf(it.vatPct, true).id }).returning();
    items.set(it.code.toUpperCase(), row!); inc(counts, "items_new");
  }
  const itemId = (code: string | null, ref: string) => {
    if (!code) return null;
    const it = items.get(code.toUpperCase());
    if (!it) throw new Error(`${ref}: артиклот ${code} го нема ниту во списокот „items“.`);
    return it.id;
  };

  // partneri
  const partners = await db.select().from(s.partners).where(eq(s.partners.clientId, client.id));
  const byEdb = new Map(partners.filter((p) => p.edb).map((p) => [p.edb!, p]));
  const byName = new Map(partners.map((p) => [normalizeName(p.name), p]));
  async function partnerOf(d: DocT) {
    const p = d.partner;
    const hit = (p.edb ? byEdb.get(p.edb) : undefined) ?? [p.name, ...(p.aliases ?? [])].map((n) => byName.get(normalizeName(n))).find(Boolean);
    const role = d.kind === "sale" ? { isCustomer: true } : { isSupplier: true };
    if (hit) {
      if (d.kind === "sale" ? !hit.isCustomer : !hit.isSupplier) { await db.update(s.partners).set(role).where(eq(s.partners.id, hit.id)); Object.assign(hit, role); }
      return hit;
    }
    const [row] = await db.insert(s.partners).values({ clientId: client!.id, name: p.name, edb: p.edb ?? null, vatNumber: p.vatNumber ?? null,
      address: p.address ?? null, city: p.city ?? null, country: p.country ?? "MK", ...role }).returning();
    out.push(`Нов партнер: ${p.name}${p.edb ? ` (ЕДБ ${p.edb})` : " – без ЕДБ, проверете во регистарот на УЈП"}.`);
    if (row!.edb) byEdb.set(row!.edb, row!);
    byName.set(normalizeName(row!.name), row!); inc(counts, "partners_new");
    return row!;
  }

  // brojot na izleznata vo godinata (redosled vo KIF): po postoeckite
  const seqOf = new Map<number, number>();
  const nextSeq = async (year: number) => {
    if (!seqOf.has(year)) {
      const [r] = await db.select({ m: sql<number>`coalesce(max(${s.invoices.seqNo}), 0)` }).from(s.invoices)
        .where(and(eq(s.invoices.clientId, client!.id), eq(s.invoices.docType, "INV"), eq(s.invoices.year, year)));
      seqOf.set(year, Number(r!.m));
    }
    seqOf.set(year, seqOf.get(year)! + 1);
    return seqOf.get(year)!;
  };

  const docs = [...data.docs].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === "purchase" ? -1 : 1));
  for (const d of docs) {
    const partner = await partnerOf(d);
    const year = Number(d.date.slice(0, 4));
    let rate = new Decimal(1), fxNote = "";
    if (d.currency !== "MKD") {
      if (d.kind === "sale") throw new Error(`${d.ref}: девизна излезна фактура не е поддржана во увозот.`);
      const r = await getNbrmRate(db, d.currency, d.date, fetcher);
      rate = new Decimal(r.rate);
      fxNote = ` Износ во ${d.currency}: ${d2(d.gross)}; среден курс НБРМ ${r.rate} (листа ${r.listDate}).`;
    }
    const mk = (n: number) => new Decimal(n).times(rate);

    if (d.kind === "purchase") {
      const [has] = await db.select({ n: s.purchaseInvoices.number }).from(s.purchaseInvoices).where(and(eq(s.purchaseInvoices.clientId, client.id),
        eq(s.purchaseInvoices.partnerId, partner.id), eq(s.purchaseInvoices.supplierNumber, d.number), ne(s.purchaseInvoices.status, "voided")));
      if (has) { inc(counts, "purchases_existing"); continue; }
      const ls = d.lines.map((l, i) => {
        const v = vatOf(l.vatPct, false, l.vatCode);
        const c = calcLine({ qty: l.qty, unitPrice: mk(l.unitPrice).toNumber(), discountPct: l.discountPct, vatRatePct: l.vatPct });
        return { lineNo: i + 1, itemId: itemId(l.itemCode, d.ref), description: l.description.slice(0, 500), unit: l.unit, qty: d4(l.qty),
          unitPrice: d4(mk(l.unitPrice)), discountPct: d2(l.discountPct), vatRateId: v.id, vatRatePct: v.pct, netAmount: c.netAmount, vatAmount: c.vatAmount };
      });
      const t = calcTotals(ls.map((l) => ({ ...l, unitNet: "0" })));
      const [net, vat, gross] = [d2(mk(d.net)), d2(mk(d.vat)), d2(mk(d.gross))];
      if (t.grossTotal !== gross) out.push(`${d.ref}: пресметано ${t.grossTotal}, во документот ${gross} – се чуваат износите од документот.`);
      const [p] = await db.insert(s.purchaseInvoices).values({ clientId: client.id, partnerId: partner.id, year, supplierNumber: d.number,
        issueDate: d.date, receivedDate: d.date, dueDate: d.dueDate, netTotal: net, vatTotal: vat, grossTotal: gross, fixedAmounts: true, source: SOURCE,
        sourceJson: { ref: d.ref, label: data.label, currency: d.currency, amount: d.gross }, note: ((d.note ?? "") + fxNote).trim() || null }).returning();
      for (const l of ls) await db.insert(s.purchaseLines).values({ purchaseInvoiceId: p!.id, ...l });
      const r = await postPurchase(db, p!.id, actor, client.modules.includes("warehouse"));
      for (const f of d.files ?? []) { await addFile(db, p!.id, f.name, Buffer.from(f.data, "base64"), actor.userId); inc(counts, "files_new"); }
      if (d.paid) {
        await createPayment(db, { clientId: client.id, direction: "out", partnerId: partner.id, payDate: d.paid.date, amount: gross, method: d.paid.method,
          note: `${data.label}: платено (${d.paid.method === "card" ? "картичка" : d.paid.method})`, allocations: [{ id: p!.id, amount: gross }] }, actor);
        inc(counts, "payments_new");
      }
      out.push(`${r.number}: ${partner.name} ${d.number} (${d.date}) ${gross}${r.receiptNumber ? `, приемница ${r.receiptNumber}` : ""}${d.paid ? ", платена" : ""}.`);
      inc(counts, "purchases_new");
      continue;
    }

    // izlezna
    const [has] = await db.select({ id: s.invoices.id }).from(s.invoices).where(and(eq(s.invoices.clientId, client.id), eq(s.invoices.number, d.number)));
    if (has) { inc(counts, "sales_existing"); continue; }
    const ls = d.lines.map((l, i) => {
      const v = vatOf(l.vatPct, true, l.vatCode);
      const c = calcLine({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, vatRatePct: l.vatPct });
      return { lineNo: i + 1, itemId: itemId(l.itemCode, d.ref), description: l.description.slice(0, 500), unit: l.unit, qty: new Decimal(l.qty).toFixed(3),
        unitPrice: d4(l.unitPrice), discountPct: d2(l.discountPct), vatRateId: v.id, vatRatePct: v.pct, netAmount: c.netAmount, vatAmount: c.vatAmount, priceSource: "Excel" };
    });
    const t = calcTotals(ls.map((l) => ({ ...l, unitNet: "0" })));
    if (t.grossTotal !== d2(d.gross)) out.push(`${d.number}: пресметано ${t.grossTotal}, во документот ${d2(d.gross)} – се чуваат износите од документот.`);
    const seqNo = await nextSeq(year);
    const [row] = await db.insert(s.invoices).values({ clientId: client.id, partnerId: partner.id, docType: "INV", year, issueDate: d.date,
      supplyDate: d.supplyDate ?? d.date, dueDate: d.dueDate, paymentMethod: "bank", source: SOURCE, createdBy: actor.userId,
      note: ((d.note ? d.note + " " : "") + `Пренесена од ${data.label} (${d.ref}); издадена надвор од е-Фактура, не се праќа кон УЈП.`) }).returning();
    for (const l of ls) await db.insert(s.invoiceLines).values({ invoiceId: row!.id, ...l });
    await db.update(s.invoices).set({ status: "issued", seqNo, number: d.number, netTotal: d2(d.net), vatTotal: d2(d.vat), grossTotal: d2(d.gross),
      payableAmount: d2(d.gross), lineCount: ls.length, issuedBy: actor.userId, issuedAt: new Date(`${d.date}T12:00:00Z`),
      sellerName: client.name, sellerEdb: client.edb, sellerVatNumber: client.vatNumber, sellerAddress: client.address, sellerCity: client.city,
      sellerIban: client.iban, sellerBank: client.bankName, buyerName: partner.name, buyerEdb: partner.edb, buyerVatNumber: partner.vatNumber,
      buyerAddress: partner.address, buyerCity: partner.city, buyerCountry: partner.country,
      statusMessage: `Пренесена од ${data.label} – надвор од е-Фактура` }).where(eq(s.invoices.id, row!.id));
    let stockNo = "";
    if (client.modules.includes("warehouse")) {
      const goods = ls.filter((l) => l.itemId && (s.STOCK_ITEM_TYPES as readonly string[]).includes([...items.values()].find((i) => i.id === l.itemId)!.type));
      if (goods.length) {
        const wh = (await defaultWarehouse(db, client.id)).id;
        const r = await postStockDoc(db, { clientId: client.id, kind: "issue", warehouseId: wh, docDate: d.supplyDate ?? d.date, invoiceId: row!.id,
          note: `${d.number}, ${partner.name}`, createdBy: actor.userId, moves: goods.map((l) => ({ warehouseId: wh, itemId: l.itemId!, qty: `-${l.qty}` })) });
        stockNo = `, испратница ${r.doc.number}`;
        for (const w of r.warnings) { out.push(`  ! ${d.number}: ${w}`); inc(counts, "stock_warnings"); }
      }
    }
    out.push(`${d.number}: ${partner.name} (${d.date}) ${d2(d.gross)}${stockNo}.`);
    inc(counts, "sales_new");
  }
  // izvodi: po dokumentite (uplatata moze da e pred fakturata - avans)
  const own = clientOwnAccounts(client);
  for (const st of [...data.statements].sort((a, b) => a.date.localeCompare(b.date) || Number(a.no) - Number(b.no))) {
    const acc = mkAccount(st.account);
    if (own.size && !own.has(normAccount(acc))) throw new Error(`Извод ${st.no}: сметката ${acc} не е сметка на ${client.name}.`);
    const sumIn = st.lines.filter((l) => l.direction === "in").reduce((a, l) => a.plus(l.amount), new Decimal(0));
    const sumOut = st.lines.filter((l) => l.direction === "out").reduce((a, l) => a.plus(l.amount), new Decimal(0));
    if (!new Decimal(st.opening).plus(sumIn).minus(sumOut).eq(st.closing)) throw new Error(`Извод ${st.no}: почетна + прилив - одлив не е нова состојба.`);
    const [has] = await db.select({ id: s.bankStatements.id }).from(s.bankStatements).where(and(eq(s.bankStatements.clientId, client.id),
      eq(s.bankStatements.ownAccount, acc), eq(s.bankStatements.statementNo, st.no), eq(s.bankStatements.statementDate, st.date), isNull(s.bankStatements.voidedAt)));
    if (has) { inc(counts, "statements_existing"); continue; }
    const [row] = await db.insert(s.bankStatements).values({ clientId: client.id, format: "stb-pdf", ownAccount: acc, statementNo: st.no, statementDate: st.date,
      openingBalance: d2(st.opening), closingBalance: d2(st.closing), fileName: st.fileName.slice(0, 200), importedBy: actor.userId,
      fileHash: createHash("sha256").update(JSON.stringify(st)).digest("hex") }).returning();
    const open: string[] = [];
    for (const l of st.lines) {
      const [bl] = await db.insert(s.bankStatementLines).values({ statementId: row!.id, clientId: client.id, lineNo: l.lineNo, lineKey: l.key, direction: l.direction,
        amount: d2(l.amount), valueDate: st.date, counterpartyName: l.name || null, counterpartyAccount: l.account || null, paymentCode: l.paymentCode || null,
        purpose: l.purpose || null }).returning();
      if (l.category) { await setCategory(db, client.id, bl!.id, l.category, "manual"); inc(counts, "lines_categorized"); continue; }
      if (!l.book) { open.push(`${l.lineNo} (${l.name} ${d2(l.amount)})`); inc(counts, "lines_open"); continue; }
      const partner = await partnerOf({ kind: l.direction === "in" ? "sale" : "purchase", partner: l.book.partner } as DocT);
      const allocs: { id: number; amount: number }[] = [];
      for (const a of l.book.invoices) {
        const [doc] = l.direction === "in"
          ? await db.select({ id: s.invoices.id }).from(s.invoices).where(and(eq(s.invoices.clientId, client.id), eq(s.invoices.number, a.number)))
          : await db.select({ id: s.purchaseInvoices.id }).from(s.purchaseInvoices).where(and(eq(s.purchaseInvoices.clientId, client.id),
            eq(s.purchaseInvoices.partnerId, partner.id), eq(s.purchaseInvoices.supplierNumber, a.number), ne(s.purchaseInvoices.status, "voided")));
        if (!doc) throw new Error(`Извод ${st.no}, ставка ${l.lineNo}: документот ${a.number} не е внесен.`);
        allocs.push({ id: doc.id, amount: a.amount });
      }
      await bookLine(db, client.id, bl!.id, { partnerId: partner.id, allocations: allocs }, actor);
      inc(counts, "lines_booked");
      if (!allocs.length) out.push(`  i Извод ${st.no}/${l.lineNo}: ${partner.name} ${d2(l.amount)} – без документ (нераспоредено)${l.note ? `: ${l.note}` : ""}.`);
      else if (l.note) out.push(`  i Извод ${st.no}/${l.lineNo}: ${l.note}`);
    }
    out.push(`Извод ${st.no} од ${st.date}: ${st.lines.length} ставки, нова состојба ${d2(st.closing)}${open.length ? `; отворени: ${open.join(", ")}` : ""}.`);
    inc(counts, "statements_new");
  }

  // brojacot za godinata ne smee da dodeli vekje iskoristen reden broj
  for (const [year, n] of seqOf) {
    await db.insert(s.counters).values({ clientId: client.id, docType: "INV", year, lastNo: n })
      .onConflictDoUpdate({ target: [s.counters.clientId, s.counters.docType, s.counters.year], set: { lastNo: sql`greatest(${s.counters.lastNo}, ${n})` } });
  }

  // zaliha na krajot
  if (client.modules.includes("warehouse")) {
    const bal = await db.select({ code: s.items.code, name: s.items.name, qty: s.stockBalances.qty, value: s.stockBalances.value }).from(s.stockBalances)
      .innerJoin(s.items, eq(s.items.id, s.stockBalances.itemId)).where(and(eq(s.stockBalances.clientId, client.id), ne(s.stockBalances.qty, "0")))
      .orderBy(s.items.code);
    out.push("", "Залиха по увозот (шифра, количина, вредност):");
    for (const b of bal) out.push(`  ${b.code.padEnd(18)} ${new Decimal(b.qty).toFixed(0).padStart(4)} ${new Decimal(b.value).toFixed(2).padStart(12)}  ${b.name.slice(0, 50)}`);
  }
  return { lines: out, counts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const file = args[0], edb = arg("--client"), user = arg("--user");
  if (!file || !edb || !user) { console.error("Upotreba: node dist/tools/import-docs.js <datoteka.json | -> --client <EDB> --user <e-poshta> [--dry-run]"); process.exit(1); }
  const { connect } = await import("../db/client.js");
  const { db, sql: pg, migrate } = connect(process.env.DATABASE_URL!, process.env.DATABASE_PASSWORD_FILE);
  await migrate();
  const json = readFileSync(file === "-" ? 0 : file, "utf8");
  console.log(`Datoteka: ${file}\nSHA-256:  ${createHash("sha256").update(json).digest("hex")}\n`);
  const DRY = Symbol("dry");
  try {
    await db.transaction(async (tx) => {
      const r = await importDocs(tx as unknown as Db, json, edb, user);
      r.lines.forEach((l) => console.log(l));
      console.log("\nZapisi:", JSON.stringify(r.counts));
      if (args.includes("--dry-run")) throw DRY;
    });
    console.log("\nUVOZOT E ZAPISAN.");
  } catch (e) {
    if (e === DRY) console.log("\nPROBA (--dry-run): nisto ne e zapisano.");
    else { console.error("\n!! UVOZOT E PREKINAT, nisto ne e zapisano:", (e as Error).message); process.exitCode = 1; }
  } finally {
    await pg.end({ timeout: 5 });
  }
}
