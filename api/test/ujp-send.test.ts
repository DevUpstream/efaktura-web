/** Праќање на УЈП преку агентот (docs/15): редица, земање, резултат, сторно чека оригинал, без двојно праќање. */
import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";
import * as s from "../src/db/schema.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";

describe("праќање на УЈП (docs/15)", () => {
  let t: Awaited<ReturnType<typeof testDb>>;
  let app: FastifyInstance;
  let cookie: string, key: string;
  beforeEach(async () => {
    t = await testDb();
    app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64") });
    cookie = `${SESSION_COOKIE}=${await createSession(t.db, t.user.id, true, {})}`;
    key = (await call("POST", "/api/agent-keys", { name: "Токен" })).body.key;
    await t.db.update(s.clients).set({ address: "ул. Македонија бр. 5", postalCode: "1000", email: "mc@x.mk" }).where(eq(s.clients.id, t.c1.id));
    await t.db.update(s.partners).set({ address: "ул. Тестна бр. 1", city: "Скопје", postalCode: "1000" }).where(eq(s.partners.id, t.p1.id));
  });
  const call = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as never, url, payload: payload as never, headers: { cookie, ...(method === "GET" ? {} : { "x-efaktura": "1" }) } });
    let body: any = null; try { body = r.json(); } catch { body = r.body; }
    return { status: r.statusCode, body };
  };
  const agent = async (url: string, payload: unknown = {}) => {
    const r = await app.inject({ method: "POST", url, payload: payload as never, headers: { "x-agent-key": key, "x-efaktura": "1" } });
    return { status: r.statusCode, body: r.json() };
  };
  const C = () => `/api/clients/${t.c1.id}`;
  const issued = async (extra: Record<string, unknown> = {}, before?: (id: number) => Promise<unknown>) => {
    const d = (await call("POST", `${C()}/invoices`, { partnerId: t.p1.id, issueDate: "2026-11-12", supplyDate: "2026-11-12", paymentMethod: "bank",
      lines: [{ description: "Услуга", unit: "ком", qty: 1, unitPrice: 254.24, vatRateId: t.vat18.id }], ...extra })).body;
    if (before) await before(d.id);
    expect((await call("POST", `/api/invoices/${d.id}/issue`)).status).toBe(200);
    return d.id as number;
  };

  it("фактура: преглед -> редица -> агент -> EUID; не двапати; сторно чека оригинал", async () => {
    const id = await issued();
    const st = (await call("GET", `/api/invoices/${id}/ujp`)).body;
    expect(st.problems).toEqual([]);
    expect(st.payload.document.seller).toMatchObject({ sellerTin: "4030994180119", sellerAddress: { streetAddress: "ул. Македонија", streetNumber: "5", postalCode: "1000" } });
    expect(st.payload.document.buyer).toMatchObject({ buyerTin: "4001235555678", buyerAddress: { streetNumber: "1" } });
    expect(st.payload.document.docTotals).toMatchObject({ docNetAmount: 254.24, docVatAmount: 45.76, docGrossAmount: 300, docFinalAmount: 300 });
    expect(st.payload.document.docPayment.docPaymentTypeCode).toBe("P12");
    expect(st.payload.document.header.docId).toBe(String(id));

    expect((await call("POST", `/api/invoices/${id}/ujp-send`)).status).toBe(200);
    expect((await call("POST", `/api/invoices/${id}/ujp-send`)).status).toBe(409);       // веќе чека
    // сторно пред оригиналот да е на УЈП: чека
    const stId = (await call("POST", `/api/invoices/${id}/derive`, { docType: "ST" })).body.id;
    const reasons = await t.db.select().from(s.ujpReasons);
    await call("PUT", `/api/invoices/${stId}`, { partnerId: t.p1.id, docType: "ST", issueDate: "2026-11-12", supplyDate: "2026-11-12", paymentMethod: "bank",
      voidReasonCode: reasons.find((x) => x.kind === "void")!.code, correctionReason: "тест",
      lines: [{ description: "Услуга", unit: "ком", qty: 1, unitPrice: 254.24, vatRateId: t.vat18.id }] });
    expect((await call("POST", `/api/invoices/${stId}/issue`)).status).toBe(200);
    expect((await call("POST", `/api/invoices/${stId}/ujp-send`)).body.waitFor).toMatch(/уште не е на УЈП/);

    const jobs = (await agent("/api/agent/ujp-jobs/take")).body;
    expect(jobs.map((j: { invoiceId: number }) => j.invoiceId)).toEqual([id]);        // сторното чека
    expect(jobs[0]).toMatchObject({ sellerEdb: "4030994180119", docType: "100" });
    expect((await agent("/api/agent/ujp-jobs/take")).body).toEqual([]);                 // „sending“ не се зема пак
    expect((await agent(`/api/agent/ujp-jobs/${jobs[0].jobId}`, { ok: true, httpStatus: 200, euid: "01a15e7f-0000-7dcf-849e-ccbf9f65386d",
      qrLink: "https://efakturatest.ujp.gov.mk/qr/x", timestamp: "2026-11-12T18:40:00", message: "{}", request: "{\"document\":{}}" })).status).toBe(200);
    const [inv] = await t.db.select().from(s.invoices).where(eq(s.invoices.id, id));
    expect(inv).toMatchObject({ status: "voided", ujpId: "01a15e7f-0000-7dcf-849e-ccbf9f65386d", ujpQrLink: "https://efakturatest.ujp.gov.mk/qr/x", ujpError: null });
    expect((await call("POST", `/api/invoices/${id}/ujp-send`)).body.message).toMatch(/Веќе е испратена/);

    // сега сторното оди, со референца ST кон EUID на оригиналот
    const j2 = (await agent("/api/agent/ujp-jobs/take")).body;
    expect(j2).toHaveLength(1);
    expect(j2[0].payload.document.docReferences[0]).toMatchObject({ docNumberRef: "01a15e7f-0000-7dcf-849e-ccbf9f65386d", docTypeRef: "ST" });
    expect(j2[0].payload.document.docTotals.docGrossAmount).toBe(-300);
    // грешка од УЈП -> порака кај фактурата; може повторно
    await agent(`/api/agent/ujp-jobs/${j2[0].jobId}`, { ok: false, httpStatus: 500, message: "E5004 Certificate validation failed" });
    const [s2] = await t.db.select().from(s.invoices).where(eq(s.invoices.id, stId));
    expect(s2).toMatchObject({ status: "issued", ujpId: null, ujpError: "E5004 Certificate validation failed" });
    expect((await call("GET", `/api/invoices/${stId}/ujp`)).body.log[0]).toMatchObject({ success: false, httpStatus: 500 });
    expect((await call("POST", `/api/invoices/${stId}/ujp-send`)).status).toBe(200);
    expect((await call("POST", `/api/invoices/${stId}/ujp-cancel`)).status).toBe(200);
    const aud = await t.db.select().from(s.auditLog).where(eq(s.auditLog.entity, "invoice"));
    expect(aud.map((a) => a.action)).toEqual(expect.arrayContaining(["ujp_queue", "ujp_sent", "ujp_error", "ujp_cancel"]));
  });

  it("проверки: адреса = предупредување; без ЕДБ не оди; „прати ги сите“; ERPNext не; лош клуч", async () => {
    await t.db.update(s.partners).set({ postalCode: null }).where(eq(s.partners.id, t.p1.id));
    const a = await issued();
    const st = (await call("GET", `/api/invoices/${a}/ujp`)).body;
    expect(st.problems).toEqual([]);
    expect(st.warnings.join()).toMatch(/Купувач: адресата нема поштенски број/);   // агентот ја зема од регистарот
    await t.db.update(s.partners).set({ edb: null }).where(eq(s.partners.id, t.p1.id));
    const nb = await issued();
    const r = await call("POST", `/api/invoices/${nb}/ujp-send`);
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/Купувачот нема ЕДБ/);
    await t.db.update(s.partners).set({ edb: "4001235555678", postalCode: "1000" }).where(eq(s.partners.id, t.p1.id));
    const b = await issued({}, (id) => t.db.update(s.invoices).set({ source: "erpnext" }).where(eq(s.invoices.id, id)));   // пренесена
    expect((await call("GET", `/api/invoices/${b}/ujp`)).body.problems.join()).toMatch(/ERPNext/);
    const all = (await call("POST", `${C()}/ujp-send-all`)).body;
    expect(all.queued).toHaveLength(1);    // a (без адреса е само предупредување)
    expect(all.skipped).toHaveLength(1);   // nb – без ЕДБ; ERPNext не е ни кандидат
    expect((await app.inject({ method: "POST", url: "/api/agent/ujp-jobs/take", headers: { "x-agent-key": "efa_" + "x".repeat(40), "x-efaktura": "1" } })).statusCode).toBe(401);
    // JSON како датотека
    const f = await app.inject({ method: "GET", url: `/api/invoices/${a}/ujp.json`, headers: { cookie } });
    expect(JSON.parse(f.body).document.header.docType).toBe("100");
  });
});
