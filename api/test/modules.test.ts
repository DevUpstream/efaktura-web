import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { clientAccess, clients, users } from "../src/db/schema.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { effectiveModules, normalizeClientModules } from "../src/domain/modules.js";

let t: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let admin: string, ana: string, anaId: number;
beforeEach(async () => {
  t = await testDb();
  app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64") });
  const [a] = await t.db.insert(users).values({ email: "ana@x.mk", displayName: "Ана", provider: "entra", role: "accountant" }).returning();
  const [g] = await t.db.insert(users).values({ email: "boss@x.mk", displayName: "Адис", provider: "entra", role: "admin" }).returning();
  anaId = a!.id;
  await t.db.insert(clientAccess).values({ clientId: t.c1.id, userId: a!.id });
  ana = `${SESSION_COOKIE}=${await createSession(t.db, a!.id, true, {})}`;
  admin = `${SESSION_COOKIE}=${await createSession(t.db, g!.id, true, {})}`;
});
async function call(who: string, method: string, url: string, payload?: unknown) {
  const r = await app.inject({ method: method as never, url, payload: payload as never, headers: { cookie: who, ...(method === "GET" ? {} : { "x-efaktura": "1" }) } });
  return { status: r.statusCode, body: r.body ? r.json() : null };
}

describe("moduli po klient", () => {
  it("pravila: fakturi sekogas; proizvodstvo bara magacin; korisnikot gleda presek", () => {
    expect(normalizeClientModules(["crm"]).modules).toEqual(["invoices", "crm"]);
    expect(normalizeClientModules(["production"]).error).toMatch(/Магацин/);
    expect(effectiveModules(["invoices", "crm", "warehouse"], "accountant", ["warehouse"])).toEqual(["invoices", "warehouse"]);
    expect(effectiveModules(["invoices", "crm"], "accountant", null)).toEqual(["invoices", "crm"]);
    expect(effectiveModules(["invoices"], "admin", ["crm"])).toEqual(["invoices"]);
  });

  it("administratorot gi menuva modulite; /me gi vrakja; iskluceniot modul e 403", async () => {
    const me1 = (await call(ana, "GET", "/api/auth/me")).body;
    expect(me1.clients[0].modules).toEqual(["invoices", "crm"]);
    expect((await call(ana, "GET", `/api/clients/${t.c1.id}/followups`)).status).toBe(200);
    expect((await call(ana, "PUT", `/api/clients/${t.c1.id}/modules`, { modules: ["invoices"] })).status).toBe(403);
    expect((await call(admin, "PUT", `/api/clients/${t.c1.id}/modules`, { modules: ["production"] })).status).toBe(422);
    expect((await call(admin, "PUT", `/api/clients/${t.c1.id}/modules`, { modules: ["warehouse"] })).body.modules).toEqual(["invoices", "warehouse"]);
    expect((await call(ana, "GET", `/api/clients/${t.c1.id}/followups`)).status).toBe(403);
    expect((await call(ana, "GET", "/api/auth/me")).body.clients[0].modules).toEqual(["invoices", "warehouse"]);
  });

  it("moduli po korisnik: samo izbranite; null = site", async () => {
    expect((await call(admin, "PUT", `/api/clients/${t.c1.id}/access/${anaId}`, { modules: [] })).status).toBe(200);
    expect((await call(ana, "GET", `/api/clients/${t.c1.id}/followups`)).status).toBe(403);
    const list = (await call(admin, "GET", "/api/users")).body.find((u: { id: number }) => u.id === anaId);
    expect(list.clientModules[t.c1.id]).toEqual([]);
    await call(admin, "PUT", `/api/clients/${t.c1.id}/access/${anaId}`, { modules: null });
    expect((await call(ana, "GET", `/api/clients/${t.c1.id}/followups`)).status).toBe(200);
    // pristapot ostanuva aktiven koga se menuvaat samo modulite
    const [row] = await t.db.select().from(clientAccess).where(eq(clientAccess.userId, anaId));
    expect(row!.isActive).toBe(true);
  });

  it("bazata odbiva nepoznat modul i klient bez fakturi", async () => {
    const err = async (p: PromiseLike<unknown>) => { try { await p; return ""; } catch (e) { return ((e as { cause?: Error }).cause ?? (e as Error)).message; } };
    expect(await err(t.db.update(clients).set({ modules: ["crm"] }).where(eq(clients.id, t.c1.id)))).toMatch(/clients_modules_ck/);
    expect(await err(t.db.update(clients).set({ modules: ["invoices", "hr"] }).where(eq(clients.id, t.c1.id)))).toMatch(/clients_modules_ck/);
  });
});
