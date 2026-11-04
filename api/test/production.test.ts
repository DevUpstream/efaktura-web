import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { testDb } from "./helpers.js";
import { bomLines, boms, clients, items, stockBalances, warehouses, workOrderLines, workOrders } from "../src/db/schema.js";
import type { Db } from "../src/db/types.js";
import { postStockDoc } from "../src/domain/stock.js";
import { conversionCost, plannedLines, postWorkOrder, voidWorkOrder } from "../src/domain/production.js";

let t: Awaited<ReturnType<typeof testDb>>;
let wh: number, top: number, legs: number, screws: number, table: number, frame: number;
const actor = () => ({ userId: t.user.id });
async function bal(itemId: number) {
  const [b] = await t.db.select().from(stockBalances).where(and(eq(stockBalances.warehouseId, wh), eq(stockBalances.itemId, itemId)));
  return b ? [Number(b.qty), Number(b.value)] : [0, 0];
}
async function err(p: Promise<unknown>) { try { await p; return ""; } catch (e) { return ((e as { cause?: Error }).cause ?? (e as Error)).message; } }
const settings = (s: object) => t.db.update(clients).set({ productionSettings: { useWaste: false, labor: "none", laborRate: 0, overhead: "none", overheadValue: 0, ...s } }).where(eq(clients.id, t.c1.id));

async function order(productItemId: number, qty: number, lines: [number, number][], extra: Partial<typeof workOrders.$inferInsert> = {}) {
  const [w] = await t.db.insert(workOrders).values({ clientId: t.c1.id, productItemId, qty: String(qty), year: 2026, docDate: "2026-11-05", ...extra }).returning();
  let n = 1;
  for (const [itemId, q] of lines) await t.db.insert(workOrderLines).values({ workOrderId: w!.id, lineNo: n++, itemId, plannedQty: String(q), qty: String(q) });
  return w!;
}

beforeEach(async () => {
  t = await testDb();
  await t.db.update(clients).set({ modules: ["invoices", "warehouse", "production"] }).where(eq(clients.id, t.c1.id));
  [{ id: wh }] = await t.db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.clientId, t.c1.id));
  const mk = async (code: string, type: "material" | "product") =>
    (await t.db.insert(items).values({ clientId: t.c1.id, code, name: code, type, unit: "ком", unitPrice: "0", vatRateId: t.vat18.id }).returning())[0]!.id;
  top = await mk("PLOCA", "material"); legs = await mk("NOGA", "material"); screws = await mk("ZAV", "material");
  table = await mk("MASA", "product"); frame = await mk("RAMKA", "product");
  await t.db.transaction((x) => postStockDoc(x as unknown as Db, { clientId: t.c1.id, kind: "receipt", warehouseId: wh, docDate: "2026-11-01",
    moves: [{ warehouseId: wh, itemId: top, qty: 20, unitCost: 1500 }, { warehouseId: wh, itemId: legs, qty: 100, unitCost: 200 }, { warehouseId: wh, itemId: screws, qty: 1000, unitCost: 5 }] }));
});

describe("normativ i planirani kolicini", () => {
  it("bez otpad: tocno od normativot; so otpad: povekje", () => {
    const lines = [{ itemId: legs, qty: "4", wastePct: "0" }, { itemId: screws, qty: "16", wastePct: "20" }];
    expect(plannedLines({ outputQty: "1" }, lines, 10, false)).toEqual([{ itemId: legs, plannedQty: "40.0000" }, { itemId: screws, plannedQty: "160.0000" }]);
    expect(plannedLines({ outputQty: "1" }, lines, 10, true)[1]).toEqual({ itemId: screws, plannedQty: "200.0000" }); // 160 / 0.8
    expect(plannedLines({ outputQty: "2" }, lines, 10, false)[0]).toEqual({ itemId: legs, plannedQty: "20.0000" });  // normativ za 2 parcinja
  });

  it("trud i opsti troshoci po postavkite na firmata; racniot iznos ima prednost", () => {
    const base = { qty: 10, laborHours: 15, laborCost: null, overheadCost: null };
    const a = conversionCost({ useWaste: false, labor: "hour", laborRate: 300, overhead: "percent", overheadValue: 10 }, base, 24000, null);
    expect([a.labor.toNumber(), a.overhead.toNumber()]).toEqual([4500, 2400]);
    const b = conversionCost({ useWaste: false, labor: "piece", laborRate: 100, overhead: "piece", overheadValue: 20 }, base, 24000, { laborCost: "150" });
    expect([b.labor.toNumber(), b.overhead.toNumber()]).toEqual([1500, 200]);
    const c = conversionCost({ useWaste: false, labor: "hour", laborRate: 300, overhead: "percent", overheadValue: 10 }, { ...base, laborCost: 999, overheadCost: 0 }, 24000, null);
    expect([c.labor.toNumber(), c.overhead.toNumber()]).toEqual([999, 0]);
  });
});

describe("raboten nalog", () => {
  it("10 masi: delovite izleguvaat, masite vleguvaat po cena na cinenje", async () => {
    await settings({ labor: "hour", laborRate: 300, overhead: "percent", overheadValue: 10 });
    const w = await order(table, 10, [[top, 10], [legs, 40], [screws, 160]], { laborHours: "15" });
    const r = await postWorkOrder(t.db, w.id, actor());
    // materijali: 10 x 1500 + 40 x 200 + 160 x 5 = 23.800; trud 15 x 300 = 4.500; opsti 10% = 2.380 -> 30.680 / 10 = 3.068
    expect(r).toMatchObject({ number: "MC-RN-2026-00001", consumptionNumber: "MC-PI-2026-00001", outputNumber: "MC-GP-2026-00001",
      materialCost: "23800.0000", laborCost: "4500.0000", overheadCost: "2380.0000", totalCost: "30680.0000", unitCost: "3068.0000" });
    expect(await bal(table)).toEqual([10, 30680]);
    expect(await bal(legs)).toEqual([60, 12000]);
    expect(await err(t.db.update(workOrders).set({ note: "x" }).where(eq(workOrders.id, w.id)) as unknown as Promise<unknown>)).toMatch(/не може да се менува/);
    expect(await err(t.db.update(workOrderLines).set({ qty: "1" }).where(eq(workOrderLines.workOrderId, w.id)) as unknown as Promise<unknown>)).toMatch(/не се менуваат/);
  });

  it("vrednosta na gotoviot proizvod e tocna i koga ne se deli na celo", async () => {
    const w = await order(table, 3, [[legs, 0.5]]);   // 100 den / 3 parcinja
    await postWorkOrder(t.db, w.id, actor());
    expect(await bal(table)).toEqual([3, 100]);
  });

  it("nema dovolno delovi: nalogot ne se knizi (block)", async () => {
    const w = await order(table, 1, [[top, 50]]);
    expect(await err(postWorkOrder(t.db, w.id, actor()))).toMatch(/нема доволно залиха/);
    const [still] = await t.db.select().from(workOrders).where(eq(workOrders.id, w.id));
    expect([still!.status, still!.number]).toEqual(["draft", null]);
    expect(await bal(top)).toEqual([20, 30000]);
  });

  it("polu-proizvod: ramka se pravi prvo, pa vleguva vo masa", async () => {
    await postWorkOrder(t.db, (await order(frame, 2, [[legs, 8]])).id, actor());        // ramka = 800 den
    await postWorkOrder(t.db, (await order(table, 2, [[frame, 2], [top, 2]])).id, actor());
    expect(await bal(frame)).toEqual([0, 0]);
    expect(await bal(table)).toEqual([2, 4600]);                                         // 1600 + 3000
  });

  it("storno: gotoviot proizvod se vrakja, delovite se vrakjaat po istite ceni", async () => {
    const w = await order(table, 2, [[top, 2], [legs, 8]]);
    await postWorkOrder(t.db, w.id, actor());
    await voidWorkOrder(t.db, w.id, actor(), "Погрешна количина", "2026-11-06");
    expect(await bal(table)).toEqual([0, 0]);
    expect(await bal(top)).toEqual([20, 30000]);
    expect(await bal(legs)).toEqual([100, 20000]);
  });

  it("storno ne e mozno ako proizvodot e vekje prodaden (block)", async () => {
    const w = await order(table, 1, [[top, 1]]);
    await postWorkOrder(t.db, w.id, actor());
    await t.db.transaction((x) => postStockDoc(x as unknown as Db, { clientId: t.c1.id, kind: "writeoff", warehouseId: wh, docDate: "2026-11-06",
      moves: [{ warehouseId: wh, itemId: table, qty: -1 }] }));
    expect(await err(voidWorkOrder(t.db, w.id, actor(), "Погрешно", "2026-11-07"))).toMatch(/нема доволно залиха/);
  });

  it("eden normativ po proizvod; proizvod od drug klient e odbien", async () => {
    const [b] = await t.db.insert(boms).values({ clientId: t.c1.id, productItemId: table }).returning();
    await t.db.insert(bomLines).values({ bomId: b!.id, lineNo: 1, itemId: legs, qty: "4" });
    expect(await err(t.db.insert(boms).values({ clientId: t.c1.id, productItemId: table }) as unknown as Promise<unknown>)).toMatch(/boms_product_uq/);
    expect(await err(t.db.insert(boms).values({ clientId: t.c2.id, productItemId: frame }) as unknown as Promise<unknown>)).toMatch(/boms_product_client_fk/);
  });
});
