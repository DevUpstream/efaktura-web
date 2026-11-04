import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as s from "../src/db/schema.js";
import type { Db } from "../src/db/types.js";
import { importSharePoint } from "../src/tools/import-sp.js";
import { issueInvoice } from "../src/domain/issue.js";

const json = readFileSync("test/fixtures/sp-export.json", "utf8");
async function emptyDb() {
  const raw = drizzle(new PGlite(), { schema: s });
  await migrate(raw, { migrationsFolder: "drizzle" });
  return raw as unknown as Db;
}

describe("uvoz od SharePoint (vistinski izvoz od 04.11.2026)", () => {
  it("bez test klienti: MC i UPSTRI, MC-2026-00001 = 270 + 48,60 = 318,60 -> 319", async () => {
    const db = await emptyDb();
    const r = await importSharePoint(db, json);
    expect(r.counts).toMatchObject({ clients: 2, partners: 2, items: 1, invoices: 1, invoice_lines: 1, ujp_reasons: 13, client_access: 4 });
    const [inv] = await db.select().from(s.invoices);
    expect(inv).toMatchObject({ number: "MC-2026-00001", status: "issued", seqNo: 1, netTotal: "270.00", vatTotal: "48.60",
      grossTotal: "318.60", payableAmount: "319.00", buyerEdb: "4001235555678", sellerEdb: "4030994180119" });
    const users = await db.select().from(s.users);
    expect(users.every((u) => u.provider === "entra" && u.role === "accountant")).toBe(true);
    // sledniot broj prodolzuva od SharePoint
    const [mc] = await db.select().from(s.clients).where(eq(s.clients.invoicePrefix, "MC"));
    const [c] = await db.select().from(s.counters).where(eq(s.counters.clientId, mc!.id));
    expect(c).toMatchObject({ docType: "INV", year: 2026, lastNo: 1 });
  });

  it("so test klienti: site 12 fakturi (avans, korekcija, storno, odobrenie) se sovpagjaat; povtoren uvoz e odbien", async () => {
    const db = await emptyDb();
    const r = await importSharePoint(db, json, { includeTest: true });
    expect(r.counts.invoices).toBe(12);
    const byNo = new Map((await db.select().from(s.invoices)).map((i) => [i.number, i]));
    expect(byNo.get("TA-2026-00001")!.status).toBe("voided");
    expect(byNo.get("TA-2026-00003")!.status).toBe("corrected");
    expect(byNo.get("TA-2026-00004")).toMatchObject({ advanceAmount: "1416.00", payableAmount: "1416.00" });
    expect(byNo.get("TA-OD-2026-00001")!.relatedInvoiceId).toBe(byNo.get("TA-2026-00002")!.id);
    const [line] = await db.select().from(s.invoiceLines).where(eq(s.invoiceLines.invoiceId, byNo.get("TA-2026-00002")!.id));
    expect(line!.vatAmount).toBe("169.0875");          // 4 decimali (SharePoint: 169.09)
    await expect(importSharePoint(db, json, { includeTest: true })).rejects.toThrow(/vekje postoi/);
  });

  it("po uvozot novata faktura dobiva sleden broj (MC-2026-00002)", async () => {
    const db = await emptyDb();
    await importSharePoint(db, json);
    const [mc] = await db.select().from(s.clients).where(eq(s.clients.invoicePrefix, "MC"));
    const [p] = await db.select().from(s.partners).where(eq(s.partners.clientId, mc!.id));
    const [u] = await db.select().from(s.users);
    const [vat] = await db.select().from(s.vatRates).where(eq(s.vatRates.code, "S18"));
    const [d] = await db.insert(s.invoices).values({ clientId: mc!.id, partnerId: p!.id, year: 2026, issueDate: "2026-11-05", supplyDate: "2026-11-05" }).returning();
    await db.insert(s.invoiceLines).values({ invoiceId: d!.id, lineNo: 1, description: "x", unit: "ком", qty: "1", unitPrice: "100",
      vatRateId: vat!.id, vatRatePct: "18", netAmount: "100", vatAmount: "18" });
    expect((await issueInvoice(db, d!.id, { userId: u!.id })).number).toBe("MC-2026-00002");
  });
});
