/** Kupuvaci: kontakt lica, istorija na komunikacija, potsetnici. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { invoices, partnerContacts, partnerNotes, partners, users } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import { audit } from "../domain/audit.js";
import { assertClientAccess, requireUser } from "../auth/context.js";
import { Id } from "./master.js";

const opt = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));
const ContactIn = z.object({
  name: z.string().trim().min(2).max(200), role: opt(120), phone: opt(50), mobile: opt(50),
  email: z.string().trim().max(254).email().optional().nullable().or(z.literal("").transform(() => null)),
  isPrimary: z.boolean().default(false), isActive: z.boolean().default(true),
});
const NoteIn = z.object({
  kind: z.enum(["call", "meeting", "email", "note"]).default("note"),
  text: z.string().trim().min(1).max(4000),
  contactId: Id.optional().nullable(),
  followUpAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable().or(z.literal("").transform(() => null)),
});
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Skopje" });

export async function crmRoutes(app: FastifyInstance, { db }: { db: Db }) {
  /** Kupuvac na klient do koj korisnikot ima pristap. */
  const ctx = async (req: FastifyRequest) => {
    const u = requireUser(req);
    const p = z.object({ clientId: Id, id: Id }).parse(req.params);
    await assertClientAccess(db, u, p.clientId);
    const [partner] = await db.select().from(partners).where(and(eq(partners.id, p.id), eq(partners.clientId, p.clientId)));
    if (!partner) throw new DomainError("not_found", "Купувачот не постои.", 404);
    return { u, clientId: p.clientId, partner };
  };

  /* -------------------------------------------------------------- kartica */
  app.get("/api/clients/:clientId/partners/:id", async (req) => {
    const { partner } = await ctx(req);
    const contacts = await db.select().from(partnerContacts).where(eq(partnerContacts.partnerId, partner.id))
      .orderBy(desc(partnerContacts.isPrimary), asc(partnerContacts.name));
    const notes = await db.select({ n: partnerNotes, author: users.displayName }).from(partnerNotes)
      .leftJoin(users, eq(users.id, partnerNotes.createdBy))
      .where(eq(partnerNotes.partnerId, partner.id)).orderBy(desc(partnerNotes.createdAt)).limit(500);
    const invs = await db.select({ id: invoices.id, number: invoices.number, docType: invoices.docType, status: invoices.status,
      issueDate: invoices.issueDate, grossTotal: invoices.grossTotal, payableAmount: invoices.payableAmount })
      .from(invoices).where(and(eq(invoices.partnerId, partner.id), sql`${invoices.status} <> 'cancelled_draft'`))
      .orderBy(desc(invoices.issueDate), desc(invoices.id)).limit(100);
    return { partner, contacts, notes: notes.map((x) => ({ ...x.n, author: x.author })), invoices: invs };
  });

  /* ------------------------------------------------------------- kontakti */
  async function onlyOnePrimary(partnerId: number, keepId: number) {
    await db.update(partnerContacts).set({ isPrimary: false })
      .where(and(eq(partnerContacts.partnerId, partnerId), sql`${partnerContacts.id} <> ${keepId}`, eq(partnerContacts.isPrimary, true)));
  }
  app.post("/api/clients/:clientId/partners/:id/contacts", async (req, reply) => {
    const { u, clientId, partner } = await ctx(req);
    const b = ContactIn.parse(req.body);
    const [c] = await db.insert(partnerContacts).values({ ...b, partnerId: partner.id }).returning();
    if (b.isPrimary) await onlyOnePrimary(partner.id, c!.id);
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "partner_contact", entityId: c!.id, action: "create", changes: b });
    return reply.status(201).send(c);
  });
  app.patch("/api/clients/:clientId/partners/:id/contacts/:contactId", async (req) => {
    const { u, clientId, partner } = await ctx(req);
    const contactId = Id.parse((req.params as { contactId: string }).contactId);
    const b = ContactIn.partial().parse(req.body);
    const [c] = await db.update(partnerContacts).set(b).where(and(eq(partnerContacts.id, contactId), eq(partnerContacts.partnerId, partner.id))).returning();
    if (!c) throw new DomainError("not_found", "Контактот не постои.", 404);
    if (b.isPrimary) await onlyOnePrimary(partner.id, c.id);
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "partner_contact", entityId: c.id, action: "update", changes: b });
    return c;
  });

  /* -------------------------------------------------------------- istorija */
  app.post("/api/clients/:clientId/partners/:id/notes", async (req, reply) => {
    const { u, clientId, partner } = await ctx(req);
    const b = NoteIn.parse(req.body);
    if (b.contactId) {
      const [c] = await db.select({ id: partnerContacts.id }).from(partnerContacts)
        .where(and(eq(partnerContacts.id, b.contactId), eq(partnerContacts.partnerId, partner.id)));
      if (!c) throw new DomainError("validation", "Контактот не е од овој купувач.", 422);
    }
    const [n] = await db.insert(partnerNotes).values({ ...b, partnerId: partner.id, clientId, createdBy: u.id }).returning();
    return reply.status(201).send(n);
  });

  /** Potsetnikot e zavrsen (zapisot ostanuva vo istorijata). */
  app.post("/api/clients/:clientId/partners/:id/notes/:noteId/done", async (req) => {
    const { partner } = await ctx(req);
    const noteId = Id.parse((req.params as { noteId: string }).noteId);
    const [n] = await db.update(partnerNotes).set({ followUpDoneAt: new Date() })
      .where(and(eq(partnerNotes.id, noteId), eq(partnerNotes.partnerId, partner.id), isNotNull(partnerNotes.followUpAt), isNull(partnerNotes.followUpDoneAt)))
      .returning();
    if (!n) throw new DomainError("not_found", "Нема отворен потсетник.", 404);
    return { ok: true };
  });

  /** Otvoreni potsetnici na klientot (zadocneti, denes i do `days` dena napred). */
  app.get("/api/clients/:clientId/followups", async (req) => {
    const u = requireUser(req);
    const clientId = Id.parse((req.params as { clientId: string }).clientId);
    await assertClientAccess(db, u, clientId);
    const { days } = z.object({ days: z.coerce.number().int().min(0).max(60).default(7) }).parse(req.query);
    const until = new Date(Date.now() + days * 864e5).toLocaleDateString("sv-SE", { timeZone: "Europe/Skopje" });
    const rows = await db.select({ id: partnerNotes.id, partnerId: partnerNotes.partnerId, partnerName: partners.name, kind: partnerNotes.kind,
      text: partnerNotes.text, followUpAt: partnerNotes.followUpAt, createdAt: partnerNotes.createdAt, author: users.displayName })
      .from(partnerNotes).innerJoin(partners, eq(partners.id, partnerNotes.partnerId)).leftJoin(users, eq(users.id, partnerNotes.createdBy))
      .where(and(eq(partnerNotes.clientId, clientId), isNotNull(partnerNotes.followUpAt), isNull(partnerNotes.followUpDoneAt), lte(partnerNotes.followUpAt, until)))
      .orderBy(asc(partnerNotes.followUpAt));
    const t = today();
    return rows.map((r) => ({ ...r, overdue: r.followUpAt! < t, isToday: r.followUpAt === t }));
  });
}
