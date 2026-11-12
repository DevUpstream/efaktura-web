/** Мапирање кон УЈП – истите вредности како Test-UjpMapping.ps1 (официјалните примери на УЈП). */
import { describe, it, expect } from "vitest";
import { checkUjpPayload, splitAddress, toUjpPayload, type UjpInvoiceIn, type UjpLineIn, type UjpParty } from "../src/domain/ujp-payload.js";

const party: UjpParty = { cCode: "MK", cName: "Северна Македонија", tin: "4030995135699", vatNumber: "МК4030995135699",
  name: "АКЦЕНТ Д.О.О.Е.Л. ЕКСПОРТ-ИМПОРТ СКОПЈЕ", street: "ОРЦЕ НИКОЛОВ", number: "133/Д3", postalCode: "1000", city: "СКОПЈЕ-ЦЕНТАР", email: null };
const inv = (o: Partial<UjpInvoiceIn> = {}): UjpInvoiceIn => ({ kind: "INV", number: "TA-2026-00001", docId: "1", issueDate: "2026-10-21", supplyDate: "2026-10-06",
  dueDate: "2026-11-05", currency: "MKD", paymentMethod: "cash", clauses: null, correctionReason: null, voidReasonCode: null, correctionReasonCode: null, ...o });
const L = (qty: number, price: number, vat: number, ind: string, grp: string, disc = 0): UjpLineIn =>
  ({ title: "TEST", itemCode: "OC-001", unit: "par.", qty, unitPrice: price, discountPct: disc, vatPct: vat, taxIndicator: ind, vatGroup: grp });
const ref = { euid: "01a15e7f-5e4e-7dcf-849e-ccbf9f65386d", date: "2026-10-21" };

describe("УЈП: мапирање (json_primeri_21.10.2026, primer_za_json_2)", () => {
  it("1) општа фактура 254,24 + 18 %", () => {
    const p = toUjpPayload(inv(), [L(1, 254.24, 18, "DDV-A", "DDV-A")], party, party, null);
    const i = p.document.docItems[0], t = p.document.docTotals;
    expect([i.docItemUnitVat, i.docItemTotalPriceWVat]).toEqual([45.7632, 300.0032]);
    expect(t).toMatchObject({ docNetAmount: 254.24, docVatAmount: 45.76, docGrossAmount: 300, docGrossAmountR: 300, docFinalAmount: 300 });
    expect(p.document.vatTotals[0].vatTotalAmount).toBe(300);
    expect(p.document.docPayment.docPaymentTypeCode).toBe("P10");
    expect(p.document.header.docType).toBe("100");
    expect("docItemTotalOriginalPriceWoVat" in i).toBe(false);   // E4018
    expect(checkUjpPayload(p, { net: 254.24, vat: 45.76, gross: 300 })).toEqual([]);
    expect(JSON.stringify(p)).toContain('"docGrossAmount":300,');
  });
  it("2) 18 % + 5 %: 667,50 -> 668; две групи", () => {
    const p = toUjpPayload(inv(), [L(1, 254.24, 18, "DDV-A", "DDV-A"), L(1, 350, 5, "DDV-B", "DDV-B")], party, party, null);
    expect(p.document.docTotals).toMatchObject({ docNetAmount: 604.24, docVatAmount: 63.26, docGrossAmount: 667.5, docGrossAmountR: 668 });
    expect(p.document.vatTotals).toHaveLength(2);
    expect(p.document.vatTotals[1].vatTotalAmount).toBe(367.5);
  });
  it("3) количина 2; 4) попуст 10 %", () => {
    const p3 = toUjpPayload(inv(), [L(2, 254.24, 18, "DDV-A", "DDV-A")], party, party, null);
    expect(p3.document.docTotals.docNetAmount).toBe(508.48);
    expect(p3.document.docItems[0]).toMatchObject({ docItemTotalVat: 91.5264, docItemTotalPriceWVat: 600.0064 });
    const p = toUjpPayload(inv(), [L(2, 1694.9153, 0, "DDV-G", "DDV-G", 10)], party, party, null);
    expect(p.document.docItems[0]).toMatchObject({ docItemUnitDiscountAmount: 169.4915, docItemUnitPriceWoVat: 1525.4238 });
    expect(p.document.docTotals).toMatchObject({ docNetAmount: 3389.83, docDiscountAmount: 338.98, docNetAmountDisc: 3050.85, docGrossAmountR: 3051 });
  });
  it("5) сторно: -29,99 / -5,40 / -35,39 / -35, без плаќање", () => {
    const p = toUjpPayload(inv({ kind: "ST", voidReasonCode: "S-1", correctionReason: "test" }), [L(-1, 29.99, 18, "DDV-A", "DDV-A")], party, party, ref, { void: { "S-1": "Погрешен купувач" } });
    const i = p.document.docItems[0], t = p.document.docTotals;
    expect([p.document.header.docStorno, p.document.header.docType, i.docItemQty, i.docItemUnitVat, i.docItemTotalPriceWVat]).toEqual([1, "100", -1, 5.3982, -35.3882]);
    expect([t.docVatAmount, t.docGrossAmount, t.docGrossAmountR]).toEqual([-5.4, -35.39, -35]);
    expect(p.document.docReferences[0]).toMatchObject({ docTypeRef: "ST", docNameRef: "Сторно" });
    expect(p.voidReason).toMatchObject({ voidCode: "S-1", voidReason: "Погрешен купувач" });
    expect(p.document.docPayment.docPaymentTypeCode).toBeNull();
    expect(checkUjpPayload(p, { gross: -35.39 }, 0.05, { void: { "S-1": "x" } })).toEqual([]);
    const p2 = toUjpPayload(inv({ kind: "ST" }), [L(-1, 29.99, 18, "DDV-A", "DDV-A")], party, party, ref);
    expect(checkUjpPayload(p2).join()).toMatch(/шифра на причина/);
  });
  it("6) книжно одобрение 110: позитивно кон УЈП; без EUID -> грешка", () => {
    const p = toUjpPayload(inv({ kind: "OD" }), [L(-1, 589, 18, "DDV-A", "DDV-A")], party, party, { euid: "e", date: "2026-08-12" });
    expect(p.document.header.docType).toBe("110");
    expect(p.document.docItems[0].docItemQty).toBe(1);
    expect(p.document.docTotals).toMatchObject({ docVatAmount: 106.02, docGrossAmount: 695.02, docGrossAmountR: 695 });
    expect(p.document.docReferences[0].docTypeRef).toBe("SYS");
    expect(checkUjpPayload(p, { net: -589, vat: -106.02, gross: -695.02 })).toEqual([]);
    expect(() => toUjpPayload(inv({ kind: "OD" }), [L(-1, 589, 18, "DDV-A", "DDV-A")], party, party, null)).toThrow(/EUID/);
  });
  it("6b) корекција KR/C02; 6c) авансна 130; 6d) одбиен аванс", () => {
    const k = toUjpPayload(inv({ kind: "KR", correctionReasonCode: "C02", correctionReason: "test" }), [L(2, 254.24, 18, "DDV-A", "DDV-A")], party, party,
      { euid: "01a15e8a-8136-7d08-9703-e85ce5a206d5", date: "2026-10-21" }, { correction: { C02: "Грешка во количина" } });
    expect([k.document.header.docStorno, k.document.docReferences[0].docTypeRef, k.document.docReferences[0].docNameRef]).toEqual([2, "KR", "Корекција"]);
    expect(k.document.docTotals).toMatchObject({ docVatAmount: 91.53, docGrossAmount: 600.01, docGrossAmountR: 600 });
    expect(k.correctionReason).toMatchObject({ correctionReason: "Грешка во количина" });
    expect(k.voidReason).toBeUndefined();
    expect(checkUjpPayload(k, { gross: 600.01, payable: 600 }, 0.05, { correction: { C02: "x" } })).toEqual([]);
    expect(checkUjpPayload(toUjpPayload(inv({ kind: "KR" }), [L(2, 254.24, 18, "DDV-A", "DDV-A")], party, party, ref)).join()).toMatch(/шифра на причина/);
    const a = toUjpPayload(inv({ kind: "AV" }), [L(1, 589, 18, "DDV-A", "DDV-A")], party, party, null);
    expect([a.document.header.docType, a.document.header.docTurnoverDate, a.document.docTotals.docGrossAmountR, a.document.docReferences.length]).toEqual(["130", null, 695, 0]);
    expect(checkUjpPayload(a)).toEqual([]);
    const f = toUjpPayload(inv({ advanceAmount: 100, advanceDate: "2026-10-01", advanceDesc: "TA-AV-2026-00001" }), [L(1, 1500, 18, "DDV-A", "DDV-A")], party, party, null);
    expect(f.document.docTotals).toMatchObject({ docGrossAmountR: 1770, docAvansAmount: 100, docFinalAmount: 1670, docAvansDesc: "TA-AV-2026-00001", docAvansDate: "2026-10-01" });
    expect(checkUjpPayload(f, { gross: 1770, payable: 1670 })).toEqual([]);
    const g = toUjpPayload(inv({ advanceAmount: 2000, advanceDate: "2026-10-01", advanceDesc: "x" }), [L(1, 1500, 18, "DDV-A", "DDV-A")], party, party, null);
    expect(checkUjpPayload(g).join()).toMatch(/Авансот е поголем/);
  });
  it("7) проверки и адреса", () => {
    const p = toUjpPayload(inv(), [L(1, 100, 18, "", "DDV-A")], party, { ...party, number: "" }, null);
    const pr = checkUjpPayload(p, { gross: 120 }).join("\n");
    expect(pr).toMatch(/даночен индикатор/); expect(pr).toMatch(/Купувач: адресата нема број/); expect(pr).toMatch(/Вкупно кај нас/);
    expect(() => toUjpPayload(inv(), [{ ...L(1, 100, 18, "DDV-11-A", "DDV-A"), vatImpact: "PRENESEN" }], party, party, null)).toThrow(/пренесена/);
    expect(splitAddress("ул. Тестна бр. 1")).toEqual({ street: "ул. Тестна", number: "1" });
    expect(splitAddress("ул. Тестна бр. 1, Скопје")).toEqual({ street: "ул. Тестна", number: "1" });
    expect(splitAddress("Орце Николов 133/Д3")).toEqual({ street: "Орце Николов", number: "133/Д3" });
    expect(splitAddress("Нерезинска бб")).toEqual({ street: "Нерезинска", number: "бб" });
    const w: string[] = [];
    expect(checkUjpPayload(toUjpPayload(inv(), [L(1, 100, 18, "DDV-A", "DDV-A")], party, { ...party, number: "" }, null), undefined, 0.05, {}, w)).toEqual([]);
    expect(w.join()).toMatch(/Купувач: адресата нема број/);
    expect(checkUjpPayload(toUjpPayload(inv({ currency: "EUR" }), [L(1, 100, 18, "DDV-A", "DDV-A")], party, party, null)).join()).toMatch(/MKD/);
  });
});
