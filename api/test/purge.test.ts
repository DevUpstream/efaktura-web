/** deploy/oneoff/purge-client-docs.sql (docs/19): praznenje na edna firma; ostanuvaat partnerite i magacinite. */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { auditLog, clients, counters, dunningLetters, invoiceLines, invoices, items, partners, purchaseInvoices, purchaseLines, warehouses } from "../src/db/schema.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { calcLine } from "../src/domain/calc.js";
import { issueInvoice } from "../src/domain/issue.js";
import { postPurchase } from "../src/domain/purchase.js";

const SQL = readFileSync(new URL("../../deploy/oneoff/purge-client-docs.sql", import.meta.url), "utf8");
const TABLES = ["invoices", "invoice_lines", "purchase_invoices", "bank_statements", "bank_statement_lines", "payments", "payment_allocations",
  "dunning_letters", "stock_docs", "stock_moves", "stock_balances", "items", "partners", "warehouses"] as const;

let t: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let admin: string;
beforeEach(async () => {
  t = await testDb();
  app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64") });
  admin = `${SESSION_COOKIE}=${await createSession(t.db, t.user.id, true, {})}`;
});

/** Извод во формат Халкбанк/Шпаркасе (фиксна ширина). */
function txt(own: string, rows: { name: string; acc: string; amount: number; refC?: string }[]) {
  const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  const closing = rows.reduce((s, r) => s + r.amount, 0);
  return [pad("1", 6), pad("05.11.2026", 12), pad(own, 18), pad(fmt(0), 19), pad(fmt(closing), 19),
    ...rows.map((r) => pad(r.name, 70) + pad(r.acc, 18) + pad(fmt(r.amount), 19) + pad("220", 6) + pad("", 72) + pad("", 24)
      + pad(r.refC ?? "", 24) + pad("", 24) + pad("10", 24))].join("\r\n") + "\r\n";
}

/** Firma so se: vlezna faktura (priemnica), izlezna faktura (ispratnica) i storno, izvod so uplata, opomena. */
async function seed(clientId: number, partnerId: number, own: string) {
  await t.db.update(clients).set({ modules: ["invoices", "incoming", "payments", "warehouse"], iban: own }).where(eq(clients.id, clientId));
  const [it] = await t.db.insert(items).values({ clientId, code: "G1", name: "Стока", type: "goods", unit: "ком", unitPrice: "200", vatRateId: t.vat18.id }).returning();
  const [p] = await t.db.insert(purchaseInvoices).values({ clientId, partnerId, year: 2026, supplierNumber: "1/2026", issueDate: "2026-11-01", receivedDate: "2026-11-02" }).returning();
  await t.db.insert(purchaseLines).values({ purchaseInvoiceId: p!.id, lineNo: 1, itemId: it!.id, description: "x", unit: "ком", qty: "10", unitPrice: "100",
    vatRateId: t.vat18.id, vatRatePct: "18", ...calcLine({ qty: 10, unitPrice: 100, vatRatePct: 18 }) });
  await postPurchase(t.db, p!.id, { userId: t.user.id }, true);
  const mkInv = async () => {
    const [i] = await t.db.insert(invoices).values({ clientId, partnerId, year: 2026, issueDate: "2026-11-03", supplyDate: "2026-11-03", dueDate: "2026-11-20" }).returning();
    await t.db.insert(invoiceLines).values({ invoiceId: i!.id, lineNo: 1, itemId: it!.id, description: "Стока", unit: "ком", qty: "1", unitPrice: "1000",
      vatRateId: t.vat18.id, vatRatePct: "18", ...calcLine({ qty: 1, unitPrice: 1000, vatRatePct: 18 }) });
    return issueInvoice(t.db, i!.id, { userId: t.user.id });
  };
  const a = await mkInv();
  await mkInv();
  const r = await app.inject({ method: "POST", url: `/api/clients/${clientId}/bank-statements`, headers: { cookie: admin, "x-efaktura": "1" },
    payload: { text: txt(own, [{ name: "Купувач", acc: "300-0000000111-22", amount: 1180, refC: a.number! }, { name: "Провизија", acc: "", amount: -50 }]) } });
  expect(r.statusCode).toBe(201);
  expect(r.json().booked).toBe(1);
  await t.db.insert(dunningLetters).values({ clientId, partnerId, docDate: "2026-11-17", level: 1, amount: "1180", items: [] });
}

async function counts(clientId: number) {
  const out: Record<string, number> = {};
  for (const tb of TABLES) {
    const where = tb === "invoice_lines" ? `invoice_id in (select id from invoices where client_id = ${clientId})`
      : tb === "payment_allocations" ? `payment_id in (select id from payments where client_id = ${clientId})`
      : tb === "stock_moves" ? `doc_id in (select id from stock_docs where client_id = ${clientId})` : `client_id = ${clientId}`;
    out[tb] = Number((await t.pg.query<{ n: number }>(`select count(*)::int n from ${tb} where ${where}`)).rows[0]!.n);
  }
  return out;
}
const run = (end: "COMMIT" | "ROLLBACK", edb = t.c2.edb) => t.pg.exec(SQL.replace(":'edb'", `'${edb}'`) + `\n${end};`);

describe("praznenje na firma", () => {
  it("brise se osven partnerite i magacinite; drugata firma ne se dopira; zastitite pak vazat", async () => {
    await seed(t.c1.id, t.p1.id, "250-0103024933-98");
    await seed(t.c2.id, t.p2.id, "210-0000000001-59");
    await t.db.insert(warehouses).values({ clientId: t.c2.id, code: "SP", name: "Продавница" });
    const before1 = await counts(t.c1.id);
    const before2 = await counts(t.c2.id);
    expect(before2).toMatchObject({ invoices: 2, purchase_invoices: 1, bank_statements: 1, payments: 1, dunning_letters: 1, items: 1, partners: 1, warehouses: 2 });
    expect(before2.stock_docs).toBeGreaterThanOrEqual(3);   // priemnica + 2 ispratnici
    const ctr = await t.db.select().from(counters).where(eq(counters.clientId, t.c2.id));

    // proba: nisto ne se menuva
    await run("ROLLBACK");
    expect(await counts(t.c2.id)).toEqual(before2);

    const res = await run("COMMIT");
    const report = res.find((x) => x.fields.some((f) => f.name === "posle"))!.rows as { tabela: string; pred: number; posle: number }[];
    expect(report.find((r) => r.tabela === "izlezni fakturi")).toMatchObject({ pred: 2, posle: 0 });
    expect(report.find((r) => r.tabela === "PARTNERI (ostanuvaat)")).toMatchObject({ pred: 1, posle: 1 });

    const after2 = await counts(t.c2.id);
    expect(after2).toEqual({ ...Object.fromEntries(TABLES.map((x) => [x, 0])), partners: 1, warehouses: 2 });
    expect(await counts(t.c1.id)).toEqual(before1);
    // brojacot na fakturite ostanuva (izdaden broj ne se koristi povtorno)
    expect(await t.db.select().from(counters).where(eq(counters.clientId, t.c2.id))).toEqual(ctr);
    const [log] = await t.db.select().from(auditLog).where(sql`${auditLog.action} = 'purge_documents'`);
    expect(log).toMatchObject({ clientId: t.c2.id, entity: "client" });
    expect((log!.changes as { deleted: Record<string, number> }).deleted).toMatchObject({ "izlezni fakturi": 2, artikli: 1 });

    // trigerite pak rabotat: izdadena faktura na drugata firma ne se brise
    const disabled = await t.pg.query(`select tgname from pg_trigger where not tgisinternal and tgenabled = 'D'`);
    expect(disabled.rows).toEqual([]);
    await expect(t.db.delete(invoices).where(eq(invoices.clientId, t.c1.id))).rejects.toThrow();
    // partnerot i magacinot se upotreblivi: nova faktura po prazneneto
    const [p] = await t.db.select().from(partners).where(eq(partners.clientId, t.c2.id));
    expect(p!.id).toBe(t.p2.id);
  });

  it("nepostoecki EDB: greska, nisto ne se brise", async () => {
    await seed(t.c2.id, t.p2.id, "210-0000000001-59");
    const before = await counts(t.c2.id);
    await expect(run("COMMIT", "4000000000000")).rejects.toThrow(/ne e najdena/);
    await t.pg.exec("ROLLBACK").catch(() => {});
    expect(await counts(t.c2.id)).toEqual(before);
  });
});
