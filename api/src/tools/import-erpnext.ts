/**
 * Uvoz na shifrarnici od ERPNext (izvoz od scripts/erpnext-export.py) vo postoecka firma (docs/11).
 *
 *   node dist/tools/import-erpnext.js <izvoz.json | -> --client <EDB> [--dry-run]
 *
 * - EDNA transakcija: ili se, ili nisto. --dry-run pravi se i na krajot vrakja nazad.
 * - Firmata mora da postoi i nejziniot EDB mora da e ist so EDB vo izvozot.
 * - Postoecki partner (ist EDB; bez EDB: ist naziv) ne se menuva: samo se dodavaat ulogi i se popolnuvaat PRAZNI polinja.
 * - Postoecki artikl (ista shifra) ne se menuva (cenata ostanuva).
 * - Smetka shto e nasha ili vekje e na drug partner ne se dodava (se pishuva vo izveshtajot).
 * - Mozhe da se pushti povtorno: vtoriot pat nisto novo ne vnesuva.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { and, eq, lte, isNull, or, gte } from "drizzle-orm";
import { z } from "zod";
import * as s from "../db/schema.js";
import type { Db } from "../db/types.js";
import { normalizeName } from "../domain/bank-import.js";
import { clientOwnAccounts } from "../domain/statements.js";

const opt = (max: number) => z.string().trim().max(max).nullable().transform((v) => v || null);
const Contact = z.object({ name: z.string().trim().min(1).max(200), role: opt(120), phone: opt(50), mobile: opt(50), email: opt(254), isPrimary: z.boolean() });
const Partner = z.object({
  ref: z.string(), name: z.string().trim().min(1), edb: z.string().regex(/^\d{13}$/).nullable(), vatNumber: opt(20), country: z.string().length(2),
  address: z.string().nullable(), city: z.string().nullable(), postalCode: opt(10), email: opt(254), phone: opt(50),
  isCustomer: z.boolean(), isSupplier: z.boolean(), isActive: z.boolean(), accounts: z.array(z.string().regex(/^\d{15}$/)), contacts: z.array(Contact),
});
const Item = z.object({
  ref: z.string(), code: z.string().trim().min(1).max(30), name: z.string().trim().min(1), type: z.enum(["goods", "service"]), unit: z.string().trim().min(1).max(10),
  vatPct: z.number(), price: z.number().nonnegative().nullable(), isActive: z.boolean(),
});
const Export = z.object({
  format: z.literal("erpnext-masterdata/1"), exportedAt: z.string(), company: z.object({ name: z.string(), edb: z.string() }),
  partners: z.array(Partner), items: z.array(Item), warnings: z.array(z.string()),
});

export interface ErpImportReport { lines: string[]; counts: Record<string, number> }

export async function importErpNext(db: Db, json: string, clientEdb: string): Promise<ErpImportReport> {
  const data = Export.parse(JSON.parse(json));
  const lines: string[] = [];
  const counts: Record<string, number> = { partners_new: 0, partners_updated: 0, partners_same: 0, accounts: 0, contacts: 0, items_new: 0, items_existing: 0 };
  const inc = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };

  if (data.company.edb !== clientEdb) throw new Error(`Изводот е од фирма со ЕДБ ${data.company.edb}, а е избрана ${clientEdb}.`);
  const [client] = await db.select().from(s.clients).where(eq(s.clients.edb, clientEdb));
  if (!client) throw new Error(`Нема фирма со ЕДБ ${clientEdb} во апликацијата.`);
  lines.push(`Фирма: ${client.name} (${client.invoicePrefix}). Извоз од ERPNext: ${data.exportedAt}.`);
  data.warnings.forEach((w) => lines.push(`ERPNext: ${w}`));

  // --- DDV stapki: edinstvena aktivna, ne-osloboduvacka, vazhecka denes
  const today = new Date().toISOString().slice(0, 10);
  const rates = await db.select().from(s.vatRates).where(and(eq(s.vatRates.isActive, true), eq(s.vatRates.isExempt, false),
    lte(s.vatRates.validFrom, today), or(isNull(s.vatRates.validTo), gte(s.vatRates.validTo, today))));
  const vatId = new Map<number, number>();
  for (const pct of new Set(data.items.map((i) => i.vatPct))) {
    const m = rates.filter((r) => Number(r.ratePct) === pct);
    if (m.length !== 1) throw new Error(`ДДВ ${pct}%: ${m.length ? "повеќе" : "нема"} активни стапки во апликацијата (${m.map((r) => r.code).join(", ")}).`);
    vatId.set(pct, m[0]!.id);
  }

  // --- partneri
  const existing = await db.select().from(s.partners).where(eq(s.partners.clientId, client.id));
  const byEdb = new Map(existing.filter((p) => p.edb).map((p) => [p.edb!, p]));
  const byName = new Map(existing.map((p) => [normalizeName(p.name), p]));
  const own = clientOwnAccounts(client);
  const accOwner = new Map((await db.select().from(s.partnerAccounts).where(eq(s.partnerAccounts.clientId, client.id))).map((a) => [a.account, a.partnerId]));
  const nameOf = new Map(existing.map((p) => [p.id, p.name]));

  for (const p of data.partners) {
    // ist EDB; inaku ist naziv (ako edniot nema EDB)
    const sameName = byName.get(normalizeName(p.name));
    let row = (p.edb ? byEdb.get(p.edb) : undefined) ?? (sameName && (!sameName.edb || !p.edb) ? sameName : undefined);
    if (row) {
      const patch: Partial<typeof s.partners.$inferInsert> = {};
      if (p.edb && !row.edb) patch.edb = p.edb;
      if (p.isCustomer && !row.isCustomer) patch.isCustomer = true;
      if (p.isSupplier && !row.isSupplier) patch.isSupplier = true;
      for (const k of ["address", "city", "postalCode", "email", "phone", "vatNumber"] as const) if (!row[k] && p[k]) patch[k] = p[k];
      if (Object.keys(patch).length) {
        await db.update(s.partners).set(patch).where(eq(s.partners.id, row.id));
        inc("partners_updated"); lines.push(`Постоечки партнер ${row.name}: дополнето ${Object.keys(patch).join(", ")}.`);
      } else inc("partners_same");
    } else {
      [row] = await db.insert(s.partners).values({ clientId: client.id, name: p.name, edb: p.edb, vatNumber: p.vatNumber, country: p.country,
        address: p.address, city: p.city, postalCode: p.postalCode, email: p.email, phone: p.phone, isCustomer: p.isCustomer, isSupplier: p.isSupplier,
        isActive: p.isActive }).returning();
      inc("partners_new"); nameOf.set(row!.id, row!.name);
      if (row!.edb) byEdb.set(row!.edb, row!); byName.set(normalizeName(row!.name), row!);
    }
    const partnerId = row!.id;

    for (const a of p.accounts) {
      if (own.has(a)) { lines.push(`Сметка ${a} (${p.name}) е наша – прескокната.`); continue; }
      const owner = accOwner.get(a);
      if (owner === partnerId) continue;
      if (owner) { lines.push(`Сметка ${a} (${p.name}) веќе е на ${nameOf.get(owner)} – прескокната.`); continue; }
      await db.insert(s.partnerAccounts).values({ clientId: client.id, partnerId, account: a, source: "manual" });
      accOwner.set(a, partnerId); inc("accounts");
    }

    if (p.contacts.length) {
      const have = await db.select().from(s.partnerContacts).where(eq(s.partnerContacts.partnerId, partnerId));
      let hasPrimary = have.some((c) => c.isPrimary);
      for (const c of p.contacts) {
        if (have.some((h) => h.name.toLowerCase() === c.name.toLowerCase() || (!!c.email && h.email?.toLowerCase() === c.email.toLowerCase()))) continue;
        const isPrimary = c.isPrimary && !hasPrimary; hasPrimary ||= isPrimary;
        await db.insert(s.partnerContacts).values({ partnerId, name: c.name, role: c.role, phone: c.phone, mobile: c.mobile, email: c.email, isPrimary });
        inc("contacts");
      }
    }
  }

  // --- artikli
  const codes = new Set((await db.select({ c: s.items.code }).from(s.items).where(eq(s.items.clientId, client.id))).map((r) => r.c.toUpperCase()));
  let noPrice = 0;
  for (const it of data.items) {
    if (codes.has(it.code.toUpperCase())) { inc("items_existing"); continue; }
    if (it.price === null) noPrice++;
    await db.insert(s.items).values({ clientId: client.id, code: it.code, name: it.name, type: it.type, unit: it.unit,
      unitPrice: (it.price ?? 0).toFixed(4), vatRateId: vatId.get(it.vatPct)!, isActive: it.isActive });
    codes.add(it.code.toUpperCase()); inc("items_new");
  }
  if (counts.items_existing) lines.push(`${counts.items_existing} артикли веќе постојат (иста шифра) – не се менувани.`);
  if (noPrice) lines.push(`${noPrice} нови артикли немаат продажна цена во ERPNext – внесени со цена 0.`);
  return { lines, counts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const file = args[0]; const ci = args.indexOf("--client"); const edb = ci >= 0 ? args[ci + 1] : undefined;
  if (!file || !edb) { console.error("Upotreba: node dist/tools/import-erpnext.js <izvoz.json | -> --client <EDB> [--dry-run]"); process.exit(1); }
  const { connect } = await import("../db/client.js");
  const { db, sql: pg, migrate } = connect(process.env.DATABASE_URL!, process.env.DATABASE_PASSWORD_FILE);
  await migrate();
  const json = readFileSync(file === "-" ? 0 : file, "utf8");
  console.log(`Datoteka: ${file}\nSHA-256:  ${createHash("sha256").update(json).digest("hex")}\n`);
  const DRY = Symbol("dry");
  try {
    await db.transaction(async (tx) => {
      const r = await importErpNext(tx as unknown as Db, json, edb);
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
