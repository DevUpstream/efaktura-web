import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./helpers.js";
import * as s from "../src/db/schema.js";
import { calcLine } from "../src/domain/calc.js";
import { issueInvoice } from "../src/domain/issue.js";
import { postPurchase } from "../src/domain/purchase.js";
import { bookCsv, kif, kuf } from "../src/domain/vatbooks.js";

describe("КИФ / КУФ", () => {
  it("стапки, сторно со минус, корекција = разлика, понуди и нацрти не; КУФ по датум на прием; CSV", async () => {
    const t = await testDb();
    const [r5] = await t.db.select().from(s.vatRates).where(eq(s.vatRates.code, "R5"));
    const mk = async (o: Partial<typeof s.invoices.$inferInsert>, lines: [number, number][]) => {
      const [i] = await t.db.insert(s.invoices).values({ clientId: t.c1.id, partnerId: t.p1.id, year: 2026, issueDate: "2026-10-05", supplyDate: "2026-10-05", ...o }).returning();
      for (const [n, [price, pct]] of lines.entries()) await t.db.insert(s.invoiceLines).values({ invoiceId: i!.id, lineNo: n + 1, description: "x", unit: "ком",
        qty: o.docType === "ST" ? "-1" : "1", unitPrice: String(price), vatRateId: pct === 5 ? r5!.id : t.vat18.id, vatRatePct: String(pct),
        ...calcLine({ qty: 1, unitPrice: price, vatRatePct: pct }, o.docType === "ST" ? -1 : 1) });
      return i!;
    };
    const a = await mk({}, [[1000, 18], [200, 5]]);
    await issueInvoice(t.db, a.id, { userId: t.user.id });
    await mk({}, [[999, 18]]);                                   // nacrt - ne
    const pf = await mk({ docType: "PF" }, [[50, 18]]); await issueInvoice(t.db, pf.id, { userId: t.user.id });   // ponuda - ne
    const b = await mk({}, [[100, 18]]); await issueInvoice(t.db, b.id, { userId: t.user.id });
    const reason = (await t.db.select().from(s.ujpReasons)).find((x) => x.kind === "void")!.code;
    const st = await mk({ docType: "ST", relatedInvoiceId: b.id, voidReasonCode: reason, correctionReason: "грешка", issueDate: "2026-10-20", supplyDate: "2026-10-20" }, [[100, 18]]);
    await issueInvoice(t.db, st.id, { userId: t.user.id });
    const corrReason = (await t.db.select().from(s.ujpReasons)).find((x) => x.kind === "correction")!.code;
    const kr = await mk({ docType: "KR", relatedInvoiceId: a.id, correctionReasonCode: corrReason, correctionReason: "цена", issueDate: "2026-11-02", supplyDate: "2026-10-05" }, [[1100, 18], [200, 5]]);
    await issueInvoice(t.db, kr.id, { userId: t.user.id });

    const oct = await kif(t.db, t.c1.id, "2026-10-01", "2026-10-31");
    expect(oct.rows.map((r) => [r.docType, r.base["18"], r.vat["18"], r.base["5"], r.total])).toEqual([
      ["INV", "1000.00", "180.00", "200.00", "1390.00"], ["INV", "100.00", "18.00", "0.00", "118.00"], ["ST", "-100.00", "-18.00", "0.00", "-118.00"]]);
    expect(oct.totals).toMatchObject({ count: 3, total: "1390.00" });
    const nov = await kif(t.db, t.c1.id, "2026-11-01", "2026-11-30");
    expect(nov.rows).toHaveLength(1);
    expect(nov.rows[0]).toMatchObject({ docType: "KR", base: { "18": "100.00", "5": "0.00" }, vat: { "18": "18.00" }, total: "118.00" });

    const [pi] = await t.db.insert(s.purchaseInvoices).values({ clientId: t.c1.id, partnerId: t.p1.id, year: 2026, supplierNumber: "D-7", issueDate: "2026-09-29", receivedDate: "2026-10-01" }).returning();
    await t.db.insert(s.purchaseLines).values({ purchaseInvoiceId: pi!.id, lineNo: 1, description: "y", unit: "ком", qty: "2", unitPrice: "50", vatRateId: t.vat18.id, vatRatePct: "18",
      ...calcLine({ qty: 2, unitPrice: 50, vatRatePct: 18 }) });
    await postPurchase(t.db, pi!.id, { userId: t.user.id }, false);
    const k = await kuf(t.db, t.c1.id, "2026-10-01", "2026-10-31");
    expect(k.rows[0]).toMatchObject({ supplierNumber: "D-7", issueDate: "2026-09-29", base: { "18": "100.00" }, vat: { "18": "18.00" }, total: "118.00" });
    expect((await kuf(t.db, t.c1.id, "2026-09-01", "2026-09-30")).rows).toHaveLength(0);

    const csv = bookCsv(oct).split("\r\n");
    expect(csv[0]!.startsWith("﻿Р.бр.;Датум на издавање;Датум на промет;Број;Вид;Купувач;ЕДБ;ДДВ број;Основица 18%;ДДВ 18%")).toBe(true);
    expect(csv[1]!.split(";").length).toBe(csv[0]!.split(";").length);
    expect(csv[4]).toBe("ВКУПНО;;;;;;;;1000,00;180,00;0,00;0,00;200,00;10,00;0,00;1390,00;");
    expect(bookCsv(k).split("\r\n")[2]!.split(";").length).toBe(bookCsv(k).split("\r\n")[0]!.split(";").length);
  });
});
