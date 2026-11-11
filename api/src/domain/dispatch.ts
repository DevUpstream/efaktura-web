/**
 * Ispratnici bez faktura (docs/12): stokata izleguva od magacin so ispratnica na kupuvac, fakturata se pravi podocna
 * od edna ili povekje ispratnici. Stavkite na fakturata ja pamtat ispratnicata (invoice_lines.stock_doc_id), pa pri
 * izdavanje zalihata ne se izdava povtorno. Storno na fakturata ja vrakja ispratnicata vo "nefakturirani".
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import * as s from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "./errors.js";

const { invoiceLines, invoices, items, partners, stockDocs, stockMoves, warehouses } = s;

/** Ispratnicite moraat da se na kupuvacot, nestornirani i ne vo druga vazecka faktura (osven dozvolenite: ovaa i originalot kaj korekcija). */
export async function assertDispatchesFree(tx: Db, clientId: number, partnerId: number, docIds: number[], allowInvoiceIds: number[]) {
  const docs = await tx.select().from(stockDocs).where(and(eq(stockDocs.clientId, clientId), inArray(stockDocs.id, docIds)));
  const errors: string[] = [];
  for (const id of docIds) {
    const d = docs.find((x) => x.id === id);
    if (!d || d.kind !== "issue" || !d.partnerId || d.invoiceId) { errors.push(`Документ ${id} не е испратница без фактура.`); continue; }
    if (d.partnerId !== partnerId) errors.push(`Испратницата ${d.number} е за друг купувач.`);
    const [rev] = await tx.select({ id: stockDocs.id }).from(stockDocs).where(eq(stockDocs.reversesDocId, d.id));
    if (rev || d.reversesDocId) errors.push(`Испратницата ${d.number} е сторнирана.`);
  }
  const used = await tx.select({ doc: invoiceLines.stockDocId, number: invoices.number, id: invoices.id }).from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(inArray(invoiceLines.stockDocId, docIds), sql`${invoices.status} not in ('cancelled_draft','voided','rejected')`));
  for (const u of used) if (!allowInvoiceIds.includes(u.id))
    errors.push(`Испратницата ${docs.find((d) => d.id === u.doc)?.number ?? u.doc} е веќе во фактура ${u.number ?? `нацрт ${u.id}`}.`);
  if (errors.length) throw new DomainError("validation", [...new Set(errors)].join(" "), 422);
}


export interface DispatchRow {
  id: number; number: string; docDate: string; partnerId: number; partnerName: string; warehouseId: number; warehouseName: string; note: string | null;
  lines: { itemId: number; code: string; name: string; unit: string; qty: string; value: string }[];
  billedBy: { id: number; number: string | null; status: string } | null; reversed: boolean;
}

/** Ispratnici bez faktura; onlyOpen = samo nefakturirani i nestornirani. */
export async function listDispatches(db: Db, clientId: number, o: { partnerId?: number; onlyOpen?: boolean; ids?: number[] } = {}): Promise<DispatchRow[]> {
  const conds = [eq(stockDocs.clientId, clientId), eq(stockDocs.kind, "issue"), sql`${stockDocs.partnerId} is not null`, isNull(stockDocs.invoiceId), isNull(stockDocs.reversesDocId)];
  if (o.partnerId) conds.push(eq(stockDocs.partnerId, o.partnerId));
  if (o.ids) conds.push(inArray(stockDocs.id, o.ids.length ? o.ids : [-1]));
  const docs = await db.select({ d: stockDocs, partnerName: partners.name, warehouseName: warehouses.name }).from(stockDocs)
    .innerJoin(partners, eq(partners.id, stockDocs.partnerId)).innerJoin(warehouses, eq(warehouses.id, stockDocs.warehouseId))
    .where(and(...conds)).orderBy(desc(stockDocs.docDate), desc(stockDocs.id)).limit(1000);
  if (!docs.length) return [];
  const ids = docs.map((x) => x.d.id);
  const moves = await db.select({ docId: stockMoves.docId, itemId: items.id, code: items.code, name: items.name, unit: items.unit,
    qty: sql<string>`-sum(${stockMoves.qty})`, value: sql<string>`-sum(${stockMoves.value})` })
    .from(stockMoves).innerJoin(items, eq(items.id, stockMoves.itemId)).where(inArray(stockMoves.docId, ids))
    .groupBy(stockMoves.docId, items.id, items.code, items.name, items.unit).orderBy(asc(items.code));
  const reversed = new Set((await db.select({ r: stockDocs.reversesDocId }).from(stockDocs).where(inArray(stockDocs.reversesDocId, ids))).map((x) => x.r));
  const billed = await db.selectDistinct({ doc: invoiceLines.stockDocId, id: invoices.id, number: invoices.number, status: invoices.status }).from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(inArray(invoiceLines.stockDocId, ids), sql`${invoices.status} not in ('cancelled_draft','voided','rejected')`));
  const rows = docs.map(({ d, partnerName, warehouseName }) => {
    const b = billed.filter((x) => x.doc === d.id).sort((a, c) => c.id - a.id)[0];
    return { id: d.id, number: d.number, docDate: d.docDate, partnerId: d.partnerId!, partnerName, warehouseId: d.warehouseId, warehouseName, note: d.note,
      lines: moves.filter((m) => m.docId === d.id).map(({ docId: _x, ...m }) => m),
      billedBy: b ? { id: b.id, number: b.number, status: b.status } : null, reversed: reversed.has(d.id) };
  });
  return o.onlyOpen ? rows.filter((r) => !r.billedBy && !r.reversed) : rows;
}
