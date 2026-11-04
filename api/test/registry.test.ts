import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { clientAccess, clients, partners, users } from "../src/db/schema.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";

let t: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let admin: string, ana: string, agentKey: string;
const UPSTREAM = { name: "УПСТРЕАМ Д.О.О.Е.Л. УВОЗ-ИЗВОЗ КРИВА ПАЛАНКА", address: "СВ.ЈОАКИМ ОСОГОВСКИ 69/9", city: "КРИВА ПАЛАНКА",
  postalCode: "1330", vatNumber: "МК4015023508550", embs: "7696531", countryCode: "MK" };

beforeEach(async () => {
  t = await testDb();
  app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64") });
  await t.db.update(users).set({ provider: "entra", passwordHash: null }).where(eq(users.id, t.user.id));
  admin = `${SESSION_COOKIE}=${await createSession(t.db, t.user.id, true, {})}`;
  const [a] = await t.db.insert(users).values({ email: "ana@x.mk", displayName: "Ана", provider: "entra", role: "accountant" }).returning();
  await t.db.insert(clientAccess).values({ clientId: t.c1.id, userId: a!.id });
  ana = `${SESSION_COOKIE}=${await createSession(t.db, a!.id, true, {})}`;
  agentKey = (await call(admin, "POST", "/api/agent-keys", { name: "Компјутер со токенот" })).body.key;
});

async function call(cookie: string, method: string, url: string, payload?: unknown) {
  const r = await app.inject({ method: method as never, url, payload: payload as never, headers: { cookie, ...(method === "GET" ? {} : { "x-efaktura": "1" }) } });
  return { status: r.statusCode, body: r.body ? r.json() : null };
}
async function agent(method: string, url: string, payload?: unknown, key = agentKey) {
  const r = await app.inject({ method: method as never, url, payload: payload as never, headers: { "x-agent-key": key, ...(method === "GET" ? {} : { "x-efaktura": "1" }) } });
  return { status: r.statusCode, body: r.body ? r.json() : null };
}

describe("registar na UJP preku agentot", () => {
  it("nov klient: baranje -> agent -> rezultat -> kreiraj so UJP ✓", async () => {
    const req = await call(admin, "POST", "/api/ujp/registry-requests", { edb: "4024016505642" });
    expect(req.status).toBe(201);
    expect((await call(admin, "POST", "/api/ujp/registry-requests", { edb: "4024016505642" })).body.id).toBe(req.body.id);   // bez duplikat
    expect((await call(admin, "POST", "/api/clients", { edb: "4024016505642", registryRequestId: req.body.id, invoicePrefix: "UP" })).status).toBe(422);
    const pending = (await agent("GET", "/api/agent/registry-requests")).body;
    expect(pending).toEqual([{ id: req.body.id, edb: "4024016505642", sellerEdb: "4024016505642" }]);
    expect((await agent("POST", `/api/agent/registry-requests/${req.body.id}`, { ok: true, company: UPSTREAM })).status).toBe(200);
    expect((await call(admin, "GET", `/api/ujp/registry-requests/${req.body.id}`)).body).toMatchObject({ status: "done", result: { embs: "7696531" } });
    // postoecko EDB -> 409
    const dupReq = (await call(admin, "POST", "/api/ujp/registry-requests", { edb: "4015023508550" })).body;
    await agent("POST", `/api/agent/registry-requests/${dupReq.id}`, { ok: true, company: UPSTREAM });
    expect((await call(admin, "POST", "/api/clients", { edb: "4015023508550", registryRequestId: dupReq.id, invoicePrefix: "XX" })).status).toBe(409);
    const c = await call(admin, "POST", "/api/clients", { edb: "4024016505642", registryRequestId: req.body.id, invoicePrefix: "up2" });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ name: UPSTREAM.name, invoicePrefix: "UP2", vatPayer: true, embs: "7696531", postalCode: "1330" });
    expect(c.body.ujpRegistryAt).toBeTruthy();
    expect((await agent("GET", "/api/agent/registry-requests")).body).toEqual([]);
  });

  it("postoecki klient: razliki -> primeni (samo admin)", async () => {
    await t.db.update(clients).set({ edb: "4015023508550", name: "Стар назив" }).where(eq(clients.id, t.c2.id));
    const req = (await call(admin, "POST", "/api/ujp/registry-requests", { clientId: t.c2.id })).body;
    await agent("POST", `/api/agent/registry-requests/${req.id}`, { ok: true, company: UPSTREAM });
    const st = (await call(admin, "GET", `/api/ujp/registry-requests/${req.id}`)).body;
    expect(st.diff.map((d: { field: string }) => d.field)).toEqual(expect.arrayContaining(["name", "address", "embs"]));
    expect((await call(ana, "POST", `/api/ujp/registry-requests/${req.id}/apply`)).status).toBe(403);   // klient = samo admin
    expect((await call(admin, "POST", `/api/ujp/registry-requests/${req.id}/apply`)).body.ok).toBe(true);
    const [c] = await t.db.select().from(clients).where(eq(clients.id, t.c2.id));
    expect(c).toMatchObject({ name: UPSTREAM.name, vatPayer: true });
    expect(c!.ujpRegistryNote).toMatch(/Стар назив/);
  });

  it("kupuvac: smetkovoditel bara proverka i nov kupuvac od UJP; greska od UJP se prikazuva", async () => {
    const r1 = (await call(ana, "POST", "/api/ujp/registry-requests", { clientId: t.c1.id, partnerId: t.p1.id })).body;
    const r2 = (await call(ana, "POST", "/api/ujp/registry-requests", { clientId: t.c1.id, edb: "4024016505642" })).body;
    const r3 = (await call(ana, "POST", "/api/ujp/registry-requests", { clientId: t.c1.id, edb: "1111111111111" })).body;
    const list = (await agent("GET", "/api/agent/registry-requests")).body;
    expect(list.map((x: { sellerEdb: string }) => x.sellerEdb)).toEqual(["4030994180119", "4030994180119", "4030994180119"]);
    await agent("POST", `/api/agent/registry-requests/${r1.id}`, { ok: true, company: { ...UPSTREAM, name: "Купувач А ДОО", vatNumber: "" } });
    await agent("POST", `/api/agent/registry-requests/${r2.id}`, { ok: true, company: { ...UPSTREAM, name: "ДЕЛИШЕС КОМЕРЦ ДООЕЛ", city: "РЕСЕН" } });
    await agent("POST", `/api/agent/registry-requests/${r3.id}`, { ok: false, error: "companies/1111111111111: HTTP 404" });
    expect((await call(ana, "POST", `/api/ujp/registry-requests/${r1.id}/apply`)).body.ok).toBe(true);
    const [p] = await t.db.select().from(partners).where(eq(partners.id, t.p1.id));
    expect(p).toMatchObject({ name: "Купувач А ДОО", vatNumber: null });
    const np = await call(ana, "POST", `/api/clients/${t.c1.id}/partners/from-ujp`, { edb: "4024016505642", registryRequestId: r2.id });
    expect(np.body).toMatchObject({ name: "ДЕЛИШЕС КОМЕРЦ ДООЕЛ", city: "РЕСЕН" });
    expect((await call(ana, "GET", `/api/ujp/registry-requests/${r3.id}`)).body).toMatchObject({ status: "error", error: expect.stringContaining("404") });
    // nov klient (bez clientId) ne moze smetkovoditel
    expect((await call(ana, "POST", "/api/ujp/registry-requests", { edb: "4015023508550" })).status).toBe(403);
  });

  it("agent: bez klucot ili so deaktiviran kluc nema pristap; kluchot ne se cuva vo bazata", async () => {
    expect((await agent("GET", "/api/agent/registry-requests", undefined, "pogresen-kluc-pogresen-kluc-pogresen")).status).toBe(401);
    const keys = (await call(admin, "GET", "/api/agent-keys")).body;
    expect(JSON.stringify(keys)).not.toContain(agentKey);
    await call(admin, "PATCH", `/api/agent-keys/${keys[0].id}`, { isActive: false });
    expect((await agent("GET", "/api/agent/registry-requests")).status).toBe(401);
  });
});
