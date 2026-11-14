/** Девизни фактури (docs/16): курс на НБРМ, пресметка во валута + денари, издавање, сторно, копија, УЈП блок, КИФ. */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { exchangeRates, invoiceLines, invoices } from "../src/db/schema.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { calcFxTotals, getNbrmRate, nbrmDate, parseNbrm, rateDateProblem } from "../src/domain/fx.js";
import { calcLine } from "../src/domain/calc.js";
import { buildInvoiceUjp } from "../src/domain/ujp-payload.js";
import { kif } from "../src/domain/vatbooks.js";

/** Лажна курсна листа: EUR 61,6950 (06.11, петок), 61,7000 (09.11); JPY 57,5 за 100. */
const LIST = [
  { RBr: 1, Datum: "2026-11-06T00:00:00", Valuta: 978, Nomin: 1, Oznaka: "EUR", Sreden: 61.695 },
  { RBr: 1, Datum: "2026-11-06T00:00:00", Valuta: 392, Nomin: 100, Oznaka: "JPY", Sreden: 57.5 },
  { RBr: 2, Datum: "2026-11-09T00:00:00", Valuta: 978, Nomin: 1, Oznaka: "EUR", Sreden: 61.7 },
];
let calls: string[] = [];
const fake = async (url: string) => { calls.push(url); return LIST; };

describe("NBRM: читање на курсната листа", () => {
  it("датуми во повеќе облици", () => {
    expect(nbrmDate("2026-11-09T00:00:00")).toBe("2026-11-09");
    expect(nbrmDate("9.11.2026")).toBe("2026-11-09");
    expect(nbrmDate("/Date(1794182400000)/")).toMatch(/^2026-11-0\d$/);
    expect(nbrmDate(null)).toBeNull();
  });
  it("Sreden / Nomin, броеви со запирка, обвивка во објект", () => {
    expect(parseNbrm(LIST).find((r) => r.currency === "JPY")!.rate).toBe("0.575000");
    expect(parseNbrm({ d: [{ Oznaka: "usd", Datum: "06.11.2026", Sreden: "52,8103", Nomin: "1" }] }))
      .toEqual([{ listDate: "2026-11-06", currency: "USD", rate: "52.810300" }]);
    expect(() => parseNbrm([{ foo: 1 }])).toThrow(/не е препознаен/);
    expect(() => parseNbrm("x")).toThrow(/Непознат/);
  });
});

describe("NBRM: курс за датум", () => {
  let t: Awaited<ReturnType<typeof testDb>>;
  beforeEach(async () => { t = await testDb(); calls = []; });
  afterEach(async () => { await t.pg.close(); });

  it("викенд -> последната листа пред датумот; кеш (второ барање без НБРМ)", async () => {
    const r = await getNbrmRate(t.db, "EUR", "2026-11-08", fake, "2026-11-14");
    expect(r).toMatchObject({ rate: "61.695000", listDate: "2026-11-06" });
    expect(calls[0]).toContain("StartDate=29.10.2026&EndDate=08.11.2026&format=json");
    expect((await getNbrmRate(t.db, "EUR", "2026-11-08", fake, "2026-11-14")).cached).toBe(true);
    expect(calls).toHaveLength(1);
    expect((await getNbrmRate(t.db, "EUR", "2026-11-09", fake, "2026-11-14")).rate).toBe("61.700000");
  });
  it("денес без денешна листа не се кешира; иден датум, непозната валута и пад на НБРМ -> јасна порака", async () => {
    await getNbrmRate(t.db, "EUR", "2026-11-14", fake, "2026-11-14");
    expect(await t.db.select().from(exchangeRates)).toHaveLength(0);
    await expect(getNbrmRate(t.db, "EUR", "2026-11-20", fake, "2026-11-14")).rejects.toThrow(/иден датум/);
    await expect(getNbrmRate(t.db, "CHF", "2026-11-09", fake, "2026-11-14")).rejects.toThrow(/нема курс за CHF/);
    await expect(getNbrmRate(t.db, "EUR", "2026-11-10", async () => { throw new Error("timeout"); }, "2026-11-14")).rejects.toThrow(/рачно/);
    expect((await getNbrmRate(t.db, "MKD", "2026-11-10", fake)).rate).toBe("1.000000");
  });
  it("датум на курсот наспроти датум на промет", () => {
    expect(rateDateProblem("2026-11-09", "2026-11-09")).toBeNull();
    expect(rateDateProblem(null, "2026-11-09")).toMatch(/нема датум/);
    expect(rateDateProblem("2026-11-10", "2026-11-09")).toMatch(/по датумот/);
    expect(rateDateProblem("2026-10-01", "2026-11-09")).toMatch(/премногу пред/);
  });
});

describe("пресметка во валута и денари", () => {
  it("1.000 EUR + 18 % по 61,695 -> 61.725,85 + 11.110,65 ден.; „за плаќање“ без заокружување на цел евро", () => {
    const l = calcLine({ qty: 2, unitPrice: "500.25", discountPct: 0, vatRatePct: 18 });
    const { fx, mkd } = calcFxTotals([{ ...l, vatRatePct: 18 }], "61.695");
    expect(fx).toMatchObject({ netTotal: "1000.50", vatTotal: "180.09", grossTotal: "1180.59", payableAmount: "1180.59" });
    expect(mkd).toMatchObject({ netTotal: "61725.85", vatTotal: "11110.65", grossTotal: "72836.50", payableAmount: "72836.50" });
  });
});

describe("девизна фактура преку API", () => {
  let t: Awaited<ReturnType<typeof testDb>>;
  let app: FastifyInstance;
  let cookie: string;
  beforeEach(async () => {
    t = await testDb(); calls = [];
    app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64"), fxFetch: fake });
    cookie = `${SESSION_COOKIE}=${await createSession(t.db, t.user.id, true, {})}`;
  });
  afterEach(async () => { await app.close(); await t.pg.close(); });
  const call = async (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, payload: payload as never, headers: { cookie, ...(method === "GET" ? {} : { "x-efaktura": "1" }) } });
    return { status: r.statusCode, body: r.headers["content-type"]?.includes("json") && r.body ? r.json() : r.rawPayload };
  };
  const line = (unitPrice = 500.25, qty = 2) => ({ description: "Консултантски услуги", unit: "час", qty, unitPrice, discountPct: 0, vatRateId: t.vat18.id });
  const draft = (extra: Record<string, unknown> = {}) => call("POST", `/api/clients/${t.c1.id}/invoices`,
    { partnerId: t.p1.id, issueDate: "2026-11-09", currency: "EUR", exchangeRate: 61.7, exchangeRateDate: "2026-11-09", lines: [line()], ...extra });

  it("GET /api/fx/rate", async () => {
    expect((await call("GET", "/api/fx/rate?currency=EUR&date=2026-11-08")).body).toMatchObject({ rate: "61.695000", listDate: "2026-11-06" });
    expect((await call("GET", "/api/fx/rate?currency=XXX&date=2026-11-08")).status).toBe(400);
  });

  it("нацрт -> издај: документот во EUR, базата во денари; PDF; УЈП блокирано; КИФ во денари", async () => {
    const c = await draft();
    expect(c.status).toBe(201);
    const d = (await call("GET", `/api/invoices/${c.body.id}`)).body;
    expect(d).toMatchObject({ currency: "EUR", exchangeRate: "61.700000", exchangeRateDate: "2026-11-09",
      fxNetTotal: "1000.50", fxVatTotal: "180.09", fxGrossTotal: "1180.59", fxPayableAmount: "1180.59",
      netTotal: "61730.85", vatTotal: "11111.55", grossTotal: "72842.40", payableAmount: "72842.40" });
    expect(d.lines[0]).toMatchObject({ fxUnitPrice: "500.2500", fxNetAmount: "1000.5000", unitPrice: "30865.4250", netAmount: "61730.8500" });
    expect(d.fxByRate[0]).toMatchObject({ net: "1000.50", vat: "180.09" });

    const iss = await call("POST", `/api/invoices/${d.id}/issue`);
    expect(iss.body).toMatchObject({ number: "MC-2026-00001", status: "issued" });
    const [row] = await t.db.select().from(invoices).where(eq(invoices.id, d.id));
    expect(row).toMatchObject({ fxGrossTotal: "1180.59", grossTotal: "72842.40" });

    const pdf = await call("GET", `/api/invoices/${d.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");

    const u = await buildInvoiceUjp(t.db, d.id);
    expect(u.problems.join(" ")).toMatch(/Девизна фактура \(EUR\) засега не се праќа на УЈП/);
    expect(u.payload!.document.docItems[0].docItemUnitOriginalPriceWoVat).toBe(500.25);

    const book = await kif(t.db, t.c1.id, "2026-11-01", "2026-11-30");
    expect(JSON.stringify(book)).toContain("61730.85");

    const list = (await call("GET", `/api/clients/${t.c1.id}/invoices?year=2026`)).body;
    expect(list[0]).toMatchObject({ currency: "EUR", fxPayableAmount: "1180.59", payableAmount: "72842.40" });
  });

  it("сторно и книжно одобрение: иста валута и курс; сторно точно ја поништува", async () => {
    const c = await draft();
    await call("POST", `/api/invoices/${c.body.id}/issue`);
    const st = await call("POST", `/api/invoices/${c.body.id}/derive`, { docType: "ST" });
    let s = (await call("GET", `/api/invoices/${st.body.id}`)).body;
    expect(s).toMatchObject({ currency: "EUR", exchangeRate: "61.700000", fxGrossTotal: "-1180.59", grossTotal: "-72842.40" });
    // корисникот праќа друга валута -> се игнорира (од оригиналот)
    await call("PUT", `/api/invoices/${s.id}`, { partnerId: s.partnerId, issueDate: "2026-11-14", currency: "USD", exchangeRate: 50, version: s.version,
      voidReasonCode: "S-1", correctionReason: "Погрешен купувач", lines: [line()] });
    s = (await call("GET", `/api/invoices/${s.id}`)).body;
    expect(s.currency).toBe("EUR");
    expect((await call("POST", `/api/invoices/${s.id}/issue`)).body).toMatchObject({ number: "MC-ST-2026-00001" });

    const c2 = await draft();
    await call("POST", `/api/invoices/${c2.body.id}/issue`);
    const od = await call("POST", `/api/invoices/${c2.body.id}/derive`, { docType: "OD" });
    const o = (await call("GET", `/api/invoices/${od.body.id}`)).body;
    const r = await call("PUT", `/api/invoices/${o.id}`, { partnerId: o.partnerId, issueDate: "2026-11-30", version: o.version,
      correctionReason: "Попуст", lines: [line(500.25, 3)] });
    expect(r.status).toBe(200);
    expect((await call("POST", `/api/invoices/${o.id}/issue`)).body.message).toMatch(/поголеми од фактурата/);
  });

  it("правила: курс задолжителен, без аванс во валута, курс за друг датум -> издавањето одбива", async () => {
    expect((await draft({ exchangeRate: null })).body.message).toMatch(/Внесете курс за EUR/);
    expect((await draft({ docType: "AV" })).body.message).toMatch(/Авансна фактура засега е само во денари/);
    const c = await draft({ supplyDate: "2026-11-09", exchangeRateDate: "2026-10-01" });
    expect((await call("POST", `/api/invoices/${c.body.id}/issue`)).body.message).toMatch(/премногу пред/);
    // MKD фактура: курс 1, без fx
    const m = await call("POST", `/api/clients/${t.c1.id}/invoices`, { partnerId: t.p1.id, issueDate: "2026-11-09", exchangeRate: 61.7, lines: [line(100, 1)] });
    const [mk] = await t.db.select().from(invoices).where(eq(invoices.id, m.body.id));
    expect(mk).toMatchObject({ currency: "MKD", exchangeRate: "1.000000", fxGrossTotal: null, payableAmount: "118.00" });
    const [ml] = await t.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, m.body.id));
    expect(ml!.fxUnitPrice).toBeNull();
  });

  it("копија: иста валута, курс од НБРМ за новиот датум", async () => {
    const c = await draft();
    await call("POST", `/api/invoices/${c.body.id}/issue`);
    const cp = await call("POST", `/api/invoices/${c.body.id}/copy`, {});
    const d = (await call("GET", `/api/invoices/${cp.body.id}`)).body;
    expect(d).toMatchObject({ currency: "EUR", fxGrossTotal: "1180.59" });
    expect(d.lines[0].fxUnitPrice).toBe("500.2500");
    expect(calls.length).toBe(1);   // курсот за денес е побаран од НБРМ
  });
});
