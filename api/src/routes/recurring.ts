/** Повторувачки фактури (модул "recurring", docs/10). */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { invoices, partners, recurringInvoices, vatRates } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import { audit } from "../domain/audit.js";
import { calcLine, calcTotals } from "../domain/calc.js";
import { createRecurring, dateIn, firstOnOrAfter, nextMonth, runRecurring, todaySkopje, updateTemplateFrom } from "../domain/recurring.js";
import { assertModule, requireUser } from "../auth/context.js";
import { Id } from "./master.js";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DayOfMonth = z.coerce.number().int().min(0).max(28);

export async function recurringRoutes(app: FastifyInstance, { db }: { db: Db }) {
  const ctx = async (req: Parameters<typeof requireUser>[0]) => {
    const u = requireUser(req);
    const p = z.object({ clientId: Id, id: Id.optional() }).parse(req.params);
    await assertModule(db, u, p.clientId, "recurring");
    return { u, clientId: p.clientId, id: p.id };
  };
  const loadOne = async (clientId: number, id: number) => {
    const [r] = await db.select().from(recurringInvoices).where(and(eq(recurringInvoices.id, id), eq(recurringInvoices.clientId, clientId)));
    if (!r) throw new DomainError("not_found", "Повторувачката фактура не постои.", 404);
    return r;
  };

  app.get("/api/clients/:clientId/recurring", async (req) => {
    const { clientId } = await ctx(req);
    const rows = await db.select({ r: recurringInvoices, partnerName: partners.name, partnerActive: partners.isActive,
      generated: sql<number>`(select count(*)::int from invoices i where i.recurring_id = ${recurringInvoices.id})`,
      lastId: sql<number | null>`(select max(i.id) from invoices i where i.recurring_id = ${recurringInvoices.id})` })
      .from(recurringInvoices).innerJoin(partners, eq(partners.id, recurringInvoices.partnerId))
      .where(eq(recurringInvoices.clientId, clientId)).orderBy(desc(recurringInvoices.isActive), partners.name);
    const rates = new Map((await db.select().from(vatRates)).map((v) => [v.id, v.ratePct]));
    const last = new Map<number, { number: string | null; status: string; issueDate: string }>();
    for (const x of rows) if (x.lastId) {
      const [i] = await db.select({ number: invoices.number, status: invoices.status, issueDate: invoices.issueDate }).from(invoices).where(eq(invoices.id, x.lastId));
      if (i) last.set(x.lastId, i);
    }
    return rows.map(({ r, ...x }) => {
      const t = calcTotals(r.lines.map((l) => ({ ...calcLine({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, vatRatePct: rates.get(l.vatRateId) ?? "0" }),
        vatRatePct: rates.get(l.vatRateId) ?? "0" })));
      return { ...r, partnerName: x.partnerName, partnerActive: x.partnerActive, generated: x.generated, grossTotal: t.grossTotal,
        last: x.lastId ? { id: x.lastId, ...last.get(x.lastId)! } : null };
    });
  });

  app.post("/api/clients/:clientId/recurring", async (req, reply) => {
    const { u, clientId } = await ctx(req);
    const b = z.object({ invoiceId: Id, name: z.string().trim().min(2).max(120), dayOfMonth: DayOfMonth, startDate: Day,
      endDate: Day.optional().nullable() }).parse(req.body);
    const r = await createRecurring(db, clientId, b.invoiceId, b, u.id);
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "recurring", entityId: r.id, action: "create", changes: b });
    return reply.status(201).send(r);
  });

  app.patch("/api/clients/:clientId/recurring/:id", async (req) => {
    const { u, clientId, id } = await ctx(req);
    const r = await loadOne(clientId, id!);
    const b = z.object({ name: z.string().trim().min(2).max(120).optional(), dayOfMonth: DayOfMonth.optional(),
      endDate: Day.optional().nullable(), isActive: z.boolean().optional() }).parse(req.body);
    const set: Partial<typeof recurringInvoices.$inferInsert> = { ...b, updatedAt: new Date() };
    const day = b.dayOfMonth ?? r.dayOfMonth;
    // продолжување или нов ден: следниот датум од денес (пропуштените месеци НЕ се прават)
    const today = todaySkopje();
    if (b.isActive && !r.isActive) set.nextDate = firstOnOrAfter(today, day);
    else if (b.dayOfMonth !== undefined && b.dayOfMonth !== r.dayOfMonth) {
      // ист месец како досегашниот следен датум (да нема две фактури во ист месец), но не во минатото
      const d = dateIn(Number(r.nextDate.slice(0, 4)), Number(r.nextDate.slice(5, 7)) - 1, day);
      const ym = r.nextDate.slice(0, 7);
      const [inMonth] = await db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.recurringId, r.id), sql`to_char(${invoices.issueDate}, 'YYYY-MM') = ${ym}`)).limit(1);
      set.nextDate = d >= today ? d : inMonth ? nextMonth(d, day) : today;
    }
    if (b.endDate && b.endDate < (set.nextDate ?? r.nextDate) && (b.isActive ?? r.isActive)) throw new DomainError("validation", "Крајот е пред следната фактура.", 422);
    const [out] = await db.update(recurringInvoices).set(set).where(eq(recurringInvoices.id, r.id)).returning();
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "recurring", entityId: r.id, action: "update", changes: b });
    return out;
  });

  /** Ставките од последната генерирана фактура стануваат шаблон (ако ја поправиле цената/количината). */
  app.post("/api/clients/:clientId/recurring/:id/template-from-last", async (req) => {
    const { u, clientId, id } = await ctx(req);
    const r = await loadOne(clientId, id!);
    const [last] = await db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.recurringId, r.id), sql`${invoices.status} <> 'cancelled_draft'`))
      .orderBy(desc(invoices.issueDate), desc(invoices.id)).limit(1);
    if (!last) throw new DomainError("validation", "Уште нема генерирана фактура.", 422);
    await updateTemplateFrom(db, r.id, last.id);
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "recurring", entityId: r.id, action: "template_from", changes: { invoiceId: last.id } });
    return { ok: true };
  });

  app.post("/api/clients/:clientId/recurring/run", async (req) => {
    const { u, clientId } = await ctx(req);
    const r = await runRecurring(db, { clientId });
    if (r.created.length) await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "recurring", entityId: 0, action: "run", changes: { created: r.created.length } });
    return r;
  });

  app.delete("/api/clients/:clientId/recurring/:id", async (req) => {
    const { u, clientId, id } = await ctx(req);
    const r = await loadOne(clientId, id!);
    const [g] = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.recurringId, r.id)).limit(1);
    if (g) throw new DomainError("in_use", "Од оваа повторувачка има направени фактури: запрете ја наместо бришење.", 409);
    await db.delete(recurringInvoices).where(eq(recurringInvoices.id, r.id));
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "recurring", entityId: r.id, action: "delete" });
    return { ok: true };
  });
}
