import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { clients, invoices, purchaseInvoices } from "../src/db/schema.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";

describe("godini za listite (fakturi, vlezni)", () => {
  it("razlicni godini, najnovata prva; samo za svojata firma", async () => {
    const t = await testDb();
    const app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64") });
    const cookie = `${SESSION_COOKIE}=${await createSession(t.db, t.user.id, true, {})}`;
    await t.db.update(clients).set({ modules: ["invoices", "incoming"] }).where(eq(clients.id, t.c2.id));
    for (const y of [2025, 2024, 2025]) await t.db.insert(invoices).values({ clientId: t.c2.id, partnerId: t.p2.id, year: y, issueDate: `${y}-05-01` });
    await t.db.insert(invoices).values({ clientId: t.c1.id, partnerId: t.p1.id, year: 2023, issueDate: "2023-05-01" });
    await t.db.insert(purchaseInvoices).values({ clientId: t.c2.id, partnerId: t.p2.id, year: 2026, supplierNumber: "1", issueDate: "2026-01-01", receivedDate: "2026-01-01" });
    const get = async (u: string) => (await app.inject({ method: "GET", url: u, headers: { cookie } })).json();
    expect(await get(`/api/clients/${t.c2.id}/invoices/years`)).toEqual([2025, 2024]);
    expect(await get(`/api/clients/${t.c2.id}/purchases/years`)).toEqual([2026]);
    expect((await get(`/api/clients/${t.c2.id}/invoices`)).length).toBe(3);   // bez godina = site
  });
});
