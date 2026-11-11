/**
 * Uvoz na vlezni fakturi, plakjanja kon niv i prilozi od ERPNext (scripts/erpnext-export.py --purchases / --files-*), docs/11.
 *
 *   node dist/tools/import-erpnext-docs.js <datoteka.json | -> --client <EDB> --user <e-poshta> [--dry-run]
 *
 * - erpnext-purchases/1: fakturite se vnesuvaat i se KNIZAT BEZ ZALIHA (zalihata e od popis), po red na datumot na prием
 *   (brojot vo knigata na vlezni fakturi ide po redosled). Zbirovite se od ERPNext (fixed_amounts).
 *   Plakjanjata od ERPNext se vnesuvaat so istiot raspored; ostatokot ostanuva otvoren (se zatvora so izvodi).
 * - erpnext-files/1: prilozi kon vekje vnesenite fakturi (po ERPNext brojot).
 * - EDNA transakcija; povtoren uvoz preskoknuva se shto vekje e vneseno (source = erpnext, ERPNext broj).
 * - Vleznite fakturi NIKOGASH ne odat kon UJP (kon UJP se prakjaat samo izlezni).
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { z } from "zod";
import * as s from "../db/schema.js";
import type { Db } from "../db/types.js";
import { normalizeName } from "../domain/bank-import.js";
import { postPurchase } from "../domain/purchase.js";
import { createPayment } from "../domain/payments.js";
import { addFile } from "../domain/ujp-import.js";

const Line = z.object({ itemCode: z.string().nullable(), description: z.string().min(1), unit: z.string().min(1).max(10), qty: z.number().positive(),
  unitPrice: z.number().nonnegative(), net: z.number().nonnegative(), vatPct: z.number() });
const Purchase = z.object({ ref: z.string(), supplierRef: z.string(), supplierEdb: z.string().nullable(), supplierName: z.string(), supplierNumber: z.string().min(1).max(60),
  issueDate: z.string().date(), receivedDate: z.string().date(), dueDate: z.string().date().nullable(), net: z.number(), vat: z.number(), gross: z.number(),
  payable: z.number(), note: z.string().nullable().optional(), lines: z.array(Line).min(1) });
const Payment = z.object({ ref: z.string(), supplierRef: z.string(), date: z.string().date(), amount: z.number().positive(), reference: z.string().nullable(),
  allocations: z.array(z.object({ ref: z.string(), amount: z.number().positive() })) });
const Purchases = z.object({ format: z.literal("erpnext-purchases/1"), exportedAt: z.string(), company: z.object({ edb: z.string() }),
  purchases: z.array(Purchase), payments: z.array(Payment) });
const Files = z.object({ format: z.literal("erpnext-files/1"), company: z.object({ edb: z.string() }),
  files: z.array(z.object({ purchaseRef: z.string(), fileName: z.string(), data: z.string() })) });

export interface DocsReport { lines: string[]; counts: Record<string, number> }
const d4 = (n: number | Decimal) => new Decimal(n).toDecimalPlaces(4).toFixed(4);
const d2 = (n: number | Decimal) => new Decimal(n).toDecimalPlaces(2).toFixed(2);

async function context(db: Db, clientEdb: string, fileEdb: string, userEmail: string) {
  if (fileEdb !== clientEdb) throw new Error(`Датотеката е од фирма со ЕДБ ${fileEdb}, а е избрана ${clientEdb}.`);
  const [client] = await db.select().from(s.clients).where(eq(s.clients.edb, clientEdb));
  if (!client) throw new Error(`Нема фирма со ЕДБ ${clientEdb}.`);
  const [user] = await db.select().from(s.users).where(sql`lower(${s.users.email}) = ${userEmail.toLowerCase()}`);
  if (!user) throw new Error(`Нема корисник ${userEmail}.`);
  return { client, actor: { userId: user.id, ip: "import-erpnext" } };
}

/** ERPNext broj -> nasha vlezna faktura (vekje vnesena). */
async function imported(db: Db, clientId: number) {
  const rows = await db.select({ id: s.purchaseInvoices.id, ref: sql<string>`${s.purchaseInvoices.sourceJson}->>'erpnext'`, number: s.purchaseInvoices.number })
    .from(s.purchaseInvoices).where(and(eq(s.purchaseInvoices.clientId, clientId), eq(s.purchaseInvoices.source, "erpnext")));
  return new Map(rows.map((r) => [r.ref, r]));
}

export async function importErpPurchases(db: Db, json: string, clientEdb: string, userEmail: string): Promise<DocsReport> {
  const data = Purchases.parse(JSON.parse(json));
  const { client, actor } = await context(db, clientEdb, data.company.edb, userEmail);
  const lines: string[] = [`Фирма: ${client.name}. Извоз од ERPNext: ${data.exportedAt}.`];
  const counts: Record<string, number> = { purchases_new: 0, purchases_existing: 0, purchases_skipped: 0, payments_new: 0, payments_existing: 0, payments_skipped: 0 };

  // DDV: 18/5 -> edinstvena aktivna ne-osloboduvacka stapka; 0 -> "NP" (dobavuvacot ne e DDV obvrznik)
  const today = new Date().toISOString().slice(0, 10);
  const rates = await db.select().from(s.vatRates).where(and(eq(s.vatRates.isActive, true), lte(s.vatRates.validFrom, today), or(isNull(s.vatRates.validTo), gte(s.vatRates.validTo, today))));
  const vat = new Map<number, { id: number; pct: string }>();
  for (const pct of new Set(data.purchases.flatMap((p) => p.lines.map((l) => l.vatPct)))) {
    const m = pct === 0 ? rates.filter((r) => r.code === "NP") : rates.filter((r) => !r.isExempt && Number(r.ratePct) === pct);
    if (m.length !== 1) throw new Error(`ДДВ ${pct}%: ${m.length ? "повеќе" : "нема"} соодветни стапки во апликацијата.`);
    vat.set(pct, { id: m[0]!.id, pct: m[0]!.ratePct });
  }

  const partners = await db.select().from(s.partners).where(eq(s.partners.clientId, client.id));
  const byEdb = new Map(partners.filter((p) => p.edb).map((p) => [p.edb!, p]));
  const byName = new Map(partners.map((p) => [normalizeName(p.name), p]));
  const items = new Map((await db.select({ id: s.items.id, code: s.items.code }).from(s.items).where(eq(s.items.clientId, client.id))).map((i) => [i.code.toUpperCase(), i.id]));
  const supplierOf = new Map<string, number>();
  const done = await imported(db, client.id);

  const other = await db.select({ n: sql<number>`count(*)::int` }).from(s.purchaseInvoices)
    .where(and(eq(s.purchaseInvoices.clientId, client.id), sql`${s.purchaseInvoices.source} <> 'erpnext'`, eq(s.purchaseInvoices.status, "posted")));
  if (other[0]!.n) lines.push(`Внимание: веќе има ${other[0]!.n} прокнижени влезни фактури што не се од ERPNext; бројот во книгата продолжува по нив.`);

  for (const p of [...data.purchases].sort((a, b) => a.receivedDate.localeCompare(b.receivedDate) || a.ref.localeCompare(b.ref))) {
    const partner = (p.supplierEdb ? byEdb.get(p.supplierEdb) : undefined) ?? byName.get(normalizeName(p.supplierName));
    if (!partner) { lines.push(`${p.ref}: добавувачот „${p.supplierName}“ не постои – прескокната.`); inc(counts, "purchases_skipped"); continue; }
    supplierOf.set(p.supplierRef, partner.id);
    if (done.has(p.ref)) { inc(counts, "purchases_existing"); continue; }
    if (!partner.isSupplier || !partner.isActive) await db.update(s.partners).set({ isSupplier: true, isActive: true }).where(eq(s.partners.id, partner.id));
    const [dup] = await db.select({ n: s.purchaseInvoices.number }).from(s.purchaseInvoices).where(and(eq(s.purchaseInvoices.clientId, client.id),
      eq(s.purchaseInvoices.partnerId, partner.id), eq(s.purchaseInvoices.supplierNumber, p.supplierNumber), sql`${s.purchaseInvoices.status} <> 'voided'`));
    if (dup) { lines.push(`${p.ref}: фактура ${p.supplierNumber} од ${partner.name} е веќе внесена (${dup.n ?? "нацрт"}) – прескокната.`); inc(counts, "purchases_skipped"); continue; }

    const [pi] = await db.insert(s.purchaseInvoices).values({ clientId: client.id, partnerId: partner.id, year: Number(p.receivedDate.slice(0, 4)),
      supplierNumber: p.supplierNumber, issueDate: p.issueDate, receivedDate: p.receivedDate, dueDate: p.dueDate,
      netTotal: d2(p.net), vatTotal: d2(p.vat), grossTotal: d2(p.gross), payableAmount: d2(p.payable) === d2(p.gross) ? null : d2(p.payable),
      note: `Пренесено од ERPNext (${p.ref}).${p.note ? ` ${p.note}` : ""}`, source: "erpnext", fixedAmounts: true, sourceJson: { erpnext: p.ref }, createdBy: actor.userId }).returning();
    let n = 0;
    for (const l of p.lines) {
      const v = vat.get(l.vatPct)!;
      await db.insert(s.purchaseLines).values({ purchaseInvoiceId: pi!.id, lineNo: ++n, itemId: l.itemCode ? items.get(l.itemCode.toUpperCase()) ?? null : null,
        description: l.description.slice(0, 500), unit: l.unit, qty: d4(l.qty), unitPrice: d4(l.unitPrice), vatRateId: v.id, vatRatePct: v.pct,
        netAmount: d4(l.net), vatAmount: d4(new Decimal(l.net).times(l.vatPct).div(100)) });
    }
    const posted = await postPurchase(db, pi!.id, actor, false);
    done.set(p.ref, { id: pi!.id, ref: p.ref, number: posted.number });
    if (p.note) lines.push(`${posted.number} (${p.ref}): ${p.note}`);
    inc(counts, "purchases_new");
  }

  const paidRefs = new Set((await db.select({ r: s.payments.note }).from(s.payments)
    .where(and(eq(s.payments.clientId, client.id), sql`${s.payments.note} like 'ERPNext %'`))).map((r) => r.r));
  for (const pay of data.payments) {
    const note = `ERPNext ${pay.ref}`;
    if (paidRefs.has(note)) { inc(counts, "payments_existing"); continue; }
    const partnerId = supplierOf.get(pay.supplierRef);
    const allocs = pay.allocations.map((a) => ({ id: done.get(a.ref)?.id, amount: a.amount }));
    if (!partnerId || allocs.some((a) => !a.id)) { lines.push(`${pay.ref}: добавувачот или фактурата не е внесена – плаќањето е прескокнато.`); inc(counts, "payments_skipped"); continue; }
    try {
      await db.transaction(async (tx) => {
        await createPayment(tx as unknown as Db, { clientId: client.id, direction: "out", partnerId, payDate: pay.date, amount: pay.amount, method: "bank",
          reference: pay.reference, note, allocations: allocs.map((a) => ({ id: a.id!, amount: a.amount })) }, actor);
      });
      inc(counts, "payments_new");
    } catch (e) { lines.push(`${pay.ref}: ${(e as Error).message} – прескокнато.`); inc(counts, "payments_skipped"); }
  }
  return { lines, counts };
}

export async function importErpFiles(db: Db, json: string, clientEdb: string, userEmail: string): Promise<DocsReport> {
  const data = Files.parse(JSON.parse(json));
  const { client, actor } = await context(db, clientEdb, data.company.edb, userEmail);
  const lines: string[] = []; const counts: Record<string, number> = { files_new: 0, files_existing: 0, files_skipped: 0 };
  const done = await imported(db, client.id);
  for (const f of data.files) {
    const pi = done.get(f.purchaseRef);
    if (!pi) { lines.push(`${f.fileName}: фактурата ${f.purchaseRef} не е внесена – прескокнат.`); inc(counts, "files_skipped"); continue; }
    const buf = Buffer.from(f.data, "base64");
    const sha = createHash("sha256").update(buf).digest("hex");
    const [has] = await db.select({ id: s.purchaseFiles.id }).from(s.purchaseFiles).where(and(eq(s.purchaseFiles.purchaseInvoiceId, pi.id), eq(s.purchaseFiles.sha256, sha)));
    if (has) { inc(counts, "files_existing"); continue; }
    try { await addFile(db, pi.id, f.fileName, buf, actor.userId); inc(counts, "files_new"); }
    catch (e) { lines.push(`${pi.number} ${f.fileName}: ${(e as Error).message} – прескокнат.`); inc(counts, "files_skipped"); }
  }
  return { lines, counts };
}

function inc(c: Record<string, number>, k: string) { c[k] = (c[k] ?? 0) + 1; }

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const file = args[0], edb = arg("--client"), user = arg("--user");
  if (!file || !edb || !user) { console.error("Upotreba: node dist/tools/import-erpnext-docs.js <datoteka.json | -> --client <EDB> --user <e-poshta> [--dry-run]"); process.exit(1); }
  const { connect } = await import("../db/client.js");
  const { db, sql: pg, migrate } = connect(process.env.DATABASE_URL!, process.env.DATABASE_PASSWORD_FILE);
  await migrate();
  const json = readFileSync(file === "-" ? 0 : file, "utf8");
  console.log(`Datoteka: ${file}\nSHA-256:  ${createHash("sha256").update(json).digest("hex")}\n`);
  const DRY = Symbol("dry");
  try {
    await db.transaction(async (tx) => {
      const fmt = (JSON.parse(json) as { format?: string }).format;
      const r = fmt === "erpnext-files/1" ? await importErpFiles(tx as unknown as Db, json, edb, user) : await importErpPurchases(tx as unknown as Db, json, edb, user);
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
