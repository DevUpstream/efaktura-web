import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { auditLog, users } from "../src/db/schema.js";
import { totpAt } from "../src/auth/crypto.js";
import type { OidcProvider, EntraClaims } from "../src/auth/entra.js";

const TENANT = "b4992b6b-a6e9-40b4-b296-9a937bcc6d04";
let t: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let nextClaims: EntraClaims;

const fakeEntra: OidcProvider = {
  async authUrl(p) { const u = new URL("https://login.example/authorize"); u.searchParams.set("state", p.state); return u; },
  async exchange(url, check) {
    if (url.searchParams.get("state") !== check.state) throw new Error("state");
    return nextClaims;
  },
};

beforeEach(async () => {
  t = await testDb();
  await t.db.delete(users).where(eq(users.id, t.user.id)).catch(() => {});   // helperot dodava korisnik; tuka pocnuvame bez admin
  app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test",
    appKey: randomBytes(32).toString("base64"), bootstrapAdminEmail: "dev@upstream.mk",
    entra: { provider: fakeEntra, tenantId: TENANT } });
});

/** Mal "prelistuvac": cuva kolacinja i go dodava CSRF zaglavieto. */
function browser() {
  const jar = new Map<string, string>();
  const keep = (r: LightMyRequestResponse) => {
    for (const c of r.cookies) c.value === "" || (c.maxAge !== undefined && c.maxAge <= 0) ? jar.delete(c.name) : jar.set(c.name, c.value);
    return r;
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  return {
    get: async (url: string) => keep(await app.inject({ method: "GET", url, headers: { cookie: cookie() } })),
    post: async (url: string, body?: unknown, csrf = true) => keep(await app.inject({ method: "POST", url, payload: body ?? {},
      headers: { cookie: cookie(), ...(csrf ? { "x-efaktura": "1" } : {}) } })),
    put: async (url: string, body: unknown) => keep(await app.inject({ method: "PUT", url, payload: body, headers: { cookie: cookie(), "x-efaktura": "1" } })),
    patch: async (url: string, body: unknown) => keep(await app.inject({ method: "PATCH", url, payload: body, headers: { cookie: cookie(), "x-efaktura": "1" } })),
  };
}

async function entraLogin(b: ReturnType<typeof browser>, claims: Partial<EntraClaims> = {}) {
  nextClaims = { oid: "11111111-1111-1111-1111-111111111111", tid: TENANT, email: "dev@upstream.mk", name: "Dev", ...claims };
  const start = await b.get("/api/auth/entra/login");
  expect(start.statusCode).toBe(302);
  const state = new URL(start.headers.location as string).searchParams.get("state");
  return b.get(`/api/auth/entra/callback?code=x&state=${state}`);
}

describe("najava so Microsoft (Entra)", () => {
  it("prv administrator (bootstrap), potoa /me so site klienti", async () => {
    const b = browser();
    const r = await entraLogin(b);
    expect(r.headers.location).toBe("/");
    const me = (await b.get("/api/auth/me")).json();
    expect(me).toMatchObject({ authenticated: true, pending: null, user: { email: "dev@upstream.mk", role: "admin" } });
    expect(me.clients.map((c: { prefix: string }) => c.prefix).sort()).toEqual(["MC", "UPSTRI"]);
  });

  it("nepoznat korisnik i drug tenant se odbieni", async () => {
    expect((await entraLogin(browser(), { email: "x@drug.mk", oid: "22222222-2222-2222-2222-222222222222" })).headers.location).toBe("/?login_error=no_access");
    expect((await entraLogin(browser(), { tid: "00000000-0000-0000-0000-000000000000" })).headers.location).toBe("/?login_error=tenant");
  });

  it("bootstrap vazi samo dodeka nema administrator", async () => {
    await entraLogin(browser());
    await t.db.update(users).set({ role: "accountant", entraOid: null, isActive: false });
    await t.db.insert(users).values({ email: "a@b.mk", displayName: "A", provider: "entra", role: "admin" });
    const r = await entraLogin(browser(), { oid: "33333333-3333-3333-3333-333333333333" });
    expect(r.headers.location).toBe("/?login_error=no_access");
  });

  it("povik bez validna state kolace e odbien", async () => {
    nextClaims = { oid: "1", tid: TENANT, email: "dev@upstream.mk", name: "D" };
    expect((await browser().get("/api/auth/entra/callback?code=x&state=y")).headers.location).toBe("/?login_error=expired");
  });
});

describe("sopstveni smetki: pokana, lozinka, TOTP", () => {
  async function adminWithLocalUser() {
    const admin = browser(); await entraLogin(admin);
    const created = (await admin.post("/api/users", { email: "Ana@Firma.mk", displayName: "Ана", provider: "local" })).json();
    const inv = (await admin.post(`/api/users/${created.id}/invite`)).json();
    return { admin, id: created.id as number, token: inv.link.split("#")[1] as string };
  }

  it("celosen tek: pokana -> lozinka -> TOTP setup -> pristap samo do dodeleni klienti", async () => {
    const { admin, id, token } = await adminWithLocalUser();
    const ana = browser();
    expect((await ana.post("/api/auth/set-password", { token, password: "kratka" })).statusCode).toBe(400);
    expect((await ana.post("/api/auth/set-password", { token, password: "Dolga-Lozinka-2026!" })).statusCode).toBe(200);
    expect((await ana.post("/api/auth/set-password", { token, password: "Dolga-Lozinka-2026!" })).statusCode).toBe(400); // ednokraten

    expect((await ana.post("/api/auth/login", { email: "ana@firma.mk", password: "Dolga-Lozinka-2026!" })).json().pending).toBe("totp_setup");
    expect((await ana.get("/api/clients")).statusCode).toBe(401);           // bez TOTP nema pristap
    const { secret } = (await ana.post("/api/auth/totp/setup")).json();
    const code = totpAt(secret, Math.floor(Date.now() / 30_000));
    expect((await ana.post("/api/auth/totp/confirm", { code })).statusCode).toBe(200);

    expect((await ana.get("/api/clients")).json()).toEqual([]);             // nema dodeleno klient
    expect((await admin.put(`/api/clients/${t.c1.id}/access/${id}`, { isActive: true })).statusCode).toBe(200);
    expect((await ana.get("/api/clients")).json().map((c: { prefix: string }) => c.prefix)).toEqual(["MC"]);
    expect((await ana.get("/api/users")).statusCode).toBe(403);             // ne e admin

    // povtorna najava: TOTP, istiot kod ne vazi vtorpat
    const ana2 = browser();
    expect((await ana2.post("/api/auth/login", { email: "ana@firma.mk", password: "Dolga-Lozinka-2026!" })).json().pending).toBe("totp");
    expect((await ana2.post("/api/auth/totp/verify", { code })).statusCode).toBe(401);
  });

  it("zaklucuvanje po 5 pogresni lozinki, ista poraka za nepostoecka smetka", async () => {
    const { token } = await adminWithLocalUser();
    const b = browser();
    await b.post("/api/auth/set-password", { token, password: "Dolga-Lozinka-2026!" });
    const unknown = await b.post("/api/auth/login", { email: "nema@nikoj.mk", password: "x" });
    const wrong = await b.post("/api/auth/login", { email: "ana@firma.mk", password: "x" });
    expect(unknown.json().message).toBe(wrong.json().message);
    for (let i = 0; i < 4; i++) await b.post("/api/auth/login", { email: "ana@firma.mk", password: "x" });
    expect((await b.post("/api/auth/login", { email: "ana@firma.mk", password: "Dolga-Lozinka-2026!" })).statusCode).toBe(423);
    const actions = (await t.db.select().from(auditLog)).map((a) => a.action);
    expect(actions.filter((a) => a === "login_failed")).toHaveLength(5);
  });
});

describe("zastita", () => {
  it("CSRF: POST bez zaglavie e odbien", async () => {
    expect((await browser().post("/api/auth/login", { email: "a@b.mk", password: "x" }, false)).statusCode).toBe(403);
  });
  it("posledniot administrator ne moze da se deaktivira", async () => {
    const admin = browser(); await entraLogin(admin);
    const me = (await admin.get("/api/auth/me")).json();
    expect((await admin.patch(`/api/users/${me.user.id}`, { isActive: false })).statusCode).toBe(409);
  });
  it("odjava ja brise sesijata", async () => {
    const b = browser(); await entraLogin(b);
    await b.post("/api/auth/logout");
    expect((await b.get("/api/clients")).statusCode).toBe(401);
  });
});
