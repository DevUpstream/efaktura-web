/**
 * Registar na UJP preku lokalniot agent.
 * UJP ne e dostapen od serverot (IP filter) -> aplikacijata pravi baranje, agentot (na kompjuterot so pristap do UJP)
 * go zema, go prasuva UJP (GET /api/v1/companies/{EDB}) i go vrakja rezultatot. UJP e primaren izvor.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { agentKeys, clients, partners, registryRequests, type UjpCompany } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import { audit } from "../domain/audit.js";
import { randomToken, sha256 } from "../auth/crypto.js";
import { assertClientAccess, requireAdmin, requireUser } from "../auth/context.js";
import { Id } from "./master.js";

const Edb = z.string().trim().regex(/^\d{13}$/, "ЕДБ мора да има 13 цифри");
const t = (v: unknown) => String(v ?? "").trim();

/** Polinja sto doagjaat od registarot i se zakluceni ("УЈП ✓"). */
export const REGISTRY_FIELDS = ["name", "address", "city", "postalCode", "vatNumber", "embs"] as const;
type RegField = (typeof REGISTRY_FIELDS)[number];
const LABEL: Record<RegField, string> = { name: "Назив", address: "Адреса", city: "Град", postalCode: "Поштенски број", vatNumber: "ДДВ број", embs: "ЕМБС" };

export function registryDiff(cur: Partial<Record<RegField, string | null>>, reg: UjpCompany) {
  return REGISTRY_FIELDS.filter((k) => t(cur[k]) !== t(reg[k]))
    .map((k) => ({ field: k, label: LABEL[k], ours: cur[k] ?? null, ujp: reg[k] || null }));
}
const regValues = (r: UjpCompany) => ({ name: t(r.name), address: t(r.address), city: t(r.city),
  postalCode: t(r.postalCode) || null, vatNumber: t(r.vatNumber) || null, embs: t(r.embs) || null });
/** "04.11.2026" (isto kako vo SharePoint belezkite). */
const today = () => new Date().toLocaleDateString("en-GB", { timeZone: "Europe/Skopje", day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\//g, ".");

/** Agentot se najavuva so x-agent-key (vo bazata samo SHA-256). */
export async function requireAgent(db: Db, req: FastifyRequest) {
  const key = String(req.headers["x-agent-key"] ?? "");
  if (key.length < 30) throw new DomainError("unauthenticated", "Недостасува клуч за агентот.", 401);
  const [k] = await db.select().from(agentKeys).where(and(eq(agentKeys.keyHash, sha256(key)), eq(agentKeys.isActive, true)));
  if (!k) throw new DomainError("unauthenticated", "Неважечки клуч за агентот.", 401);
  if (!k.lastUsedAt || Date.now() - k.lastUsedAt.getTime() > 60_000)
    await db.update(agentKeys).set({ lastUsedAt: new Date() }).where(eq(agentKeys.id, k.id));
  return k;
}

const CompanyIn = z.object({
  name: z.string().trim().min(1).max(300), address: z.string().trim().max(300).default(""), city: z.string().trim().max(120).default(""),
  postalCode: z.string().trim().max(10).default(""), vatNumber: z.string().trim().max(20).default(""),
  embs: z.string().trim().max(8).default(""), countryCode: z.string().trim().max(2).default("MK"),
});

export async function registryRoutes(app: FastifyInstance, { db }: { db: Db }) {
  /* ------------------------------------------------------------ korisnik */
  app.post("/api/ujp/registry-requests", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const u = requireUser(req);
    const b = z.object({ edb: Edb.optional(), clientId: Id.optional(), partnerId: Id.optional() }).parse(req.body);
    let kind: "lookup" | "client" | "partner", edb: string, sellerEdb: string, clientId: number | null = null, partnerId: number | null = null;
    if (b.partnerId || (b.clientId && b.edb)) {
      // kupuvac (postoecki ili nov) na klient
      if (!b.clientId) throw new DomainError("validation", "Недостасува клиент.", 422);
      await assertClientAccess(db, u, b.clientId);
      const [c] = await db.select().from(clients).where(eq(clients.id, b.clientId));
      if (b.partnerId) {
        const [p] = await db.select().from(partners).where(and(eq(partners.id, b.partnerId), eq(partners.clientId, b.clientId)));
        if (!p?.edb) throw new DomainError("validation", "Купувачот нема ЕДБ.", 422);
        edb = p.edb; partnerId = p.id;
      } else edb = b.edb!;
      kind = b.partnerId ? "partner" : "lookup"; sellerEdb = c!.edb; clientId = c!.id;
    } else if (b.clientId) {
      requireAdmin(req);
      const [c] = await db.select().from(clients).where(eq(clients.id, b.clientId));
      if (!c) throw new DomainError("not_found", "Фирмата не постои.", 404);
      kind = "client"; edb = c.edb; sellerEdb = c.edb; clientId = c.id;
    } else if (b.edb) {
      requireAdmin(req);                       // nov klient
      kind = "lookup"; edb = b.edb; sellerEdb = b.edb;
    } else throw new DomainError("validation", "Внесете ЕДБ.", 422);

    // isto baranje vo poslednite 10 minuti -> istoto (agentot ne go prasuva UJP dvapati)
    const [dup] = await db.select().from(registryRequests).where(and(eq(registryRequests.edb, edb), eq(registryRequests.sellerEdb, sellerEdb),
      eq(registryRequests.kind, kind), sql`${registryRequests.status} <> 'error'`, gt(registryRequests.createdAt, new Date(Date.now() - 600_000)),
      partnerId ? eq(registryRequests.partnerId, partnerId) : sql`true`, clientId ? eq(registryRequests.clientId, clientId) : sql`true`))
      .orderBy(sql`${registryRequests.id} desc`).limit(1);
    if (dup) return reply.status(200).send({ id: dup.id });
    const [r] = await db.insert(registryRequests).values({ kind, edb, sellerEdb, clientId, partnerId, requestedBy: u.id }).returning();
    return reply.status(201).send({ id: r!.id });
  });

  app.get("/api/ujp/registry-requests/:id", async (req) => {
    const u = requireUser(req);
    const id = Id.parse((req.params as { id: string }).id);
    const [r] = await db.select().from(registryRequests).where(eq(registryRequests.id, id));
    if (!r) throw new DomainError("not_found", "Барањето не постои.", 404);
    if (r.clientId) await assertClientAccess(db, u, r.clientId); else requireAdmin(req);
    let diff = null;
    if (r.status === "done" && r.result) {
      if (r.kind === "client" && r.clientId) diff = registryDiff((await db.select().from(clients).where(eq(clients.id, r.clientId)))[0]!, r.result);
      if (r.kind === "partner" && r.partnerId) diff = registryDiff((await db.select().from(partners).where(eq(partners.id, r.partnerId)))[0]!, r.result);
    }
    const [agent] = await db.select({ lastUsedAt: agentKeys.lastUsedAt }).from(agentKeys).where(eq(agentKeys.isActive, true))
      .orderBy(sql`${agentKeys.lastUsedAt} desc nulls last`).limit(1);
    return { id: r.id, kind: r.kind, edb: r.edb, status: r.status, result: r.result, error: r.error, diff,
      agentLastSeen: agent?.lastUsedAt ?? null };
  });

  /** Gi zapisuva podatocite od registarot vo klientot/kupuvacot (UJP e primaren izvor). */
  app.post("/api/ujp/registry-requests/:id/apply", async (req) => {
    const u = requireUser(req);
    const id = Id.parse((req.params as { id: string }).id);
    const [r] = await db.select().from(registryRequests).where(eq(registryRequests.id, id));
    if (!r || r.status !== "done" || !r.result) throw new DomainError("validation", "Барањето уште не е завршено.", 409);
    const note = (d: { field: string; ours: unknown; ujp: unknown }[]) =>
      d.length ? `${today()}: ${d.map((x) => `${x.field}: «${x.ours ?? ""}» → «${x.ujp ?? ""}»`).join("; ")}` : `Се совпаѓа со регистарот (${today()})`;
    if (r.kind === "client" && r.clientId) {
      requireAdmin(req);
      const [c] = await db.select().from(clients).where(eq(clients.id, r.clientId));
      const d = registryDiff(c!, r.result);
      const v = regValues(r.result);
      await db.update(clients).set({ ...v, address: v.address || c!.address, city: v.city || c!.city, vatPayer: !!v.vatNumber,
        ujpRegistryAt: new Date(), ujpRegistryNote: note(d) }).where(eq(clients.id, r.clientId));
      await audit(db, { userId: u.id, ip: req.ip }, { clientId: r.clientId, entity: "client", entityId: r.clientId, action: "ujp_registry", changes: d });
      return { ok: true, changed: d.length };
    }
    if (r.kind === "partner" && r.partnerId) {
      await assertClientAccess(db, u, r.clientId!);
      const [p] = await db.select().from(partners).where(eq(partners.id, r.partnerId));
      const d = registryDiff(p!, r.result);
      await db.update(partners).set({ ...regValues(r.result), country: (r.result.countryCode || "MK").slice(0, 2),
        ujpRegistryAt: new Date(), ujpRegistryNote: note(d) }).where(eq(partners.id, r.partnerId));
      await audit(db, { userId: u.id, ip: req.ip }, { clientId: r.clientId, entity: "partner", entityId: r.partnerId, action: "ujp_registry", changes: d });
      return { ok: true, changed: d.length };
    }
    throw new DomainError("validation", "Ова барање е само пребарување.", 422);
  });

  /* ------------------------------------------- nov klient / kupuvac od UJP */
  const fromLookup = async (requestId: number, edb: string) => {
    const [r] = await db.select().from(registryRequests).where(eq(registryRequests.id, requestId));
    if (!r || r.edb !== edb || r.status !== "done" || !r.result) throw new DomainError("validation", "Прво повлечете ги податоците од УЈП.", 422);
    return r.result;
  };

  app.post("/api/clients", async (req, reply) => {
    const u = requireAdmin(req);
    const b = z.object({ edb: Edb, registryRequestId: Id, invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,10}$/, "Префикс: до 10 латинични букви/цифри"),
      email: z.string().trim().max(254).optional().nullable(), phone: z.string().trim().max(50).optional().nullable() }).parse(req.body);
    const reg = await fromLookup(b.registryRequestId, b.edb);
    const v = regValues(reg);
    if (!v.address || !v.city) throw new DomainError("validation", "Регистарот на УЈП не врати адреса/град за ова ЕДБ.", 422);
    try {
      const [c] = await db.insert(clients).values({ edb: b.edb, ...v, address: v.address, city: v.city, vatPayer: !!v.vatNumber,
        country: (reg.countryCode || "MK").slice(0, 2), invoicePrefix: b.invoicePrefix, email: b.email ?? null, phone: b.phone ?? null,
        ujpRegistryAt: new Date(), ujpRegistryNote: `Креиран од регистарот на УЈП (${today()})` }).returning();
      await audit(db, { userId: u.id, ip: req.ip }, { clientId: c!.id, entity: "client", entityId: c!.id, action: "create", changes: { edb: b.edb, prefix: b.invoicePrefix } });
      return reply.status(201).send(c);
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
      if (code === "23505") throw new DomainError("duplicate", "Фирма со ова ЕДБ или префикс веќе постои.", 409);
      throw e;
    }
  });

  app.post("/api/clients/:clientId/partners/from-ujp", async (req, reply) => {
    const u = requireUser(req);
    const clientId = Id.parse((req.params as { clientId: string }).clientId);
    await assertClientAccess(db, u, clientId);
    const b = z.object({ edb: Edb, registryRequestId: Id, email: z.string().trim().max(254).optional().nullable(), phone: z.string().trim().max(50).optional().nullable(),
      role: z.enum(["customer", "supplier", "both"]).default("customer") }).parse(req.body);
    const reg = await fromLookup(b.registryRequestId, b.edb);
    try {
      const [p] = await db.insert(partners).values({ clientId, edb: b.edb, ...regValues(reg), country: (reg.countryCode || "MK").slice(0, 2),
        email: b.email ?? null, phone: b.phone ?? null, isCustomer: b.role !== "supplier", isSupplier: b.role !== "customer", ujpRegistryAt: new Date(), ujpRegistryNote: `Креиран од регистарот на УЈП (${today()})` }).returning();
      await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "partner", entityId: p!.id, action: "create_from_ujp", changes: { edb: b.edb } });
      return reply.status(201).send(p);
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
      if (code === "23505") throw new DomainError("duplicate", "Купувач со ова ЕДБ веќе постои.", 409);
      throw e;
    }
  });

  /* --------------------------------------------------------- kluchevi za agent */
  const assertClients = async (ids: number[] | null) => {
    if (!ids?.length) return;
    const found = await db.select({ id: clients.id }).from(clients).where(inArray(clients.id, ids));
    if (found.length !== new Set(ids).size) throw new DomainError("validation", "Непозната фирма.", 422);
  };
  app.get("/api/agent-keys", async (req) => {
    requireAdmin(req);
    return db.select({ id: agentKeys.id, name: agentKeys.name, isActive: agentKeys.isActive, lastUsedAt: agentKeys.lastUsedAt, createdAt: agentKeys.createdAt,
      clientIds: agentKeys.clientIds, agentVersion: agentKeys.agentVersion, agentInfo: agentKeys.agentInfo })
      .from(agentKeys).orderBy(asc(agentKeys.id));
  });
  app.post("/api/agent-keys", async (req, reply) => {
    const u = requireAdmin(req);
    const { name, clientIds } = z.object({ name: z.string().trim().min(2).max(100), clientIds: z.array(Id).max(50).nullable().default(null) }).parse(req.body);
    await assertClients(clientIds);
    const key = `efa_${randomToken(32)}`;
    const [k] = await db.insert(agentKeys).values({ name, keyHash: sha256(key), clientIds: clientIds?.length ? clientIds : null }).returning();
    await audit(db, { userId: u.id, ip: req.ip }, { entity: "agent_key", entityId: k!.id, action: "create", changes: { name, clientIds } });
    return reply.status(201).send({ id: k!.id, name, key });   // klucot se prikazuva SAMO sega
  });
  app.patch("/api/agent-keys/:id", async (req) => {
    const u = requireAdmin(req);
    const id = Id.parse((req.params as { id: string }).id);
    const b = z.object({ isActive: z.boolean().optional(), clientIds: z.array(Id).max(50).nullable().optional() }).parse(req.body);
    if (b.clientIds !== undefined) await assertClients(b.clientIds);
    await db.update(agentKeys).set({ ...(b.isActive !== undefined ? { isActive: b.isActive } : {}),
      ...(b.clientIds !== undefined ? { clientIds: b.clientIds?.length ? b.clientIds : null } : {}) }).where(eq(agentKeys.id, id));
    await audit(db, { userId: u.id, ip: req.ip }, { entity: "agent_key", entityId: id,
      action: b.isActive === undefined ? "update" : b.isActive ? "enable" : "disable", changes: b.clientIds !== undefined ? { clientIds: b.clientIds } : undefined });
    return { ok: true };
  });

  /* ----------------------------------------------------------------- agent */
  // agentot prashuva na sekoi 4 s: bez zapis vo dnevnikot (obrabotkata - POST - se zapishuva)
  app.get("/api/agent/registry-requests", { logLevel: "silent" }, async (req) => {
    const k = await requireAgent(db, req);
    if (k.clientIds) return [];   // агент на клиент: само праќање за неговите фирми, регистарот го води бирото
    return db.select({ id: registryRequests.id, edb: registryRequests.edb, sellerEdb: registryRequests.sellerEdb })
      .from(registryRequests).where(eq(registryRequests.status, "pending")).orderBy(asc(registryRequests.id)).limit(20);
  });

  app.post("/api/agent/registry-requests/:id", async (req) => {
    const k = await requireAgent(db, req);
    if (k.clientIds) throw new DomainError("forbidden", "Агентот на клиент не го води регистарот.", 403);
    const id = Id.parse((req.params as { id: string }).id);
    const b = z.union([z.object({ ok: z.literal(true), company: CompanyIn }), z.object({ ok: z.literal(false), error: z.string().max(2000) })]).parse(req.body);
    const [r] = await db.update(registryRequests).set(b.ok
      ? { status: "done", result: b.company, error: null, doneAt: new Date(), agentKeyId: k.id }
      : { status: "error", error: b.error, doneAt: new Date(), agentKeyId: k.id })
      .where(and(eq(registryRequests.id, id), eq(registryRequests.status, "pending"))).returning();
    if (!r) throw new DomainError("not_found", "Барањето не постои или е веќе обработено.", 404);
    return { ok: true };
  });
}
