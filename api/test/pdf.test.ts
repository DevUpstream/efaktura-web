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

describe("povikuvanje na broj (docs/08)", () => {
  it("samo za izdadeni dokumenti sto se plakjaat; moze da se iskluci", async () => {
    const { paymentReference } = await import("../src/domain/pdf.js");
    const inv = { number: "MC-2026-00004", docType: "INV", status: "issued" };
    expect(paymentReference(inv, "1180", {})).toBe("MC-2026-00004");
    expect(paymentReference({ ...inv, status: "sent_to_ujp", docType: "AV" }, "500", {})).toBe("MC-2026-00004");
    expect(paymentReference({ ...inv, number: null, status: "draft" }, "1180", {})).toBeNull();
    expect(paymentReference({ ...inv, docType: "OD" }, "-100", {})).toBeNull();
    expect(paymentReference({ ...inv, docType: "ST" }, "-1180", {})).toBeNull();
    expect(paymentReference(inv, "0", {})).toBeNull();   // celosno platena so avans
    expect(paymentReference(inv, "1180", { showPaymentReference: false })).toBeNull();
  });
  it("izdadena faktura so povikuvanje se renderira", async () => {
    const b = await renderInvoicePdf({ inv: { ...inv, status: "issued", number: "UPSTRI-2026-00007" } as never, lines, client });
    expect(pages(b)).toBe(1);
  });
});
