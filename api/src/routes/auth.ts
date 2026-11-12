import type { FastifyInstance } from "fastify";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { users, userTokens } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import { audit } from "../domain/audit.js";
import { newTotpSecret, otpauthUri, seal, sha256, unseal, verifyTotp } from "../auth/crypto.js";
import { hashPassword, passwordProblem, verifyPassword } from "../auth/passwords.js";
import { createSession, destroySession, destroyUserSessions, markMfaOk } from "../auth/sessions.js";
import { accessibleClients, clearSessionCookie, setSessionCookie } from "../auth/context.js";
import { pkce, type OidcProvider } from "../auth/entra.js";

export interface AuthDeps {
  db: Db; appKey: Buffer; publicUrl: string; bootstrapAdminEmail?: string;
  entra?: { provider: OidcProvider; tenantId: string };
}

const MAX_FAILED = 5, LOCK_MIN = 15;
const OIDC_COOKIE = "__Host-efo";
const Email = z.string().trim().toLowerCase().email().max(254);

export async function authRoutes(app: FastifyInstance, d: AuthDeps) {
  const { db, appKey } = d;
  const meta = (req: { ip: string; headers: Record<string, unknown> }) => ({ ip: req.ip, userAgent: String(req.headers["user-agent"] ?? "") });
  const strict = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  /* -------------------------------------------------------------- me */
  app.get("/api/auth/me", async (req) => {
    const u = req.user;
    if (!u) return { authenticated: false, entra: !!d.entra };
    const pending = u.provider === "local" && !u.mfaOk ? (u.totpEnabled ? "totp" : "totp_setup") : null;
    return {
      authenticated: true, pending,
      user: { id: u.id, email: u.email, displayName: u.displayName, role: u.role, provider: u.provider },
      clients: pending ? [] : (await accessibleClients(db, u)).map((c) => ({ id: c.id, name: c.name, edb: c.edb, prefix: c.invoicePrefix, modules: c.modules, costCenterMode: c.costCenterMode })),
    };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.user) {
      await destroySession(db, req.user.sessionHash);
      await audit(db, { userId: req.user.id, ip: req.ip }, { entity: "user", entityId: req.user.id, action: "logout" });
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  /* ------------------------------------------------ sopstveni smetki */
  app.post("/api/auth/login", strict, async (req, reply) => {
    const b = z.object({ email: Email, password: z.string().min(1).max(200) }).parse(req.body);
    const [u] = await db.select().from(users).where(sql`lower(${users.email}) = ${b.email}`);
    const fail = new DomainError("bad_credentials", "Погрешна е-пошта или лозинка.", 401);
    const ok = await verifyPassword(u?.provider === "local" ? u.passwordHash : null, b.password);
    if (!u || u.provider !== "local" || !u.isActive) throw fail;
    if (u.lockedUntil && u.lockedUntil > new Date())
      throw new DomainError("locked", `Сметката е привремено заклучена. Обидете се по ${LOCK_MIN} минути.`, 423);
    if (!ok) {
      const n = u.failedLogins + 1;
      await db.update(users).set({ failedLogins: n, lockedUntil: n >= MAX_FAILED ? new Date(Date.now() + LOCK_MIN * 60_000) : null })
        .where(eq(users.id, u.id));
      await audit(db, { userId: u.id, ip: req.ip }, { entity: "user", entityId: u.id, action: "login_failed", changes: { attempt: n } });
      throw fail;
    }
    await db.update(users).set({ failedLogins: 0, lockedUntil: null }).where(eq(users.id, u.id));
    setSessionCookie(reply, await createSession(db, u.id, false, meta(req)));
    return { ok: true, pending: u.totpEnabled ? "totp" : "totp_setup" };
  });

  /** Kod od aplikacijata za avtentikacija (2. cekor). */
  app.post("/api/auth/totp/verify", strict, async (req) => {
    const u = req.user;
    if (!u || u.provider !== "local" || !u.totpEnabled || !u.totpSecretEnc) throw new DomainError("unauthenticated", "Не сте најавени.", 401);
    const { code } = z.object({ code: z.string().trim() }).parse(req.body);
    const secret = unseal<string>(appKey, u.totpSecretEnc, "totp")!;
    const ctr = verifyTotp(secret, code, Date.now(), u.totpLastCounter);
    if (ctr === null) {
      await audit(db, { userId: u.id, ip: req.ip }, { entity: "user", entityId: u.id, action: "totp_failed" });
      throw new DomainError("bad_code", "Погрешен код.", 401);
    }
    await db.update(users).set({ totpLastCounter: ctr, lastLoginAt: new Date() }).where(eq(users.id, u.id));
    await markMfaOk(db, u.sessionHash);
    await audit(db, { userId: u.id, ip: req.ip }, { entity: "user", entityId: u.id, action: "login", changes: { provider: "local" } });
    return { ok: true };
  });

  /** Prva najava: nova TOTP tajna (se potvrduva so /confirm). */
  app.post("/api/auth/totp/setup", strict, async (req) => {
    const u = req.user;
    if (!u || u.provider !== "local" || u.totpEnabled) throw new DomainError("unauthenticated", "Не е дозволено.", 401);
    const secret = newTotpSecret();
    await db.update(users).set({ totpSecretEnc: seal(appKey, secret, "totp"), totpLastCounter: -1 }).where(eq(users.id, u.id));
    return { secret, uri: otpauthUri(secret, u.email) };
  });

  app.post("/api/auth/totp/confirm", strict, async (req) => {
    const u = req.user;
    if (!u || u.provider !== "local" || u.totpEnabled || !u.totpSecretEnc) throw new DomainError("unauthenticated", "Не е дозволено.", 401);
    const { code } = z.object({ code: z.string().trim() }).parse(req.body);
    const ctr = verifyTotp(unseal<string>(appKey, u.totpSecretEnc, "totp")!, code);
    if (ctr === null) throw new DomainError("bad_code", "Погрешен код. Проверете го времето на телефонот.", 400);
    await db.update(users).set({ totpEnabled: true, totpLastCounter: ctr, lastLoginAt: new Date() }).where(eq(users.id, u.id));
    await markMfaOk(db, u.sessionHash);
    await audit(db, { userId: u.id, ip: req.ip }, { entity: "user", entityId: u.id, action: "totp_enabled" });
    return { ok: true };
  });

  /** Pokana / reset: postavuvanje lozinka so ednokraten token. */
  app.post("/api/auth/set-password", strict, async (req) => {
    const b = z.object({ token: z.string().min(20).max(100), password: z.string() }).parse(req.body);
    const problem = passwordProblem(b.password);
    if (problem) throw new DomainError("weak_password", problem, 400);
    const pwHash = await hashPassword(b.password);
    const userId = await db.transaction(async (tx) => {
      const [t] = await tx.select().from(userTokens).where(and(eq(userTokens.idHash, sha256(b.token)),
        isNull(userTokens.usedAt), gt(userTokens.expiresAt, new Date()))).for("update");
      if (!t) throw new DomainError("bad_token", "Линкот е неважечки или истечен. Побарајте нов од администраторот.", 400);
      await tx.update(userTokens).set({ usedAt: new Date() }).where(eq(userTokens.idHash, t.idHash));
      // reset: nov TOTP pri sledna najava
      await tx.update(users).set({ passwordHash: pwHash, failedLogins: 0, lockedUntil: null,
        ...(t.purpose === "reset" ? { totpEnabled: false, totpSecretEnc: null } : {}) }).where(eq(users.id, t.userId));
      return t.userId;
    });
    await destroyUserSessions(db, userId);
    await audit(db, { userId, ip: req.ip }, { entity: "user", entityId: userId, action: "password_set" });
    return { ok: true };
  });

  /* ---------------------------------------------------------- Entra */
  const redirectUri = `${d.publicUrl}/api/auth/entra/callback`;

  app.get("/api/auth/entra/login", strict, async (_req, reply) => {
    if (!d.entra) throw new DomainError("not_configured", "Најавата со Microsoft не е поставена.", 404);
    const v = pkce.verifier(), state = pkce.state(), nonce = pkce.nonce();
    reply.setCookie(OIDC_COOKIE, seal(appKey, { v, state, nonce, at: Date.now() }, "oidc"),
      { path: "/", httpOnly: true, secure: true, sameSite: "lax", maxAge: 600 });
    const url = await d.entra.provider.authUrl({ redirectUri, state, nonce, codeChallenge: await pkce.challenge(v) });
    return reply.redirect(url.href);
  });

  app.get("/api/auth/entra/callback", strict, async (req, reply) => {
    const fail = (why: string) => reply.redirect(`/?login_error=${encodeURIComponent(why)}`);
    if (!d.entra) return fail("not_configured");
    const st = unseal<{ v: string; state: string; nonce: string; at: number }>(appKey, req.cookies[OIDC_COOKIE], "oidc");
    reply.clearCookie(OIDC_COOKIE, { path: "/" });
    if (!st || Date.now() - st.at > 600_000) return fail("expired");

    let claims;
    try {
      claims = await d.entra.provider.exchange(new URL(req.url, d.publicUrl), { state: st.state, nonce: st.nonce, verifier: st.v });
    } catch (e) {
      req.log.warn({ err: e }, "entra callback");
      return fail("microsoft");
    }
    if (claims.tid !== d.entra.tenantId || !claims.oid) return fail("tenant");

    let [u] = await db.select().from(users).where(eq(users.entraOid, claims.oid));
    if (!u && claims.email) {
      // prethodno dodaden od administrator (po e-posta), oid se vrzuva pri prva najava
      [u] = await db.select().from(users).where(and(sql`lower(${users.email}) = ${claims.email}`, eq(users.provider, "entra"), isNull(users.entraOid)));
      if (u) [u] = await db.update(users).set({ entraOid: claims.oid }).where(eq(users.id, u.id)).returning();
    }
    if (!u && d.bootstrapAdminEmail && claims.email === d.bootstrapAdminEmail) {
      const [{ n }] = await db.select({ n: count() }).from(users).where(eq(users.role, "admin")) as [{ n: number }];
      if (Number(n) === 0) {
        [u] = await db.insert(users).values({ email: claims.email, displayName: claims.name, provider: "entra",
          entraOid: claims.oid, role: "admin" }).returning();
        await audit(db, { userId: u!.id, ip: req.ip }, { entity: "user", entityId: u!.id, action: "bootstrap_admin" });
      }
    }
    if (!u || !u.isActive || u.provider !== "entra") {
      await audit(db, { ip: req.ip }, { entity: "user", entityId: claims.email || claims.oid, action: "login_denied" });
      return fail("no_access");
    }
    await db.update(users).set({ lastLoginAt: new Date(), displayName: claims.name || u.displayName }).where(eq(users.id, u.id));
    setSessionCookie(reply, await createSession(db, u.id, true, meta(req)));
    await audit(db, { userId: u.id, ip: req.ip }, { entity: "user", entityId: u.id, action: "login", changes: { provider: "entra" } });
    return reply.redirect("/");
  });
}
