import { describe, it, expect, beforeEach } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { testDb } from "./helpers.js";
import { clients, invoiceLines, invoices, items, partners, purchaseInvoices, purchaseLines, stockBalances, stockDocs, stockMoves,
  warehouses } from "../src/db/schema.js";
import type { Db } from "../src/db/types.js";
import { calcLine } from "../src/domain/calc.js";
import { postStockDoc, reverseStockDoc } from "../src/domain/stock.js";
import { postPurchase, voidPurchase } from "../src/domain/purchase.js";
import { issueInvoice } from "../src/domain/issue.js";

let t: Awaited<ReturnType<typeof testDb>>;
let wh: number, wh2: number, goods: number, lotItem: number, svc: number;
const actor = () => ({ userId: t.user.id });
const tx = <T>(f: (d: Db) => Promise<T>) => t.db.transaction(async (x) => f(x as unknown as Db));
async function bal(itemId: number, w = wh) {
  const [b] = await t.db.select().from(stockBalances).where(and(eq(stockBalances.warehouseId, w), eq(stockBalances.itemId, itemId)));
  return b ? [Number(b.qty), Number(b.value)] : [0, 0];
}
const recv = (itemId: number, qty: number, cost: number, extra: object = {}) => tx((d) => postStockDoc(d, {
  clientId: t.c1.id, kind: "receipt", warehouseId: wh, docDate: "2026-11-04", moves: [{ warehouseId: wh, itemId, qty, unitCost: cost, ...extra }] }));
const issue = (itemId: number, qty: number) => tx((d) => postStockDoc(d, {
  clientId: t.c1.id, kind: "issue", warehouseId: wh, docDate: "2026-11-05", moves: [{ warehouseId: wh, itemId, qty: -qty }] }));
async function err(p: Promise<unknown>) { try { await p; return ""; } catch (e) { return ((e as { cause?: Error }).cause ?? (e as Error)).message; } }

beforeEach(async () => {
  t = await testDb();
  await t.db.update(clients).set({ modules: ["invoices", "incoming", "warehouse"] }).where(eq(clients.id, t.c1.id));
  [{ id: wh }] = await t.db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.clientId, t.c1.id));
  [{ id: wh2 }] = await t.db.insert(warehouses).values({ clientId: t.c1.id, code: "PROD", name: "Продавница" }).returning({ id: warehouses.id });
  const mk = async (code: string, type: "goods" | "service" | "material", trackLots = false) =>
    (await t.db.insert(items).values({ clientId: t.c1.id, code, name: code, type, unit: "ком", unitPrice: "200", vatRateId: t.vat18.id, trackLots }).returning())[0]!.id;
  goods = await mk("G1", "goods"); lotItem = await mk("L1", "material", true); svc = await mk("S1", "service");
});

describe("prosecna nabavna cena i zaliha", () => {
  it("sekoj klient dobiva glaven magacin; dokumentot ima broj", async () => {
    const [w2] = await t.db.select().from(warehouses).where(eq(warehouses.clientId, t.c2.id));
    expect(w2).toMatchObject({ code: "GL", isDefault: true });
    const r = await recv(goods, 10, 100);
    expect(r.doc.number).toBe("MC-PR-2026-00001");
  });

  it("10 x 100 + 10 x 130 = prosek 115; izlez 5 po 115", async () => {
    await recv(goods, 10, 100); await recv(goods, 10, 130);
    expect(await bal(goods)).toEqual([20, 2300]);
    await issue(goods, 5);
    expect(await bal(goods)).toEqual([15, 1725]);
    const [mv] = await t.db.select().from(stockMoves).where(sql`${stockMoves.qty} < 0`);
    expect([mv!.unitCost, mv!.value]).toEqual(["115.0000", "-575.0000"]);
  });

  it("ispraznuvanje go nosi celiot ostatok od vrednosta (bez centi sto visat)", async () => {
    await recv(goods, 3, 10);
    await recv(goods, 3, 10.01);                    // 60.03 / 6 = 10.005
    await issue(goods, 1); await issue(goods, 5);
    expect(await bal(goods)).toEqual([0, 0]);
  });

  it("block: nema dovolno zaliha -> greska, nisto ne e zapisano", async () => {
    await recv(goods, 2, 100);
    expect(await err(issue(goods, 3))).toMatch(/нема доволно залиха \(има 2.00, потребно 3.00\)/);
    expect(await bal(goods)).toEqual([2, 200]);
    expect(await t.db.select().from(stockDocs)).toHaveLength(1);
  });

  it("warn: dozvoleno so predupreduvanje, zalihata vo minus", async () => {
    await t.db.update(clients).set({ negativeStock: "warn" }).where(eq(clients.id, t.c1.id));
    await recv(goods, 2, 100);
    const r = await issue(goods, 3);
    expect(r.warnings[0]).toMatch(/нема доволно залиха/);
    expect(await bal(goods)).toEqual([-1, -100]);
  });

  it("usluga ne vodi zaliha", async () => {
    expect(await err(recv(svc, 1, 10))).toMatch(/услуга/);
  });

  it("dvizenjata i dokumentite ne se menuvaat i ne se brisat", async () => {
    await recv(goods, 1, 1);
    expect(await err(t.db.update(stockMoves).set({ qty: "5" }) as unknown as Promise<unknown>)).toMatch(/само за додавање/);
    expect(await err(t.db.execute(sql`delete from stock_docs`) as unknown as Promise<unknown>)).toMatch(/само за додавање/);
  });
});

describe("lot i rok na traenje", () => {
  it("lot e zadolzitelen; izlez po najbliskiot rok (FEFO)", async () => {
    expect(await err(recv(lotItem, 5, 10))).toMatch(/лот/);
    await recv(lotItem, 5, 10, { lotNo: "A", expiryDate: "2027-03-01" });
    await recv(lotItem, 5, 10, { lotNo: "B", expiryDate: "2026-12-01" });
    await issue(lotItem, 7);
    const out = await t.db.execute(sql`select l.lot_no, m.qty from stock_moves m join lots l on l.id = m.lot_id where m.qty < 0 order by m.id`);
    expect((out as unknown as { rows: { lot_no: string; qty: string }[] }).rows.map((r) => [r.lot_no, Number(r.qty)])).toEqual([["B", -5], ["A", -2]]);
  });
});

describe("prenos i storno", () => {
  it("prenos gi nosi istite ceni i lotovi; stornoto vrakja tocno", async () => {
    await recv(goods, 10, 100);
    await recv(lotItem, 4, 50, { lotNo: "X" });
    const r = await tx((d) => postStockDoc(d, { clientId: t.c1.id, kind: "transfer", warehouseId: wh, toWarehouseId: wh2, docDate: "2026-11-06",
      moves: [{ warehouseId: wh, itemId: goods, qty: -4 }, { warehouseId: wh, itemId: lotItem, qty: -1 }] }));
    expect(await bal(goods, wh2)).toEqual([4, 400]);
    expect(await bal(lotItem, wh2)).toEqual([1, 50]);
    await tx((d) => reverseStockDoc(d, r.doc.id, { docDate: "2026-11-07" }));
    expect(await bal(goods)).toEqual([10, 1000]);
    expect(await bal(goods, wh2)).toEqual([0, 0]);
    expect(await err(tx((d) => reverseStockDoc(d, r.doc.id, { docDate: "2026-11-07" })))).toMatch(/веќе сторниран/);
  });
});

describe("vlezni fakturi", () => {
  async function purchase(lines: { itemId: number | null; qty: number; price: number; allocate?: boolean; lotNo?: string }[], supplierNumber = "123/2026") {
    const [p] = await t.db.insert(purchaseInvoices).values({ clientId: t.c1.id, partnerId: t.p1.id, year: 2026, supplierNumber,
      issueDate: "2026-11-01", receivedDate: "2026-11-02" }).returning();
    let n = 1;
    for (const l of lines) await t.db.insert(purchaseLines).values({ purchaseInvoiceId: p!.id, lineNo: n++, itemId: l.itemId, description: "x",
      unit: "ком", qty: String(l.qty), unitPrice: String(l.price), vatRateId: t.vat18.id, vatRatePct: "18", allocate: !!l.allocate, lotNo: l.lotNo,
      ...calcLine({ qty: l.qty, unitPrice: l.price, vatRatePct: 18 }) });
    return p!;
  }

  it("knizenje: broj, priemnica, zavisen trosok rasporeden po osnovica", async () => {
    const p = await purchase([{ itemId: goods, qty: 10, price: 100 }, { itemId: lotItem, qty: 10, price: 300, lotNo: "L-1" }, { itemId: svc, qty: 1, price: 400, allocate: true }]);
    const r = await postPurchase(t.db, p.id, actor(), true);
    expect(r).toMatchObject({ status: "posted", number: "MC-VF-2026-00001", receiptNumber: "MC-PR-2026-00001", netTotal: "4400.00", grossTotal: "5192.00" });
    expect(await bal(goods)).toEqual([10, 1100]);        // 1000 + 400 x 1/4
    expect(await bal(lotItem)).toEqual([10, 3300]);      // 3000 + 400 x 3/4
    expect(await err(t.db.update(purchaseInvoices).set({ note: "x" }).where(eq(purchaseInvoices.id, p.id)) as unknown as Promise<unknown>)).toMatch(/не може да се менува/);
    expect(await err(t.db.update(purchaseLines).set({ qty: "1" }).where(eq(purchaseLines.purchaseInvoiceId, p.id)) as unknown as Promise<unknown>)).toMatch(/не се менуваат/);
  });

  it("klient sto ne e DDV obvrznik: DDV vleguva vo nabavnata cena", async () => {
    await t.db.update(clients).set({ vatPayer: false }).where(eq(clients.id, t.c1.id));
    await postPurchase(t.db, (await purchase([{ itemId: goods, qty: 2, price: 100 }])).id, actor(), true);
    expect(await bal(goods)).toEqual([2, 236]);
  });

  it("bez Magacin: samo kniga, bez priemnica", async () => {
    const r = await postPurchase(t.db, (await purchase([{ itemId: goods, qty: 2, price: 100 }])).id, actor(), false);
    expect(r.receiptNumber).toBeNull();
    expect(await bal(goods)).toEqual([0, 0]);
  });

  it("ista faktura od ist dobavuvac ne se vnesuva dvapati; storno vrakja zaliha", async () => {
    const p = await purchase([{ itemId: goods, qty: 5, price: 100 }]);
    await postPurchase(t.db, p.id, actor(), true);
    expect(await err(t.db.insert(purchaseInvoices).values({ clientId: t.c1.id, partnerId: t.p1.id, year: 2026, supplierNumber: "123/2026",
      issueDate: "2026-11-01", receivedDate: "2026-11-02" }) as unknown as Promise<unknown>)).toMatch(/purchase_supplier_no_uq/);
    await voidPurchase(t.db, p.id, actor(), "Погрешно внесена", "2026-11-03");
    expect(await bal(goods)).toEqual([0, 0]);
    const p2 = await purchase([{ itemId: goods, qty: 5, price: 100 }]);   // po storno moze povtorno
    expect((await postPurchase(t.db, p2.id, actor(), true)).number).toBe("MC-VF-2026-00002");
  });

  it("dobavuvac od drug klient e odbien od bazata", async () => {
    expect(await err(t.db.insert(purchaseInvoices).values({ clientId: t.c1.id, partnerId: t.p2.id, year: 2026, supplierNumber: "1",
      issueDate: "2026-11-01", receivedDate: "2026-11-01" }) as unknown as Promise<unknown>)).toMatch(/purchase_partner_client_fk/);
  });
});

describe("izlezna faktura i magacin", () => {
  async function draft(qty: number, over: Partial<typeof invoices.$inferInsert> = {}, sign: 1 | -1 = 1) {
    const [inv] = await t.db.insert(invoices).values({ clientId: t.c1.id, partnerId: t.p1.id, year: 2026, issueDate: "2026-11-04", supplyDate: "2026-11-04", ...over }).returning();
    await t.db.insert(invoiceLines).values({ invoiceId: inv!.id, lineNo: 1, itemId: goods, description: "G1", unit: "ком", qty: String(qty), unitPrice: "200",
      vatRateId: t.vat18.id, vatRatePct: "18", ...calcLine({ qty, unitPrice: 200, vatRatePct: 18 }, sign) });
    return inv!;
  }

  it("izdavanje pravi ispratnica; bez zaliha fakturata ne se izdava (block)", async () => {
    await recv(goods, 3, 100);
    const big = await draft(5);
    expect(await err(issueInvoice(t.db, big.id, actor()))).toMatch(/нема доволно залиха/);
    const [still] = await t.db.select().from(invoices).where(eq(invoices.id, big.id));
    expect([still!.status, still!.number]).toEqual(["draft", null]);
    const ok = await issueInvoice(t.db, (await draft(2)).id, actor());
    expect(ok).toMatchObject({ number: "MC-2026-00001", stockDocNumber: "MC-IS-2026-00001" });
    expect(await bal(goods)).toEqual([1, 100]);
  });

  it("storno ja vrakja zalihata po istata cena", async () => {
    await recv(goods, 3, 100);
    const a = await issueInvoice(t.db, (await draft(2)).id, actor());
    await recv(goods, 1, 400);                     // prosekot se menuva: (100 + 400) / 2 = 250
    await issueInvoice(t.db, (await draft(2, { docType: "ST", relatedInvoiceId: a.id, voidReasonCode: "S-1", correctionReason: "Погрешно" }, -1)).id, actor());
    expect(await bal(goods)).toEqual([4, 700]);    // 500 + 2 x 100 (originalnata cena)
  });

  it("bez modul Magacin fakturata ne ja menuva zalihata", async () => {
    await t.db.update(clients).set({ modules: ["invoices"] }).where(eq(clients.id, t.c1.id));
    const r = await issueInvoice(t.db, (await draft(5)).id, actor());
    expect(r.stockDocNumber).toBeNull();
    expect(await bal(goods)).toEqual([0, 0]);
  });
});

void partners;
