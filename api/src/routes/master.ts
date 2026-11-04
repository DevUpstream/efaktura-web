/** Shifrarnici po klient: kupuvaci, artikli; globalni: DDV stapki, pricini. Predlog-cena (docs/03). */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { clients, invoiceLines, invoices, items, partnerPrices, partners, ujpReasons, vatRates } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import { audit } from "../domain/audit.js";
import { assertClientAccess, requireAdmin, requireUser } from "../auth/context.js";

export const Id = z.coerce.number().int().positive();
const opt = (s: z.ZodString) => s.trim().max(300).optional().nullable().transform((v) => (v ? v : null));
const Edb = z.string().trim().regex(/^\d{13}$/, "ЕДБ мора да има 13 цифри").optional().nullable().or(z.literal("").transform(() => null));

const PartnerIn = z.object({
  name: z.string().trim().min(2).max(300),
  edb: Edb,
  embs: opt(z.string().max(8)),
  vatNumber: opt(z.string().max(20)),
  address: opt(z.string()), city: opt(z.string()), postalCode: opt(z.string().max(10)),
  country: z.string().trim().length(2).toUpperCase().default("MK"),
  email: opt(z.string().max(254)), phone: opt(z.string().max(50)),
  isActive: z.boolean().default(true),
});
/** Polinja zakluceni po proverka vo registarot na UJP ("UJP ✓"). */
const REGISTRY_LOCKED = ["name", "edb", "embs", "vatNumber", "address", "city", "postalCode"] as const;

const ItemIn = z.object({
  code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(2).max(300),
  type: z.enum(["goods", "service"]).default("service"),
  unit: z.string().trim().min(1).max(10),
  unitPrice: z.coerce.number().min(0).max(1e12).transform((n) => n.toFixed(4)),
  vatRateId: Id,
  isActive: z.boolean().default(true),
});

const pgUnique = (e: unknown) => {
  const c = (e as { cause?: { code?: string }; code?: string });
  return (c.cause?.code ?? c.code) === "23505";
};

export async function masterRoutes(app: FastifyInstance, { db }: { db: Db }) {
  const ctx = async (req: Parameters<typeof requireUser>[0]) => {
    const u = requireUser(req);
    const clientId = Id.parse((req.params as { clientId: string }).clientId);
    await assertClientAccess(db, u, clientId);
    return { u, clientId };
  };

  app.get("/api/vat-rates", async (req) => {
    requireUser(req);
    return db.select().from(vatRates).orderBy(desc(vatRates.ratePct), vatRates.code);
  });
  app.get("/api/ujp-reasons", async (req) => {
    requireUser(req);
    return db.select().from(ujpReasons).where(eq(ujpReasons.isActive, true)).orderBy(ujpReasons.code);
  });

  /* -------------------------------------------- klient: podatoci i PDF */
  app.get("/api/clients/:clientId", async (req) => {
    const { clientId } = await ctx(req);
    const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
    return c;
  });

  const Txt = (max: number) => z.string().trim().max(max).optional();
  const ClientPatch = z.object({
    iban: z.string().trim().max(34).optional().nullable(), bankName: z.string().trim().max(200).optional().nullable(),
    email: z.string().trim().max(254).optional().nullable(), phone: z.string().trim().max(50).optional().nullable(),
    invoiceClauses: z.string().max(4000).optional().nullable(),
    pdfSettings: z.object({
      shortName: Txt(60), tagline: Txt(150), subtitle: Txt(150), contactLine: Txt(200),
      addressLines: z.array(z.string().trim().max(200)).max(6).optional(),
      bankAccounts: z.array(z.object({ account: z.string().trim().min(3).max(40), bank: z.string().trim().max(120) })).max(5).optional(),
      invoiceTitle: Txt(40), signatory: Txt(120), paymentNote: Txt(300), clausesTitle: Txt(300), receiverDeclaration: Txt(500),
      showReceivedBy: z.boolean().optional(),
    }).optional(),
  });
  /** Samo administrator. Nazivot, EDB, adresata i DDV brojot doagjaat od registarot na UJP i ne se menuvaat tuka. */
  app.patch("/api/clients/:clientId", async (req) => {
    const u = requireAdmin(req);
    const clientId = Id.parse((req.params as { clientId: string }).clientId);
    const b = ClientPatch.parse(req.body);
    const [c] = await db.update(clients).set(b).where(eq(clients.id, clientId)).returning();
    if (!c) throw new DomainError("not_found", "Клиентот не постои.", 404);
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "client", entityId: clientId, action: "update", changes: b });
    return c;
  });

  /* ---------------------------------------------------------- kupuvaci */
  app.get("/api/clients/:clientId/partners", async (req) => {
    const { clientId } = await ctx(req);
    return db.select().from(partners).where(eq(partners.clientId, clientId)).orderBy(partners.name);
  });

  app.post("/api/clients/:clientId/partners", async (req, reply) => {
    const { u, clientId } = await ctx(req);
    const b = PartnerIn.parse(req.body);
    try {
      const [p] = await db.insert(partners).values({ ...b, clientId }).returning();
      await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "partner", entityId: p!.id, action: "create", changes: b });
      return reply.status(201).send(p);
    } catch (e) {
      if (pgUnique(e)) throw new DomainError("duplicate", "Купувач со ова ЕДБ веќе постои.", 409);
      throw e;
    }
  });

  app.patch("/api/clients/:clientId/partners/:id", async (req) => {
    const { u, clientId } = await ctx(req);
    const id = Id.parse((req.params as { id: string }).id);
    const b = PartnerIn.partial().parse(req.body);
    const [cur] = await db.select().from(partners).where(and(eq(partners.id, id), eq(partners.clientId, clientId)));
    if (!cur) throw new DomainError("not_found", "Купувачот не постои.", 404);
    if (cur.ujpRegistryAt) {
      const changed = REGISTRY_LOCKED.filter((k) => k in b && (b as Record<string, unknown>)[k] !== cur[k]);
      if (changed.length) throw new DomainError("registry_locked", "Податоците се проверени во регистарот на УЈП и се заклучени.", 409);
    }
    try {
      const [p] = await db.update(partners).set(b).where(eq(partners.id, id)).returning();
      await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "partner", entityId: id, action: "update", changes: b });
      return p;
    } catch (e) {
      if (pgUnique(e)) throw new DomainError("duplicate", "Купувач со ова ЕДБ веќе постои.", 409);
      throw e;
    }
  });

  /* ----------------------------------------------------------- artikli */
  app.get("/api/clients/:clientId/items", async (req) => {
    const { clientId } = await ctx(req);
    return db.select().from(items).where(eq(items.clientId, clientId)).orderBy(items.code);
  });

  app.post("/api/clients/:clientId/items", async (req, reply) => {
    const { u, clientId } = await ctx(req);
    const b = ItemIn.parse(req.body);
    try {
      const [it] = await db.insert(items).values({ ...b, clientId }).returning();
      await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "item", entityId: it!.id, action: "create", changes: b });
      return reply.status(201).send(it);
    } catch (e) {
      if (pgUnique(e)) throw new DomainError("duplicate", "Артикл со оваа шифра веќе постои.", 409);
      throw e;
    }
  });

  app.patch("/api/clients/:clientId/items/:id", async (req) => {
    const { u, clientId } = await ctx(req);
    const id = Id.parse((req.params as { id: string }).id);
    const b = ItemIn.partial().parse(req.body);
    try {
      const [it] = await db.update(items).set(b).where(and(eq(items.id, id), eq(items.clientId, clientId))).returning();
      if (!it) throw new DomainError("not_found", "Артиклот не постои.", 404);
      await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "item", entityId: id, action: "update", changes: b });
      return it;
    } catch (e) {
      if (pgUnique(e)) throw new DomainError("duplicate", "Артикл со оваа шифра веќе постои.", 409);
      throw e;
    }
  });

  /* -------------------------------- predlog-cena: dogovorena > posledna > standardna */
  app.get("/api/clients/:clientId/price", async (req) => {
    const { clientId } = await ctx(req);
    const q = z.object({ partnerId: Id, itemId: Id, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      excludeInvoiceId: Id.optional() }).parse(req.query);
    return suggestPrice(db, clientId, q);
  });
}

const fmt = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

export async function suggestPrice(db: Db, clientId: number,
  q: { partnerId: number; itemId: number; date: string; excludeInvoiceId?: number }) {
  const [item] = await db.select().from(items).where(and(eq(items.id, q.itemId), eq(items.clientId, clientId)));
  if (!item) throw new DomainError("not_found", "Артиклот не постои.", 404);

  const [pp] = await db.select().from(partnerPrices).where(and(eq(partnerPrices.clientId, clientId),
    eq(partnerPrices.partnerId, q.partnerId), eq(partnerPrices.itemId, q.itemId),
    lte(partnerPrices.validFrom, q.date), gte(partnerPrices.validTo, q.date)));
  if (pp) return { price: pp.price, source: `Договорена цена (од ${fmt(pp.validFrom)})` };

  const [last] = await db.select({ price: invoiceLines.unitPrice, date: invoices.issueDate }).from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(eq(invoices.clientId, clientId), eq(invoices.partnerId, q.partnerId), eq(invoiceLines.itemId, q.itemId),
      gt(invoiceLines.qty, "0"), inArray(invoices.status, ["issued", "json_exported", "sent_to_ujp", "corrected"]),
      q.excludeInvoiceId ? ne(invoices.id, q.excludeInvoiceId) : sql`true`))
    .orderBy(desc(invoices.issueDate), desc(invoices.id)).limit(1);
  if (last) return { price: last.price, source: `Последна цена за купувачот (${fmt(last.date)})` };

  return { price: item.unitPrice, source: "Стандардна цена" };
}
