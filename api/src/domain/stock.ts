/**
 * Magacin (docs/07): kniga na dvizenja so prosecna nabavna cena.
 *  - zalihata se menuva SAMO preku postStockDoc (vo transakcija na povikuvacot);
 *  - vlez: vrednost += kol x cena; prosekot = vrednost / kolicina;
 *  - izlez: po tekovnata prosecna cena; ako se isprazni zalihata, izleguva celata preostanata vrednost;
 *  - zaliha vo minus: spored poставkata na klientot (block = greska, warn = dozvoleno + predupreduvanje);
 *  - lot: vlez so broj i rok; izlez avtomatski po najbliskiot rok (FEFO), osven ako e daden lot.
 */
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { clients, items, lotBalances, lots, STOCK_DOC_CODE, STOCK_ITEM_TYPES, stockBalances, stockCounters, stockDocs, stockMoves,
  warehouses } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "./errors.js";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const r4 = (v: Decimal.Value) => new D(v).toDecimalPlaces(4, D.ROUND_HALF_UP);
type Kind = (typeof stockDocs.$inferSelect)["kind"];
export type Tx = Db;

export interface MoveIn {
  warehouseId: number; itemId: number;
  qty: Decimal.Value;                // + vlez, - izlez
  unitCost?: Decimal.Value;          // zadolzitelno kaj vlez; kaj izlez samo za tocno storno
  value?: Decimal.Value;             // tocna vrednost na vlezot (bez razlika od zaokruzuvanje), samo bez lot-delenje
  lotId?: number | null; lotNo?: string | null; expiryDate?: string | null;
}
export interface StockDocIn {
  clientId: number; kind: Kind; warehouseId: number; toWarehouseId?: number | null; docDate: string;
  purchaseInvoiceId?: number | null; invoiceId?: number | null; workOrderId?: number | null; reversesDocId?: number | null; note?: string | null;
  createdBy?: number | null; moves: MoveIn[];
}

export function formatStockNumber(prefix: string, code: string, year: number, seq: number) {
  return `${prefix}-${code}-${year}-${String(seq).padStart(5, "0")}`;
}

export async function nextStockNo(tx: Tx, clientId: number, kind: string, year: number) {
  const [c] = await tx.insert(stockCounters).values({ clientId, kind, year, lastNo: 1 })
    .onConflictDoUpdate({ target: [stockCounters.clientId, stockCounters.kind, stockCounters.year], set: { lastNo: sql`${stockCounters.lastNo} + 1` } })
    .returning();
  return c!.lastNo;
}

export async function defaultWarehouse(tx: Tx, clientId: number) {
  const [w] = await tx.select().from(warehouses).where(and(eq(warehouses.clientId, clientId), eq(warehouses.isDefault, true)));
  if (!w) throw new DomainError("validation", "Клиентот нема главен магацин.", 422);
  return w;
}

async function lockBalance(tx: Tx, clientId: number, warehouseId: number, itemId: number) {
  await tx.insert(stockBalances).values({ clientId, warehouseId, itemId }).onConflictDoNothing();
  const [b] = await tx.select().from(stockBalances)
    .where(and(eq(stockBalances.warehouseId, warehouseId), eq(stockBalances.itemId, itemId))).for("update");
  return b!;
}

async function lotFor(tx: Tx, clientId: number, itemId: number, lotNo: string, expiry: string | null | undefined) {
  const no = lotNo.trim();
  await tx.insert(lots).values({ clientId, itemId, lotNo: no, expiryDate: expiry ?? null }).onConflictDoNothing();
  const [l] = await tx.select().from(lots).where(and(eq(lots.itemId, itemId), eq(lots.lotNo, no)));
  return l!;
}

/** Lotovi so zaliha po rok (FEFO), za izlez. */
async function fefo(tx: Tx, warehouseId: number, itemId: number) {
  return tx.select({ lotId: lots.id, qty: lotBalances.qty }).from(lotBalances).innerJoin(lots, eq(lots.id, lotBalances.lotId))
    .where(and(eq(lotBalances.warehouseId, warehouseId), eq(lots.itemId, itemId), gt(lotBalances.qty, "0")))
    .orderBy(sql`${lots.expiryDate} asc nulls last`, asc(lots.id)).for("update");
}

async function addLot(tx: Tx, lotId: number, warehouseId: number, qty: Decimal) {
  await tx.insert(lotBalances).values({ lotId, warehouseId, qty: qty.toFixed(4) })
    .onConflictDoUpdate({ target: [lotBalances.lotId, lotBalances.warehouseId], set: { qty: sql`${lotBalances.qty} + ${qty.toFixed(4)}` } });
}

type StockClient = typeof clients.$inferSelect;
type StockDoc = typeof stockDocs.$inferSelect;
type StockMove = typeof stockMoves.$inferSelect;

async function createDoc(tx: Tx, client: StockClient, d: Omit<StockDocIn, "moves">): Promise<StockDoc> {
  const year = Number(d.docDate.slice(0, 4));
  const seqNo = await nextStockNo(tx, d.clientId, d.kind, year);
  const [doc] = await tx.insert(stockDocs).values({
    clientId: d.clientId, kind: d.kind, warehouseId: d.warehouseId, toWarehouseId: d.toWarehouseId ?? null, year, seqNo,
    number: formatStockNumber(client.invoicePrefix, STOCK_DOC_CODE[d.kind], year, seqNo), docDate: d.docDate,
    purchaseInvoiceId: d.purchaseInvoiceId ?? null, invoiceId: d.invoiceId ?? null, workOrderId: d.workOrderId ?? null, reversesDocId: d.reversesDocId ?? null,
    note: d.note ?? null, createdBy: d.createdBy ?? null,
  }).returning();
  return doc!;
}

/** Gi zapisuva dvizenjata na dokumentot; greskite i predupreduvanjata gi sobira. */
async function applyMoves(tx: Tx, client: StockClient, doc: StockDoc, moves: MoveIn[], errors: string[], warnings: string[]): Promise<StockMove[]> {
  const itemIds = [...new Set(moves.map((m) => m.itemId))];
  const its = itemIds.length ? await tx.select().from(items).where(and(eq(items.clientId, client.id), inArray(items.id, itemIds))) : [];
  const byId = new Map(its.map((i) => [i.id, i]));
  for (const id of itemIds) {
    const it = byId.get(id);
    if (!it) errors.push(`Артиклот ${id} не постои.`);
    else if (!(STOCK_ITEM_TYPES as readonly string[]).includes(it.type)) errors.push(`„${it.name}“ е услуга и не води залиха.`);
  }
  if (errors.length) return [];
  const out: StockMove[] = [];
  for (const m of moves) {
    const it = byId.get(m.itemId)!;
    const qty = r4(m.qty);
    if (qty.isZero()) continue;
    const b = await lockBalance(tx, client.id, m.warehouseId, m.itemId);
    let bq = new D(b.qty), bv = new D(b.value), lastCost = new D(b.lastCost);

    // delovi po lot: [lotId|null, kolicina]
    let parts: [number | null, Decimal][] = [[m.lotId ?? null, qty]];
    if (qty.gt(0) && it.trackLots && !m.lotId && !doc.reversesDocId) {
      if (!m.lotNo?.trim()) { errors.push(`„${it.name}“ води лот: внесете број на лот.`); continue; }
      parts = [[(await lotFor(tx, client.id, it.id, m.lotNo, m.expiryDate)).id, qty]];
    } else if (qty.lt(0) && it.trackLots && !m.lotId) {
      parts = [];
      let need = qty.abs();
      for (const l of await fefo(tx, m.warehouseId, it.id)) {
        if (need.lte(0)) break;
        const take = D.min(need, l.qty);
        parts.push([l.lotId, take.neg()]); need = need.minus(take);
      }
      if (need.gt(0)) parts.push([null, need.neg()]);  // bez lot (zaliha vo minus)
    }

    for (const [lotId, q] of parts) {
      let cost: Decimal, value: Decimal;
      if (m.unitCost !== undefined) { cost = r4(m.unitCost); value = m.value !== undefined && parts.length === 1 ? r4(m.value) : r4(q.times(cost)); }   // vlez ili tocno storno
      else if (q.gt(0)) { errors.push(`Недостасува набавна цена за „${it.name}“.`); continue; }
      else {
        const avg = bq.gt(0) ? bv.div(bq) : lastCost;
        cost = r4(avg);
        value = bq.plus(q).isZero() ? bv.neg() : r4(q.times(avg)); // ispraznuvanje: celata preostanata vrednost
      }
      const nq = bq.plus(q);
      if (q.lt(0) && nq.lt(0)) {
        const msg = `„${it.name}“: нема доволно залиха (има ${D.max(bq, 0).toFixed(2)}, потребно ${q.abs().toFixed(2)}).`;
        if (client.negativeStock === "block") { errors.push(msg); continue; }
        warnings.push(msg);
      }
      bq = nq; bv = bq.isZero() ? new D(0) : r4(bv.plus(value));
      if (q.gt(0)) lastCost = cost;
      const [mv] = await tx.insert(stockMoves).values({
        docId: doc.id, clientId: client.id, warehouseId: m.warehouseId, itemId: it.id, lotId,
        qty: q.toFixed(4), unitCost: cost.toFixed(4), value: value.toFixed(4), balanceQty: bq.toFixed(4), balanceValue: bv.toFixed(4),
      }).returning();
      out.push(mv!);
      if (lotId) await addLot(tx, lotId, m.warehouseId, q);
    }
    if (bq.gt(0)) lastCost = r4(bv.div(bq));
    await tx.update(stockBalances).set({ qty: bq.toFixed(4), value: bv.toFixed(4), lastCost: lastCost.toFixed(4) })
      .where(and(eq(stockBalances.warehouseId, m.warehouseId), eq(stockBalances.itemId, m.itemId)));
  }
  return out;
}

/**
 * Pravi magacinski dokument so dvizenjata. Mora da se povika vo transakcija.
 * Prenos (transfer): dvizenjata se izlezi od warehouseId; vlezovite vo toWarehouseId se pravat avtomatski
 * so istite ceni i lotovi. Vrakja dokumentot i predupreduvanjata (zaliha vo minus kaj "warn").
 */
export async function postStockDoc(tx: Tx, d: StockDocIn): Promise<{ doc: StockDoc; warnings: string[] }> {
  if (!d.moves.length) throw new DomainError("validation", "Документот нема ставки.", 422);
  const [client] = await tx.select().from(clients).where(eq(clients.id, d.clientId));
  const errors: string[] = [], warnings: string[] = [];
  const doc = await createDoc(tx, client!, d);
  const outs = await applyMoves(tx, client!, doc, d.moves, errors, warnings);
  if (d.kind === "transfer" && !d.reversesDocId && !errors.length) {
    if (!d.toWarehouseId || d.toWarehouseId === d.warehouseId) errors.push("Изберете друг магацин за пренос.");
    else await applyMoves(tx, client!, doc, outs.map((o) => ({ warehouseId: d.toWarehouseId!, itemId: o.itemId,
      qty: new D(o.qty).neg(), unitCost: o.unitCost, lotId: o.lotId })), errors, warnings);
  }
  if (errors.length) throw new DomainError("stock", errors.join(" "), 422);
  return { doc, warnings };
}

/** Tocno storno na dokument: istite dvizenja so obraten znak i istite ceni i lotovi. */
export async function reverseStockDoc(tx: Tx, docId: number, opts: { docDate: string; createdBy?: number | null; note?: string | null }) {
  const [orig] = await tx.select().from(stockDocs).where(eq(stockDocs.id, docId)).for("update");
  if (!orig) throw new DomainError("not_found", "Документот не постои.", 404);
  if (orig.reversesDocId) throw new DomainError("validation", "Сторно документ не се сторнира.", 422);
  const [done] = await tx.select({ id: stockDocs.id }).from(stockDocs).where(eq(stockDocs.reversesDocId, orig.id));
  if (done) throw new DomainError("validation", `Документот ${orig.number} е веќе сторниран.`, 409);
  const moves = await tx.select().from(stockMoves).where(eq(stockMoves.docId, orig.id)).orderBy(asc(stockMoves.id));
  return postStockDoc(tx, {
    clientId: orig.clientId, kind: orig.kind, warehouseId: orig.warehouseId, toWarehouseId: orig.toWarehouseId, docDate: opts.docDate,
    purchaseInvoiceId: orig.purchaseInvoiceId, invoiceId: orig.invoiceId, workOrderId: orig.workOrderId, reversesDocId: orig.id,
    note: opts.note ?? `Сторно на ${orig.number}`, createdBy: opts.createdBy,
    // obraten redosled: prvo se vrakja izlezot (kaj prenos), pa vlezot
    moves: moves.reverse().map((m) => ({ warehouseId: m.warehouseId, itemId: m.itemId, qty: new D(m.qty).neg(), unitCost: m.unitCost, value: new D(m.value).neg(), lotId: m.lotId })),
  });
}

/** Momentalna sostojba (za proverka pred izlez/prenos). */
export async function balanceOf(tx: Tx, warehouseId: number, itemId: number) {
  const [b] = await tx.select().from(stockBalances).where(and(eq(stockBalances.warehouseId, warehouseId), eq(stockBalances.itemId, itemId)));
  return { qty: new D(b?.qty ?? 0), value: new D(b?.value ?? 0), avg: b && new D(b.qty).gt(0) ? new D(b.value).div(b.qty) : new D(b?.lastCost ?? 0) };
}
export { D as StockDecimal };
