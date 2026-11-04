/**
 * Proizvodstvo (docs/07).
 *  - Firma: kako se presmetuva cenata na cinenje (otpad, trud, struja/opsti troshoci) -> clients.productionSettings.
 *  - Proizvod: normativ (od sto e napraven, za outputQty parcinja; trud vo casovi ili po parce).
 *  - Raboten nalog: planirani kolicini od normativot (so otpad), realnite se popravaat pred knizenje.
 *    Knizenje: izdatnica (PI) na delovite po prosecna cena -> priemnica na gotov proizvod (GP) po cena na cinenje.
 *  - Polu-proizvod: sekoj artikl so zaliha moze da e del vo normativ (i "Gotov proizvod"), pa se pravi na nivoa so poveke nalozi.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { bomLines, boms, clients, DEFAULT_PRODUCTION, type ProductionSettings, stockDocs, stockMoves, workOrderLines, workOrders } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "./errors.js";
import { audit, type Actor } from "./audit.js";
import { defaultWarehouse, formatStockNumber, nextStockNo, postStockDoc, reverseStockDoc } from "./stock.js";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const r4 = (v: Decimal.Value) => new D(v).toDecimalPlaces(4, D.ROUND_HALF_UP);

export function productionSettings(c: { productionSettings: ProductionSettings | null }): ProductionSettings {
  return { ...DEFAULT_PRODUCTION, ...(c.productionSettings ?? {}) };
}

/** Planirani kolicini za `qty` parcinja od normativot (so otpad ako firmata go koristi). */
export function plannedLines(bom: { outputQty: string }, lines: { itemId: number; qty: string; wastePct: string }[], qty: Decimal.Value, useWaste: boolean) {
  const factor = new D(qty).div(bom.outputQty);
  return lines.map((l) => {
    const base = new D(l.qty).times(factor);
    const waste = useWaste ? new D(l.wastePct) : new D(0);
    // so otpad X% treba base / (1 - X%) za da ostane base vo proizvodot
    const planned = waste.isZero() ? base : base.div(new D(1).minus(waste.div(100)));
    return { itemId: l.itemId, plannedQty: r4(planned).toFixed(4) };
  });
}

/** Trud i opsti troshoci za nalogot (racnite iznosi imaat prednost). */
export function conversionCost(s: ProductionSettings, o: { qty: Decimal.Value; laborHours: Decimal.Value | null; laborCost: Decimal.Value | null;
  overheadCost: Decimal.Value | null }, materialCost: Decimal.Value, bom: { laborCost: string | null } | null) {
  let labor: Decimal;
  if (o.laborCost !== null && o.laborCost !== undefined) labor = new D(o.laborCost);
  else if (s.labor === "hour") labor = new D(o.laborHours ?? 0).times(s.laborRate);
  else if (s.labor === "piece") labor = new D(o.qty).times(bom?.laborCost ?? s.laborRate);
  else labor = new D(0);
  let overhead: Decimal;
  if (o.overheadCost !== null && o.overheadCost !== undefined) overhead = new D(o.overheadCost);
  else if (s.overhead === "percent") overhead = new D(materialCost).times(s.overheadValue).div(100);
  else if (s.overhead === "piece") overhead = new D(o.qty).times(s.overheadValue);
  else overhead = new D(0);
  return { labor: r4(labor), overhead: r4(overhead) };
}

export async function postWorkOrder(db: Db, id: number, actor: Actor & { userId: number }) {
  return db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const [w] = await tx.select().from(workOrders).where(eq(workOrders.id, id)).for("update");
    if (!w) throw new DomainError("not_found", "Работниот налог не постои.", 404);
    if (w.status !== "draft") throw new DomainError("not_draft", "Налогот е веќе прокнижен.", 409);
    const [client] = await tx.select().from(clients).where(eq(clients.id, w.clientId));
    const s = productionSettings(client!);
    const lines = (await tx.select().from(workOrderLines).where(eq(workOrderLines.workOrderId, w.id)).orderBy(asc(workOrderLines.lineNo)))
      .filter((l) => new D(l.qty).gt(0));
    if (!lines.length) throw new DomainError("validation", "Налогот нема потрошени делови.", 422);
    if (lines.some((l) => l.itemId === w.productItemId)) throw new DomainError("validation", "Производот не може да биде дел сам на себе.", 422);
    const [bom] = await tx.select().from(boms).where(eq(boms.productItemId, w.productItemId));
    const fromWh = w.warehouseId ?? (await defaultWarehouse(tx, w.clientId)).id;
    const toWh = w.outputWarehouseId ?? fromWh;

    const seqNo = await nextStockNo(tx, w.clientId, "work_order", w.year);
    const number = formatStockNumber(client!.invoicePrefix, "RN", w.year, seqNo);
    const cons = await postStockDoc(tx, { clientId: w.clientId, kind: "consumption", warehouseId: fromWh, docDate: w.docDate, workOrderId: w.id,
      note: `${number}: потрошено за производство`, createdBy: actor.userId,
      moves: lines.map((l) => ({ warehouseId: fromWh, itemId: l.itemId, qty: new D(l.qty).neg() })) });
    const consMoves = await tx.select({ value: stockMoves.value }).from(stockMoves).where(eq(stockMoves.docId, cons.doc.id));
    const material = r4(consMoves.reduce((a, m) => a.minus(m.value), new D(0)));
    const conv = conversionCost(s, w, material, bom ?? null);
    const total = r4(material.plus(conv.labor).plus(conv.overhead));
    const unit = r4(total.div(w.qty));
    const out = await postStockDoc(tx, { clientId: w.clientId, kind: "output", warehouseId: toWh, docDate: w.docDate, workOrderId: w.id,
      note: `${number}: готов производ`, createdBy: actor.userId,
      // vrednosta na vlezot = total (ne unit x qty), za da nema razlika od zaokruzuvanje
      moves: [{ warehouseId: toWh, itemId: w.productItemId, qty: w.qty, unitCost: total.div(w.qty), value: total, lotNo: `${number}` }] });

    const [posted] = await tx.update(workOrders).set({ status: "posted", seqNo, number, warehouseId: fromWh, outputWarehouseId: toWh,
      materialCost: material.toFixed(4), laborCost: conv.labor.toFixed(4), overheadCost: conv.overhead.toFixed(4), totalCost: total.toFixed(4), unitCost: unit.toFixed(4),
      postedBy: actor.userId, postedAt: new Date(), version: w.version + 1 }).where(eq(workOrders.id, w.id)).returning();
    await audit(tx, actor, { clientId: w.clientId, entity: "work_order", entityId: w.id, action: "post",
      changes: { number, material: material.toFixed(2), labor: conv.labor.toFixed(2), overhead: conv.overhead.toFixed(2), unit: unit.toFixed(4) } });
    return { ...posted!, consumptionNumber: cons.doc.number, outputNumber: out.doc.number, warnings: [...cons.warnings, ...out.warnings] };
  });
}

/** Storno: prvo se vrakja gotoviot proizvod (mora da go ima na zaliha), pa delovite - po istite ceni. */
export async function voidWorkOrder(db: Db, id: number, actor: Actor & { userId: number }, reason: string, date: string) {
  return db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const [w] = await tx.select().from(workOrders).where(eq(workOrders.id, id)).for("update");
    if (!w) throw new DomainError("not_found", "Работниот налог не постои.", 404);
    if (w.status !== "posted") throw new DomainError("validation", "Се сторнира само прокнижен налог.", 422);
    if (reason.trim().length < 3) throw new DomainError("validation", "Внесете причина за сторно.", 422);
    const docs = await tx.select().from(stockDocs).where(and(eq(stockDocs.workOrderId, w.id), isNull(stockDocs.reversesDocId)));
    const warnings: string[] = [];
    for (const d of [...docs.filter((d) => d.kind === "output"), ...docs.filter((d) => d.kind !== "output")]) {
      warnings.push(...(await reverseStockDoc(tx, d.id, { docDate: date, createdBy: actor.userId, note: `Сторно на ${w.number}: ${reason}` })).warnings);
    }
    const [v] = await tx.update(workOrders).set({ status: "voided", voidedAt: new Date(), voidReason: reason, version: w.version + 1 })
      .where(eq(workOrders.id, w.id)).returning();
    await audit(tx, actor, { clientId: w.clientId, entity: "work_order", entityId: w.id, action: "void", changes: { reason } });
    return { ...v!, warnings };
  });
}

export { bomLines };
