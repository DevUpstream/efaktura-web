/** Najava na sekoe baranje, CSRF zastita i proverki na pristap. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { clientAccess, clients } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import { loadSession, SESSION_COOKIE, type SessionUser } from "./sessions.js";

declare module "fastify" {
  interface FastifyRequest { user?: SessionUser }
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
export const CSRF_HEADER = "x-efaktura";

export function registerAuthContext(app: FastifyInstance, db: Db) {
  app.decorateRequest("user", undefined);
  app.addHook("onRequest", async (req) => {
    // CSRF: sekoe baranje sto menuva mora da ima sopstveno zaglavie (prelistuvacot ne go dozvoluva od tuga stranica)
    if (!SAFE.has(req.method) && req.headers[CSRF_HEADER] !== "1") {
      throw new DomainError("csrf", "Недостасува заштитно заглавје.", 403);
    }
    req.user = await loadSession(db, req.cookies[SESSION_COOKIE]);
  });
}

/** Najaven i (za sopstveni smetki) potvrden TOTP. */
export function requireUser(req: FastifyRequest): SessionUser {
  const u = req.user;
  if (!u) throw new DomainError("unauthenticated", "Не сте најавени.", 401);
  if (u.provider === "local" && !u.mfaOk) throw new DomainError("mfa_required", "Потребна е потврда со код (2FA).", 401);
  return u;
}

export function requireAdmin(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  if (u.role !== "admin") throw new DomainError("forbidden", "Само администратор.", 403);
  return u;
}

/** Klienti do koi korisnikot ima pristap (admin gi gleda site). */
export async function accessibleClients(db: Db, u: SessionUser) {
  if (u.role === "admin") return db.select().from(clients).orderBy(clients.name);
  const rows = await db.select({ c: clients }).from(clientAccess)
    .innerJoin(clients, eq(clients.id, clientAccess.clientId))
    .where(and(eq(clientAccess.userId, u.id), eq(clientAccess.isActive, true)))
    .orderBy(clients.name);
  return rows.map((r) => r.c);
}

/** Frla 404 (ne 403) za da ne se otkriva postoenjeto na tugi klienti. */
export async function assertClientAccess(db: Db, u: SessionUser, clientId: number) {
  if (u.role === "admin") {
    const [c] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, clientId));
    if (c) return;
  } else {
    const [a] = await db.select({ id: clientAccess.clientId }).from(clientAccess)
      .where(and(eq(clientAccess.clientId, clientId), eq(clientAccess.userId, u.id), eq(clientAccess.isActive, true)));
    if (a) return;
  }
  throw new DomainError("not_found", "Клиентот не постои.", 404);
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, secure: true, sameSite: "lax", maxAge: 12 * 3600 });
}
export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, secure: true, sameSite: "lax" });
}
