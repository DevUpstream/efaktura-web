/** src/tools/import-docs.ts (docs/20): vlezni i izlezni od Excel/PDF so zaliha. Podatocite se izmisleni. */
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { testDb } from "./helpers.js";
import { bankStatementLines, clients, counters, invoices, items, partners, paymentAllocations, payments, purchaseFiles, purchaseInvoices, stockBalances,
  stockDocs } from "../src/db/schema.js";
import { importDocs } from "../src/tools/import-docs.js";

let t: Awaited<ReturnType<typeof testDb>>;
const EDB = "4015023508550";
const PDF = Buffer.from("%PDF-1.4 test").toString("base64");
const nbrm = async () => [{ Oznaka: "USD", Datum: "/Date(1696284000000)/", Nomin: 1, Sreden: 56.5 }];
const L = (itemCode: string | null, qty: number, unitPrice: number, vatPct = 18) => ({ itemCode, description: itemCode ?? "Услуга", unit: "ком", qty, unitPrice, discountPct: 0, vatPct });
const file = () => JSON.stringify({ format: "docs/1", label: "Тест 2023", company: { edb: EDB },
  items: [{ code: "T1", name: "Тонер", type: "goods", unit: "ком", vatPct: 18, price: 1500 }, { code: "K1", name: "Клима", type: "goods", unit: "ком", vatPct: 18, price: 40000 }],
  docs: [
    { kind: "sale", ref: "x1", number: "2023/11/2", date: "2023-11-13", dueDate: null, partner: { name: "Нов Купувач ДОО", city: "Скопје" },
      lines: [L("T1", 3, 1500)], net: 4500, vat: 810, gross: 5310 },
    { kind: "purchase", ref: "p1", number: "01-1/2023", date: "2023-11-10", dueDate: "2023-12-10", partner: { edb: "4080014547370", name: "Добавувач" },
      lines: [L("T1", 2, 650)], net: 1300, vat: 234, gross: 1534, files: [{ name: "f.pdf", data: PDF }] },
    { kind: "purchase", ref: "p2", number: "500", date: "2023-10-03", dueDate: null, currency: "USD", paid: { date: "2023-10-03", method: "card" }, partner: { name: "ICDSoft Ltd.", country: "BG" },
      lines: [L(null, 1, 19, 0)], net: 19, vat: 0, gross: 19 },
    { kind: "sale", ref: "x2", number: "2023/10/1", date: "2023-10-04", dueDate: null, partner: { name: "Физичко Лице" },
      lines: [L("K1", 1, 40677.97), L(null, 1, 1000)], net: 41677.97, vat: 7502.03, gross: 49180 },
    { kind: "sale", ref: "x3", number: "2023/11/3", date: "2023-11-14", supplyDate: "2023-11-13", dueDate: null, partner: { name: "Донаторски проект", edb: "4075021100158" },
      lines: [{ ...L("T1", 1, 1500, 0), vatCode: "Z0" }], net: 1500, vat: 0, gross: 1500, note: "член 24-а" },
  ],
  statements: [{ no: "1", date: "2023-11-20", account: "200004115053690", opening: 100, closing: 1000 + 100 - 11 - 500 + 1500, fileName: "izv.pdf", lines: [
    { lineNo: 1, direction: "in", amount: 1000, name: "Физичко Лице", account: "210501682596969", paymentCode: "930", purpose: "по фактура", key: "FT1",
      book: { partner: { name: "Физичко Лице" }, invoices: [{ number: "2023/10/1", amount: 1000 }] } },
    { lineNo: 2, direction: "out", amount: 11, name: "Провизија", account: "200000000099029", paymentCode: "666", purpose: "провизија", key: "k2", category: "fee" },
    { lineNo: 3, direction: "out", amount: 500, name: "СЕТЕК", account: "200001969089613", paymentCode: "200", purpose: "плаќање", key: "FT3",
      book: { partner: { name: "СЕТЕК ДОО", edb: "4057009501106" }, invoices: [] }, note: "нема влезна фактура" },
    { lineNo: 4, direction: "in", amount: 1500, name: "Основач", account: "200001329767463", paymentCode: "468", purpose: "позајмица", key: "FT4" },
  ] }] });

beforeEach(async () => {
  t = await testDb();
  await t.db.update(clients).set({ modules: ["invoices", "incoming", "payments", "warehouse"], vatPayer: true, negativeStock: "warn",
    pdfSettings: { bankAccounts: [{ bank: "Стопанска", account: "200004115053690" }] } as never }).where(eq(clients.id, t.c2.id));
  await t.db.insert(partners).values({ clientId: t.c2.id, name: "КРЕАТИВА ДООЕЛ", edb: "4080014547370" });
});

describe("uvoz od Excel/PDF so zaliha", () => {
  it("artikli, partneri, vlezni so priemnica, izlezni so ispratnica i redosled po datum", async () => {
    const r = await importDocs(t.db, file(), EDB, t.user.email, nbrm);
    expect(r.counts).toMatchObject({ items_new: 2, partners_new: 5, purchases_new: 2, sales_new: 3, files_new: 1,
      statements_new: 1, lines_booked: 2, lines_categorized: 1, lines_open: 1 });
    // po datum: 2023/10/1 (seq 1) pred 2023/11/2 (seq 2), iako vo datotekata e obratno
    const inv = await t.db.select().from(invoices).where(eq(invoices.clientId, t.c2.id)).orderBy(invoices.seqNo);
    expect(inv.map((i) => [i.number, i.seqNo, i.status, i.source, i.grossTotal])).toEqual([["2023/10/1", 1, "issued", "excel", "49180.00"],
      ["2023/11/2", 2, "issued", "excel", "5310.00"], ["2023/11/3", 3, "issued", "excel", "1500.00"]]);
    expect(inv[2]).toMatchObject({ issueDate: "2023-11-14", supplyDate: "2023-11-13", vatTotal: "0.00" });
    const [ctr] = await t.db.select().from(counters).where(and(eq(counters.clientId, t.c2.id), eq(counters.year, 2023)));
    expect(ctr!.lastNo).toBe(3);
    // USD -> denari po NBRM; DDV 0 -> NP
    const pur = await t.db.select().from(purchaseInvoices).where(eq(purchaseInvoices.clientId, t.c2.id)).orderBy(purchaseInvoices.seqNo);
    expect(pur.map((p) => [p.supplierNumber, p.status, p.grossTotal, p.number])).toEqual([["500", "posted", "1073.50", "UPSTRI-VF-2023-00001"], ["01-1/2023", "posted", "1534.00", "UPSTRI-VF-2023-00002"]]);
    expect(pur[0]!.note).toMatch(/USD: 19.00; среден курс НБРМ 56.5/);
    expect(await t.db.select({ id: purchaseFiles.id }).from(purchaseFiles).where(eq(purchaseFiles.purchaseInvoiceId, pur[1]!.id))).toHaveLength(1);
    // zaliha: klimata e prodadena bez vlez (minus), tonerot 2 vlez - 3 izlez = -1
    const docs = await t.db.select().from(stockDocs).where(eq(stockDocs.clientId, t.c2.id));
    expect(docs.map((d) => d.kind).sort()).toEqual(["issue", "issue", "issue", "receipt"]);
    expect(docs.find((d) => d.note?.startsWith("2023/11/3"))!.docDate).toBe("2023-11-13");
    expect(r.counts.stock_warnings).toBe(3);
    const bal = await t.db.select({ code: items.code, qty: stockBalances.qty }).from(stockBalances).innerJoin(items, eq(items.id, stockBalances.itemId))
      .where(eq(stockBalances.clientId, t.c2.id)).orderBy(items.code);
    expect(bal.map((b) => [b.code, Number(b.qty)])).toEqual([["K1", -1], ["T1", -2]]);
    // izvod: uplata po faktura, provizija, isplata bez faktura (nerasporedena), pozajmica ostanuva otvorena
    const pays = await t.db.select().from(payments).where(eq(payments.clientId, t.c2.id)).orderBy(payments.id);
    expect(pays.map((p) => [p.direction, p.method, p.amount])).toEqual([["out", "card", "1073.50"], ["in", "bank", "1000.00"], ["out", "bank", "500.00"]]);
    expect(await t.db.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, pays[0]!.id))).toHaveLength(1);
    expect(await t.db.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, pays[1]!.id))).toHaveLength(1);
    expect(await t.db.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, pays[2]!.id))).toHaveLength(0);
    const lines = await t.db.select().from(bankStatementLines).where(eq(bankStatementLines.clientId, t.c2.id)).orderBy(bankStatementLines.lineNo);
    expect(lines.map((l) => [l.category, !!l.paymentId])).toEqual([[null, true], ["fee", false], [null, true], [null, false]]);
    expect(r.lines.join("\n")).toMatch(/СЕТЕК ДОО 500.00 – без документ \(нераспоредено\): нема влезна фактура/);
    expect(r.lines.join("\n")).toMatch(/Нов партнер: Физичко Лице – без ЕДБ/);
    // postoeckiot dobavuvac (po EDB) dobiva uloga, ne se pravi nov
    const [kre] = await t.db.select().from(partners).where(eq(partners.edb, "4080014547370"));
    expect(kre!.isSupplier).toBe(true);

    // povtoren uvoz: nisto novo
    const again = await importDocs(t.db, file(), EDB, t.user.email, nbrm);
    expect(again.counts).toMatchObject({ items_new: 0, partners_new: 0, purchases_new: 0, purchases_existing: 2, sales_new: 0, sales_existing: 3,
      statements_new: 0, statements_existing: 1 });
  });

  it("pogresna firma ili nepoznat artikl: greska", async () => {
    await expect(importDocs(t.db, file(), "4030994180119", t.user.email, nbrm)).rejects.toThrow(/ЕДБ/);
    const bad = JSON.parse(file()); bad.docs[0].lines[0].itemCode = "NEMA";
    await expect(importDocs(t.db, JSON.stringify(bad), EDB, t.user.email, nbrm)).rejects.toThrow(/NEMA/);
  });
});
