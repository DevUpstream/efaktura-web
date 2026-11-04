import { describe, it, expect } from "vitest";
import { calcLine, calcTotals, round } from "../src/domain/calc.js";

describe("calc - isti pravila kako Power Apps i agentot", () => {
  it("DryRun MC-2026-00001: 270,00 + 48,60 = 318,60 -> 319", () => {
    const l = calcLine({ qty: 1, unitPrice: 270, vatRatePct: 18 });
    const t = calcTotals([{ ...l, vatRatePct: 18 }]);
    expect(t).toMatchObject({ netTotal: "270.00", vatTotal: "48.60", grossTotal: "318.60", payableAmount: "319.00" });
  });

  it("zaokruzuva away from zero (i za negativni)", () => {
    expect(round("2.5", 0).toString()).toBe("3");
    expect(round("-2.5", 0).toString()).toBe("-3");
    expect(round("1.00005", 4).toString()).toBe("1.0001");
  });

  it("popust i DDV po edinica na 4 decimali", () => {
    // 3 x 33.3333, popust 10% -> edinica 33.3333 - 3.3333 = 30.0000; DDV 18% = 5.4000
    const l = calcLine({ qty: 3, unitPrice: "33.3333", discountPct: 10, vatRatePct: 18 });
    expect(l).toEqual({ unitNet: "30.0000", netAmount: "90.0000", vatAmount: "16.2000" });
  });

  it("nema float greski (0.1 + 0.2)", () => {
    const a = calcLine({ qty: "0.1", unitPrice: 1, vatRatePct: 0 });
    const b = calcLine({ qty: "0.2", unitPrice: 1, vatRatePct: 0 });
    expect(calcTotals([{ ...a, vatRatePct: 0 }, { ...b, vatRatePct: 0 }]).netTotal).toBe("0.30");
  });

  it("knizno odobrenie (sign -1) dava negativni iznosi", () => {
    const l = calcLine({ qty: 2, unitPrice: 100, vatRatePct: 18 }, -1);
    expect(l).toMatchObject({ netAmount: "-200.0000", vatAmount: "-36.0000" });
    expect(calcTotals([{ ...l, vatRatePct: 18 }]).payableAmount).toBe("-236.00");
  });

  it("zaglavjeto e zbir na NEZAOKRUZENI stavki, pa 2 decimali; avans se odbiva od zaokruzeniot iznos", () => {
    const lines = [1, 2, 3].map(() => ({ ...calcLine({ qty: 1, unitPrice: "0.0049", vatRatePct: 18 }), vatRatePct: 18 }));
    const t = calcTotals(lines, "100.00");
    expect(t.netTotal).toBe("0.01");          // 0.0147 -> 0.01 (a ne 3 x 0.00)
    expect(t.payableAmount).toBe("-100.00");  // round(0.01,0)=0 - 100
  });

  it("grupi po DDV stapka", () => {
    const t = calcTotals([
      { ...calcLine({ qty: 1, unitPrice: 100, vatRatePct: 18 }), vatRatePct: 18 },
      { ...calcLine({ qty: 1, unitPrice: 100, vatRatePct: 5 }), vatRatePct: 5 },
      { ...calcLine({ qty: 1, unitPrice: 50, vatRatePct: 18 }), vatRatePct: 18 },
    ]);
    expect(t.byRate).toEqual([
      { vatRatePct: "18.00", net: "150.00", vat: "27.00" },
      { vatRatePct: "5.00", net: "100.00", vat: "5.00" },
    ]);
  });
});
