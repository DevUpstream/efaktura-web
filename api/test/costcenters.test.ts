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
import { iosFor } from "../src/domain/receivables.js";
import { partnerCard } from "../src/domain/partnercard.js";

describe("трошковни места и картица на партнер (docs/14)", () => {
  let t: Awaited<ReturnType<typeof testDb>>;
  let app: FastifyInstance;
  let cookie: string;
  beforeEach(async () => {
    t = await testDb();
    app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64") });
    cookie = `${SESSION_COOKIE}=${await createSession(t.db, t.user.id, true, {})}`;
    await t.db.update(s.clients).set({ modules: ["invoices", "incoming", "payments"] }).where(eq(s.clients.id, t.c1.id));
    await t.db.update(s.partners).set({ isCustomer: true, isSupplier: true }).where(eq(s.partners.id, t.p1.id));
  });
  const C = () => `/api/clients/${t.c1.id}`;
  const call = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as never, url, payload: payload as never, headers: { cookie, ...(method === "GET" ? {} : { "x-efaktura": "1" }) } });
    let body: unknown = null; try { body = r.json(); } catch { body = r.body; }
    return { status: r.statusCode, body: body as any, raw: r };
  };
  const draft = (extra: Record<string, unknown> = {}, lines: Record<string, unknown>[] = [{}]) => ({ partnerId: t.p1.id, docType: "INV", issueDate: "2026-10-05",
    lines: lines.map((l) => ({ description: "Услуга", unit: "ком", qty: 1, unitPrice: 1000, vatRateId: t.vat18.id, ...l })), ...extra });

  it("ТМ: шифрарник, задолжително, по ставки, промена по издавање со ревизија, масовно, извештај", async () => {
    const a = (await call("POST", `${C()}/cost-centers`, { code: "PRO", name: "Продажба" })).body;
    const b = (await call("POST", `${C()}/cost-centers`, { code: "SRV", name: "Сервис" })).body;
    expect((await call("POST", `${C()}/cost-centers`, { code: "pro", name: "Дупликат" })).status).toBe(422);
    const [other] = await t.db.insert(s.costCenters).values({ clientId: t.c2.id, code: "X", name: "Туѓо" }).returning();

    // tugo TM ne
    expect((await call("POST", `${C()}/invoices`, draft({ costCenterId: other!.id }))).status).toBe(422);
    // zadolzitelno: bez TM ne se izdava
    await call("PATCH", `${C()}`, { costCenterMode: "required" });
    const i1 = (await call("POST", `${C()}/invoices`, draft())).body;
    await expect(issueInvoice(t.db, i1.id, { userId: t.user.id })).rejects.toThrow(/трошковно место/);
    // po stavki: dvete stavki imaat TM -> moze
    const i2 = (await call("POST", `${C()}/invoices`, draft({}, [{ costCenterId: a.id }, { unitPrice: 500, costCenterId: b.id }]))).body;
    await issueInvoice(t.db, i2.id, { userId: t.user.id });
    // na zaglavje
    const i3 = (await call("POST", `${C()}/invoices`, draft({ costCenterId: b.id }, [{ unitPrice: 200 }]))).body;
    await issueInvoice(t.db, i3.id, { userId: t.user.id });

    // promena po izdavanje: samo TM; druga promena i ponatamu zabraneta
    expect((await call("POST", `/api/invoices/${i3.id}/cost-center`, { costCenterId: a.id })).status).toBe(200);
    await expect(t.db.update(s.invoices).set({ note: "x" }).where(eq(s.invoices.id, i3.id))).rejects.toThrow();
    const [ln] = await t.db.select().from(s.invoiceLines).where(eq(s.invoiceLines.invoiceId, i2.id));
    expect((await call("POST", `/api/invoices/${i2.id}/cost-center`, { costCenterId: null, lines: [{ id: ln!.id, costCenterId: b.id }] })).status).toBe(200);
    await expect(t.db.update(s.invoiceLines).set({ qty: "5" }).where(eq(s.invoiceLines.id, ln!.id))).rejects.toThrow();
    const aud = await t.db.select().from(s.auditLog).where(eq(s.auditLog.action, "cost_center"));
    expect(aud.length).toBe(2);

    // vlezna: TM i po knizenje
    const [pi] = await t.db.insert(s.purchaseInvoices).values({ clientId: t.c1.id, partnerId: t.p1.id, year: 2026, supplierNumber: "D-1", issueDate: "2026-10-03", receivedDate: "2026-10-06" }).returning();
    await t.db.insert(s.purchaseLines).values({ purchaseInvoiceId: pi!.id, lineNo: 1, description: "Набавка", unit: "ком", qty: "1", unitPrice: "300", vatRateId: t.vat18.id, vatRatePct: "18",
      ...calcLine({ qty: 1, unitPrice: 300, vatRatePct: 18 }) });
    await expect(postPurchase(t.db, pi!.id, { userId: t.user.id }, false)).rejects.toThrow(/трошковно место/);
    await call("PATCH", `${C()}`, { costCenterMode: "optional" });
    await postPurchase(t.db, pi!.id, { userId: t.user.id }, false);
    // masovno: proba pa izvrsi
    expect((await call("POST", `${C()}/cost-centers/assign`, { kind: "purchase", from: "2026-10-01", to: "2026-10-31", costCenterId: b.id })).body).toEqual({ count: 1, applied: false });
    expect((await call("POST", `${C()}/cost-centers/assign`, { kind: "purchase", from: "2026-10-01", to: "2026-10-31", costCenterId: b.id, dryRun: false })).body).toEqual({ count: 1, applied: true });
    await expect(t.db.update(s.purchaseInvoices).set({ note: "x" }).where(eq(s.purchaseInvoices.id, pi!.id))).rejects.toThrow();

    const r = (await call("GET", `${C()}/reports/cost-centers?from=2026-10-01&to=2026-10-31`)).body;
    const by = (code: string) => r.rows.find((x: { code: string }) => x.code === code);
    // i2: stavka1 (PRO->SRV preku stavka? ne: stavka1 = SRV po promenata, stavka2 = SRV) = 1500; i3 = PRO 200; vlezna SRV 300
    expect(by("SRV")).toMatchObject({ revenue: "1500.00", costs: "300.00", result: "1200.00" });
    expect(by("PRO")).toMatchObject({ revenue: "200.00", costs: "0.00" });
    expect(r.totals).toMatchObject({ revenue: "1700.00", costs: "300.00" });
    expect((await call("GET", `${C()}/reports/cost-centers/${b.id}?from=2026-10-01&to=2026-10-31`)).body.invoices).toHaveLength(1);
    expect((await call("GET", `${C()}/reports/cost-centers?from=2026-10-01&to=2026-10-31&format=csv`)).raw.body).toContain("Сервис;1500,00;300,00;1200,00");
  });

  it("картица на партнер: купувач, добавувач, заедно = ИОС; сторно и корекција; PDF и CSV", async () => {
    const mk = async (o: Partial<typeof s.invoices.$inferInsert>, price: number) => {
      const [i] = await t.db.insert(s.invoices).values({ clientId: t.c1.id, partnerId: t.p1.id, year: 2026, issueDate: "2026-10-05", supplyDate: "2026-10-05", ...o }).returning();
      const neg = o.docType === "ST" ? -1 : 1;
      await t.db.insert(s.invoiceLines).values({ invoiceId: i!.id, lineNo: 1, description: "x", unit: "ком", qty: String(neg), unitPrice: String(price), vatRateId: t.vat18.id, vatRatePct: "18",
        ...calcLine({ qty: 1, unitPrice: price, vatRatePct: 18 }, neg) });
      return issueInvoice(t.db, i!.id, { userId: t.user.id });
    };
    const a = await mk({ issueDate: "2026-09-10", supplyDate: "2026-09-10" }, 1000);   // 1180, pred periodot
    const b = await mk({}, 500);                                                        // 590
    const reasons = await t.db.select().from(s.ujpReasons);
    await mk({ docType: "ST", relatedInvoiceId: b.id, voidReasonCode: reasons.find((x) => x.kind === "void")!.code, correctionReason: "г", issueDate: "2026-10-20", supplyDate: "2026-10-20" }, 500);
    await mk({ docType: "KR", relatedInvoiceId: a.id, correctionReasonCode: reasons.find((x) => x.kind === "correction")!.code, correctionReason: "ц", issueDate: "2026-10-21", supplyDate: "2026-09-10" }, 1100);   // 1298 -> razlika 118
    const [pi] = await t.db.insert(s.purchaseInvoices).values({ clientId: t.c1.id, partnerId: t.p1.id, year: 2026, supplierNumber: "D-1", issueDate: "2026-10-03", receivedDate: "2026-10-06" }).returning();
    await t.db.insert(s.purchaseLines).values({ purchaseInvoiceId: pi!.id, lineNo: 1, description: "y", unit: "ком", qty: "1", unitPrice: "300", vatRateId: t.vat18.id, vatRatePct: "18",
      ...calcLine({ qty: 1, unitPrice: 300, vatRatePct: 18 }) });
    await postPurchase(t.db, pi!.id, { userId: t.user.id }, false);   // 354
    await call("POST", `${C()}/payments`, { direction: "in", partnerId: t.p1.id, payDate: "2026-10-25", amount: 1000, method: "bank", reference: "извод 7" });
    await call("POST", `${C()}/payments`, { direction: "out", partnerId: t.p1.id, payDate: "2026-10-26", amount: 100, method: "bank" });

    const cu = await partnerCard(t.db, t.c1.id, t.p1.id, "customer", "2026-10-01", "2026-10-31");
    expect(cu.opening).toBe("1180.00");
    expect(cu.rows.map((r) => [r.type, r.debit, r.credit, r.balance])).toEqual([
      ["INV", "590.00", "0.00", "1770.00"], ["ST", "0.00", "590.00", "1180.00"], ["KR", "118.00", "0.00", "1298.00"], ["PIN", "0.00", "1000.00", "298.00"]]);
    const su = await partnerCard(t.db, t.c1.id, t.p1.id, "supplier", "2026-10-01", "2026-10-31");
    expect(su).toMatchObject({ opening: "0.00", debit: "100.00", credit: "354.00", closing: "254.00" });
    const both = await partnerCard(t.db, t.c1.id, t.p1.id, "both", "2026-01-01", "2026-10-31");
    expect(both.closing).toBe("44.00");   // 298 - 254
    // kontrola: kartica (zaedno) = IOS
    for (const d of ["2026-09-30", "2026-10-21", "2026-10-31"]) {
      const c = await partnerCard(t.db, t.c1.id, t.p1.id, "both", "2026-01-01", d);
      expect(c.closing).toBe((await iosFor(t.db, t.c1.id, t.p1.id, d)).balance);
    }
    const sum = (await call("GET", `${C()}/partner-cards?side=both&from=2026-10-01&to=2026-10-31`)).body;
    expect(sum.rows[0]).toMatchObject({ partnerId: t.p1.id, opening: "1180.00", closing: "44.00" });
    expect((await call("GET", `${C()}/partners/${t.p1.id}/card?side=customer&from=2026-10-01&to=2026-10-31&format=pdf`)).raw.headers["content-type"]).toBe("application/pdf");
    const csv = (await call("GET", `${C()}/partners/${t.p1.id}/card?side=customer&from=2026-10-01&to=2026-10-31&format=csv`)).raw.body;
    expect(csv).toContain("2026-10-01;Почетно салдо;;;;;1180,00");
    expect(csv).toContain("Промет и крајно салдо;;;708,00;1590,00;298,00");
  });
});
