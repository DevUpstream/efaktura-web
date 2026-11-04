/** Administracija: korisnici, pokani, pristap do klienti. */
import type { FastifyInstance } from "fastify";
import { and, count, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { clientAccess, clients, users, userTokens } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import { audit } from "../domain/audit.js";
import { randomToken, sha256 } from "../auth/crypto.js";
import { MODULE_KEYS, MODULES, normalizeClientModules } from "../domain/modules.js";
import { accessibleClients, requireAdmin, requireUser } from "../auth/context.js";
import { destroyUserSessions } from "../auth/sessions.js";

const Id = z.coerce.number().int().positive();
const publicUser = (u: typeof users.$inferSelect) => ({
  id: u.id, email: u.email, displayName: u.displayName, provider: u.provider, role: u.role, isActive: u.isActive,
  totpEnabled: u.totpEnabled, entraLinked: !!u.entraOid, hasPassword: !!u.passwordHash, lastLoginAt: u.lastLoginAt,
  lockedUntil: u.lockedUntil,
});

export async function userRoutes(app: FastifyInstance, { db, publicUrl }: { db: Db; publicUrl: string }) {
  const adminsLeft = async (exceptId: number) => {
    const [r] = await db.select({ n: count() }).from(users).where(and(eq(users.role, "admin"), eq(users.isActive, true), ne(users.id, exceptId)));
    return Number(r?.n ?? 0);
  };

  app.get("/api/clients", async (req) => {
    const u = requireUser(req);
    return (await accessibleClients(db, u)).map((c) => ({ id: c.id, name: c.name, edb: c.edb, prefix: c.invoicePrefix, isActive: c.isActive, modules: c.modules,
      city: c.city, vatNumber: c.vatNumber, ujpRegistryAt: c.ujpRegistryAt, ujpRegistryNote: c.ujpRegistryNote }));
  });

  app.get("/api/users", async (req) => {
    requireAdmin(req);
    const list = await db.select().from(users).orderBy(users.displayName);
    const access = await db.select().from(clientAccess).where(eq(clientAccess.isActive, true));
    return list.map((u) => {
      const mine = access.filter((a) => a.userId === u.id);
      return { ...publicUser(u), clientIds: mine.map((a) => a.clientId),
        clientModules: Object.fromEntries(mine.map((a) => [a.clientId, a.modules ?? null])) as Record<number, string[] | null> };
    });
  });

  app.post("/api/users", async (req, reply) => {
    const me = requireAdmin(req);
    const b = z.object({
      email: z.string().trim().toLowerCase().email().max(254),
      displayName: z.string().trim().min(2).max(200),
      provider: z.enum(["entra", "local"]),
      role: z.enum(["admin", "accountant"]).default("accountant"),
    }).parse(req.body);
    const [dup] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${b.email}`);
    if (dup) throw new DomainError("duplicate", "Корисник со оваа е-пошта веќе постои.", 409);
    const [u] = await db.insert(users).values(b).returning();
    await audit(db, { userId: me.id, ip: req.ip }, { entity: "user", entityId: u!.id, action: "create", changes: b });
    return reply.status(201).send(publicUser(u!));
  });

  app.patch("/api/users/:id", async (req) => {
    const me = requireAdmin(req);
    const id = Id.parse((req.params as { id: string }).id);
    const b = z.object({
      displayName: z.string().trim().min(2).max(200).optional(),
      role: z.enum(["admin", "accountant"]).optional(),
      isActive: z.boolean().optional(),
    }).parse(req.body);
    if ((b.role === "accountant" || b.isActive === false) && (await adminsLeft(id)) === 0)
      throw new DomainError("last_admin", "Мора да остане барем еден активен администратор.", 409);
    const [u] = await db.update(users).set(b).where(eq(users.id, id)).returning();
    if (!u) throw new DomainError("not_found", "Корисникот не постои.", 404);
    if (b.isActive === false || b.role) await destroyUserSessions(db, id);
    await audit(db, { userId: me.id, ip: req.ip }, { entity: "user", entityId: id, action: "update", changes: b });
    return publicUser(u);
  });

  /** Pokana ili reset (samo sopstveni smetki): ednokraten link, vazi 72 casa. Linkot go prakja administratorot. */
  app.post("/api/users/:id/invite", async (req) => {
    const me = requireAdmin(req);
    const id = Id.parse((req.params as { id: string }).id);
    const [u] = await db.select().from(users).where(eq(users.id, id));
    if (!u || u.provider !== "local") throw new DomainError("not_local", "Покана е само за сопствени сметки (не Microsoft).", 400);
    const token = randomToken();
    const purpose = u.passwordHash ? "reset" : "invite";
    await db.insert(userTokens).values({ idHash: sha256(token), userId: id, purpose, createdBy: me.id,
      expiresAt: new Date(Date.now() + 72 * 3600_000) });
    await audit(db, { userId: me.id, ip: req.ip }, { entity: "user", entityId: id, action: purpose });
    return { purpose, link: `${publicUrl}/set-password#${token}`, expiresInHours: 72 };
  });

  /** Dodeluva / odzema pristap do klient. */
  app.put("/api/clients/:clientId/access/:userId", async (req) => {
    const me = requireAdmin(req);
    const p = z.object({ clientId: Id, userId: Id }).parse(req.params);
    const b = z.object({ isActive: z.boolean().optional(), modules: z.array(z.enum(MODULE_KEYS)).max(20).nullable().optional() }).parse(req.body);
    const [c] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, p.clientId));
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, p.userId));
    if (!c || !u) throw new DomainError("not_found", "Клиентот или корисникот не постои.", 404);
    const set: { isActive?: boolean; modules?: string[] | null } = {};
    if (b.isActive !== undefined) set.isActive = b.isActive;
    if (b.modules !== undefined) set.modules = b.modules;
    if (!Object.keys(set).length) throw new DomainError("validation", "Нема промена.", 422);
    await db.insert(clientAccess).values({ clientId: p.clientId, userId: p.userId, isActive: b.isActive ?? true, modules: b.modules ?? null })
      .onConflictDoUpdate({ target: [clientAccess.clientId, clientAccess.userId], set });
    await audit(db, { userId: me.id, ip: req.ip }, { clientId: p.clientId, entity: "client_access", entityId: `${p.clientId}:${p.userId}`,
      action: b.isActive === undefined ? "modules" : b.isActive ? "grant" : "revoke", changes: set });
    return { ok: true };
  });

  /** Katalog na moduli (za ekranite na administratorot). */
  app.get("/api/modules", async (req) => { requireUser(req); return MODULES; });

  /** Koi moduli gi ima firmata (samo administrator). */
  app.put("/api/clients/:clientId/modules", async (req) => {
    const me = requireAdmin(req);
    const clientId = Id.parse((req.params as { clientId: string }).clientId);
    const { modules } = z.object({ modules: z.array(z.enum(MODULE_KEYS)).max(20) }).parse(req.body);
    const n = normalizeClientModules(modules);
    if (n.error) throw new DomainError("validation", n.error, 422);
    const [c] = await db.update(clients).set({ modules: n.modules }).where(eq(clients.id, clientId)).returning({ id: clients.id, modules: clients.modules });
    if (!c) throw new DomainError("not_found", "Клиентот не постои.", 404);
    await audit(db, { userId: me.id, ip: req.ip }, { clientId, entity: "client", entityId: clientId, action: "modules", changes: { modules: n.modules } });
    return c;
  });
}
