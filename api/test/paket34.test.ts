/** Пакети 3 и 4 (забелешки 1/7, 11, 15, 16/18/19, 22): серверски дел. */
import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { clientAccess, clients, items, users } from "../src/db/schema.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { DUNNING_TEXT, DUNNING_TITLE } from "../src/domain/receivables.js";

let t: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let ana: string, admin: string, anaId: number;
beforeEach(async () => {
  t = await testDb();
  app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64") });
  const [a] = await t.db.insert(users).values({ email: "ana@x.mk", displayName: "Ана Погрешно", provider: "local", role: "accountant" }).returning();
  anaId = a!.id;
  await t.db.insert(clientAccess).values({ clientId: t.c1.id, userId: a!.id });
  ana = `${SESSION_COOKIE}=${await createSession(t.db, a!.id, true, {})}`;
  admin = `${SESSION_COOKIE}=${await createSession(t.db, t.user.id, true, {})}`;
});
async function call(who: string, method: string, url: string, payload?: unknown) {
  const r = await app.inject({ method: method as never, url, payload: payload as never, headers: { cookie: who, ...(method === "GET" ? {} : { "x-efaktura": "1" }) } });
  return { status: r.statusCode, headers: r.headers, body: r.headers["content-type"]?.includes("json") && r.body ? r.json() : r.rawPayload };
}
const C = () => `/api/clients/${t.c1.id}`;

describe("1/7: уреди корисник", () => {
  it("име и е-пошта (сопствена сметка); дупликат; Microsoft поврзана – е-поштата не се менува; само админ", async () => {
    expect((await call(ana, "PATCH", `/api/users/${anaId}`, { displayName: "Ана Точно" })).status).toBe(403);
    const r = await call(admin, "PATCH", `/api/users/${anaId}`, { displayName: "Ана Точно", email: "Ana.Tochno@X.mk" });
    expect(r.body).toMatchObject({ displayName: "Ана Точно", email: "ana.tochno@x.mk" });
    expect((await call(admin, "PATCH", `/api/users/${anaId}`, { email: "dev@upstream.mk" })).status).toBe(409);
    const [m] = await t.db.insert(users).values({ email: "ms@x.mk", displayName: "МС", provider: "entra", role: "accountant",
      entraOid: "00000000-0000-0000-0000-000000000001" }).returning();
    expect((await call(admin, "PATCH", `/api/users/${m!.id}`, { email: "drug@x.mk" })).body.message).toMatch(/кај Microsoft/);
    expect((await call(admin, "PATCH", `/api/users/${m!.id}`, { displayName: "Марија" })).body.displayName).toBe("Марија");
  });
});

describe("15, 22: единици мерка и текст на опомените", () => {
  it("листа по фирма во /me (стандардна ако нема), без дупликати; текст на опомена; ниво 3 = опомена пред тужба", async () => {
    const me0 = (await call(ana, "GET", "/api/auth/me")).body;
    expect(me0.clients[0].units[0]).toBe("парче");
    const r = await call(admin, "PATCH", C(), { units: ["парче", "кг", "кг", "рол"], dunningTexts: { "3": "Последна покана пред тужба.\nРок 5 дена." } });
    expect(r.body.units).toEqual(["парче", "кг", "рол"]);
    expect((await call(ana, "GET", "/api/auth/me")).body.clients.find((c: { id: number }) => c.id === t.c1.id).units).toEqual(["парче", "кг", "рол"]);
    expect((await call(admin, "PATCH", C(), { units: ["предолга единица"] })).status).toBe(400);
    expect((await call(ana, "PATCH", C(), { units: ["x"] })).status).toBe(403);
    expect(DUNNING_TITLE[3]).toBe("Опомена пред тужба");
    expect(DUNNING_TEXT[3]).toMatch(/тужба/);
    const [c] = await t.db.select().from(clients).where(eq(clients.id, t.c1.id));
    expect(c!.dunningTexts).toEqual({ "3": "Последна покана пред тужба.\nРок 5 дена." });
  });
});

describe("11: КВФ", () => {
  it("CSV на книгата на влезни фактури се вика KVF", async () => {
    await t.db.update(clients).set({ modules: ["invoices", "incoming"] }).where(eq(clients.id, t.c1.id));
    const r = await call(ana, "GET", `${C()}/vat-books/kuf?from=2026-11-01&to=2026-11-30&format=csv`);
    expect(r.status).toBe(200);
    expect(String(r.headers["content-disposition"])).toContain("-KVF-");
  });
});

describe("16, 18, 19: цени по артикл", () => {
  it("излез (во валутата на фактурата) и влез, со партнер; филтер по купувач, насока, валута", async () => {
    await t.db.update(clients).set({ modules: ["invoices", "incoming"] }).where(eq(clients.id, t.c1.id));
    const [it] = await t.db.insert(items).values({ clientId: t.c1.id, code: "K1", name: "Кабел", type: "goods", unit: "м", unitPrice: "100", vatRateId: t.vat18.id }).returning();
    const line = (price: number, qty = 1) => ({ itemId: it!.id, description: "Кабел", unit: "м", qty, unitPrice: price, vatRateId: t.vat18.id });
    for (const [d, p] of [["2026-11-02", 110], ["2026-11-05", 120]] as const) {
      const x = await call(ana, "POST", `${C()}/invoices`, { partnerId: t.p1.id, issueDate: d, supplyDate: d, lines: [line(p, 10)] });
      expect((await call(ana, "POST", `/api/invoices/${x.body.id}/issue`)).status).toBe(200);
    }
    const draft = await call(ana, "POST", `${C()}/invoices`, { partnerId: t.p1.id, issueDate: "2026-11-06", lines: [line(999)] });   // nacrt – ne vleguva
    expect(draft.status).toBe(201);
    const pur = await call(ana, "POST", `${C()}/purchases`, { partnerId: t.p1.id, supplierNumber: "F-9", issueDate: "2026-11-01", receivedDate: "2026-11-01",
      lines: [{ ...line(70, 50), description: "Кабел" }] });
    expect((await call(ana, "POST", `${C()}/purchases/${pur.body.id}/post`)).status).toBe(200);

    const all = (await call(ana, "GET", `${C()}/items/${it!.id}/prices`)).body;
    expect(all.map((r: { direction: string; price: string; date: string }) => [r.direction, Number(r.price), r.date])).toEqual([
      ["out", 120, "2026-11-05"], ["out", 110, "2026-11-02"], ["in", 70, "2026-11-01"]]);
    expect(all[0]).toMatchObject({ number: "MC-2026-00002", partnerId: t.p1.id, currency: "MKD" });
    expect(all[2].number).toContain("F-9");
    const out = (await call(ana, "GET", `${C()}/items/${it!.id}/prices?direction=out&limit=1&partnerId=${t.p1.id}`)).body;
    expect(out).toHaveLength(1);
    expect((await call(ana, "GET", `${C()}/items/${it!.id}/prices?currency=EUR`)).body).toHaveLength(0);
    expect([403, 404]).toContain((await call(ana, "GET", `/api/clients/${t.c2.id}/items/${it!.id}/prices`)).status);   // tugja firma: nema podatoci
  });
});
