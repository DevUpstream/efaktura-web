/** Proizvodstvo: normativi i rabotni nalozi (docs/07). Modulot "production" se proveruva na sekoe baranje. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { bomLines, boms, clients, items, STOCK_ITEM_TYPES, stockBalances, stockDocs, users, warehouses, workOrderLines, workOrders } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import { audit } from "../domain/audit.js";
import { conversionCost, plannedLines, postWorkOrder, productionSettings, voidWorkOrder } from "../domain/production.js";
import { StockDecimal as D } from "../domain/stock.js";
import { assertModule, requireUser } from "../auth/context.js";
import { Id } from "./master.js";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Датум ГГГГ-ММ-ДД");
const num = (min: number, max: number) => z.coerce.number().min(min).max(max);
const optNum = z.union([z.coerce.number().min(0).max(1e12), z.literal("").transform(() => null), z.null()]).optional();
const optText = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

const BomIn = z.object({
  outputQty: num(0.0001, 1e9).default(1), laborHours: num(0, 1e6).default(0), laborCost: optNum, note: optText(1000),
  isActive: z.boolean().default(true),
  lines: z.array(z.object({ itemId: Id, qty: num(0.0001, 1e9), wastePct: num(0, 99.99).default(0) })).max(300),
});
const OrderIn = z.object({
  productItemId: Id, qty: num(0.0001, 1e9), docDate: Day, warehouseId: Id.optional().nullable(), outputWarehouseId: Id.optional().nullable(),
  laborHours: optNum, laborCost: optNum, overheadCost: optNum, note: optText(1000),
  lines: z.array(z.object({ itemId: Id, plannedQty: num(0, 1e9).optional(), qty: num(0, 1e9) })).max(300).optional(),
  replan: z.boolean().optional(), version: z.number().int().optional(),
});

export async function productionRoutes(app: FastifyInstance, { db }: { db: Db }) {
  const ctx = async (req: FastifyRequest) => {
    const u = requireUser(req);
    const p = z.object({ clientId: Id, id: Id.optional() }).parse(req.params);
    await assertModule(db, u, p.clientId, "production");
    return { u, ...p };
  };
  const clientRow = async (clientId: number) => (await db.select().from(clients).where(eq(clients.id, clientId)))[0]!;
  async function stockItems(clientId: number, ids: number[]) {
    if (!ids.length) return new Map<number, typeof items.$inferSelect>();
    const rows = await db.select().from(items).where(and(eq(items.clientId, clientId), inArray(items.id, ids)));
    const m = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const it = m.get(id);
      if (!it) throw new DomainError("validation", "Непознат артикл.", 422);
      if (!(STOCK_ITEM_TYPES as readonly string[]).includes(it.type)) throw new DomainError("validation", `„${it.name}“ е услуга и не може да биде дел или производ.`, 422);
    }
    return m;
  }
  async function ownWarehouse(clientId: number, id: number | null | undefined) {
    if (!id) return;
    const [w] = await db.select().from(warehouses).where(and(eq(warehouses.id, id), eq(warehouses.clientId, clientId), eq(warehouses.isActive, true)));
    if (!w) throw new DomainError("validation", "Непознат или неактивен магацин.", 422);
  }

  /* ----------------------------------------------------------- normativi */
  app.get("/api/clients/:clientId/boms", async (req) => {
    const { clientId } = await ctx(req);
    return db.select({ productItemId: items.id, code: items.code, name: items.name, unit: items.unit, type: items.type, isActiveItem: items.isActive,
      bomId: boms.id, outputQty: boms.outputQty, laborHours: boms.laborHours, isActive: boms.isActive,
      lines: sql<number>`(select count(*)::int from bom_lines l where l.bom_id = ${boms.id})` })
      .from(items).leftJoin(boms, eq(boms.productItemId, items.id))
      .where(and(eq(items.clientId, clientId), sql`(${items.type} = 'product' or ${boms.id} is not null)`)).orderBy(asc(items.name));
  });
  app.get("/api/clients/:clientId/boms/:id", async (req) => {
    const { clientId, id } = await ctx(req);
    const [product] = await db.select().from(items).where(and(eq(items.id, id!), eq(items.clientId, clientId)));
    if (!product) throw new DomainError("not_found", "Артиклот не постои.", 404);
    const [bom] = await db.select().from(boms).where(eq(boms.productItemId, product.id));
    const lines = bom ? await db.select({ id: bomLines.id, itemId: bomLines.itemId, qty: bomLines.qty, wastePct: bomLines.wastePct, code: items.code, name: items.name, unit: items.unit,
      avgCost: sql<string>`(select case when sum(b.qty) > 0 then sum(b.value) / sum(b.qty) else max(b.last_cost) end from stock_balances b where b.item_id = ${bomLines.itemId})` })
      .from(bomLines).innerJoin(items, eq(items.id, bomLines.itemId)).where(eq(bomLines.bomId, bom.id)).orderBy(asc(bomLines.lineNo)) : [];
    return { product, bom: bom ?? null, lines };
  });
  app.put("/api/clients/:clientId/boms/:id", async (req) => {
    const { u, clientId, id } = await ctx(req);
    const b = BomIn.parse(req.body);
    await stockItems(clientId, [id!]);
    if (b.lines.some((l) => l.itemId === id)) throw new DomainError("validation", "Производот не може да биде дел сам на себе.", 422);
    await stockItems(clientId, [...new Set(b.lines.map((l) => l.itemId))]);
    const bomId = await db.transaction(async (tx) => {
      const vals = { outputQty: String(b.outputQty), laborHours: String(b.laborHours), laborCost: b.laborCost === null || b.laborCost === undefined ? null : String(b.laborCost),
        note: b.note, isActive: b.isActive };
      const [ex] = await tx.select().from(boms).where(eq(boms.productItemId, id!));
      const bid = ex ? (await tx.update(boms).set(vals).where(eq(boms.id, ex.id)).returning())[0]!.id
        : (await tx.insert(boms).values({ ...vals, clientId, productItemId: id! }).returning())[0]!.id;
      await tx.delete(bomLines).where(eq(bomLines.bomId, bid));
      for (const [i, l] of b.lines.entries()) await tx.insert(bomLines).values({ bomId: bid, lineNo: i + 1, itemId: l.itemId, qty: String(l.qty), wastePct: String(l.wastePct) });
      return bid;
    });
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "bom", entityId: bomId, action: "save", changes: { productItemId: id, lines: b.lines.length } });
    return { id: bomId };
  });

  /* ------------------------------------------------------ rabotni nalozi */
  app.get("/api/clients/:clientId/work-orders", async (req) => {
    const { clientId } = await ctx(req);
    const q = z.object({ status: z.enum(["draft", "posted", "voided"]).optional() }).parse(req.query);
    const conds = [eq(workOrders.clientId, clientId)];
    if (q.status) conds.push(eq(workOrders.status, q.status));
    return db.select({ id: workOrders.id, number: workOrders.number, status: workOrders.status, docDate: workOrders.docDate, qty: workOrders.qty,
      productName: items.name, productCode: items.code, unit: items.unit, totalCost: workOrders.totalCost, unitCost: workOrders.unitCost })
      .from(workOrders).innerJoin(items, eq(items.id, workOrders.productItemId)).where(and(...conds))
      .orderBy(desc(workOrders.docDate), desc(workOrders.id)).limit(500);
  });

  async function loadOrder(clientId: number, id: number) {
    const [w] = await db.select().from(workOrders).where(and(eq(workOrders.id, id), eq(workOrders.clientId, clientId)));
    if (!w) throw new DomainError("not_found", "Работниот налог не постои.", 404);
    return w;
  }
  app.get("/api/clients/:clientId/work-orders/:id", async (req) => {
    const { clientId, id } = await ctx(req);
    const w = await loadOrder(clientId, id!);
    const c = await clientRow(clientId);
    const s = productionSettings(c);
    const [product] = await db.select().from(items).where(eq(items.id, w.productItemId));
    const [bom] = await db.select().from(boms).where(eq(boms.productItemId, w.productItemId));
    const fromWh = w.warehouseId ?? (await db.select().from(warehouses).where(and(eq(warehouses.clientId, clientId), eq(warehouses.isDefault, true))))[0]?.id;
    const lines = await db.select({ id: workOrderLines.id, itemId: workOrderLines.itemId, plannedQty: workOrderLines.plannedQty, qty: workOrderLines.qty,
      code: items.code, name: items.name, unit: items.unit,
      stockQty: sql<string>`coalesce((select b.qty from stock_balances b where b.item_id = ${workOrderLines.itemId} and b.warehouse_id = ${fromWh ?? 0}), 0)`,
      avgCost: sql<string>`coalesce((select case when b.qty > 0 then b.value / b.qty else b.last_cost end from stock_balances b where b.item_id = ${workOrderLines.itemId} and b.warehouse_id = ${fromWh ?? 0}), 0)` })
      .from(workOrderLines).innerJoin(items, eq(items.id, workOrderLines.itemId)).where(eq(workOrderLines.workOrderId, w.id)).orderBy(asc(workOrderLines.lineNo));
    const docs = await db.select({ id: stockDocs.id, number: stockDocs.number, kind: stockDocs.kind, reversesDocId: stockDocs.reversesDocId })
      .from(stockDocs).where(eq(stockDocs.workOrderId, w.id)).orderBy(asc(stockDocs.id));
    // procenka (za nacrt): materijali po tekovnata prosecna cena + trud + opsti
    let estimate = null;
    if (w.status === "draft") {
      const material = lines.reduce((a, l) => a.plus(new D(l.qty).times(l.avgCost)), new D(0)).toDecimalPlaces(4);
      const laborHours = w.laborHours ?? (bom ? new D(bom.laborHours).times(w.qty).div(bom.outputQty).toFixed(4) : "0");
      const conv = conversionCost(s, { ...w, laborHours }, material, bom ?? null);
      const total = material.plus(conv.labor).plus(conv.overhead);
      estimate = { material: material.toFixed(2), labor: conv.labor.toFixed(2), overhead: conv.overhead.toFixed(2), total: total.toFixed(2),
        unit: total.div(w.qty).toFixed(4), laborHours };
    }
    const [author] = w.createdBy ? await db.select({ n: users.displayName }).from(users).where(eq(users.id, w.createdBy)) : [];
    return { ...w, product, hasBom: !!bom, settings: s, lines, stockDocs: docs, estimate, author: author?.n ?? null };
  });

  async function planFromBom(clientId: number, productItemId: number, qty: number) {
    const c = await clientRow(clientId);
    const [bom] = await db.select().from(boms).where(eq(boms.productItemId, productItemId));
    if (!bom) return { lines: [] as { itemId: number; plannedQty: string }[], laborHours: null as string | null };
    const bl = await db.select().from(bomLines).where(eq(bomLines.bomId, bom.id)).orderBy(asc(bomLines.lineNo));
    return { lines: plannedLines(bom, bl, qty, productionSettings(c).useWaste),
      laborHours: new D(bom.laborHours).times(qty).div(bom.outputQty).toDecimalPlaces(4).toFixed(4) };
  }
  async function writeLines(tx: Db, woId: number, lines: { itemId: number; plannedQty?: number | string; qty: number | string }[]) {
    await tx.delete(workOrderLines).where(eq(workOrderLines.workOrderId, woId));
    for (const [i, l] of lines.entries()) await tx.insert(workOrderLines).values({ workOrderId: woId, lineNo: i + 1, itemId: l.itemId,
      plannedQty: String(l.plannedQty ?? l.qty), qty: String(l.qty) });
  }
  const optStr = (v: number | null | undefined) => (v === null || v === undefined ? null : String(v));

  app.post("/api/clients/:clientId/work-orders", async (req, reply) => {
    const { u, clientId } = await ctx(req);
    const b = OrderIn.parse(req.body);
    const its = await stockItems(clientId, [b.productItemId, ...(b.lines ?? []).map((l) => l.itemId)]);
    if (its.get(b.productItemId)!.type === "goods") throw new DomainError("validation", "Производ мора да е од вид „Готов производ“ или „Материјал / дел“.", 422);
    await ownWarehouse(clientId, b.warehouseId); await ownWarehouse(clientId, b.outputWarehouseId);
    const plan = await planFromBom(clientId, b.productItemId, b.qty);
    const id = await db.transaction(async (tx) => {
      const [w] = await tx.insert(workOrders).values({ clientId, productItemId: b.productItemId, qty: String(b.qty), docDate: b.docDate, year: Number(b.docDate.slice(0, 4)),
        warehouseId: b.warehouseId ?? null, outputWarehouseId: b.outputWarehouseId ?? null, note: b.note, createdBy: u.id,
        laborHours: optStr(b.laborHours) ?? plan.laborHours, laborCost: optStr(b.laborCost), overheadCost: optStr(b.overheadCost) }).returning();
      await writeLines(tx as unknown as Db, w!.id, b.lines ?? plan.lines.map((l) => ({ ...l, qty: l.plannedQty })));
      return w!.id;
    });
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "work_order", entityId: id, action: "create" });
    return reply.status(201).send({ id });
  });
  app.put("/api/clients/:clientId/work-orders/:id", async (req) => {
    const { u, clientId, id } = await ctx(req);
    const b = OrderIn.parse(req.body);
    await stockItems(clientId, [b.productItemId, ...(b.lines ?? []).map((l) => l.itemId)]);
    await ownWarehouse(clientId, b.warehouseId); await ownWarehouse(clientId, b.outputWarehouseId);
    const plan = b.replan ? await planFromBom(clientId, b.productItemId, b.qty) : null;
    await db.transaction(async (tx) => {
      const [w] = await tx.select().from(workOrders).where(and(eq(workOrders.id, id!), eq(workOrders.clientId, clientId))).for("update");
      if (!w) throw new DomainError("not_found", "Работниот налог не постои.", 404);
      if (w.status !== "draft") throw new DomainError("not_draft", "Само нацрт може да се менува.", 409);
      if (b.version !== undefined && b.version !== w.version) throw new DomainError("conflict", "Налогот е изменет од друг корисник. Освежете ја страницата.", 409);
      await tx.update(workOrders).set({ productItemId: b.productItemId, qty: String(b.qty), docDate: b.docDate, year: Number(b.docDate.slice(0, 4)),
        warehouseId: b.warehouseId ?? null, outputWarehouseId: b.outputWarehouseId ?? null, note: b.note,
        laborHours: plan ? plan.laborHours : optStr(b.laborHours), laborCost: optStr(b.laborCost), overheadCost: optStr(b.overheadCost),
        version: sql`${workOrders.version} + 1` }).where(eq(workOrders.id, w.id));
      if (plan) await writeLines(tx as unknown as Db, w.id, plan.lines.map((l) => ({ ...l, qty: l.plannedQty })));
      else if (b.lines) await writeLines(tx as unknown as Db, w.id, b.lines);
    });
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "work_order", entityId: id!, action: "save_draft" });
    return { id };
  });
  app.delete("/api/clients/:clientId/work-orders/:id", async (req) => {
    const { u, clientId, id } = await ctx(req);
    const w = await loadOrder(clientId, id!);
    if (w.status !== "draft") throw new DomainError("not_draft", "Се брише само нацрт.", 409);
    await db.delete(workOrders).where(eq(workOrders.id, w.id));
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "work_order", entityId: w.id, action: "delete_draft" });
    return { ok: true };
  });
  app.post("/api/clients/:clientId/work-orders/:id/post", async (req) => {
    const { u, clientId, id } = await ctx(req);
    await loadOrder(clientId, id!);
    const r = await postWorkOrder(db, id!, { userId: u.id, ip: req.ip });
    return { id: r.id, number: r.number, unitCost: r.unitCost, totalCost: r.totalCost, consumptionNumber: r.consumptionNumber, outputNumber: r.outputNumber, warnings: r.warnings };
  });
  app.post("/api/clients/:clientId/work-orders/:id/void", async (req) => {
    const { u, clientId, id } = await ctx(req);
    await loadOrder(clientId, id!);
    const b = z.object({ reason: z.string().trim().min(3).max(500), date: Day }).parse(req.body);
    const r = await voidWorkOrder(db, id!, { userId: u.id, ip: req.ip }, b.reason, b.date);
    return { id: r.id, status: r.status, warnings: r.warnings };
  });
}
void stockBalances;
