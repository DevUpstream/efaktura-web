import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { clients, invoiceLines, invoices } from "../src/db/schema.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { calcLine } from "../src/domain/calc.js";
import { issueInvoice } from "../src/domain/issue.js";
import { gradeOf, partnerScores } from "../src/domain/score.js";

let t: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance; let admin: string;
beforeEach(async () => {
  t = await testDb();
  app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64") });
  admin = `${SESSION_COOKIE}=${await createSession(t.db, t.user.id, true, {})}`;
  await t.db.update(clients).set({ modules: ["invoices", "payments"] }).where(eq(clients.id, t.c1.id));
});
const call = async (method: string, url: string, payload?: unknown) => {
  const r = await app.inject({ method: method as never, url, payload: payload as never, headers: { cookie: admin, ...(method === "GET" ? {} : { "x-efaktura": "1" }) } });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
const C = () => `/api/clients/${t.c1.id}`;
async function inv(price: number, issue: string, due: string) {
  const [i] = await t.db.insert(invoices).values({ clientId: t.c1.id, partnerId: t.p1.id, year: 2026, issueDate: issue, supplyDate: issue, dueDate: due }).returning();
  await t.db.insert(invoiceLines).values({ invoiceId: i!.id, lineNo: 1, description: "У", unit: "ком", qty: "1", unitPrice: String(price), vatRateId: t.vat18.id, vatRatePct: "18",
    ...calcLine({ qty: 1, unitPrice: price, vatRatePct: 18 }) });
  return issueInvoice(t.db, i!.id, { userId: t.user.id });
}
const pay = (id: number, amount: number, payDate: string) => call("POST", `${C()}/payments`, { direction: "in", partnerId: t.p1.id, payDate, amount, allocations: [{ id, amount }] });

describe("platezhna disciplina", () => {
  it("granici na ocenkata", () => {
    expect(gradeOf(null, 0, false)).toBe("-");
    expect(gradeOf(3, 10, true)).toBe("A");
    expect(gradeOf(15, 40, true)).toBe("B");
    expect(gradeOf(30, 80, true)).toBe("V");
    expect(gradeOf(60, 0, true)).toBe("G");
    expect(gradeOf(0, 120, true)).toBe("G");   // redovno plakjal, no sega ima dolg nad 90 dena
  });

  it("prosecno zadocnuvanje ponderirano so iznosot; zadocneto sega", async () => {
    const a = await inv(1000, "2026-08-01", "2026-08-15");   // 1180, platena 10 dena docna
    const b = await inv(100, "2026-09-01", "2026-09-15");    // 118, platena 40 dena docna
    await inv(500, "2026-09-20", "2026-10-01");              // 590, otvorena
    await pay(a.id, 1180, "2026-08-25"); await pay(b.id, 118, "2026-10-25");
    const [s] = await partnerScores(t.db, t.c1.id, { partnerId: t.p1.id, asOf: "2026-11-05" });
    // (10 x 1180 + 40 x 118) / 1298 = 12.7
    expect(s).toMatchObject({ grade: "B", avgDaysLate: 13, paidCount: 2, lateShare: 100, open: "590.00", overdue: "590.00", maxDaysOverdue: 35 });
    expect(s!.warnings[0]).toMatch(/задоцнет долг 590,00 ден., најстар 35 дена/);
  });

  it("kreditni limit: predupreduvanje so novata faktura", async () => {
    await inv(1000, "2026-11-01", "2026-12-01");   // 1180 otvoreno, ne e dospeano
    expect((await call("PUT", `${C()}/partners/${t.p1.id}/credit-limit`, { creditLimit: 2000 })).body.creditLimit).toBe("2000.00");
    const ok = (await call("GET", `${C()}/partners/${t.p1.id}/score?extra=500`)).body;
    expect(ok).toMatchObject({ limitUsed: 84, warnings: [] });
    const over = (await call("GET", `${C()}/partners/${t.p1.id}/score?extra=1000`)).body;
    expect(over.warnings[0]).toMatch(/лимит .* надминат: отворено \+ оваа фактура 2.180 ден/);
    expect((await call("GET", `${C()}/partner-scores`)).body.find((x: { partnerId: number }) => x.partnerId === t.p1.id).grade).toBe("A");
    await call("PUT", `${C()}/partners/${t.p1.id}/credit-limit`, { creditLimit: null });
    expect((await call("GET", `${C()}/partners/${t.p1.id}/score?extra=99999`)).body.warnings).toEqual([]);
  });
});
