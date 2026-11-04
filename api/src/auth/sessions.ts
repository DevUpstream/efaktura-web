import { and, eq, gt, lt, or, sql } from "drizzle-orm";
import { sessions, users } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { randomToken, sha256 } from "./crypto.js";

export const SESSION_COOKIE = "__Host-efs";
export const IDLE_MS = 8 * 3600_000;      // 8 h neaktivnost
export const ABSOLUTE_MS = 12 * 3600_000; // 12 h najmnogu

export type SessionUser = typeof users.$inferSelect & { mfaOk: boolean; sessionHash: string };

export async function createSession(db: Db, userId: number, mfaOk: boolean, meta: { ip?: string; userAgent?: string }) {
  const token = randomToken();
  await db.insert(sessions).values({
    idHash: sha256(token), userId, mfaOk, expiresAt: new Date(Date.now() + ABSOLUTE_MS),
    ip: meta.ip?.slice(0, 45), userAgent: meta.userAgent?.slice(0, 300),
  });
  return token;
}

export async function loadSession(db: Db, token: string | undefined): Promise<SessionUser | undefined> {
  if (!token) return undefined;
  const idHash = sha256(token);
  const now = new Date();
  const [row] = await db.select({ s: sessions, u: users }).from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.idHash, idHash), gt(sessions.expiresAt, now),
      gt(sessions.lastSeenAt, new Date(now.getTime() - IDLE_MS)), eq(users.isActive, true)));
  if (!row) return undefined;
  if (now.getTime() - row.s.lastSeenAt.getTime() > 60_000) {         // ne zapisuvaj na sekoe baranje
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.idHash, idHash));
  }
  return { ...row.u, mfaOk: row.s.mfaOk, sessionHash: idHash };
}

export const markMfaOk = (db: Db, idHash: string) => db.update(sessions).set({ mfaOk: true }).where(eq(sessions.idHash, idHash));
export const destroySession = (db: Db, idHash: string) => db.delete(sessions).where(eq(sessions.idHash, idHash));
export const destroyUserSessions = (db: Db, userId: number) => db.delete(sessions).where(eq(sessions.userId, userId));

export async function purgeExpired(db: Db) {
  const now = new Date();
  await db.delete(sessions).where(or(lt(sessions.expiresAt, now), lt(sessions.lastSeenAt, new Date(now.getTime() - IDLE_MS))));
}
export { sql };
