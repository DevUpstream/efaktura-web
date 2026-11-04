import { describe, it, expect } from "vitest";
import { renderInvoicePdf } from "../src/domain/pdf.js";
import { mk, client, inv, lines } from "./pdf-fixture.js";

const pages = (b: Buffer) => (b.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

describe("PDF faktura (format UPSTREAM 2026/10/11)", () => {
  it("primerot e edna strana, validen PDF so vgradeni fontovi", async () => {
    const b = await renderInvoicePdf({ inv, lines, client, itemCodes: { 1: "TD4520", 2: "ET5070" } });
    expect(b.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pages(b)).toBe(1);
    expect(b.toString("latin1")).toContain("OpenSans");
  });
  it("40 stavki -> povekje strani so header", async () => {
    const many = Array.from({ length: 40 }, (_, i) => mk(i + 1, 1, `Ставка ${i + 1} со подолг опис за проверка на прекршување`, "ком", 1, "100", 18));
    expect(pages(await renderInvoicePdf({ inv, lines: many, client }))).toBeGreaterThan(1);
  });
  it("nacrt, storno i avans bez greska; bez PDF postavki se koristat osnovnite podatoci", async () => {
    const bare = { ...client, pdfSettings: null, invoiceClauses: null, iban: "200000000000000", bankName: "Банка" };
    for (const v of [{ ...inv, number: null }, { ...inv, docType: "ST", correctionReason: "Погрешен купувач", voidReasonCode: "S-1" },
      { ...inv, advanceAmount: "1000.00" }]) {
      expect(pages(await renderInvoicePdf({ inv: v as never, lines, client: bare, relatedNumber: "UPSTRI-2026-00001", relatedDate: "2026-10-30" }))).toBe(1);
    }
  });
});
