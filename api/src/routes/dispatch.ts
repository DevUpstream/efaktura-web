/**
 * Ispratnici bez faktura (docs/12): lista na nefakturirani, faktura od izbrani ispratnici, PDF na magacinski dokument.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { clients, invoices, items, lots, partners, stockDocs, stockMoves, warehouses } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import { audit } from "../domain/audit.js";
import { listDispatches } from "../domain/dispatch.js";
import { renderSimpleDoc, q3 } from "../domain/pdf-docs.js";
import { assertModule, requireUser } from "../auth/context.js";
import { Id, suggestPrice } from "./master.js";
import { writeDraft, type Draft } from "./invoices.js";

const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Skopje" });
const KIND_TITLE: Record<string, string> = { receipt: "Приемница", issue: "Испратница", writeoff: "Отпис", inventory: "Попис",
  transfer: "Пренос меѓу магацини", consumption: "Издатница за производство", output: "Приемница на готов производ" };

export async function dispatchRoutes(app: FastifyInstance, { db }: { db: Db }) {
  const ctx = async (req: FastifyRequest) => {
    const u = requireUser(req);
    const p = z.object({ clientId: Id, id: Id.optional() }).parse(req.params);
    await assertModule(db, u, p.clientId, "warehouse");
    return { u, ...p };
  };

  /** Ispratnici bez faktura: ?open=1 samo nefakturirani; ?partnerId= za eden kupuvac. */
  app.get("/api/clients/:clientId/dispatches", async (req) => {
    const { clientId } = await ctx(req);
    const q = z.object({ open: z.enum(["0", "1"]).default("1"), partnerId: Id.optional() }).parse(req.query);
    return listDispatches(db, clientId, { onlyOpen: q.open === "1", partnerId: q.partnerId });
  });

  /** Nov NACRT faktura od izbrani ispratnici (ist kupuvac). Cenite: dogovorena / posledna / standardna (kako vo urednikot). */
  app.post("/api/clients/:clientId/dispatches/invoice", async (req, reply) => {
    const { u, clientId } = await ctx(req);
    const { docIds } = z.object({ docIds: z.array(Id).min(1).max(100) }).parse(req.body);
    const ds = await listDispatches(db, clientId, { ids: docIds });
    if (ds.length !== new Set(docIds).size) throw new DomainError("validation", "Некои од избраните документи не се испратници без фактура.", 422);
    const open = ds.filter((d) => !d.billedBy && !d.reversed);
    if (open.length !== ds.length) throw new DomainError("validation", `Веќе фактурирани или сторнирани: ${ds.filter((d) => !open.includes(d)).map((d) => d.number).join(", ")}.`, 422);
    const partnerIds = new Set(ds.map((d) => d.partnerId));
    if (partnerIds.size !== 1) throw new DomainError("validation", "Изберете испратници само за еден купувач.", 422);
    const partnerId = ds[0]!.partnerId;
    const date = today();
    const its = new Map((await db.select().from(items).where(eq(items.clientId, clientId))).map((i) => [i.id, i]));
    const sorted = [...ds].sort((a, b) => a.docDate.localeCompare(b.docDate) || a.id - b.id);
    const lines: Draft["lines"] = [];
    for (const d of sorted) for (const l of d.lines) {
      const it = its.get(l.itemId)!;
      const p = await suggestPrice(db, clientId, { partnerId, itemId: l.itemId, date });
      lines.push({ itemId: l.itemId, description: it.name, unit: it.unit, qty: Number(l.qty), unitPrice: Number(p.price), discountPct: 0,
        vatRateId: it.vatRateId, priceSource: p.source.slice(0, 80), stockDocId: d.id });
    }
    const whs = new Set(ds.map((d) => d.warehouseId));
    const due = new Date(Date.parse(`${date}T12:00:00Z`) + 15 * 864e5).toISOString().slice(0, 10);   // ist rok kako nova faktura vo urednikot
    const b: Draft = { partnerId, docType: "INV", issueDate: date, supplyDate: sorted.at(-1)!.docDate, dueDate: due, paymentMethod: "bank",
      note: `По испратници: ${sorted.map((d) => `${d.number} од ${d.docDate.slice(8, 10)}.${d.docDate.slice(5, 7)}.${d.docDate.slice(0, 4)}`).join(", ")}`,
      warehouseId: whs.size === 1 ? ds[0]!.warehouseId : null, lines };
    const id = await db.transaction(async (tx) => {
      const [inv] = await tx.insert(invoices).values({ clientId, partnerId, docType: "INV", year: Number(date.slice(0, 4)), issueDate: date, createdBy: u.id }).returning();
      await writeDraft(tx as unknown as Db, inv!.id, clientId, b, null);
      return inv!.id;
    });
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "invoice", entityId: id, action: "from_dispatches", changes: { docs: sorted.map((d) => d.number) } });
    return reply.status(201).send({ id });
  });

  /** PDF na magacinski dokument (ispratnicata so "Издал / Примил"). */
  app.get("/api/clients/:clientId/stock-docs/:id/pdf", async (req, reply) => {
    const { clientId, id } = await ctx(req);
    const [d] = await db.select().from(stockDocs).where(and(eq(stockDocs.id, id!), eq(stockDocs.clientId, clientId)));
    if (!d) throw new DomainError("not_found", "Документот не постои.", 404);
    const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
    const [wh] = await db.select().from(warehouses).where(eq(warehouses.id, d.warehouseId));
    const [partner] = d.partnerId ? await db.select().from(partners).where(eq(partners.id, d.partnerId)) : [];
    const moves = await db.select({ code: items.code, name: items.name, unit: items.unit, qty: stockMoves.qty, lotNo: lots.lotNo, whId: stockMoves.warehouseId })
      .from(stockMoves).innerJoin(items, eq(items.id, stockMoves.itemId)).leftJoin(lots, eq(lots.id, stockMoves.lotId))
      .where(eq(stockMoves.docId, d.id)).orderBy(asc(stockMoves.id));
    const own = moves.filter((m) => m.whId === d.warehouseId);
    const isIssue = d.kind === "issue";
    const pdf = await renderSimpleDoc({
      client: client!, title: (d.reversesDocId ? "Сторно – " : "") + (KIND_TITLE[d.kind] ?? d.kind), number: d.number, date: d.docDate,
      meta: [["Магацин", wh?.name ?? ""]], partner: partner ? { name: partner.name, edb: partner.edb, address: partner.address, city: partner.city } : null,
      partnerLabel: "Примач", intro: d.note ? [d.note] : [],
      sections: [{ cols: [{ title: "Р.бр.", width: 6 }, { title: "Шифра", width: 16 }, { title: "Назив", width: 50 }, { title: "Лот", width: 12 },
        { title: "Ед.", width: 7 }, { title: "Количина", width: 12, align: "right" }],
        rows: own.map((m, i) => [String(i + 1), m.code, m.name, m.lotNo ?? "", m.unit, q3(Math.abs(Number(m.qty)))]) }],
      outro: isIssue ? ["Испратницата не е фактура. Фактурата ќе биде издадена дополнително."] : [],
      signatures: isIssue ? ["Издал", "Превезол", "Примил (име, презиме, потпис)"] : ["Изготвил", "Одобрил"],
    });
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="${d.number}.pdf"`).send(pdf);
  });
}
