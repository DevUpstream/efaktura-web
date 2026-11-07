/** Vlezni fakturi i Magacin (docs/07). Modulite "incoming" i "warehouse" se proveruvaat na sekoe baranje. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { clients, items, lotBalances, lots, partners, purchaseFiles, purchaseInvoices, purchaseLines, stockBalances, stockDocs, stockMoves, users, vatRates,
  warehouses } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import { audit } from "../domain/audit.js";
import { calcLine, calcTotals } from "../domain/calc.js";
import { postPurchase, voidPurchase } from "../domain/purchase.js";
import { addFile, importUjpPurchase, MAX_FILE } from "../domain/ujp-import.js";
import { balanceOf, postStockDoc, reverseStockDoc, StockDecimal as D, type MoveIn } from "../domain/stock.js";
import { assertClientAccess, assertModule, requireAdmin, requireUser } from "../auth/context.js";
import { Id } from "./master.js";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Датум ГГГГ-ММ-ДД");
const optText = (max: number) => z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));
const Qty = z.coerce.number().positive().max(1e9);

const PurchaseLineIn = z.object({
  itemId: Id.optional().nullable(), description: z.string().trim().min(1).max(500), unit: z.string().trim().min(1).max(10),
  qty: Qty, unitPrice: z.coerce.number().min(0).max(1e12), discountPct: z.coerce.number().min(0).max(100).default(0),
  vatRateId: Id, allocate: z.boolean().default(false), lotNo: optText(50), expiryDate: Day.optional().nullable().or(z.literal("").transform(() => null)),
});
const PurchaseIn = z.object({
  partnerId: Id, supplierNumber: z.string().trim().min(1).max(60), issueDate: Day, receivedDate: Day,
  dueDate: Day.optional().nullable().or(z.literal("").transform(() => null)), warehouseId: Id.optional().nullable(),
  note: optText(2000), lines: z.array(PurchaseLineIn).max(500), version: z.number().int().optional(),
});
const StockLineIn = z.object({
  itemId: Id, qty: z.coerce.number().min(0).max(1e9), unitCost: z.coerce.number().min(0).max(1e12).optional(),
  lotId: Id.optional().nullable(), lotNo: optText(50), expiryDate: Day.optional().nullable().or(z.literal("").transform(() => null)),
});
const StockDocIn = z.object({
  kind: z.enum(["receipt", "writeoff", "inventory", "transfer"]), warehouseId: Id, toWarehouseId: Id.optional().nullable(),
  docDate: Day, note: optText(1000), lines: z.array(StockLineIn).min(1).max(500),
});

const pgUnique = (e: unknown) => ((e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code) === "23505";

export async function stockRoutes(app: FastifyInstance, { db }: { db: Db }) {
  const params = (req: FastifyRequest) => z.object({ clientId: Id, id: Id.optional() }).parse(req.params);
  const withModule = async (req: FastifyRequest, mod: "incoming" | "warehouse") => {
    const u = requireUser(req);
    const p = params(req);
    await assertModule(db, u, p.clientId, mod);
    return { u, ...p };
  };
  const clientMods = async (clientId: number) => (await db.select({ m: clients.modules }).from(clients).where(eq(clients.id, clientId)))[0]!.m;
  async function ownWarehouse(clientId: number, id: number) {
    const [w] = await db.select().from(warehouses).where(and(eq(warehouses.id, id), eq(warehouses.clientId, clientId)));
    if (!w || !w.isActive) throw new DomainError("validation", "Непознат или неактивен магацин.", 422);
    return w;
  }

  /* ------------------------------------------------------------ magacini */
  app.get("/api/clients/:clientId/warehouses", async (req) => {
    const u = requireUser(req);
    const { clientId } = params(req);
    await assertClientAccess(db, u, clientId);
    return db.select().from(warehouses).where(eq(warehouses.clientId, clientId)).orderBy(desc(warehouses.isDefault), asc(warehouses.name));
  });
  const WarehouseIn = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,10}$/, "Шифра: до 10 латинични букви/цифри"),
    name: z.string().trim().min(2).max(120), isActive: z.boolean().default(true), isDefault: z.boolean().default(false) });
  app.post("/api/clients/:clientId/warehouses", async (req, reply) => {
    const u = requireAdmin(req);
    const { clientId } = params(req);
    const b = WarehouseIn.parse(req.body);
    try {
      const w = await db.transaction(async (tx) => {
        if (b.isDefault) await tx.update(warehouses).set({ isDefault: false }).where(eq(warehouses.clientId, clientId));
        return (await tx.insert(warehouses).values({ ...b, clientId }).returning())[0]!;
      });
      await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "warehouse", entityId: w.id, action: "create", changes: b });
      return reply.status(201).send(w);
    } catch (e) { if (pgUnique(e)) throw new DomainError("duplicate", "Магацин со таа шифра веќе постои.", 409); throw e; }
  });
  app.patch("/api/clients/:clientId/warehouses/:id", async (req) => {
    const u = requireAdmin(req);
    const { clientId, id } = params(req);
    const b = WarehouseIn.omit({ code: true }).partial().parse(req.body);
    const w = await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(warehouses).where(and(eq(warehouses.id, id!), eq(warehouses.clientId, clientId)));
      if (!cur) throw new DomainError("not_found", "Магацинот не постои.", 404);
      if ((b.isActive === false || b.isDefault === false) && cur.isDefault) throw new DomainError("validation", "Главниот магацин не може да се исклучи: прво одредете друг главен.", 422);
      if (b.isDefault) await tx.update(warehouses).set({ isDefault: false }).where(eq(warehouses.clientId, clientId));
      return (await tx.update(warehouses).set(b).where(eq(warehouses.id, id!)).returning())[0]!;
    });
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "warehouse", entityId: id!, action: "update", changes: b });
    return w;
  });

  /* ------------------------------------------------------- vlezni fakturi */
  app.get("/api/clients/:clientId/purchases", async (req) => {
    const { clientId } = await withModule(req, "incoming");
    const q = z.object({ status: z.enum(["draft", "posted", "voided"]).optional(), q: z.string().trim().max(100).optional(),
      year: z.coerce.number().int().optional() }).parse(req.query);
    const conds = [eq(purchaseInvoices.clientId, clientId)];
    if (q.status) conds.push(eq(purchaseInvoices.status, q.status));
    if (q.year) conds.push(eq(purchaseInvoices.year, q.year));
    if (q.q) conds.push(or(ilike(partners.name, `%${q.q}%`), ilike(purchaseInvoices.supplierNumber, `%${q.q}%`), ilike(purchaseInvoices.number, `%${q.q}%`))!);
    return db.select({ id: purchaseInvoices.id, number: purchaseInvoices.number, status: purchaseInvoices.status, supplierNumber: purchaseInvoices.supplierNumber,
      issueDate: purchaseInvoices.issueDate, receivedDate: purchaseInvoices.receivedDate, dueDate: purchaseInvoices.dueDate, supplierName: partners.name,
      netTotal: purchaseInvoices.netTotal, vatTotal: purchaseInvoices.vatTotal, grossTotal: purchaseInvoices.grossTotal, source: purchaseInvoices.source,
      fileCount: sql<number>`(select count(*)::int from purchase_files f where f.purchase_invoice_id = ${purchaseInvoices.id})` })
      .from(purchaseInvoices).innerJoin(partners, eq(partners.id, purchaseInvoices.partnerId)).where(and(...conds))
      .orderBy(desc(purchaseInvoices.receivedDate), desc(purchaseInvoices.id)).limit(500);
  });

  async function loadPurchase(clientId: number, id: number) {
    const [p] = await db.select().from(purchaseInvoices).where(and(eq(purchaseInvoices.id, id), eq(purchaseInvoices.clientId, clientId)));
    if (!p) throw new DomainError("not_found", "Влезната фактура не постои.", 404);
    return p;
  }
  app.get("/api/clients/:clientId/purchases/:id", async (req) => {
    const { clientId, id } = await withModule(req, "incoming");
    const p = await loadPurchase(clientId, id!);
    const lines = await db.select().from(purchaseLines).where(eq(purchaseLines.purchaseInvoiceId, p.id)).orderBy(asc(purchaseLines.lineNo));
    const docs = await db.select({ id: stockDocs.id, number: stockDocs.number, kind: stockDocs.kind, docDate: stockDocs.docDate, reversesDocId: stockDocs.reversesDocId })
      .from(stockDocs).where(eq(stockDocs.purchaseInvoiceId, p.id)).orderBy(asc(stockDocs.id));
    const totals = calcTotals(lines.map((l) => ({ ...l, unitNet: "0" })));
    const files = await db.select({ id: purchaseFiles.id, fileName: purchaseFiles.fileName, contentType: purchaseFiles.contentType, size: purchaseFiles.size,
      createdAt: purchaseFiles.createdAt }).from(purchaseFiles).where(eq(purchaseFiles.purchaseInvoiceId, p.id)).orderBy(asc(purchaseFiles.id));
    const { sourceJson: _src, ...head } = p;
    return { ...head, hasSource: !!_src, lines, byRate: totals.byRate, stockDocs: docs, files };
  });

  /* uvoz na e-faktura (JSON vo formatot na UJP) + PDF, docs/09 */
  const B64 = z.string().max(Math.ceil(MAX_FILE * 4 / 3) + 16).regex(/^[A-Za-z0-9+/=\s]*$/, "Неисправна датотека");
  app.post("/api/clients/:clientId/purchases/import-ujp", { bodyLimit: 16 * 1024 * 1024 }, async (req, reply) => {
    const { u, clientId } = await withModule(req, "incoming");
    const b = z.object({ text: z.string().min(2).max(2_000_000), fileName: z.string().max(200).optional().nullable(),
      pdf: z.object({ name: z.string().min(1).max(200), base64: B64 }).optional().nullable() }).parse(req.body);
    try {
      const r = await importUjpPurchase(db, clientId, { text: b.text, fileName: b.fileName ?? null,
        pdf: b.pdf ? { name: b.pdf.name, data: Buffer.from(b.pdf.base64, "base64") } : null }, { userId: u.id, ip: req.ip });
      return reply.status(201).send(r);
    } catch (e) { if (pgUnique(e)) throw new DomainError("duplicate", "Оваа фактура е веќе внесена.", 409); throw e; }
  });
  app.post("/api/clients/:clientId/purchases/:id/files", { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const { u, clientId, id } = await withModule(req, "incoming");
    const p = await loadPurchase(clientId, id!);
    const b = z.object({ name: z.string().min(1).max(200), base64: B64 }).parse(req.body);
    const f = await addFile(db, p.id, b.name, Buffer.from(b.base64, "base64"), u.id);
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "purchase_invoice", entityId: p.id, action: "add_file", changes: { file: f.fileName } });
    return reply.status(201).send(f);
  });
  const fileParams = (req: FastifyRequest) => z.object({ fileId: Id }).parse(req.params);
  async function loadFile(purchaseId: number, fileId: number) {
    const [f] = await db.select().from(purchaseFiles).where(and(eq(purchaseFiles.id, fileId), eq(purchaseFiles.purchaseInvoiceId, purchaseId)));
    if (!f) throw new DomainError("not_found", "Прилогот не постои.", 404);
    return f;
  }
  app.get("/api/clients/:clientId/purchases/:id/files/:fileId", async (req, reply) => {
    const { clientId, id } = await withModule(req, "incoming");
    const p = await loadPurchase(clientId, id!);
    const f = await loadFile(p.id, fileParams(req).fileId);
    return reply.header("content-type", f.contentType).header("x-content-type-options", "nosniff")
      .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.fileName)}`).send(Buffer.from(f.data));
  });
  app.delete("/api/clients/:clientId/purchases/:id/files/:fileId", async (req) => {
    const { u, clientId, id } = await withModule(req, "incoming");
    const p = await loadPurchase(clientId, id!);
    if (p.status !== "draft") throw new DomainError("not_draft", "Прилогот на прокнижена фактура не се брише.", 409);
    const f = await loadFile(p.id, fileParams(req).fileId);
    await db.delete(purchaseFiles).where(eq(purchaseFiles.id, f.id));
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "purchase_invoice", entityId: p.id, action: "delete_file", changes: { file: f.fileName } });
    return { ok: true };
  });

  async function writePurchase(tx: Db, clientId: number, id: number, b: z.infer<typeof PurchaseIn>) {
    const [sup] = await tx.select({ id: partners.id }).from(partners).where(and(eq(partners.id, b.partnerId), eq(partners.clientId, clientId)));
    if (!sup) throw new DomainError("validation", "Добавувачот не постои.", 422);
    await tx.update(partners).set({ isSupplier: true }).where(and(eq(partners.id, sup.id), eq(partners.isSupplier, false)));
    if (b.warehouseId) await ownWarehouse(clientId, b.warehouseId);
    const rates = new Map((await tx.select().from(vatRates)).map((r) => [r.id, r]));
    const ids = b.lines.map((l) => l.itemId).filter((x): x is number => !!x);
    if (ids.length) {
      const own = await tx.select({ id: items.id }).from(items).where(and(eq(items.clientId, clientId), inArray(items.id, ids)));
      if (own.length !== new Set(ids).size) throw new DomainError("validation", "Непознат артикл.", 422);
    }
    await tx.delete(purchaseLines).where(eq(purchaseLines.purchaseInvoiceId, id));
    const calc = [];
    for (const [i, l] of b.lines.entries()) {
      const rate = rates.get(l.vatRateId);
      if (!rate) throw new DomainError("validation", `Ставка ${i + 1}: непозната ДДВ стапка.`, 422);
      const r = calcLine({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, vatRatePct: rate.ratePct });
      await tx.insert(purchaseLines).values({ purchaseInvoiceId: id, lineNo: i + 1, itemId: l.itemId ?? null, description: l.description, unit: l.unit,
        qty: String(l.qty), unitPrice: String(l.unitPrice), discountPct: String(l.discountPct), vatRateId: rate.id, vatRatePct: rate.ratePct,
        netAmount: r.netAmount, vatAmount: r.vatAmount, allocate: l.allocate, lotNo: l.lotNo, expiryDate: l.expiryDate ?? null });
      calc.push({ ...r, vatRatePct: rate.ratePct });
    }
    const t = calcTotals(calc);
    await tx.update(purchaseInvoices).set({ partnerId: b.partnerId, supplierNumber: b.supplierNumber, issueDate: b.issueDate, receivedDate: b.receivedDate,
      dueDate: b.dueDate ?? null, warehouseId: b.warehouseId ?? null, note: b.note, year: Number(b.receivedDate.slice(0, 4)),
      netTotal: t.netTotal, vatTotal: t.vatTotal, grossTotal: t.grossTotal, version: sql`${purchaseInvoices.version} + 1` })
      .where(eq(purchaseInvoices.id, id));
  }

  /** Uvezena e-faktura: se menuvaat samo artikl, zavisen trosok, lot, rok, datum na priem, rok za plakjanje, magacin, zabeleska. */
  async function writeImported(tx: Db, clientId: number, p: typeof purchaseInvoices.$inferSelect, b: z.infer<typeof PurchaseIn>) {
    const cur = await tx.select().from(purchaseLines).where(eq(purchaseLines.purchaseInvoiceId, p.id)).orderBy(asc(purchaseLines.lineNo));
    const same = (a: unknown, c: unknown) => Math.abs(Number(a) - Number(c)) < 0.00005;
    const changed = b.partnerId !== p.partnerId || b.supplierNumber !== p.supplierNumber || b.issueDate !== p.issueDate || b.lines.length !== cur.length
      || b.lines.some((l, i) => !same(l.qty, cur[i]!.qty) || !same(l.unitPrice, cur[i]!.unitPrice) || !same(l.discountPct, cur[i]!.discountPct)
        || l.vatRateId !== cur[i]!.vatRateId || l.description !== cur[i]!.description);
    if (changed) throw new DomainError("validation", "Увезена е-фактура: добавувачот, бројот, датумот и износите се од документот и не се менуваат. Ако фактурата е погрешна, побарајте корекција од добавувачот.", 422);
    if (b.receivedDate < p.issueDate) throw new DomainError("validation", "Датумот на прием е пред датумот на фактурата.", 422);
    if (b.warehouseId) await ownWarehouse(clientId, b.warehouseId);
    const ids = b.lines.map((l) => l.itemId).filter((x): x is number => !!x);
    if (ids.length) {
      const own = await tx.select({ id: items.id }).from(items).where(and(eq(items.clientId, clientId), inArray(items.id, ids)));
      if (own.length !== new Set(ids).size) throw new DomainError("validation", "Непознат артикл.", 422);
    }
    for (const [i, l] of b.lines.entries())
      await tx.update(purchaseLines).set({ itemId: l.itemId ?? null, allocate: l.allocate, lotNo: l.lotNo, expiryDate: l.expiryDate ?? null }).where(eq(purchaseLines.id, cur[i]!.id));
    await tx.update(purchaseInvoices).set({ receivedDate: b.receivedDate, dueDate: b.dueDate ?? null, warehouseId: b.warehouseId ?? null, note: b.note,
      year: Number(b.receivedDate.slice(0, 4)), version: sql`${purchaseInvoices.version} + 1` }).where(eq(purchaseInvoices.id, p.id));
  }

  app.post("/api/clients/:clientId/purchases", async (req, reply) => {
    const { u, clientId } = await withModule(req, "incoming");
    const b = PurchaseIn.parse(req.body);
    try {
      const id = await db.transaction(async (tx) => {
        const [p] = await tx.insert(purchaseInvoices).values({ clientId, partnerId: b.partnerId, year: Number(b.receivedDate.slice(0, 4)),
          supplierNumber: b.supplierNumber, issueDate: b.issueDate, receivedDate: b.receivedDate, createdBy: u.id }).returning();
        await writePurchase(tx as unknown as Db, clientId, p!.id, b);
        return p!.id;
      });
      await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "purchase_invoice", entityId: id, action: "create" });
      return reply.status(201).send({ id });
    } catch (e) { if (pgUnique(e)) throw new DomainError("duplicate", `Фактура ${b.supplierNumber} од овој добавувач е веќе внесена.`, 409); throw e; }
  });
  app.put("/api/clients/:clientId/purchases/:id", async (req) => {
    const { u, clientId, id } = await withModule(req, "incoming");
    const b = PurchaseIn.parse(req.body);
    try {
      await db.transaction(async (tx) => {
        const [p] = await tx.select().from(purchaseInvoices).where(and(eq(purchaseInvoices.id, id!), eq(purchaseInvoices.clientId, clientId))).for("update");
        if (!p) throw new DomainError("not_found", "Влезната фактура не постои.", 404);
        if (p.status !== "draft") throw new DomainError("not_draft", "Само нацрт може да се менува.", 409);
        if (b.version !== undefined && b.version !== p.version) throw new DomainError("conflict", "Фактурата е изменета од друг корисник. Освежете ја страницата.", 409);
        if (p.fixedAmounts) await writeImported(tx as unknown as Db, clientId, p, b);
        else await writePurchase(tx as unknown as Db, clientId, p.id, b);
      });
    } catch (e) { if (pgUnique(e)) throw new DomainError("duplicate", `Фактура ${b.supplierNumber} од овој добавувач е веќе внесена.`, 409); throw e; }
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "purchase_invoice", entityId: id!, action: "save_draft" });
    return { id };
  });
  app.delete("/api/clients/:clientId/purchases/:id", async (req) => {
    const { u, clientId, id } = await withModule(req, "incoming");
    const p = await loadPurchase(clientId, id!);
    if (p.status !== "draft") throw new DomainError("not_draft", "Се брише само нацрт.", 409);
    await db.delete(purchaseInvoices).where(eq(purchaseInvoices.id, p.id));
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "purchase_invoice", entityId: p.id, action: "delete_draft" });
    return { ok: true };
  });
  app.post("/api/clients/:clientId/purchases/:id/post", async (req) => {
    const { u, clientId, id } = await withModule(req, "incoming");
    await loadPurchase(clientId, id!);
    const r = await postPurchase(db, id!, { userId: u.id, ip: req.ip }, (await clientMods(clientId)).includes("warehouse"));
    return { id: r.id, number: r.number, receiptNumber: r.receiptNumber };
  });
  app.post("/api/clients/:clientId/purchases/:id/void", async (req) => {
    const { u, clientId, id } = await withModule(req, "incoming");
    await loadPurchase(clientId, id!);
    const b = z.object({ reason: z.string().trim().min(3).max(500), date: Day }).parse(req.body);
    const r = await voidPurchase(db, id!, { userId: u.id, ip: req.ip }, b.reason, b.date);
    return { id: r.id, status: r.status, warnings: r.warnings };
  });

  /* ------------------------------------------------------------- zaliha */
  app.get("/api/clients/:clientId/stock", async (req) => {
    const { clientId } = await withModule(req, "warehouse");
    const q = z.object({ warehouseId: Id.optional(), all: z.coerce.boolean().default(false) }).parse(req.query);
    const conds = [eq(stockBalances.clientId, clientId)];
    if (q.warehouseId) conds.push(eq(stockBalances.warehouseId, q.warehouseId));
    if (!q.all) conds.push(sql`(${stockBalances.qty} <> 0 or ${stockBalances.value} <> 0)`);
    const rows = await db.select({ warehouseId: stockBalances.warehouseId, warehouseName: warehouses.name, itemId: items.id, code: items.code, name: items.name,
      type: items.type, unit: items.unit, trackLots: items.trackLots, qty: stockBalances.qty, value: stockBalances.value, lastCost: stockBalances.lastCost, salePrice: items.unitPrice })
      .from(stockBalances).innerJoin(items, eq(items.id, stockBalances.itemId)).innerJoin(warehouses, eq(warehouses.id, stockBalances.warehouseId))
      .where(and(...conds)).orderBy(asc(items.name), asc(warehouses.name));
    const lotRows = await db.select({ warehouseId: lotBalances.warehouseId, itemId: lots.itemId, lotId: lots.id, lotNo: lots.lotNo, expiryDate: lots.expiryDate, qty: lotBalances.qty })
      .from(lotBalances).innerJoin(lots, eq(lots.id, lotBalances.lotId)).where(and(eq(lots.clientId, clientId), sql`${lotBalances.qty} <> 0`))
      .orderBy(sql`${lots.expiryDate} asc nulls last`);
    return rows.map((r) => ({ ...r, avgCost: new D(r.qty).gt(0) ? new D(r.value).div(r.qty).toFixed(4) : r.lastCost,
      lots: lotRows.filter((l) => l.itemId === r.itemId && l.warehouseId === r.warehouseId) }));
  });

  app.get("/api/clients/:clientId/stock/card", async (req) => {
    const { clientId } = await withModule(req, "warehouse");
    const q = z.object({ itemId: Id, warehouseId: Id.optional(), from: Day.optional(), to: Day.optional() }).parse(req.query);
    const conds = [eq(stockMoves.clientId, clientId), eq(stockMoves.itemId, q.itemId)];
    if (q.warehouseId) conds.push(eq(stockMoves.warehouseId, q.warehouseId));
    if (q.from) conds.push(sql`${stockDocs.docDate} >= ${q.from}`);
    if (q.to) conds.push(sql`${stockDocs.docDate} <= ${q.to}`);
    const [item] = await db.select().from(items).where(and(eq(items.id, q.itemId), eq(items.clientId, clientId)));
    if (!item) throw new DomainError("not_found", "Артиклот не постои.", 404);
    const moves = await db.select({ id: stockMoves.id, docId: stockDocs.id, number: stockDocs.number, kind: stockDocs.kind, docDate: stockDocs.docDate,
      note: stockDocs.note, warehouseName: warehouses.name, lotNo: lots.lotNo, qty: stockMoves.qty, unitCost: stockMoves.unitCost, value: stockMoves.value,
      balanceQty: stockMoves.balanceQty, balanceValue: stockMoves.balanceValue, invoiceId: stockDocs.invoiceId, purchaseInvoiceId: stockDocs.purchaseInvoiceId })
      .from(stockMoves).innerJoin(stockDocs, eq(stockDocs.id, stockMoves.docId)).innerJoin(warehouses, eq(warehouses.id, stockMoves.warehouseId))
      .leftJoin(lots, eq(lots.id, stockMoves.lotId)).where(and(...conds)).orderBy(asc(stockMoves.id)).limit(5000);
    return { item, moves };
  });

  /* ------------------------------------------------- magacinski dokumenti */
  app.get("/api/clients/:clientId/stock-docs", async (req) => {
    const { clientId } = await withModule(req, "warehouse");
    const q = z.object({ kind: z.enum(["receipt", "issue", "writeoff", "inventory", "transfer"]).optional() }).parse(req.query);
    const conds = [eq(stockDocs.clientId, clientId)];
    if (q.kind) conds.push(eq(stockDocs.kind, q.kind));
    const docs = await db.select({ id: stockDocs.id, number: stockDocs.number, kind: stockDocs.kind, docDate: stockDocs.docDate, note: stockDocs.note,
      warehouseName: warehouses.name, reversesDocId: stockDocs.reversesDocId, invoiceId: stockDocs.invoiceId, purchaseInvoiceId: stockDocs.purchaseInvoiceId,
      value: sql<string>`(select coalesce(sum(m.value), 0) from stock_moves m where m.doc_id = ${stockDocs.id} and m.warehouse_id = ${stockDocs.warehouseId})`,
      lines: sql<number>`(select count(*)::int from stock_moves m where m.doc_id = ${stockDocs.id})` })
      .from(stockDocs).innerJoin(warehouses, eq(warehouses.id, stockDocs.warehouseId)).where(and(...conds))
      .orderBy(desc(stockDocs.docDate), desc(stockDocs.id)).limit(500);
    const reversed = new Set(docs.filter((d) => d.reversesDocId).map((d) => d.reversesDocId));
    return docs.map((d) => ({ ...d, reversed: reversed.has(d.id) }));
  });
  app.get("/api/clients/:clientId/stock-docs/:id", async (req) => {
    const { clientId, id } = await withModule(req, "warehouse");
    const [doc] = await db.select({ d: stockDocs, author: users.displayName }).from(stockDocs).leftJoin(users, eq(users.id, stockDocs.createdBy))
      .where(and(eq(stockDocs.id, id!), eq(stockDocs.clientId, clientId)));
    if (!doc) throw new DomainError("not_found", "Документот не постои.", 404);
    const moves = await db.select({ id: stockMoves.id, itemId: items.id, code: items.code, name: items.name, unit: items.unit, warehouseName: warehouses.name,
      lotNo: lots.lotNo, expiryDate: lots.expiryDate, qty: stockMoves.qty, unitCost: stockMoves.unitCost, value: stockMoves.value })
      .from(stockMoves).innerJoin(items, eq(items.id, stockMoves.itemId)).innerJoin(warehouses, eq(warehouses.id, stockMoves.warehouseId))
      .leftJoin(lots, eq(lots.id, stockMoves.lotId)).where(eq(stockMoves.docId, doc.d.id)).orderBy(asc(stockMoves.id));
    const [rev] = await db.select({ id: stockDocs.id, number: stockDocs.number }).from(stockDocs).where(eq(stockDocs.reversesDocId, doc.d.id));
    const [orig] = doc.d.reversesDocId ? await db.select({ id: stockDocs.id, number: stockDocs.number }).from(stockDocs).where(eq(stockDocs.id, doc.d.reversesDocId)) : [];
    return { ...doc.d, author: doc.author, moves, reversedBy: rev ?? null, reverses: orig ?? null };
  });

  /** Racni dokumenti: pocetna sostojba / priemnica, otpis, popis (izbroena kolicina), prenos. */
  app.post("/api/clients/:clientId/stock-docs", async (req, reply) => {
    const { u, clientId } = await withModule(req, "warehouse");
    const b = StockDocIn.parse(req.body);
    await ownWarehouse(clientId, b.warehouseId);
    if (b.kind === "transfer") { if (!b.toWarehouseId) throw new DomainError("validation", "Изберете магацин во кој се пренесува.", 422); await ownWarehouse(clientId, b.toWarehouseId); }
    const r = await db.transaction(async (tx0) => {
      const tx = tx0 as unknown as Db;
      const moves: MoveIn[] = [];
      for (const [i, l] of b.lines.entries()) {
        const base = { warehouseId: b.warehouseId, itemId: l.itemId, lotId: l.lotId ?? null };
        if (b.kind === "receipt") {
          if (!(l.qty > 0)) throw new DomainError("validation", `Ставка ${i + 1}: количината мора да е поголема од 0.`, 422);
          if (l.unitCost === undefined) throw new DomainError("validation", `Ставка ${i + 1}: внесете набавна цена.`, 422);
          moves.push({ ...base, qty: l.qty, unitCost: l.unitCost, lotNo: l.lotNo, expiryDate: l.expiryDate });
        } else if (b.kind === "writeoff" || b.kind === "transfer") {
          if (!(l.qty > 0)) throw new DomainError("validation", `Ставка ${i + 1}: количината мора да е поголема од 0.`, 422);
          moves.push({ ...base, qty: -l.qty });
        } else {
          // popis: l.qty = izbroena kolicina; razlikata vo odnos na knizenata
          let cur: InstanceType<typeof D>;
          if (l.lotId) {
            const [lb] = await tx.select().from(lotBalances).where(and(eq(lotBalances.lotId, l.lotId), eq(lotBalances.warehouseId, b.warehouseId)));
            cur = new D(lb?.qty ?? 0);
          } else {
            const [it] = await tx.select({ trackLots: items.trackLots }).from(items).where(eq(items.id, l.itemId));
            if (it?.trackLots) throw new DomainError("validation", `Ставка ${i + 1}: артиклот води лот, пописот се прави по лот.`, 422);
            cur = (await balanceOf(tx, b.warehouseId, l.itemId)).qty;
          }
          const diff = new D(l.qty).minus(cur);
          if (diff.isZero()) continue;
          const avg = (await balanceOf(tx, b.warehouseId, l.itemId)).avg;
          moves.push({ ...base, qty: diff, ...(diff.gt(0) ? { unitCost: l.unitCost ?? avg.toDecimalPlaces(4) } : {}) });
        }
      }
      if (!moves.length) throw new DomainError("validation", "Нема разлика меѓу пописот и книжената залиха.", 422);
      return postStockDoc(tx, { clientId, kind: b.kind, warehouseId: b.warehouseId, toWarehouseId: b.toWarehouseId ?? null, docDate: b.docDate,
        note: b.note, createdBy: u.id, moves });
    });
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "stock_doc", entityId: r.doc.id, action: "create", changes: { number: r.doc.number, kind: b.kind } });
    return reply.status(201).send({ id: r.doc.id, number: r.doc.number, warnings: r.warnings });
  });

  /** Storno na racen dokument (dokumentite od fakturi se stornираат preku fakturata). */
  app.post("/api/clients/:clientId/stock-docs/:id/reverse", async (req) => {
    const { u, clientId, id } = await withModule(req, "warehouse");
    const { date } = z.object({ date: Day }).parse(req.body);
    const [d] = await db.select().from(stockDocs).where(and(eq(stockDocs.id, id!), eq(stockDocs.clientId, clientId)));
    if (!d) throw new DomainError("not_found", "Документот не постои.", 404);
    if (d.invoiceId || d.purchaseInvoiceId) throw new DomainError("validation", "Документот е од фактура: сторнирајте ја фактурата.", 422);
    const r = await db.transaction(async (tx) => reverseStockDoc(tx as unknown as Db, d.id, { docDate: date, createdBy: u.id }));
    await audit(db, { userId: u.id, ip: req.ip }, { clientId, entity: "stock_doc", entityId: d.id, action: "reverse", changes: { by: r.doc.number } });
    return { id: r.doc.id, number: r.doc.number, warnings: r.warnings };
  });
}
