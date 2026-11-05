import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { clientAccess, clients, invoiceLines, invoices, partners, paymentAllocations, payments, purchaseInvoices, purchaseLines, users } from "../src/db/schema.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { calcLine } from "../src/domain/calc.js";
import { issueInvoice } from "../src/domain/issue.js";
import { postPurchase } from "../src/domain/purchase.js";
import { findInvoiceNumbers, parseAmount, parseStatement } from "../src/domain/bank-import.js";

let t: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let ana: string;
const actor = () => ({ userId: t.user.id });
beforeEach(async () => {
  t = await testDb();
  app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64") });
  const [a] = await t.db.insert(users).values({ email: "ana@x.mk", displayName: "Ана", provider: "entra", role: "accountant" }).returning();
  await t.db.insert(clientAccess).values({ clientId: t.c1.id, userId: a!.id });
  ana = `${SESSION_COOKIE}=${await createSession(t.db, a!.id, true, {})}`;
  await t.db.update(clients).set({ modules: ["invoices", "incoming", "payments"] }).where(eq(clients.id, t.c1.id));
});
async function call(method: string, url: string, payload?: unknown) {
  const r = await app.inject({ method: method as never, url, payload: payload as never, headers: { cookie: ana, ...(method === "GET" ? {} : { "x-efaktura": "1" }) } });
  return { status: r.statusCode, body: r.body ? r.json() : null };
}
const C = () => `/api/clients/${t.c1.id}`;
async function inv(price: number, over: Partial<typeof invoices.$inferInsert> = {}, sign: 1 | -1 = 1) {
  const [i] = await t.db.insert(invoices).values({ clientId: t.c1.id, partnerId: t.p1.id, year: 2026, issueDate: "2026-10-01", supplyDate: "2026-10-01", dueDate: "2026-10-15", ...over }).returning();
  await t.db.insert(invoiceLines).values({ invoiceId: i!.id, lineNo: 1, description: "У", unit: "ком", qty: "1", unitPrice: String(price), vatRateId: t.vat18.id, vatRatePct: "18",
    ...calcLine({ qty: 1, unitPrice: price, vatRatePct: 18 }, sign) });
  return issueInvoice(t.db, i!.id, actor());
}
async function err(p: Promise<unknown>) { try { await p; return ""; } catch (e) { return ((e as { cause?: Error }).cause ?? (e as Error)).message; } }

describe("otvoreni stavki i uplati", () => {
  it("faktura - knizno odobrenie - uplata = ostanato; zadocneti po starost", async () => {
    const a = await inv(1000);                                      // 1180
    await inv(100, { docType: "OD", relatedInvoiceId: a.id, correctionReason: "Попуст", dueDate: null }, -1);   // -118
    const o = (await call("GET", `${C()}/open-items?direction=in&asOf=2026-11-04`)).body;
    expect(o.items[0]).toMatchObject({ number: "MC-2026-00001", amount: "1180.00", credits: "-118.00", remaining: "1062.00", daysOverdue: 20 });
    expect(o.aging).toMatchObject({ d30: "1062.00", total: "1062.00" });
    const p = await call("POST", `${C()}/payments`, { direction: "in", partnerId: t.p1.id, payDate: "2026-11-04", amount: 1000 });
    expect(p.body).toMatchObject({ allocated: [{ number: "MC-2026-00001", amount: "1000.00" }], unallocated: "0.00" });
    expect((await call("GET", `${C()}/open-items?direction=in`)).body.items[0].remaining).toBe("62.00");
  });

  it("avtomatski od najstarata; preplata ostanuva nerasporedena; podocna raspored", async () => {
    const a = await inv(100, { dueDate: "2026-10-10" });   // 118
    const b = await inv(200, { dueDate: "2026-10-20" });   // 236
    const p = (await call("POST", `${C()}/payments`, { direction: "in", partnerId: t.p1.id, payDate: "2026-11-01", amount: 400 })).body;
    expect(p.allocated.map((x: { amount: string }) => x.amount)).toEqual(["118.00", "236.00"]);
    expect(p.unallocated).toBe("46.00");
    const o = (await call("GET", `${C()}/open-items?direction=in`)).body;
    expect(o.items).toHaveLength(0);
    expect(o.byPartner[0]).toMatchObject({ partnerId: t.p1.id, unallocated: "46.00" });
    const c = await inv(50);   // 59
    expect((await call("POST", `${C()}/payments/${p.id}/allocate`, {})).body.allocated).toEqual([{ id: c.id, amount: "46.00" }]);
    void a; void b;
  });

  it("racen raspored: ne poveke od ostanatoto i od uplatata", async () => {
    const a = await inv(100);   // 118
    expect((await call("POST", `${C()}/payments`, { direction: "in", partnerId: t.p1.id, payDate: "2026-11-01", amount: 100, allocations: [{ id: a.id, amount: 200 }] })).status).toBe(422);
    expect((await call("POST", `${C()}/payments`, { direction: "in", partnerId: t.p1.id, payDate: "2026-11-01", amount: 50, allocations: [{ id: a.id, amount: 60 }] })).status).toBe(422);
    expect((await call("POST", `${C()}/payments`, { direction: "in", partnerId: t.p2.id, payDate: "2026-11-01", amount: 50 })).status).toBe(422);  // tug partner
  });

  it("storno na uplata ja vrakja fakturata vo otvoreni; uplatata ne se menuva i ne se brise", async () => {
    await inv(100);
    const p = (await call("POST", `${C()}/payments`, { direction: "in", partnerId: t.p1.id, payDate: "2026-11-01", amount: 118 })).body;
    expect((await call("GET", `${C()}/open-items?direction=in`)).body.items).toHaveLength(0);
    expect(await err(t.db.update(payments).set({ amount: "1" }).where(eq(payments.id, p.id)) as unknown as Promise<unknown>)).toMatch(/не може да се менува/);
    expect(await err(t.db.execute(sql`delete from payment_allocations`) as unknown as Promise<unknown>)).toMatch(/само за додавање/);
    expect((await call("POST", `${C()}/payments/${p.id}/void`, { reason: "Погрешен купувач" })).status).toBe(200);
    expect((await call("GET", `${C()}/open-items?direction=in`)).body.items[0].remaining).toBe("118.00");
    expect((await call("POST", `${C()}/payments/${p.id}/void`, { reason: "пак" })).status).toBe(409);
  });

  it("stornirana faktura ne e dolg", async () => {
    const a = await inv(100);
    await inv(100, { docType: "ST", relatedInvoiceId: a.id, voidReasonCode: "S-1", correctionReason: "Погрешно" }, -1);
    expect((await call("GET", `${C()}/open-items?direction=in`)).body.items).toHaveLength(0);
  });

  it("dobavuvaci: proknizena vlezna faktura -> isplata", async () => {
    const [pi] = await t.db.insert(purchaseInvoices).values({ clientId: t.c1.id, partnerId: t.p1.id, year: 2026, supplierNumber: "77", issueDate: "2026-10-01", receivedDate: "2026-10-02", dueDate: "2026-10-31" }).returning();
    await t.db.insert(purchaseLines).values({ purchaseInvoiceId: pi!.id, lineNo: 1, description: "x", unit: "ком", qty: "1", unitPrice: "500", vatRateId: t.vat18.id, vatRatePct: "18", ...calcLine({ qty: 1, unitPrice: 500, vatRatePct: 18 }) });
    await postPurchase(t.db, pi!.id, actor(), false);
    const o = (await call("GET", `${C()}/open-items?direction=out&asOf=2026-11-04`)).body;
    expect(o.items[0]).toMatchObject({ remaining: "590.00", daysOverdue: 4 });
    await call("POST", `${C()}/payments`, { direction: "out", partnerId: t.p1.id, payDate: "2026-11-04", amount: 590 });
    expect((await call("GET", `${C()}/open-items?direction=out`)).body.items).toHaveLength(0);
  });

  it("bez modul Plakjanja 403", async () => {
    await t.db.update(clients).set({ modules: ["invoices"] }).where(eq(clients.id, t.c1.id));
    expect((await call("GET", `${C()}/payments`)).status).toBe(403);
  });
});

describe("izvod od banka", () => {
  const mapping = { delimiter: ";", skipRows: 1, dateCol: 0, dateFormat: "dd.MM.yyyy", amountMode: "split", creditCol: 3, debitCol: 4, decimal: ",",
    nameCol: 1, accountCol: 2, referenceCols: [5] } as const;
  const csv = [
    "Датум;Налогодавач;Сметка;Прилив;Одлив;Цел",
    "04.11.2026;\"КУПУВАЧ А ДООЕЛ\";300000000000111;1.180,00;;Плаќање по фактура MC-2026-1",
    "04.11.2026;ДРУГ;210000000000999;;500,00;Кирија",
    "05.11.2026;Купувач А;;236,00;;аванс",
    "лош ред;;;;;",
  ].join("\n");

  it("parser: datumi, iznosi, nasoka, navodnici; broevi na fakturi", () => {
    const r = parseStatement(csv, mapping);
    expect(r.rows.map((x) => [x.date, x.amount, x.direction, x.name])).toEqual([
      ["2026-11-04", "1180.00", "in", "КУПУВАЧ А ДООЕЛ"], ["2026-11-04", "500.00", "out", "ДРУГ"], ["2026-11-05", "236.00", "in", "Купувач А"]]);
    expect(r.skipped).toEqual([{ line: 5, reason: "датум" }]);
    expect(parseAmount("-1.234,56", ",")!.toNumber()).toBe(-1234.56);
    expect(findInvoiceNumbers("ф-ра MC-2026-1 и mc-od-2026-00012", ["MC"])).toEqual(["MC-2026-00001", "MC-OD-2026-00012"]);
  });

  it("CSV preku izvod: mapiranje, prepoznavanje po smetka i broj, vtor uvoz odbien", async () => {
    await t.db.update(partners).set({ bankAccount: "300-0000000001-11" }).where(eq(partners.id, t.p1.id));
    const a = await inv(1000);
    expect((await call("POST", `${C()}/bank-statements`, { text: csv })).status).toBe(422);   // nema mapiranje
    expect((await call("PUT", `${C()}/bank-mapping`, mapping)).status).toBe(200);
    const r = (await call("POST", `${C()}/bank-statements`, { text: csv, fileName: "izvod.csv" })).body;
    expect(r).toMatchObject({ lines: 3, booked: 1 });
    const d = (await call("GET", `${C()}/bank-statements/${r.id}`)).body;
    expect(d.lines[0]).toMatchObject({ status: "booked", booking: { documents: "MC-2026-00001" } });
    void a;
    expect((await call("POST", `${C()}/bank-statements`, { text: csv })).status).toBe(409);
    expect(await t.db.select().from(paymentAllocations)).toHaveLength(1);
  });
});
