import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { clientAccess, clients, invoices, partners, recurringInvoices, users } from "../src/db/schema.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { dateIn, fillPlaceholders, firstOnOrAfter, nextMonth, runRecurring } from "../src/domain/recurring.js";
import { openItems } from "../src/domain/payments.js";

let t: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let ana: string;
beforeEach(async () => {
  t = await testDb();
  app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64") });
  const [a] = await t.db.insert(users).values({ email: "ana@x.mk", displayName: "Ана", provider: "entra", role: "accountant" }).returning();
  await t.db.insert(clientAccess).values({ clientId: t.c1.id, userId: a!.id });
  ana = `${SESSION_COOKIE}=${await createSession(t.db, a!.id, true, {})}`;
  await t.db.update(clients).set({ modules: ["invoices", "recurring", "incoming", "payments"] }).where(eq(clients.id, t.c1.id));
});
async function call(method: string, url: string, payload?: unknown) {
  const r = await app.inject({ method: method as never, url, payload: payload as never, headers: { cookie: ana, ...(method === "GET" ? {} : { "x-efaktura": "1" }) } });
  return { status: r.statusCode, body: r.headers["content-type"]?.toString().includes("json") ? r.json() : r.rawPayload };
}
const C = () => `/api/clients/${t.c1.id}`;
const line = (desc = "Одржување", price = 1000) => ({ description: desc, unit: "мес", qty: 1, unitPrice: price, discountPct: 0, vatRateId: t.vat18.id });
async function draft(docType = "INV", lines = [line()], issueDate = "2026-11-02", dueDate: string | null = "2026-11-17") {
  const r = await call("POST", `${C()}/invoices`, { partnerId: t.p1.id, docType, issueDate, dueDate, lines });
  expect(r.status).toBe(201);
  return r.body.id as number;
}

describe("uloge na partnerite", () => {
  it("nov partner bez uloga = kupuvac; vlezna faktura go oznacuva kako dobavuvac; faktura kako kupuvac", async () => {
    const p = await call("POST", `${C()}/partners`, { name: "Нов ДООЕЛ", edb: "4030000000001" });
    expect(p.body).toMatchObject({ isCustomer: true, isSupplier: false });
    const s = await call("POST", `${C()}/partners`, { name: "Добавувач ДОО", edb: "4030000000002", isSupplier: true });
    expect(s.body).toMatchObject({ isCustomer: false, isSupplier: true });
    // ist partner i kako dobavuvac (vlezna faktura) -> dvete uloge
    const pr = await call("POST", `${C()}/purchases`, { partnerId: p.body.id, supplierNumber: "X-1", issueDate: "2026-11-01", receivedDate: "2026-11-02",
      lines: [{ description: "Услуга", unit: "ком", qty: 1, unitPrice: 100, discountPct: 0, vatRateId: t.vat18.id, allocate: false }] });
    expect(pr.status).toBe(201);
    const [x] = await t.db.select().from(partners).where(eq(partners.id, p.body.id));
    expect(x).toMatchObject({ isCustomer: true, isSupplier: true });
    // dobavuvac -> izdadena faktura -> i kupuvac
    await call("POST", `${C()}/invoices`, { partnerId: s.body.id, docType: "INV", issueDate: "2026-11-02", lines: [line()] });
    const [y] = await t.db.select().from(partners).where(eq(partners.id, s.body.id));
    expect(y!.isCustomer).toBe(true);
    // racna promena
    const u = await call("PATCH", `${C()}/partners/${s.body.id}`, { isCustomer: false });
    expect(u.body.isCustomer).toBe(false);
  });
});

describe("ponuda -> faktura, kopija", () => {
  it("ponuda: svoj broj, ne e dolg, PDF bez rok za plakjanje; -> nacrt faktura so isti stavki; otkazuvanje", async () => {
    const pf = await draft("PF", [line("Изработка веб", 50000)], "2026-11-02", "2026-11-30");
    const iss = await call("POST", `/api/invoices/${pf}/issue`);
    expect(iss.status).toBe(200);
    expect(iss.body.number).toBe("MC-PF-2026-00001");
    expect((await openItems(t.db, t.c1.id, "in")).length).toBe(0);
    const pdf = await call("GET", `/api/invoices/${pf}/pdf`);
    expect(pdf.status).toBe(200);
    expect((await call("POST", `/api/invoices/${pf}/derive`, { docType: "ST" })).status).toBe(422);

    const conv = await call("POST", `/api/invoices/${pf}/copy`, { as: "INV" });
    expect(conv.status).toBe(201);
    const inv = (await call("GET", `/api/invoices/${conv.body.id}`)).body;
    expect(inv).toMatchObject({ docType: "INV", status: "draft", sourceInvoiceId: pf, sourceNumber: "MC-PF-2026-00001", grossTotal: "59000.00" });
    expect(inv.lines[0].priceSource).toBe("Од понуда MC-PF-2026-00001");
    expect((await call("GET", `/api/invoices/${pf}`)).body.made).toHaveLength(1);
    // izdadenata faktura NE e ponuda: dobiva svoj broj
    expect((await call("POST", `/api/invoices/${conv.body.id}/issue`)).body.number).toBe("MC-2026-00001");
    // ponudata moze da se otkaze i po izdavanje; fakturata ne
    expect((await call("POST", `/api/invoices/${pf}/cancel`)).status).toBe(200);
    expect((await t.db.select().from(invoices).where(eq(invoices.id, pf)))[0]!.status).toBe("voided");
    expect((await call("POST", `/api/invoices/${conv.body.id}/cancel`)).status).toBe(409);
  });

  it("kopija na faktura: denesen datum, ist broj denovi do rok, isti ceni; storno ne se kopira", async () => {
    const id = await draft();
    await call("POST", `/api/invoices/${id}/issue`);
    const c = await call("POST", `/api/invoices/${id}/copy`, {});
    const cp = (await call("GET", `/api/invoices/${c.body.id}`)).body;
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Skopje" });
    expect(cp).toMatchObject({ docType: "INV", status: "draft", issueDate: today, grossTotal: "1180.00" });
    expect((Date.parse(cp.dueDate) - Date.parse(cp.issueDate)) / 86400000).toBe(15);
    const st = await call("POST", `/api/invoices/${id}/derive`, { docType: "ST" });
    expect((await call("POST", `/api/invoices/${st.body.id}/copy`, {})).status).toBe(422);
  });
});

describe("povtoruvacki fakturi", () => {
  it("datumi i zamena na {месец}", () => {
    expect(dateIn(2026, 1, 0)).toBe("2026-02-28");
    expect(nextMonth("2026-12-31", 0)).toBe("2027-01-31");
    expect(firstOnOrAfter("2026-11-07", 5)).toBe("2026-12-05");
    expect(firstOnOrAfter("2026-11-07", 0)).toBe("2026-11-30");
    expect(fillPlaceholders("Претплата за {месец} {година} ({претходен месец})", "2026-01-31")).toBe("Претплата за јануари 2026 (декември 2025)");
  });

  it("modul: bez nego 403; nacrti sekoj mesec, bez dupli, nadomestuva propusteno, kraj, pauza", async () => {
    const src = await draft("INV", [line("Претплата за {месец}", 1730)], "2026-09-30", "2026-10-15");
    await t.db.update(clients).set({ modules: ["invoices"] }).where(eq(clients.id, t.c1.id));
    expect((await call("GET", `${C()}/recurring`)).status).toBe(403);
    await t.db.update(clients).set({ modules: ["invoices", "recurring"] }).where(eq(clients.id, t.c1.id));

    const r = await call("POST", `${C()}/recurring`, { invoiceId: src, name: "Pantheon", dayOfMonth: 0, startDate: "2026-09-01", endDate: "2026-12-31" });
    expect(r.status).toBe(201);
    expect(r.body.nextDate).toBe("2026-09-30");
    const a = await runRecurring(t.db, { today: "2026-11-07" });
    expect(a.created.map((x) => x.issueDate)).toEqual(["2026-09-30", "2026-10-31"]);
    expect((await runRecurring(t.db, { today: "2026-11-07" })).created).toHaveLength(0);
    const [g] = await t.db.select().from(invoices).where(eq(invoices.id, a.created[1]!.invoiceId));
    expect(g).toMatchObject({ status: "draft", dueDate: "2026-11-15", recurringId: r.body.id, grossTotal: "2041.40" });
    const gl = (await call("GET", `/api/invoices/${g!.id}`)).body.lines;
    expect(gl[0].description).toBe("Претплата за октомври");

    // otkazan nacrt ne se pravi povtorno
    await call("POST", `/api/invoices/${a.created[0]!.invoiceId}/cancel`);
    expect((await runRecurring(t.db, { today: "2026-11-08" })).created).toHaveLength(0);

    // cena smeneta vo poslednata -> sablon
    await call("PUT", `/api/invoices/${g!.id}`, { partnerId: t.p1.id, docType: "INV", issueDate: "2026-10-31", dueDate: "2026-11-15",
      lines: [{ ...line("Претплата за октомври", 1800) }] });
    expect((await call("POST", `${C()}/recurring/${r.body.id}/template-from-last`)).status).toBe(200);
    const [tpl] = await t.db.select().from(recurringInvoices).where(eq(recurringInvoices.id, r.body.id));
    expect(tpl!.lines[0]).toMatchObject({ description: "Претплата за {месец}", unitPrice: 1800 });

    // pauza -> nisto; prodolzuvanje -> od denes (bez propustenoto)
    await call("PATCH", `${C()}/recurring/${r.body.id}`, { isActive: false });
    expect((await runRecurring(t.db, { today: "2026-12-31" })).created).toHaveLength(0);
    const list = (await call("GET", `${C()}/recurring`)).body;
    expect(list[0]).toMatchObject({ generated: 2, isActive: false, grossTotal: "2124.00" });
    expect((await call("DELETE", `${C()}/recurring/${r.body.id}`)).status).toBe(409);
    const res = await call("PATCH", `${C()}/recurring/${r.body.id}`, { isActive: true });
    expect(res.status).toBe(200);
    // kraj: posle 31.12 se iskluchuva sama
    await t.db.update(recurringInvoices).set({ nextDate: "2026-12-31" }).where(eq(recurringInvoices.id, r.body.id));
    expect((await runRecurring(t.db, { today: "2027-02-01" })).created.map((x) => x.issueDate)).toEqual(["2026-12-31"]);
    const [end] = await t.db.select().from(recurringInvoices).where(eq(recurringInvoices.id, r.body.id));
    expect(end!.isActive).toBe(false);
  });
});
