import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { testDb } from "./helpers.js";
import * as s from "../src/db/schema.js";
import { importErpFiles, importErpPurchases } from "../src/tools/import-erpnext-docs.js";

const EDB = "4015023508550";
/** Izmisleni podatoci vo formatot na scripts/erpnext-export.py --purchases. */
const line = (o: Record<string, unknown>) => ({ itemCode: null, description: "Тонер", unit: "ком", qty: 2, unitPrice: 500, net: 1000, vatPct: 18, ...o });
const pur = (o: Record<string, unknown>) => ({ ref: "ACC-PINV-2025-00001", supplierRef: "ДОБ А", supplierEdb: "4000000000033", supplierName: "ДОБ А ДОО",
  supplierNumber: "F-1", issueDate: "2025-03-01", receivedDate: "2025-03-02", dueDate: "2025-04-01", net: 1000, vat: 180, gross: 1180, payable: 1180,
  lines: [line({})], ...o });
const doc = (purchases: unknown[], payments: unknown[] = []) => JSON.stringify({ format: "erpnext-purchases/1", exportedAt: "2026-11-11T10:00:00Z",
  company: { edb: EDB }, purchases, payments });

describe("uvoz na vlezni fakturi od ERPNext", () => {
  it("knizi bez zaliha po red na datum, plakjanja so raspored, prilozi; povtorno ne dodava", async () => {
    const t = await testDb();
    const [sup] = await t.db.insert(s.partners).values({ clientId: t.c2.id, name: "Доб А", edb: "4000000000033" }).returning();
    await t.db.insert(s.items).values({ clientId: t.c2.id, code: "T-1", name: "Тонер", type: "goods", unit: "ком", unitPrice: "0", vatRateId: t.vat18.id });
    const json = doc([
      pur({ ref: "ACC-PINV-2026-00001", supplierNumber: "F-3", issueDate: "2026-01-05", receivedDate: "2026-01-05", lines: [line({ itemCode: "t-1" })] }),
      pur({}),
      pur({ ref: "ACC-PINV-2025-00002", supplierNumber: "F-2", receivedDate: "2025-05-01", net: 500, vat: 25, gross: 525, payable: 525,
        lines: [line({ qty: 1, unitPrice: 500, net: 500, vatPct: 5 })] }),
      pur({ ref: "ACC-PINV-2025-00003", supplierNumber: "F-4", receivedDate: "2025-06-01", net: 300, vat: 0, gross: 300, payable: 300,
        lines: [line({ qty: 1, unitPrice: 300, net: 300, vatPct: 0 })] }),
    ], [{ ref: "ACC-PAY-1", supplierRef: "ДОБ А", date: "2025-04-01", amount: 1180, reference: "извод 5",
      allocations: [{ ref: "ACC-PINV-2025-00001", amount: 1180 }] }]);
    const r = await importErpPurchases(t.db, json, EDB, "dev@upstream.mk");
    expect(r.counts).toMatchObject({ purchases_new: 4, payments_new: 1, purchases_skipped: 0 });
    const ps = await t.db.select().from(s.purchaseInvoices).where(eq(s.purchaseInvoices.clientId, t.c2.id));
    const by = (ref: string) => ps.find((p) => (p.sourceJson as { erpnext: string }).erpnext === ref)!;
    expect(by("ACC-PINV-2025-00001")).toMatchObject({ status: "posted", number: "UPSTRI-VF-2025-00001", source: "erpnext", grossTotal: "1180.00", partnerId: sup!.id });
    expect(by("ACC-PINV-2025-00002").number).toBe("UPSTRI-VF-2025-00002");
    expect(by("ACC-PINV-2026-00001").number).toBe("UPSTRI-VF-2026-00001");
    const [np] = await t.db.select().from(s.vatRates).where(eq(s.vatRates.code, "NP"));
    const [l0] = await t.db.select().from(s.purchaseLines).where(eq(s.purchaseLines.purchaseInvoiceId, by("ACC-PINV-2025-00003").id));
    expect(l0).toMatchObject({ vatRateId: np!.id, vatAmount: "0.0000" });
    const [l1] = await t.db.select().from(s.purchaseLines).where(eq(s.purchaseLines.purchaseInvoiceId, by("ACC-PINV-2026-00001").id));
    expect(l1!.itemId).not.toBeNull();
    // bez zaliha
    expect((await t.db.select().from(s.stockDocs)).length).toBe(0);
    // platena e samo prvata; dobavuvacot dobiva uloga
    const open = await t.db.execute(sql`select pi.supplier_number n, pi.gross_total - coalesce((select sum(a.amount) from payment_allocations a where a.purchase_invoice_id = pi.id), 0) o from purchase_invoices pi order by n`);
    expect(((open as { rows?: unknown[] }).rows ?? open) as unknown[]).toMatchObject([{ n: "F-1", o: "0.00" }, { n: "F-2", o: "525.00" }, { n: "F-3", o: "1180.00" }, { n: "F-4", o: "300.00" }]);
    expect((await t.db.select().from(s.partners).where(eq(s.partners.id, sup!.id)))[0]!.isSupplier).toBe(true);

    const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
    const files = JSON.stringify({ format: "erpnext-files/1", company: { edb: EDB }, files: [
      { purchaseRef: "ACC-PINV-2025-00001", fileName: "f1.pdf", data: pdf }, { purchaseRef: "ACC-PINV-2025-00009", fileName: "x.pdf", data: pdf },
      { purchaseRef: "ACC-PINV-2025-00002", fileName: "bad.txt", data: Buffer.from("hello").toString("base64") }] });
    const f = await importErpFiles(t.db, files, EDB, "dev@upstream.mk");
    expect(f.counts).toMatchObject({ files_new: 1, files_skipped: 2 });
    expect((await importErpFiles(t.db, files, EDB, "dev@upstream.mk")).counts).toMatchObject({ files_new: 0, files_existing: 1 });

    const again = await importErpPurchases(t.db, json, EDB, "dev@upstream.mk");
    expect(again.counts).toMatchObject({ purchases_new: 0, purchases_existing: 4, payments_new: 0, payments_existing: 1 });
  });

  it("rachno vnesena ista faktura i nepoznat dobavuvac se preskoknuvaat; pogreshna firma se odbiva", async () => {
    const t = await testDb();
    const [sup] = await t.db.insert(s.partners).values({ clientId: t.c2.id, name: "Доб А", edb: "4000000000033", isSupplier: true }).returning();
    await t.db.insert(s.purchaseInvoices).values({ clientId: t.c2.id, partnerId: sup!.id, year: 2025, supplierNumber: "F-1", issueDate: "2025-03-01", receivedDate: "2025-03-02" });
    const r = await importErpPurchases(t.db, doc([pur({}), pur({ ref: "X", supplierEdb: "4000000000099", supplierName: "Непознат" })]), EDB, "dev@upstream.mk");
    expect(r.counts).toMatchObject({ purchases_new: 0, purchases_skipped: 2 });
    expect(r.lines.join("\n")).toMatch(/F-1.*веќе внесена/);
    expect((await t.db.select().from(s.purchaseInvoices).where(and(eq(s.purchaseInvoices.clientId, t.c2.id), eq(s.purchaseInvoices.source, "erpnext")))).length).toBe(0);
    await expect(importErpPurchases(t.db, doc([]), "4030994180119", "dev@upstream.mk")).rejects.toThrow(/ЕДБ 4015023508550/);
  });
});
