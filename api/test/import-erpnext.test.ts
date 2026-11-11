import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./helpers.js";
import * as s from "../src/db/schema.js";
import { importErpNext } from "../src/tools/import-erpnext.js";

/** Izmisleni podatoci vo formatot na scripts/erpnext-export.py. */
const p = (o: Record<string, unknown>) => ({ ref: "Customer:x", name: "X", edb: null, vatNumber: null, country: "MK", address: null, city: null, postalCode: null,
  email: null, phone: null, isCustomer: true, isSupplier: false, isActive: true, accounts: [], contacts: [], ...o });
const exp = (o: Record<string, unknown> = {}) => JSON.stringify({ format: "erpnext-masterdata/1", exportedAt: "2026-11-11T10:00:00+00:00",
  company: { name: "УПСТРЕАМ ДООЕЛ", edb: "4015023508550" }, warnings: [], ...o,
  partners: o.partners ?? [
    p({ ref: "Customer:A", name: "АЛФА ДООЕЛ", edb: "4000000000011", vatNumber: "MK4000000000011", address: "ул. Прва 1", city: "Скопје", postalCode: "1000",
      isSupplier: true, accounts: ["300000000011122", "200000000000163"], contacts: [{ name: "Петар Тест", role: "Набавка", phone: null, mobile: "+38970000001", email: "p@alfa.test", isPrimary: true }] }),
    p({ ref: "Customer:B", name: "Купувач Б", edb: "4000000000022", address: "ул. Втора 2", city: "Битола" }),
    p({ ref: "Supplier:C", name: "ГАМА ДОО", edb: "4000000000033", isCustomer: false, isSupplier: true, accounts: ["300000000099922"] }),
  ],
  items: o.items ?? [
    { ref: "T1", code: "T-001", name: "Тонер тест", type: "goods", unit: "ком", vatPct: 18, price: 1200, isActive: true },
    { ref: "L1", code: "L-001", name: "Лаптоп тест", type: "goods", unit: "ком", vatPct: 5, price: null, isActive: true },
    { ref: "S1", code: "S-001", name: "Сервис", type: "service", unit: "час", vatPct: 18, price: 900, isActive: true },
  ] });

describe("uvoz na shifrarnici od ERPNext", () => {
  it("novi partneri, smetki, kontakti, artikli; postoecki se dopolnuvaat; povtoren uvoz ne dodava nisto", async () => {
    const t = await testDb();
    await t.db.update(s.clients).set({ iban: "200-0000000001-63" }).where(eq(s.clients.id, t.c2.id));   // nasha smetka
    const [gama] = await t.db.insert(s.partners).values({ clientId: t.c2.id, name: "Гама", edb: "4000000000033", email: "stara@gama.test" }).returning();
    await t.db.insert(s.partnerAccounts).values({ clientId: t.c2.id, partnerId: t.p2.id, account: "300000000099922", source: "manual" });
    await t.db.insert(s.items).values({ clientId: t.c2.id, code: "t-001", name: "Стар тонер", unit: "ком", unitPrice: "999", vatRateId: t.vat18.id });

    const r = await importErpNext(t.db, exp(), "4015023508550");
    expect(r.counts).toMatchObject({ partners_new: 1, partners_updated: 2, accounts: 1, contacts: 1, items_new: 2, items_existing: 1 });
    expect(r.lines.join("\n")).toMatch(/200000000000163.*наша/);
    expect(r.lines.join("\n")).toMatch(/300000000099922.*веќе е на Купувач Б/);

    const ps = await t.db.select().from(s.partners).where(eq(s.partners.clientId, t.c2.id));
    const alfa = ps.find((x) => x.edb === "4000000000011")!;
    expect(alfa).toMatchObject({ name: "АЛФА ДООЕЛ", isCustomer: true, isSupplier: true, city: "Скопје", vatNumber: "MK4000000000011" });
    // Kupuvac B (bez EDB vo aplikacijata) e prepoznaen po naziv: se dopolnuva EDB, ne se pravi nov
    expect(ps.find((x) => x.id === t.p2.id)).toMatchObject({ edb: "4000000000022", city: "Битола", isCustomer: true });
    // postoeckiot ne se menuva (naziv, e-poshta), samo ulogata
    expect(ps.find((x) => x.id === gama!.id)).toMatchObject({ name: "Гама", email: "stara@gama.test", isSupplier: true });
    expect(await t.db.select().from(s.partnerContacts).where(eq(s.partnerContacts.partnerId, alfa.id))).toMatchObject([{ name: "Петар Тест", isPrimary: true }]);

    const its = await t.db.select().from(s.items).where(eq(s.items.clientId, t.c2.id));
    expect(its.find((i) => i.code === "t-001")).toMatchObject({ name: "Стар тонер", unitPrice: "999.0000" });
    const [r5] = await t.db.select().from(s.vatRates).where(eq(s.vatRates.code, "R5"));
    expect(its.find((i) => i.code === "L-001")).toMatchObject({ vatRateId: r5!.id, unitPrice: "0.0000", type: "goods" });
    expect(its.find((i) => i.code === "S-001")).toMatchObject({ type: "service", unit: "час", unitPrice: "900.0000" });
    // MC (druga firma) ne e dopirana
    expect(await t.db.select().from(s.partners).where(eq(s.partners.clientId, t.c1.id))).toHaveLength(1);

    const again = await importErpNext(t.db, exp(), "4015023508550");
    expect(again.counts).toMatchObject({ partners_new: 0, partners_updated: 0, accounts: 0, contacts: 0, items_new: 0 });
  });

  it("odbiva pogreshna firma i nepoznata DDV stapka", async () => {
    const t = await testDb();
    await expect(importErpNext(t.db, exp(), "4030994180119")).rejects.toThrow(/ЕДБ 4015023508550/);
    await expect(importErpNext(t.db, exp({ items: [{ ref: "X", code: "X", name: "X", type: "goods", unit: "ком", vatPct: 7, price: 1, isActive: true }] }), "4015023508550"))
      .rejects.toThrow(/ДДВ 7%/);
  });
});
