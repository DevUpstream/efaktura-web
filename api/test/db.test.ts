import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { testDb } from "./helpers.js";
import { auditLog, invoiceLines, invoices, partnerPrices, items, ujpReasons, vatRates } from "../src/db/schema.js";
import { calcLine } from "../src/domain/calc.js";
import { issueInvoice, formatInvoiceNumber } from "../src/domain/issue.js";

type Ctx = Awaited<ReturnType<typeof testDb>>;
let t: Ctx;
beforeEach(async () => { t = await testDb(); });

async function draft(over: Partial<typeof invoices.$inferInsert> = {}, qty = 1, price = 270, sign: 1 | -1 = 1) {
  const [inv] = await t.db.insert(invoices).values({
    clientId: t.c1.id, partnerId: t.p1.id, year: 2026, issueDate: "2026-11-04", supplyDate: "2026-11-04", ...over,
  }).returning();
  await t.db.insert(invoiceLines).values({
    invoiceId: inv!.id, lineNo: 1, description: "Услуга", unit: "ком", qty: String(qty), unitPrice: String(price),
    vatRateId: t.vat18.id, vatRatePct: "18", ...calcLine({ qty, unitPrice: price, vatRatePct: 18 }, sign),
  });
  return inv!;
}
const actor = () => ({ userId: t.user.id });
/** Porakata od bazata (Drizzle ja pakuva vo err.cause). */
async function dbError(p: PromiseLike<unknown>): Promise<string> {
  try { await p; } catch (e) { const err = e as Error & { cause?: Error }; return err.cause?.message ?? err.message; }
  throw new Error("ocekuvav greska od bazata");
}

describe("migracii i pocetni podatoci", () => {
  it("DDV stapki i shifri na pricini", async () => {
    expect((await t.db.select().from(vatRates)).map((r) => r.code).sort()).toEqual(["E0", "NP", "R10", "R5", "S18", "Z0"]);
    expect((await t.db.select().from(ujpReasons)).length).toBe(5);
  });
});

describe("izdavanje i numeracija", () => {
  it("format na broj kako tekot v5", () => {
    expect(formatInvoiceNumber("MC", "INV", 2026, 1)).toBe("MC-2026-00001");
    expect(formatInvoiceNumber("UPSTRI", "OD", 2026, 12)).toBe("UPSTRI-OD-2026-00012");
  });

  it("MC-2026-00001: 270,00 + 48,60 = 318,60 -> 319, snimka na prodavac i kupuvac", async () => {
    const inv = await draft();
    const r = await issueInvoice(t.db, inv.id, actor());
    expect(r).toMatchObject({ status: "issued", number: "MC-2026-00001", seqNo: 1, netTotal: "270.00", vatTotal: "48.60",
      grossTotal: "318.60", payableAmount: "319.00", sellerEdb: "4030994180119", buyerName: "Купувач А", lineCount: 1 });
    expect((await t.db.select().from(auditLog)).map((a) => a.action)).toContain("issue");
  });

  it("posledovatelni broevi, poseben brojac po vid i po klient", async () => {
    const a = await issueInvoice(t.db, (await draft()).id, actor());
    const b = await issueInvoice(t.db, (await draft()).id, actor());
    const od = await issueInvoice(t.db, (await draft({ docType: "OD", relatedInvoiceId: a.id }, 1, 10, -1)).id, actor());
    expect([a.number, b.number, od.number]).toEqual(["MC-2026-00001", "MC-2026-00002", "MC-OD-2026-00001"]);
  });

  it("odbiva faktura bez stavki, bez datum na promet i dvojno izdavanje", async () => {
    const [empty] = await t.db.insert(invoices).values({ clientId: t.c1.id, partnerId: t.p1.id, year: 2026, issueDate: "2026-11-04" }).returning();
    await expect(issueInvoice(t.db, empty!.id, actor())).rejects.toThrow(/нема ставки.*датум на промет/);
    const inv = await draft();
    await issueInvoice(t.db, inv.id, actor());
    await expect(issueInvoice(t.db, inv.id, actor())).rejects.toThrow(/статус/);
  });

  it("storno ja oznacuva originalnata kako storniranа; vtoro storno ne e mozno", async () => {
    const a = await issueInvoice(t.db, (await draft()).id, actor());
    await issueInvoice(t.db, (await draft({ docType: "ST", relatedInvoiceId: a.id, voidReasonCode: "S-1" }, 1, 270, -1)).id, actor());
    const [orig] = await t.db.select().from(invoices).where(eq(invoices.id, a.id));
    expect(orig!.status).toBe("voided");
    const st2 = await draft({ docType: "ST", relatedInvoiceId: a.id, voidReasonCode: "S-1" }, 1, 270, -1);
    await expect(issueInvoice(t.db, st2.id, actor())).rejects.toThrow(/сторнирана/);
  });

  it("avans: najmnogu neiskoristeniot del", async () => {
    const av = await issueInvoice(t.db, (await draft({ docType: "AV", supplyDate: null }, 1, 100)).id, actor()); // 118.00
    const i1 = await draft({ advanceInvoiceId: av.id, advanceAmount: "100.00" });
    expect((await issueInvoice(t.db, i1.id, actor())).payableAmount).toBe("219.00");      // 319 - 100
    const i2 = await draft({ advanceInvoiceId: av.id, advanceAmount: "20.00" });
    await expect(issueInvoice(t.db, i2.id, actor())).rejects.toThrow(/неискористениот дел \(18.00\)/);
  });
});

describe("integritet vo bazata (triggeri)", () => {
  it("izdadena faktura ne se menuva i ne se brise; UJP polinjata smeat", async () => {
    const a = await issueInvoice(t.db, (await draft()).id, actor());
    expect(await dbError(t.db.update(invoices).set({ netTotal: "1.00" }).where(eq(invoices.id, a.id)))).toMatch(/не може да се менува/);
    expect(await dbError(t.db.update(invoices).set({ status: "draft" }).where(eq(invoices.id, a.id)))).toMatch(/нацрт/);
    expect(await dbError(t.db.delete(invoices).where(eq(invoices.id, a.id)))).toMatch(/не смее да се брише/);
    expect(await dbError(t.db.insert(invoiceLines).values({ invoiceId: a.id, lineNo: 2, description: "x", unit: "ком", qty: "1",
      unitPrice: "1", vatRateId: t.vat18.id, vatRatePct: "18", netAmount: "1", vatAmount: "0.18" }))).toMatch(/Ставките/);
    await t.db.update(invoices).set({ ujpId: "EUID-TEST-1", status: "sent_to_ujp" }).where(eq(invoices.id, a.id));
  });

  it("nacrt se brise zaedno so stavkite", async () => {
    const d = await draft();
    await t.db.delete(invoices).where(eq(invoices.id, d.id));
    expect(await t.db.select().from(invoiceLines)).toHaveLength(0);
  });

  it("kupuvac od drug klient e odbien od bazata", async () => {
    expect(await dbError(t.db.insert(invoices).values({ clientId: t.c1.id, partnerId: t.p2.id, year: 2026, issueDate: "2026-11-04" })))
      .toMatch(/invoices_partner_client_fk/);
  });

  it("dogovoreni ceni: periodite ne se preklopuvaat", async () => {
    const [it1] = await t.db.insert(items).values({ clientId: t.c1.id, code: "U1", name: "Услуга", unit: "ком", unitPrice: "100", vatRateId: t.vat18.id }).returning();
    const base = { clientId: t.c1.id, partnerId: t.p1.id, itemId: it1!.id, price: "90" };
    await t.db.insert(partnerPrices).values({ ...base, validFrom: "2026-01-01", validTo: "2026-06-30" });
    await t.db.insert(partnerPrices).values({ ...base, validFrom: "2026-07-01" });
    expect(await dbError(t.db.insert(partnerPrices).values({ ...base, validFrom: "2026-06-01", validTo: "2026-06-15" }))).toMatch(/преклопува/);
  });

  it("dnevnikot e samo za dodavanje", async () => {
    await issueInvoice(t.db, (await draft()).id, actor());
    expect(await dbError(t.db.update(auditLog).set({ action: "x" }))).toMatch(/само за додавање/);
    expect(await dbError(t.db.execute(sql`delete from audit_log`))).toMatch(/само за додавање/);
  });
});
