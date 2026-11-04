import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { clientAccess, clients, items, users, warehouses } from "../src/db/schema.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";

let t: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let ana: string, admin: string, wh: number, goods: number, svc: number;
beforeEach(async () => {
  t = await testDb();
  app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64") });
  const [a] = await t.db.insert(users).values({ email: "ana@x.mk", displayName: "Ана", provider: "entra", role: "accountant" }).returning();
  await t.db.insert(clientAccess).values({ clientId: t.c1.id, userId: a!.id });
  ana = `${SESSION_COOKIE}=${await createSession(t.db, a!.id, true, {})}`;
  admin = `${SESSION_COOKIE}=${await createSession(t.db, t.user.id, true, {})}`;
  await t.db.update(clients).set({ modules: ["invoices", "incoming", "warehouse"] }).where(eq(clients.id, t.c1.id));
  [{ id: wh }] = await t.db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.clientId, t.c1.id));
  goods = (await t.db.insert(items).values({ clientId: t.c1.id, code: "G1", name: "Стока", type: "goods", unit: "ком", unitPrice: "200", vatRateId: t.vat18.id }).returning())[0]!.id;
  svc = (await t.db.insert(items).values({ clientId: t.c1.id, code: "TR", name: "Превоз", type: "service", unit: "ком", unitPrice: "0", vatRateId: t.vat18.id }).returning())[0]!.id;
});
async function call(who: string, method: string, url: string, payload?: unknown) {
  const r = await app.inject({ method: method as never, url, payload: payload as never, headers: { cookie: who, ...(method === "GET" ? {} : { "x-efaktura": "1" }) } });
  return { status: r.statusCode, body: r.body ? r.json() : null };
}
const C = () => `/api/clients/${t.c1.id}`;
const line = (itemId: number | null, qty: number, price: number, extra: object = {}) =>
  ({ itemId, description: "x", unit: "ком", qty, unitPrice: price, vatRateId: t.vat18.id, ...extra });

describe("API: vlezni fakturi i magacin", () => {
  it("vlezna faktura: nacrt -> knizenje -> zaliha -> storno", async () => {
    const r = await call(ana, "POST", `${C()}/purchases`, { partnerId: t.p1.id, supplierNumber: "F-77", issueDate: "2026-11-01", receivedDate: "2026-11-02",
      lines: [line(goods, 10, 100), line(svc, 1, 200, { allocate: true })] });
    expect(r.status).toBe(201);
    const posted = (await call(ana, "POST", `${C()}/purchases/${r.body.id}/post`)).body;
    expect(posted).toMatchObject({ number: "MC-VF-2026-00001", receiptNumber: "MC-PR-2026-00001" });
    const stock = (await call(ana, "GET", `${C()}/stock`)).body;
    expect(stock[0]).toMatchObject({ code: "G1", qty: "10.0000", value: "1200.0000", avgCost: "120.0000" });
    const card = (await call(ana, "GET", `${C()}/stock/card?itemId=${goods}`)).body;
    expect(card.moves).toHaveLength(1);
    expect((await call(ana, "PUT", `${C()}/purchases/${r.body.id}`, { partnerId: t.p1.id, supplierNumber: "F-77", issueDate: "2026-11-01", receivedDate: "2026-11-02", lines: [] })).status).toBe(409);
    expect((await call(ana, "POST", `${C()}/purchases/${r.body.id}/void`, { reason: "Погрешно", date: "2026-11-03" })).status).toBe(200);
    expect((await call(ana, "GET", `${C()}/stock`)).body).toHaveLength(0);
  });

  it("popis: izbroena kolicina -> razlika; otpis; storno samo za racni", async () => {
    await call(ana, "POST", `${C()}/stock-docs`, { kind: "receipt", warehouseId: wh, docDate: "2026-11-01", lines: [{ itemId: goods, qty: 10, unitCost: 50 }] });
    const inv = await call(ana, "POST", `${C()}/stock-docs`, { kind: "inventory", warehouseId: wh, docDate: "2026-11-02", lines: [{ itemId: goods, qty: 8 }] });
    expect(inv.body.number).toBe("MC-PO-2026-00001");
    const w = await call(ana, "POST", `${C()}/stock-docs`, { kind: "writeoff", warehouseId: wh, docDate: "2026-11-02", lines: [{ itemId: goods, qty: 1 }] });
    expect((await call(ana, "GET", `${C()}/stock`)).body[0]).toMatchObject({ qty: "7.0000", value: "350.0000" });
    expect((await call(ana, "POST", `${C()}/stock-docs`, { kind: "inventory", warehouseId: wh, docDate: "2026-11-02", lines: [{ itemId: goods, qty: 7 }] })).status).toBe(422);
    expect((await call(ana, "POST", `${C()}/stock-docs/${w.body.id}/reverse`, { date: "2026-11-03" })).body.number).toBe("MC-OT-2026-00002");
    const docs = (await call(ana, "GET", `${C()}/stock-docs`)).body;
    expect(docs.find((d: { id: number }) => d.id === w.body.id).reversed).toBe(true);
  });

  it("moduli: bez Magacin 403; bez Vlezni 403; tug klient 404", async () => {
    await t.db.update(clients).set({ modules: ["invoices"] }).where(eq(clients.id, t.c1.id));
    expect((await call(ana, "GET", `${C()}/stock`)).status).toBe(403);
    expect((await call(ana, "GET", `${C()}/purchases`)).status).toBe(403);
    expect((await call(ana, "GET", `/api/clients/${t.c2.id}/warehouses`)).status).toBe(404);
  });

  it("magacini: samo administrator; eden glaven", async () => {
    expect((await call(ana, "POST", `${C()}/warehouses`, { code: "P1", name: "Продавница" })).status).toBe(403);
    const w = (await call(admin, "POST", `${C()}/warehouses`, { code: "p1", name: "Продавница", isDefault: true })).body;
    expect(w.code).toBe("P1");
    const list = (await call(ana, "GET", `${C()}/warehouses`)).body;
    expect(list.filter((x: { isDefault: boolean }) => x.isDefault).map((x: { code: string }) => x.code)).toEqual(["P1"]);
    expect((await call(admin, "PATCH", `${C()}/warehouses/${w.id}`, { isActive: false })).status).toBe(422);
  });

  it("izdavanje faktura vrakja broj na ispratnica", async () => {
    await call(ana, "POST", `${C()}/stock-docs`, { kind: "receipt", warehouseId: wh, docDate: "2026-11-01", lines: [{ itemId: goods, qty: 5, unitCost: 50 }] });
    const d = await call(ana, "POST", `${C()}/invoices`, { partnerId: t.p1.id, issueDate: "2026-11-04", supplyDate: "2026-11-04",
      lines: [{ itemId: goods, description: "Стока", unit: "ком", qty: 2, unitPrice: 200, discountPct: 0, vatRateId: t.vat18.id }] });
    const r = await call(ana, "POST", `/api/invoices/${d.body.id}/issue`);
    expect(r.body).toMatchObject({ number: "MC-2026-00001", stockDocNumber: "MC-IS-2026-00001", stockWarnings: [] });
  });
});
