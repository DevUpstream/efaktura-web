import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";
import * as s from "../src/db/schema.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { calcLine } from "../src/domain/calc.js";
import { issueInvoice } from "../src/domain/issue.js";
import { postPurchase } from "../src/domain/purchase.js";
import { toCsv } from "../src/routes/export.js";

/** docs/12: испратници, денес, ИОС, компензации, опомени, извоз, агент. Измислени податоци. */
describe("docs/12", () => {
  let t: Awaited<ReturnType<typeof testDb>>;
  let app: FastifyInstance;
  let cookie: string;
  let item: number, wh: number;
  beforeEach(async () => {
    t = await testDb();
    app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64") });
    cookie = `${SESSION_COOKIE}=${await createSession(t.db, t.user.id, true, {})}`;
    await t.db.update(s.clients).set({ modules: ["invoices", "incoming", "payments", "warehouse", "crm"], iban: "300-0000000001-11" }).where(eq(s.clients.id, t.c1.id));
    await t.db.update(s.partners).set({ isCustomer: true, isSupplier: true }).where(eq(s.partners.id, t.p1.id));
    const [it] = await t.db.insert(s.items).values({ clientId: t.c1.id, code: "T1", name: "Тонер", type: "goods", unit: "ком", unitPrice: "100", vatRateId: t.vat18.id }).returning();
    item = it!.id;
    const r = await call("POST", `${C()}/stock-docs`, { kind: "receipt", warehouseId: (await whId()), docDate: "2026-11-01", lines: [{ itemId: item, qty: 10, unitCost: 50 }] });
    expect(r.status).toBe(201);
  });
  const C = () => `/api/clients/${t.c1.id}`;
  const whId = async () => { if (!wh) wh = (await call("GET", `${C()}/warehouses`)).body[0].id; return wh; };
  const call = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as never, url, payload: payload as never, headers: { cookie, ...(method === "GET" ? {} : { "x-efaktura": "1" }) } });
    let body: unknown = null; try { body = r.json(); } catch { body = r.body; }
    return { status: r.statusCode, body: body as any, raw: r };
  };
  const stockQty = async () => Number((await call("GET", `${C()}/stock`)).body.find((x: { itemId: number }) => x.itemId === item)?.qty ?? 0);

  it("испратница без фактура → фактура од испратници: залихата се намалува само еднаш; сторно ја враќа во нефактурирани", async () => {
    wh = 0;
    expect(await stockQty()).toBe(10);
    const d1 = await call("POST", `${C()}/stock-docs`, { kind: "issue", warehouseId: await whId(), partnerId: t.p1.id, docDate: "2026-11-02", lines: [{ itemId: item, qty: 3 }] });
    expect(d1.status).toBe(201);
    expect((await call("POST", `${C()}/stock-docs`, { kind: "issue", warehouseId: await whId(), docDate: "2026-11-02", lines: [{ itemId: item, qty: 1 }] })).status).toBe(422);
    const d2 = await call("POST", `${C()}/stock-docs`, { kind: "issue", warehouseId: await whId(), partnerId: t.p1.id, docDate: "2026-11-03", lines: [{ itemId: item, qty: 2 }] });
    expect(await stockQty()).toBe(5);
    const open = (await call("GET", `${C()}/dispatches`)).body;
    expect(open.map((d: { id: number }) => d.id).sort()).toEqual([d1.body.id, d2.body.id].sort());
    expect((await call("GET", `${C()}/stock-docs/${d1.body.id}/pdf`)).raw.headers["content-type"]).toBe("application/pdf");

    const inv = await call("POST", `${C()}/dispatches/invoice`, { docIds: [d1.body.id, d2.body.id] });
    expect(inv.status).toBe(201);
    // ista ispratnica vo druga faktura - ne
    expect((await call("POST", `${C()}/dispatches/invoice`, { docIds: [d1.body.id] })).status).toBe(422);
    expect((await call("GET", `${C()}/dispatches`)).body).toHaveLength(0);
    // ispratnica vo nacrt ne se stornira
    expect((await call("POST", `${C()}/stock-docs/${d1.body.id}/reverse`, { date: "2026-11-05" })).status).toBe(422);
    const lines = await t.db.select().from(s.invoiceLines).where(eq(s.invoiceLines.invoiceId, inv.body.id));
    expect(lines.map((l) => [Number(l.qty), l.unitPrice, l.stockDocId])).toEqual([[3, "100.0000", d1.body.id], [2, "100.0000", d2.body.id]]);
    // urednikot zacuvuva so vrskata
    const full = (await call("GET", `/api/invoices/${inv.body.id}`)).body;
    const put = await call("PUT", `/api/invoices/${inv.body.id}`, { ...full, lines: full.lines.map((l: Record<string, unknown>) => ({ ...l, qty: Math.abs(Number(l.qty)) })) });
    expect(put.status).toBe(200);
    expect((await t.db.select().from(s.invoiceLines).where(eq(s.invoiceLines.invoiceId, inv.body.id))).every((l) => !!l.stockDocId)).toBe(true);

    const issued = await issueInvoice(t.db, inv.body.id, { userId: t.user.id });
    expect(issued.stockDocNumber).toBeNull();
    expect(await stockQty()).toBe(5);   // ne se izdava povtorno
    // storno na fakturata -> ispratnicite povtorno nefakturirani, zalihata ista
    const st = await call("POST", `/api/invoices/${inv.body.id}/derive`, { docType: "ST" });
    const reason = (await t.db.select().from(s.ujpReasons)).find((r) => r.kind === "void")!.code;
    await t.db.update(s.invoices).set({ voidReasonCode: reason, correctionReason: "грешка" }).where(eq(s.invoices.id, st.body.id));
    await issueInvoice(t.db, st.body.id, { userId: t.user.id });
    expect(await stockQty()).toBe(5);
    expect((await call("GET", `${C()}/dispatches`)).body).toHaveLength(2);
  });

  it("денес, ИОС, компензација, опомена, извоз, агент", async () => {
    const mk = async (price: number, due: string) => {
      const [i] = await t.db.insert(s.invoices).values({ clientId: t.c1.id, partnerId: t.p1.id, year: 2026, issueDate: "2026-10-01", supplyDate: "2026-10-01", dueDate: due }).returning();
      await t.db.insert(s.invoiceLines).values({ invoiceId: i!.id, lineNo: 1, description: "У", unit: "ком", qty: "1", unitPrice: String(price), vatRateId: t.vat18.id, vatRatePct: "18",
        ...calcLine({ qty: 1, unitPrice: price, vatRatePct: 18 }) });
      return issueInvoice(t.db, i!.id, { userId: t.user.id });
    };
    const a = await mk(1000, "2026-10-15");  // 1180, docnenje
    await mk(500, "2099-01-01");             // 590
    const [pi] = await t.db.insert(s.purchaseInvoices).values({ clientId: t.c1.id, partnerId: t.p1.id, year: 2026, supplierNumber: "D-1", issueDate: "2026-10-02", receivedDate: "2026-10-02" }).returning();
    await t.db.insert(s.purchaseLines).values({ purchaseInvoiceId: pi!.id, lineNo: 1, description: "Услуга", unit: "ком", qty: "1", unitPrice: "300", vatRateId: t.vat18.id, vatRatePct: "18",
      ...calcLine({ qty: 1, unitPrice: 300, vatRatePct: 18 }) });
    await postPurchase(t.db, pi!.id, { userId: t.user.id }, false);   // 354

    const today = (await call("GET", `${C()}/today`)).body;
    expect(today.receivables.overdue).toMatchObject({ count: 1, amount: "1180.00" });
    expect(today.invoices.waitingUjp).toBe(2);
    expect(today.agent).toMatchObject({ configured: false, ok: false });

    const ios = (await call("GET", `${C()}/ios/${t.p1.id}?asOf=2026-11-11`)).body;
    expect(ios).toMatchObject({ totalReceivable: "1770.00", totalPayable: "354.00", balance: "1416.00" });
    expect((await call("GET", `${C()}/ios/${t.p1.id}?asOf=2026-09-30`)).body.balance).toBe("0.00");
    expect((await call("GET", `${C()}/ios/${t.p1.id}/pdf`)).raw.headers["content-type"]).toBe("application/pdf");

    const cand = (await call("GET", `${C()}/compensations/candidates/${t.p1.id}`)).body;
    expect(cand.max).toBe("354.00");
    expect((await call("POST", `${C()}/compensations`, { partnerId: t.p1.id, date: "2026-11-11", invoices: [{ id: a.id, amount: 300 }], purchases: [{ id: pi!.id, amount: 354 }] })).status).toBe(422);
    const comp = await call("POST", `${C()}/compensations`, { partnerId: t.p1.id, date: "2026-11-11", invoices: [{ id: a.id, amount: 354 }], purchases: [{ id: pi!.id, amount: 354 }] });
    expect(comp.status).toBe(201);
    expect(comp.body.number).toBe("MC-KMP-2026-00001");
    expect((await call("GET", `${C()}/ios/${t.p1.id}`)).body).toMatchObject({ totalReceivable: "1416.00", totalPayable: "0.00", balance: "1416.00" });
    expect((await call("GET", `${C()}/compensations/${comp.body.id}/pdf`)).raw.headers["content-type"]).toBe("application/pdf");
    expect((await call("POST", `${C()}/compensations/${comp.body.id}/void`, { reason: "грешка" })).status).toBe(200);
    expect((await call("GET", `${C()}/ios/${t.p1.id}`)).body.balance).toBe("1416.00");
    expect((await call("GET", `${C()}/ios/${t.p1.id}`)).body.totalPayable).toBe("354.00");

    const dun = (await call("GET", `${C()}/dunning?minDays=1`)).body;
    expect(dun[0]).toMatchObject({ partnerId: t.p1.id, count: 1, amount: "1180.00", nextLevel: 1 });
    const l = await call("POST", `${C()}/dunning`, { partnerId: t.p1.id, level: 1 });
    expect(l.status).toBe(201);
    expect((await call("GET", `${C()}/dunning`)).body[0].nextLevel).toBe(2);
    expect((await call("GET", `${C()}/dunning/letters/${l.body.id}/pdf`)).raw.headers["content-type"]).toBe("application/pdf");

    const zip = await call("GET", `${C()}/export.zip`);
    expect(zip.status).toBe(200);
    expect(zip.raw.headers["content-type"]).toBe("application/zip");
    expect(zip.raw.rawPayload.subarray(0, 2).toString()).toBe("PK");
    expect(toCsv([{ a: 'x;"y"', b: null }])).toBe('﻿a;b\r\n"x;""y""";\r\n');

    // agent: kluc koristen pred 1 minuta = raboti; 5 minuti = ne
    await t.db.insert(s.agentKeys).values({ name: "PC", keyHash: "a".repeat(64), lastUsedAt: new Date(Date.now() - 60_000) });
    expect((await app.inject({ method: "GET", url: "/api/health/agent" })).statusCode).toBe(200);
    await t.db.update(s.agentKeys).set({ lastUsedAt: new Date(Date.now() - 5 * 60_000) });
    expect((await app.inject({ method: "GET", url: "/api/health/agent" })).statusCode).toBe(503);
    expect((await call("GET", "/api/status")).body.agent).toMatchObject({ configured: true, ok: false });
  });
});
