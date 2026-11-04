import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { clientAccess, invoices, items, partnerPrices, partners, users } from "../src/db/schema.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";

let t: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let admin: string, ana: string;   // kolacinja

beforeEach(async () => {
  t = await testDb();
  app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64") });
  await t.db.update(users).set({ provider: "entra", passwordHash: null }).where(eq(users.id, t.user.id));
  admin = `${SESSION_COOKIE}=${await createSession(t.db, t.user.id, true, {})}`;
  const [a] = await t.db.insert(users).values({ email: "ana@x.mk", displayName: "Ана", provider: "entra", role: "accountant" }).returning();
  await t.db.insert(clientAccess).values({ clientId: t.c1.id, userId: a!.id });
  ana = `${SESSION_COOKIE}=${await createSession(t.db, a!.id, true, {})}`;
});

const call = async (cookie: string, method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, payload: payload as never, headers: { cookie, ...(method === "GET" ? {} : { "x-efaktura": "1" }) } });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};

describe("pristap po klient", () => {
  it("smetkovoditelot ne gi gleda tugite klienti (404, ne 403)", async () => {
    expect((await call(ana, "GET", `/api/clients/${t.c1.id}/partners`)).status).toBe(200);
    expect((await call(ana, "GET", `/api/clients/${t.c2.id}/partners`)).status).toBe(404);
    expect((await call(ana, "GET", `/api/clients/${t.c2.id}/invoices`)).status).toBe(404);
  });
});

describe("kupuvaci i artikli", () => {
  it("dodavanje, dupli EDB, zakluceni polinja po UJP ✓", async () => {
    const p = await call(ana, "POST", `/api/clients/${t.c1.id}/partners`, { name: "Нов купувач", edb: "4001235555679", city: "Скопје" });
    expect(p.status).toBe(201);
    expect((await call(ana, "POST", `/api/clients/${t.c1.id}/partners`, { name: "Друг", edb: "4001235555679" })).status).toBe(409);
    expect((await call(ana, "POST", `/api/clients/${t.c1.id}/partners`, { name: "Лош", edb: "123" })).status).toBe(400);
    await t.db.update(partners).set({ ujpRegistryAt: new Date() }).where(eq(partners.id, p.body.id));
    expect((await call(ana, "PATCH", `/api/clients/${t.c1.id}/partners/${p.body.id}`, { name: "Сменето" })).status).toBe(409);
    expect((await call(ana, "PATCH", `/api/clients/${t.c1.id}/partners/${p.body.id}`, { email: "a@b.mk" })).status).toBe(200);
  });

  it("artikl: cena na 4 decimali, dupla shifra", async () => {
    const r = await call(ana, "POST", `/api/clients/${t.c1.id}/items`, { code: "U1", name: "Услуга", unit: "час", unitPrice: 1500.5, vatRateId: t.vat18.id });
    expect(r.body.unitPrice).toBe("1500.5000");
    expect((await call(ana, "POST", `/api/clients/${t.c1.id}/items`, { code: "U1", name: "Друго", unit: "час", unitPrice: 1, vatRateId: t.vat18.id })).status).toBe(409);
  });
});

describe("fakturi preku API", () => {
  async function item(code = "U1", price = "100") {
    const [it] = await t.db.insert(items).values({ clientId: t.c1.id, code, name: "Услуга " + code, unit: "ком", unitPrice: price, vatRateId: t.vat18.id }).returning();
    return it!;
  }
  const line = (itemId: number, qty = 3, unitPrice = 100, discountPct = 10) =>
    ({ itemId, description: "Тест", unit: "ком", qty, unitPrice, discountPct, vatRateId: t.vat18.id });

  it("nacrt -> zacuvaj -> izdaj: serverot presmetuva (DryRun MC: 3 x 100, -10% = 270 + 48,60 = 319)", async () => {
    const it = await item();
    const c = await call(ana, "POST", `/api/clients/${t.c1.id}/invoices`, { partnerId: t.p1.id, issueDate: "2026-11-05", lines: [line(it.id, 1, 50, 0)] });
    expect(c.status).toBe(201);
    let d = (await call(ana, "GET", `/api/invoices/${c.body.id}`)).body;
    expect(d).toMatchObject({ status: "draft", netTotal: "50.00", supplyDate: "2026-11-05", number: null });

    // zacuvaj so pogresna verzija -> konflikt
    expect((await call(ana, "PUT", `/api/invoices/${d.id}`, { partnerId: t.p1.id, issueDate: "2026-11-05", lines: [line(it.id)], version: 99 })).status).toBe(409);
    expect((await call(ana, "PUT", `/api/invoices/${d.id}`, { partnerId: t.p1.id, issueDate: "2026-11-05", lines: [line(it.id)], version: d.version })).status).toBe(200);
    d = (await call(ana, "GET", `/api/invoices/${d.id}`)).body;
    expect(d).toMatchObject({ netTotal: "270.00", vatTotal: "48.60", grossTotal: "318.60", payableAmount: "319.00", lineCount: 1 });
    expect(d.lines[0]).toMatchObject({ netAmount: "270.0000", vatAmount: "48.6000", vatRatePct: "18.00" });

    const iss = await call(ana, "POST", `/api/invoices/${d.id}/issue`);
    expect(iss.body).toMatchObject({ number: "MC-2026-00001", status: "issued" });
    expect((await call(ana, "PUT", `/api/invoices/${d.id}`, { partnerId: t.p1.id, issueDate: "2026-11-05", lines: [] })).status).toBe(409);
    expect((await call(ana, "POST", `/api/invoices/${d.id}/cancel`)).status).toBe(409);

    const list = (await call(ana, "GET", `/api/clients/${t.c1.id}/invoices?year=2026`)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ number: "MC-2026-00001", buyerName: "Купувач А", grossTotal: "318.60" });
  });

  it("kupuvac ili artikl od drug klient e odbien", async () => {
    const it = await item();
    expect((await call(admin, "POST", `/api/clients/${t.c1.id}/invoices`, { partnerId: t.p2.id, issueDate: "2026-11-05", lines: [] })).status).toBe(422);
    const [foreign] = await t.db.insert(items).values({ clientId: t.c2.id, code: "Z", name: "Туѓ", unit: "ком", unitPrice: "1", vatRateId: t.vat18.id }).returning();
    expect((await call(admin, "POST", `/api/clients/${t.c1.id}/invoices`, { partnerId: t.p1.id, issueDate: "2026-11-05", lines: [line(foreign!.id)] })).status).toBe(422);
    expect(it.id).toBeGreaterThan(0);
  });

  it("otkazuvanje nacrt", async () => {
    const c = await call(ana, "POST", `/api/clients/${t.c1.id}/invoices`, { partnerId: t.p1.id, issueDate: "2026-11-05", lines: [] });
    expect((await call(ana, "POST", `/api/invoices/${c.body.id}/cancel`)).status).toBe(200);
    const [inv] = await t.db.select().from(invoices).where(eq(invoices.id, c.body.id));
    expect(inv!.status).toBe("cancelled_draft");
  });

  it("predlog-cena: dogovorena > posledna > standardna", async () => {
    const it = await item("U2", "100");
    const url = `/api/clients/${t.c1.id}/price?partnerId=${t.p1.id}&itemId=${it.id}&date=2026-11-05`;
    expect((await call(ana, "GET", url)).body).toEqual({ price: "100.0000", source: "Стандардна цена" });
    const c = await call(ana, "POST", `/api/clients/${t.c1.id}/invoices`, { partnerId: t.p1.id, issueDate: "2026-11-01", lines: [line(it.id, 1, 95, 0)] });
    await call(ana, "POST", `/api/invoices/${c.body.id}/issue`);
    expect((await call(ana, "GET", url)).body).toEqual({ price: "95.0000", source: "Последна цена за купувачот (01.11.2026)" });
    await t.db.insert(partnerPrices).values({ clientId: t.c1.id, partnerId: t.p1.id, itemId: it.id, price: "90", validFrom: "2026-11-02" });
    expect((await call(ana, "GET", url)).body).toEqual({ price: "90.0000", source: "Договорена цена (од 02.11.2026)" });
  });
});

describe("povrzani dokumenti (pravila od tekot v5)", () => {
  async function issued(price = 100, qty = 2) {
    const [it] = await t.db.insert(items).values({ clientId: t.c1.id, code: "P" + price + qty, name: "Производ", unit: "ком", unitPrice: String(price), vatRateId: t.vat18.id }).returning();
    const c = await call(ana, "POST", `/api/clients/${t.c1.id}/invoices`, { partnerId: t.p1.id, issueDate: "2026-11-05",
      lines: [{ itemId: it!.id, description: "Производ", unit: "ком", qty, unitPrice: price, discountPct: 0, vatRateId: t.vat18.id }] });
    await call(ana, "POST", `/api/invoices/${c.body.id}/issue`);
    return (await call(ana, "GET", `/api/invoices/${c.body.id}`)).body;
  }
  const save = async (d: { id: number; partnerId: number; issueDate: string; version: number; lines: { itemId: number; description: string; unit: string; qty: string; unitPrice: string; discountPct: string; vatRateId: number }[] }, extra: Record<string, unknown> = {}, qtyOverride?: number) =>
    call(ana, "PUT", `/api/invoices/${d.id}`, { partnerId: d.partnerId, issueDate: d.issueDate, version: d.version,
      lines: d.lines.map((l) => ({ ...l, qty: qtyOverride ?? Math.abs(Number(l.qty)), unitPrice: Number(l.unitPrice), discountPct: Number(l.discountPct) })), ...extra });

  it("storno: tocna kopija so minus, bara pricina i S-shifra, originalot -> storniran", async () => {
    const o = await issued();                                             // 200 + 36 = 236
    const st = await call(ana, "POST", `/api/invoices/${o.id}/derive`, { docType: "ST" });
    let d = (await call(ana, "GET", `/api/invoices/${st.body.id}`)).body;
    expect(d).toMatchObject({ docType: "ST", relatedNumber: "MC-2026-00001", grossTotal: "-236.00" });
    expect(d.lines[0].qty).toBe("-2.000");
    expect((await call(ana, "POST", `/api/invoices/${d.id}/issue`)).body.message).toMatch(/причина/);
    await save(d, { voidReasonCode: "S-1", correctionReason: "Погрешен купувач" }, 1);   // kolicinata se ignorira kaj storno
    d = (await call(ana, "GET", `/api/invoices/${d.id}`)).body;
    expect(d.grossTotal).toBe("-236.00");
    expect((await call(ana, "POST", `/api/invoices/${d.id}/issue`)).body).toMatchObject({ number: "MC-ST-2026-00001" });
    expect((await call(ana, "GET", `/api/invoices/${o.id}`)).body.status).toBe("voided");
  });

  it("odobrenie: zbirot na odobrenija ne smee da ja nadmine fakturata; po odobrenie nema storno", async () => {
    const o = await issued();
    const od1 = (await call(ana, "POST", `/api/invoices/${o.id}/derive`, { docType: "OD" })).body.id;
    let d = (await call(ana, "GET", `/api/invoices/${od1}`)).body;
    await save(d, { correctionReason: "Вратена 1 ставка" }, 1);
    expect((await call(ana, "POST", `/api/invoices/${od1}/issue`)).body.number).toBe("MC-OD-2026-00001");
    const od2 = (await call(ana, "POST", `/api/invoices/${o.id}/derive`, { docType: "OD" })).body.id;
    d = (await call(ana, "GET", `/api/invoices/${od2}`)).body;
    await save(d, { correctionReason: "Уште" }, 2);                       // 1 + 2 > 2
    expect((await call(ana, "POST", `/api/invoices/${od2}/issue`)).body.message).toMatch(/поголеми од фактурата/);
    const st = (await call(ana, "POST", `/api/invoices/${o.id}/derive`, { docType: "ST" })).body.id;
    d = (await call(ana, "GET", `/api/invoices/${st}`)).body;
    await save(d, { voidReasonCode: "S-1", correctionReason: "x" });
    expect((await call(ana, "POST", `/api/invoices/${st}/issue`)).body.message).toMatch(/книжни одобренија/);
  });

  it("korekcija: C-shifra i opis; originalot -> korigiran; zadolzuvanje pocnuva bez stavki", async () => {
    const o = await issued();
    const kr = (await call(ana, "POST", `/api/invoices/${o.id}/derive`, { docType: "KR" })).body.id;
    const d = (await call(ana, "GET", `/api/invoices/${kr}`)).body;
    expect(d.lines[0].qty).toBe("2.000");
    await save(d, { correctionReasonCode: "C02", correctionReason: "Грешна количина" }, 3);
    expect((await call(ana, "POST", `/api/invoices/${kr}/issue`)).body.number).toBe("MC-KR-2026-00001");
    expect((await call(ana, "GET", `/api/invoices/${o.id}`)).body.status).toBe("corrected");
    // od korigirana faktura ne moze nov dokument
    expect((await call(ana, "POST", `/api/invoices/${o.id}/derive`, { docType: "KZ" })).status).toBe(422);
    const kz = (await call(ana, "POST", `/api/invoices/${kr}/derive`, { docType: "KZ" })).body.id;
    expect((await call(ana, "GET", `/api/invoices/${kz}`)).body.lines).toHaveLength(0);
  });

  it("avans: lista so neiskoristen del i odbivanje na faktura", async () => {
    const [it] = await t.db.insert(items).values({ clientId: t.c1.id, code: "AV", name: "Аванс", unit: "ком", unitPrice: "1000", vatRateId: t.vat18.id }).returning();
    const line = { itemId: it!.id, description: "Аванс", unit: "ком", qty: 1, unitPrice: 1000, discountPct: 0, vatRateId: t.vat18.id };
    const av = await call(ana, "POST", `/api/clients/${t.c1.id}/invoices`, { partnerId: t.p1.id, docType: "AV", issueDate: "2026-11-05", lines: [line] });
    await call(ana, "POST", `/api/invoices/${av.body.id}/issue`);
    const list = (await call(ana, "GET", `/api/clients/${t.c1.id}/advances?partnerId=${t.p1.id}`)).body;
    expect(list).toEqual([expect.objectContaining({ number: "MC-AV-2026-00001", remaining: "1180.00" })]);
    const inv = await call(ana, "POST", `/api/clients/${t.c1.id}/invoices`, { partnerId: t.p1.id, issueDate: "2026-11-05",
      advanceInvoiceId: av.body.id, advanceAmount: 500, lines: [{ ...line, qty: 2 }] });
    const d = (await call(ana, "GET", `/api/invoices/${inv.body.id}`)).body;
    expect(d).toMatchObject({ grossTotal: "2360.00", advanceAmount: "500.00", payableAmount: "1860.00", advanceNumber: "MC-AV-2026-00001" });
    await call(ana, "POST", `/api/invoices/${inv.body.id}/issue`);
    expect((await call(ana, "GET", `/api/clients/${t.c1.id}/advances?partnerId=${t.p1.id}`)).body[0].remaining).toBe("680.00");
  });
});

describe("za plakjanje - celi denari", () => {
  it("avans so decimali e odbien pri izdavanje", async () => {
    const [it] = await t.db.insert(items).values({ clientId: t.c1.id, code: "AVX", name: "Аванс", unit: "ком", unitPrice: "1000.42", vatRateId: t.vat18.id }).returning();
    const line = { itemId: it!.id, description: "Аванс", unit: "ком", qty: 1, unitPrice: 1000.42, discountPct: 0, vatRateId: t.vat18.id };
    const av = await call(ana, "POST", `/api/clients/${t.c1.id}/invoices`, { partnerId: t.p1.id, docType: "AV", issueDate: "2026-11-05", lines: [line] });
    await call(ana, "POST", `/api/invoices/${av.body.id}/issue`);      // 1180,50
    const inv = await call(ana, "POST", `/api/clients/${t.c1.id}/invoices`, { partnerId: t.p1.id, issueDate: "2026-11-05",
      advanceInvoiceId: av.body.id, advanceAmount: 1180.5, lines: [{ ...line, qty: 2 }] });
    expect((await call(ana, "POST", `/api/invoices/${inv.body.id}/issue`)).body.message).toMatch(/цели денари/);
  });
});

describe("PDF i postavki na klientot", () => {
  it("samo admin gi menuva postavkite; PDF se vrakja kako application/pdf", async () => {
    const body = { pdfSettings: { shortName: "MC ДООЕЛ", invoiceTitle: "Фактура-Испратница", bankAccounts: [{ account: "210076965310159", bank: "НЛБ Банка АД Скопје" }] } };
    expect((await call(ana, "PATCH", `/api/clients/${t.c1.id}`, body)).status).toBe(403);
    const r = await call(admin, "PATCH", `/api/clients/${t.c1.id}`, body);
    expect(r.body.pdfSettings.shortName).toBe("MC ДООЕЛ");
    const c = await call(ana, "POST", `/api/clients/${t.c1.id}/invoices`, { partnerId: t.p1.id, issueDate: "2026-11-05",
      lines: [{ description: "Услуга", unit: "ком", qty: 1, unitPrice: 270, discountPct: 0, vatRateId: t.vat18.id }] });
    const pdf = await app.inject({ method: "GET", url: `/api/invoices/${c.body.id}/pdf`, headers: { cookie: ana } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    // tug klient -> 404
    const [foreign] = await t.db.insert(invoices).values({ clientId: t.c2.id, partnerId: t.p2.id, year: 2026, issueDate: "2026-11-05" }).returning();
    expect((await app.inject({ method: "GET", url: `/api/invoices/${foreign!.id}/pdf`, headers: { cookie: ana } })).statusCode).toBe(404);
  });
});
