/**
 * Vlezni fakturi (docs/07). Knizenje: broj vo knigata na vlezni fakturi + (ako e vkluchen Magacin) priemnica.
 * Nabavna cena po edinica = (osnovica na stavkata + del od zavisnite troshoci) / kolicina.
 *  - zavisni troshoci = stavki "allocate" (prevoz, carina...), se rasporeduvaat spored osnovicata na stavkite so zaliha;
 *  - ako klientot NE e DDV obvrznik, DDV-to ne se odbiva, pa vleguva vo nabavnata cena.
 */
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { clients, items, partners, purchaseInvoices, purchaseLines, STOCK_ITEM_TYPES, stockDocs } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { calcTotals } from "./calc.js";
import { DomainError } from "./errors.js";
import { missingCostCenter } from "./costcenters.js";
import { audit, type Actor } from "./audit.js";
import { defaultWarehouse, formatStockNumber, nextStockNo, postStockDoc, reverseStockDoc } from "./stock.js";
import { learnItems } from "./ujp-import.js";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export async function postPurchase(db: Db, id: number, actor: Actor & { userId: number }, withStock: boolean) {
  return db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const [p] = await tx.select().from(purchaseInvoices).where(eq(purchaseInvoices.id, id)).for("update");
    if (!p) throw new DomainError("not_found", "Влезната фактура не постои.", 404);
    if (p.status !== "draft") throw new DomainError("not_draft", "Влезната фактура е веќе прокнижена.", 409);
    const [client] = await tx.select().from(clients).where(eq(clients.id, p.clientId));
    const [supplier] = await tx.select().from(partners).where(eq(partners.id, p.partnerId));
    const lines = await tx.select().from(purchaseLines).where(eq(purchaseLines.purchaseInvoiceId, p.id)).orderBy(asc(purchaseLines.lineNo));
    const itemRows = await tx.select().from(items).where(eq(items.clientId, p.clientId));
    const itemById = new Map(itemRows.map((i) => [i.id, i]));
    const isStock = (l: (typeof lines)[number]) => !!l.itemId && (STOCK_ITEM_TYPES as readonly string[]).includes(itemById.get(l.itemId)?.type ?? "");

    const errors: string[] = [];
    if (!lines.length) errors.push("Фактурата нема ставки.");
    if (!supplier?.isActive) errors.push("Добавувачот не е активен.");
    if (p.receivedDate < p.issueDate) errors.push("Датумот на прием е пред датумот на фактурата.");
    const ccMsg = missingCostCenter(client!.costCenterMode, p.costCenterId, lines);
    if (ccMsg) errors.push(ccMsg);
    const [dup] = await tx.select({ n: purchaseInvoices.number }).from(purchaseInvoices).where(and(
      eq(purchaseInvoices.clientId, p.clientId), eq(purchaseInvoices.partnerId, p.partnerId),
      eq(purchaseInvoices.supplierNumber, p.supplierNumber), ne(purchaseInvoices.id, p.id), ne(purchaseInvoices.status, "voided")));
    if (dup) errors.push(`Фактура ${p.supplierNumber} од овој добавувач е веќе внесена (${dup.n ?? "нацрт"}).`);
    const stockLines = withStock ? lines.filter(isStock) : [];
    const allocLines = lines.filter((l) => l.allocate && !isStock(l));
    if (allocLines.length && withStock && !stockLines.length) errors.push("Зависните трошоци немаат на што да се распоредат (нема ставки со залиха).");
    if (errors.length) throw new DomainError("validation", errors.join(" "), 422);

    // nabavna cena
    const vatInCost = !client!.vatPayer;
    const lineCost = (l: (typeof lines)[number]) => new D(l.netAmount).plus(vatInCost ? l.vatAmount : 0);
    const allocTotal = allocLines.reduce((a, l) => a.plus(lineCost(l)), new D(0));
    const base = stockLines.reduce((a, l) => a.plus(l.netAmount), new D(0));
    let remaining = allocTotal;
    const costs = new Map<number, string>();
    stockLines.forEach((l, i) => {
      const share = i === stockLines.length - 1 ? remaining : base.isZero() ? new D(0) : allocTotal.times(l.netAmount).div(base).toDecimalPlaces(4);
      remaining = remaining.minus(share);
      costs.set(l.id, lineCost(l).plus(share).div(l.qty).toDecimalPlaces(4).toFixed(4));
    });
    for (const l of stockLines) await tx.update(purchaseLines).set({ unitCost: costs.get(l.id)! }).where(eq(purchaseLines.id, l.id));

    // uvezena e-faktura: zbirovite se od dokumentot (dobavuvacot moze da zaokruzuva poinaku)
    const totals = p.fixedAmounts ? { netTotal: p.netTotal, vatTotal: p.vatTotal, grossTotal: p.grossTotal } : calcTotals(lines.map((l) => ({ ...l, unitNet: "0" })));
    await learnItems(tx, p.clientId, p.partnerId, lines);
    const seqNo = await nextStockNo(tx, p.clientId, "purchase", p.year);
    const number = formatStockNumber(client!.invoicePrefix, "VF", p.year, seqNo);
    let warehouseId = p.warehouseId;
    if (stockLines.length && !warehouseId) warehouseId = (await defaultWarehouse(tx, p.clientId)).id;
    const [posted] = await tx.update(purchaseInvoices).set({
      status: "posted", seqNo, number, netTotal: totals.netTotal, vatTotal: totals.vatTotal, grossTotal: totals.grossTotal,
      warehouseId, postedBy: actor.userId, postedAt: new Date(), version: p.version + 1,
    }).where(eq(purchaseInvoices.id, p.id)).returning();

    let receipt: string | null = null;
    if (stockLines.length) {
      const r = await postStockDoc(tx, {
        clientId: p.clientId, kind: "receipt", warehouseId: warehouseId!, docDate: p.receivedDate, purchaseInvoiceId: p.id,
        note: `${supplier!.name}, ф-ра ${p.supplierNumber}`, createdBy: actor.userId,
        moves: stockLines.map((l) => ({ warehouseId: warehouseId!, itemId: l.itemId!, qty: l.qty, unitCost: costs.get(l.id)!,
          lotNo: l.lotNo, expiryDate: l.expiryDate })),
      });
      receipt = r.doc.number;
    }
    await audit(tx, actor, { clientId: p.clientId, entity: "purchase_invoice", entityId: p.id, action: "post",
      changes: { number, receipt, gross: totals.grossTotal } });
    return { ...posted!, receiptNumber: receipt };
  });
}

/** Storno na vlezna faktura: obratna priemnica (po istite ceni). Ako stokata e vekje izdadena, vazi pravilото za minus. */
export async function voidPurchase(db: Db, id: number, actor: Actor & { userId: number }, reason: string, date: string) {
  return db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const [p] = await tx.select().from(purchaseInvoices).where(eq(purchaseInvoices.id, id)).for("update");
    if (!p) throw new DomainError("not_found", "Влезната фактура не постои.", 404);
    if (p.status !== "posted") throw new DomainError("validation", "Се сторнира само прокнижена влезна фактура.", 422);
    if (!reason.trim()) throw new DomainError("validation", "Внесете причина за сторно.", 422);
    const docs = await tx.select().from(stockDocs).where(and(eq(stockDocs.purchaseInvoiceId, p.id), isNull(stockDocs.reversesDocId)));
    const warnings: string[] = [];
    for (const d of docs) warnings.push(...(await reverseStockDoc(tx, d.id, { docDate: date, createdBy: actor.userId,
      note: `Сторно на влезна фактура ${p.number}: ${reason}` })).warnings);
    const [v] = await tx.update(purchaseInvoices).set({ status: "voided", voidedAt: new Date(), voidReason: reason, version: p.version + 1 })
      .where(eq(purchaseInvoices.id, p.id)).returning();
    await audit(tx, actor, { clientId: p.clientId, entity: "purchase_invoice", entityId: p.id, action: "void", changes: { reason } });
    return { ...v!, warnings };
  });
}
