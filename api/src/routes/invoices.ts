/** Fakturi: lista, detali, nacrt (kreiraj / zacuvaj), izdavanje, otkazuvanje. */
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { invoiceLines, invoices, items, partners, vatRates } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import { audit } from "../domain/audit.js";
import { calcLine, calcTotals } from "../domain/calc.js";
import { issueInvoice } from "../domain/issue.js";
import { assertClientAccess, requireUser } from "../auth/context.js";
import { Id } from "./master.js";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LineIn = z.object({
  itemId: Id.optional().nullable(),
  description: z.string().trim().min(1).max(500),
  unit: z.string().trim().min(1).max(10),
  qty: z.coerce.number().positive().max(1e9),
  unitPrice: z.coerce.number().min(0).max(1e12),
  discountPct: z.coerce.number().min(0).max(100).default(0),
  vatRateId: Id,
  priceSource: z.string().trim().max(80).optional().nullable(),
});
const DraftIn = z.object({
  partnerId: Id,
  docType: z.enum(["INV", "AV"]).default("INV"),   // OD/KZ/ST/KR se pravat od izdadena faktura (sledna faza)
  issueDate: Day,
  supplyDate: Day.optional().nullable(),
  dueDate: Day.optional().nullable(),
  paymentMethod: z.enum(["bank", "cash", "card", "compensation", "other"]).default("bank"),
  note: z.string().max(2000).optional().nullable(),
  clauses: z.string().max(4000).optional().nullable(),
  lines: z.array(LineIn).max(500),
  version: z.number().int().optional(),
});
type Draft = z.infer<typeof DraftIn>;

export async function invoiceRoutes(app: FastifyInstance, { db }: { db: Db }) {
  /** Ja vcituva fakturata i proveruva pristap (404 za tugi). */
  const load = async (req: Parameters<typeof requireUser>[0]) => {
    const u = requireUser(req);
    const id = Id.parse((req.params as { id: string }).id);
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
    if (!inv) throw new DomainError("not_found", "Фактурата не постои.", 404);
    await assertClientAccess(db, u, inv.clientId);
    return { u, inv };
  };

  app.get("/api/clients/:clientId/invoices", async (req) => {
    const u = requireUser(req);
    const clientId = Id.parse((req.params as { clientId: string }).clientId);
    await assertClientAccess(db, u, clientId);
    const q = z.object({ year: z.coerce.number().int().optional(), status: z.string().optional(), docType: z.string().optional() }).parse(req.query);
    const conds = [eq(invoices.clientId, clientId)];
    if (q.year) conds.push(eq(invoices.year, q.year));
    if (q.status) conds.push(inArray(invoices.status, q.status.split(",") as never));
    if (q.docType) conds.push(inArray(invoices.docType, q.docType.split(",") as never));
    return db.select({
      id: invoices.id, number: invoices.number, docType: invoices.docType, status: invoices.status,
      issueDate: invoices.issueDate, dueDate: invoices.dueDate,
      buyerName: sql<string>`coalesce(${invoices.buyerName}, ${partners.name})`,
      netTotal: invoices.netTotal, vatTotal: invoices.vatTotal, grossTotal: invoices.grossTotal, payableAmount: invoices.payableAmount,
      ujpId: invoices.ujpId, ujpStatusName: invoices.ujpStatusName, ujpError: invoices.ujpError, relatedInvoiceId: invoices.relatedInvoiceId,
    }).from(invoices).innerJoin(partners, eq(partners.id, invoices.partnerId))
      .where(and(...conds)).orderBy(desc(invoices.issueDate), desc(invoices.id)).limit(1000);
  });

  app.get("/api/invoices/:id", async (req) => {
    const { inv } = await load(req);
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id)).orderBy(asc(invoiceLines.lineNo));
    const totals = calcTotals(lines.map((l) => ({ ...l, unitNet: "0" })), inv.advanceAmount ?? 0);
    return { ...inv, lines, byRate: totals.byRate };
  });

  /** Gi presmetuva stavkite na serverot (klientot samo prikazuva) i gi zapisuva. */
  async function writeDraft(tx: Db, invoiceId: number, clientId: number, b: Draft) {
    const [partner] = await tx.select().from(partners).where(and(eq(partners.id, b.partnerId), eq(partners.clientId, clientId)));
    if (!partner) throw new DomainError("validation", "Купувачот не постои.", 422);
    const rates = new Map((await tx.select().from(vatRates)).map((r) => [r.id, r]));
    const itemIds = b.lines.map((l) => l.itemId).filter((x): x is number => !!x);
    if (itemIds.length) {
      const own = await tx.select({ id: items.id }).from(items).where(and(eq(items.clientId, clientId), inArray(items.id, itemIds)));
      if (own.length !== new Set(itemIds).size) throw new DomainError("validation", "Непознат артикл.", 422);
    }
    await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
    const calc = [];
    for (const [i, l] of b.lines.entries()) {
      const rate = rates.get(l.vatRateId);
      if (!rate) throw new DomainError("validation", `Ставка ${i + 1}: непозната ДДВ стапка.`, 422);
      const r = calcLine({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, vatRatePct: rate.ratePct });
      await tx.insert(invoiceLines).values({
        invoiceId, lineNo: i + 1, itemId: l.itemId ?? null, description: l.description, unit: l.unit,
        qty: String(l.qty), unitPrice: String(l.unitPrice), discountPct: String(l.discountPct),
        vatRateId: rate.id, vatRatePct: rate.ratePct, netAmount: r.netAmount, vatAmount: r.vatAmount, priceSource: l.priceSource ?? null,
      });
      calc.push({ ...r, vatRatePct: rate.ratePct });
    }
    const t = calcTotals(calc);
    await tx.update(invoices).set({
      partnerId: b.partnerId, docType: b.docType, year: Number(b.issueDate.slice(0, 4)), issueDate: b.issueDate,
      supplyDate: b.docType === "AV" ? null : (b.supplyDate ?? b.issueDate), dueDate: b.dueDate ?? null,
      paymentMethod: b.paymentMethod, note: b.note ?? null, clauses: b.clauses ?? null,
      netTotal: t.netTotal, vatTotal: t.vatTotal, grossTotal: t.grossTotal, payableAmount: t.payableAmount, lineCount: b.lines.length,
      buyerName: partner.name, version: sql`${invoices.version} + 1`,
    }).where(eq(invoices.id, invoiceId));
  }

  app.post("/api/clients/:clientId/invoices", async (req, reply) => {
    const u = requireUser(req);
    const clientId = Id.parse((req.params as { clientId: string }).clientId);
    await assertClientAccess(db, u, clientId);
    const b = DraftIn.parse(req.body);
    const [partner] = await db.select({ id: partners.id }).from(partners).where(and(eq(partners.id, b.partnerId), eq(partners.clientId, clientId)));
    if (!partner) throw new DomainError("validation", "Купувачот не постои.", 422);
    const id = await db.transaction(async (tx) => {
      const [inv] = await tx.insert(invoices).values({ clientId, partnerId: b.partnerId, docType: b.docType,
        year: Number(b.issueDate.slice(0, 4)), issueDate: b.issueDate, createdBy: u.id }).returning();
      await writeDraft(tx as unknown as Db, inv!.id, clientId, b);
      return inv!.id;
    });
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "invoice", entityId: id, action: "create_draft" });
    return reply.status(201).send({ id });
  });

  app.put("/api/invoices/:id", async (req) => {
    const { u, inv } = await load(req);
    const b = DraftIn.parse(req.body);
    if (inv.status !== "draft") throw new DomainError("not_draft", "Само нацрт може да се менува.", 409);
    if (b.version !== undefined && b.version !== inv.version)
      throw new DomainError("conflict", "Фактурата е изменета од друг корисник. Освежете ја страницата.", 409);
    await db.transaction(async (tx) => {
      const [locked] = await tx.select({ v: invoices.version }).from(invoices).where(eq(invoices.id, inv.id)).for("update");
      if (locked!.v !== inv.version) throw new DomainError("conflict", "Фактурата е изменета од друг корисник. Освежете ја страницата.", 409);
      await writeDraft(tx as unknown as Db, inv.id, inv.clientId, b);
    });
    await audit(db, { userId: u.id, ip: req.ip }, { clientId: inv.clientId, entity: "invoice", entityId: inv.id, action: "save_draft" });
    return { id: inv.id };
  });

  app.post("/api/invoices/:id/issue", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const { u, inv } = await load(req);
    const r = await issueInvoice(db, inv.id, { userId: u.id, ip: req.ip });
    return { id: r.id, number: r.number, status: r.status };
  });

  /** Nacrt: se otkazuva (ostanuva trag). Izdadena: ne - samo storno/korekcija. */
  app.post("/api/invoices/:id/cancel", async (req) => {
    const { u, inv } = await load(req);
    if (inv.status !== "draft") throw new DomainError("not_draft", "Само нацрт може да се откаже. Издадена фактура се сторнира.", 409);
    await db.update(invoices).set({ status: "cancelled_draft" }).where(eq(invoices.id, inv.id));
    await audit(db, { userId: u.id, ip: req.ip }, { clientId: inv.clientId, entity: "invoice", entityId: inv.id, action: "cancel_draft" });
    return { ok: true };
  });
}
