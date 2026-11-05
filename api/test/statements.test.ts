import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { clientAccess, clients, invoiceLines, invoices, partnerAccounts, partners, purchaseInvoices, purchaseLines, users } from "../src/db/schema.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { calcLine } from "../src/domain/calc.js";
import { issueInvoice } from "../src/domain/issue.js";
import { postPurchase } from "../src/domain/purchase.js";
import { parseMkTxt } from "../src/domain/bank-txt.js";
import { matchLine, uniqueSubset } from "../src/domain/matching.js";

const fx = (f: string) => readFileSync(new URL(`./fixtures/statements/${f}`, import.meta.url), "utf8");

/** Izvod vo istiot format kako Halkbank/Sparkasse (fiksna sirina). */
function txt(no: number, date: string, own: string, opening: number, rows: { name: string; acc: string; amount: number; code?: string; purpose?: string; refD?: string; refC?: string; edb?: string }[]) {
  const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  const closing = rows.reduce((s, r) => s + r.amount, opening);
  return [pad(String(no), 6), pad(date, 12), pad(own, 18), pad(fmt(opening), 19), pad(fmt(closing), 19),
    ...rows.map((r) => pad(r.name, 70) + pad(r.acc, 18) + pad(fmt(r.amount), 19) + pad(r.code ?? "220", 6) + pad(r.purpose ?? "", 72) + pad(r.refD ?? "", 24)
      + pad(r.refC ?? "", 24) + pad(r.edb ?? "", 24) + pad("10", 24))].join("\r\n") + "\r\n";
}

describe("parser na TXT izvod (vistinski izvodi)", () => {
  it("Halkbank i Sparkasse: zaglavje, stavki, EDB, sostojbata se sovpagja", () => {
    const h = parseMkTxt(fx("halk-11.txt"));
    expect(h).toMatchObject({ statementNo: "11", date: "2026-02-27", ownAccount: "270-0000010922-04", opening: "52090.00", closing: "51840.00" });
    expect(h.lines[0]).toMatchObject({ direction: "out", amount: "250.00", name: "ХАЛКБАНК АД СКОПЈЕ", account: "270-0000001001-85", paymentCode: "674",
      refDebit: "162300035-3130126", refCredit: "180-2022003130126", edb: "" });
    const s = parseMkTxt(fx("sparkasse-03.txt"));
    expect(s.lines[0]).toMatchObject({ amount: "68989.00", account: "250-0101024226-53", edb: "4080022607926", refCredit: "1682300 12 25 3" });
    expect(s.lines[0]!.purpose).toBe("Плаќање по основ на извршени услуги 25-1200-230");
    expect(parseMkTxt(fx("sparkasse-29.txt")).lines).toHaveLength(6);
  });
  it("odbiva necelosen izvod i pomesteni koloni", () => {
    expect(() => parseMkTxt(fx("sparkasse-29.txt").replace("71,768.00", "71,769.00"))).toThrow(/не е целосен/);
    const bad = fx("halk-11.txt").split("\r\n"); bad[5] = "    " + bad[5];
    expect(() => parseMkTxt(bad.join("\r\n"))).toThrow(/колоните не се на очекуваното место/);
  });
  it("kombinacija: edinstvena -> da, dvosmislena -> ne", () => {
    const it = (id: number, r: string) => ({ id, remaining: r }) as never;
    expect(uniqueSubset([it(1, "100.00"), it(2, "250.00"), it(3, "400.00")], "500.00")?.map((x: { id: number }) => x.id)).toEqual([1, 3]);
    expect(uniqueSubset([it(1, "100.00"), it(2, "100.00"), it(3, "300.00")], "400.00")).toBeNull();
  });
});

describe("uvoz, prepoznavanje i knizenje", () => {
  let t: Awaited<ReturnType<typeof testDb>>;
  let app: FastifyInstance;
  let ana: string;
  const OWN = "250-0103024933-98";
  beforeEach(async () => {
    t = await testDb();
    app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64") });
    const [a] = await t.db.insert(users).values({ email: "ana@x.mk", displayName: "Ана", provider: "entra", role: "accountant" }).returning();
    await t.db.insert(clientAccess).values({ clientId: t.c1.id, userId: a!.id });
    ana = `${SESSION_COOKIE}=${await createSession(t.db, a!.id, true, {})}`;
    await t.db.update(clients).set({ modules: ["invoices", "incoming", "payments"], iban: OWN }).where(eq(clients.id, t.c1.id));
    await t.db.update(partners).set({ edb: "4030000000011", name: "КУПУВАЧ А ДООЕЛ Струмица" }).where(eq(partners.id, t.p1.id));
  });
  const call = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as never, url, payload: payload as never, headers: { cookie: ana, ...(method === "GET" ? {} : { "x-efaktura": "1" }) } });
    return { status: r.statusCode, body: r.body ? r.json() : null };
  };
  const C = () => `/api/clients/${t.c1.id}`;
  async function inv(price: number, due = "2026-10-15") {
    const [i] = await t.db.insert(invoices).values({ clientId: t.c1.id, partnerId: t.p1.id, year: 2026, issueDate: "2026-10-01", supplyDate: "2026-10-01", dueDate: due }).returning();
    await t.db.insert(invoiceLines).values({ invoiceId: i!.id, lineNo: 1, description: "У", unit: "ком", qty: "1", unitPrice: String(price), vatRateId: t.vat18.id, vatRatePct: "18",
      ...calcLine({ qty: 1, unitPrice: price, vatRatePct: 18 }) });
    return issueInvoice(t.db, i!.id, { userId: t.user.id });
  }

  it("sigurno se knizi samo; verojatnoto ceka; provizija i Trezor ne se partneri", async () => {
    const a = await inv(1000);   // 1180
    await inv(500);              // 590
    const st = txt(30, "05.11.2026", OWN, 10000, [
      { name: "КУПУВАЧ А ДООЕЛ СТРУМИЦА", acc: "300-0000000111-22", amount: 1180, purpose: "Плаќање фактура", refC: "MC-2026-1", edb: "4030000000011" },
      { name: "Купувач А", acc: "300-0000000999-22", amount: 300, purpose: "аванс" },
      { name: "Трезор на РМ", acc: "100-0000000630-95", amount: -525, code: "100", edb: "4030994180119" },
      { name: "Шпаркасе Банка А.Д. Скопје", acc: "250-0000033333-22", amount: -10, code: "666", purpose: "[AutoProv]Провизија" },
    ]);
    const r = (await call("POST", `${C()}/bank-statements`, { text: st, fileName: "30.txt" })).body;
    expect(r).toMatchObject({ lines: 4, booked: 1, categorized: 2 });
    const d = (await call("GET", `${C()}/bank-statements/${r.id}`)).body;
    expect(d.lines[0]).toMatchObject({ status: "booked", booking: { documents: a.number } });
    expect(d.lines[1].suggestion).toMatchObject({ partnerId: t.p1.id, partnerBy: "name", confidence: "likely" });
    expect(d.lines[2]).toMatchObject({ status: "ignored", category: "tax", categorySource: "auto" });
    expect(d.lines[3]).toMatchObject({ status: "ignored", category: "fee", categorySource: "auto" });
    expect(d.counts).toMatchObject({ booked: 1, open: 1, ignored: 2 });
    const list = (await call("GET", `${C()}/bank-statements`)).body;
    expect(list[0]).toMatchObject({ statementNo: "30", lines: 4, open: 1, inflow: "1480.00", outflow: "535.00" });
  });

  it("racno knizenje ja ucи smetkata; sledniot izvod e sigurен po smetka + tocen iznos", async () => {
    await inv(500); const b = await inv(200);  // 590, 236
    const s1 = (await call("POST", `${C()}/bank-statements`, { text: txt(31, "05.11.2026", OWN, 0, [{ name: "Купувач А", acc: "300-0000000999-22", amount: 590 }]) })).body;
    const d1 = (await call("GET", `${C()}/bank-statements/${s1.id}`)).body;
    expect(d1.lines[0].suggestion.confidence).toBe("likely");
    const bk = (await call("POST", `${C()}/bank-lines/${d1.lines[0].id}/book`, { partnerId: t.p1.id, allocations: null })).body;
    expect(bk.learned).toBe(true);
    expect((await t.db.select().from(partnerAccounts))[0]).toMatchObject({ account: "300000000099922", partnerId: t.p1.id });
    const s2 = (await call("POST", `${C()}/bank-statements`, { text: txt(32, "06.11.2026", OWN, 590, [{ name: "KUPUVAC A", acc: "300-0000000999-22", amount: 236 }]) })).body;
    expect(s2.booked).toBe(1);
    const d2 = (await call("GET", `${C()}/bank-statements/${s2.id}`)).body;
    expect(d2.lines[0].booking.documents).toBe(b.number);
  });

  it("kratok broj (2/2026) i kombinacija na fakturi", async () => {
    await inv(100); const b = await inv(200); const c = await inv(300);   // 118, 236, 354
    await t.db.insert(partnerAccounts).values({ clientId: t.c1.id, partnerId: t.p1.id, account: "300000000011122", source: "manual" });
    const r = (await call("POST", `${C()}/bank-statements`, { text: txt(33, "05.11.2026", OWN, 0, [
      { name: "x", acc: "300-0000000111-22", amount: 236, purpose: "по ф-ра 2/2026" },
      { name: "x", acc: "300-0000000111-22", amount: 472 },                            // 118 + 354
    ]) })).body;
    expect(r.booked).toBe(2);
    const d = (await call("GET", `${C()}/bank-statements/${r.id}`)).body;
    expect(d.lines.map((l: { booking: { documents: string } }) => l.booking.documents)).toEqual([b.number, `MC-2026-00001, ${c.number}`]);
  });

  it("isplata na dobavuvac po brojot na negovata faktura (kako ESM: 25-1200-230)", async () => {
    await t.db.update(partners).set({ edb: "4080022607926", name: "ЕСМ СНАБДУВАЊЕ СО ТОПЛИНА ДООЕЛ СКОПЈЕ" }).where(eq(partners.id, t.p1.id));
    for (const sn of ["25-1200-230", "25-1200-231"]) {
      const [pi] = await t.db.insert(purchaseInvoices).values({ clientId: t.c1.id, partnerId: t.p1.id, year: 2026, supplierNumber: sn, issueDate: "2026-01-02", receivedDate: "2026-01-03" }).returning();
      await t.db.insert(purchaseLines).values({ purchaseInvoiceId: pi!.id, lineNo: 1, description: "Топлина", unit: "ком", qty: "1", unitPrice: "58465.25", vatRateId: t.vat18.id, vatRatePct: "18",
        ...calcLine({ qty: 1, unitPrice: 58465.25, vatRatePct: 18 }) });
      await postPurchase(t.db, pi!.id, { userId: t.user.id }, false);
    }
    await t.db.update(clients).set({ iban: "250-0103024776-84" }).where(eq(clients.id, t.c1.id));
    const r = (await call("POST", `${C()}/bank-statements`, { text: fx("sparkasse-03.txt"), fileName: "2026-03.txt" })).body;
    expect(r.booked).toBe(1);
    const d = (await call("GET", `${C()}/bank-statements/${r.id}`)).body;
    expect(d.lines[0].booking.documents).toMatch(/\(25-1200-230\)/);
    expect(d.lines[1]).toMatchObject({ status: "ignored", category: "fee" });   // provizija - avtomatski
  });

  it("zastita: pogresna firma, dupli izvod, ignoriraj, storno ja otvora stavkata", async () => {
    expect((await call("POST", `${C()}/bank-statements`, { text: fx("halk-11.txt") })).status).toBe(422);    // smetka 270-... ne e nasha
    await inv(1000);
    const st = txt(34, "05.11.2026", OWN, 0, [{ name: "x", acc: "300-0000000111-22", amount: 1180, refC: "MC-2026-00001" }]);
    const r = (await call("POST", `${C()}/bank-statements`, { text: st })).body;
    expect((await call("POST", `${C()}/bank-statements`, { text: st })).status).toBe(409);
    const d = (await call("GET", `${C()}/bank-statements/${r.id}`)).body;
    expect((await call("POST", `${C()}/bank-lines/${d.lines[0].id}/category`, { category: "skip" })).status).toBe(422);   // proknizena
    await call("POST", `${C()}/payments/${d.lines[0].booking.paymentId}/void`, { reason: "Погрешно" });
    expect((await call("GET", `${C()}/bank-statements/${r.id}`)).body.lines[0].status).toBe("open");
    expect((await call("POST", `${C()}/bank-statements/${r.id}/book-sure`)).body.booked).toBe(1);   // povtorno knizenje
    // druga firma ne mozhe da ja koristi istata smetka
    await t.db.update(clients).set({ modules: ["invoices", "payments"], iban: null }).where(eq(clients.id, t.c2.id));
    await t.db.insert(clientAccess).values({ clientId: t.c2.id, userId: (await t.db.select().from(users).where(eq(users.email, "ana@x.mk")))[0]!.id });
    expect((await call("POST", `/api/clients/${t.c2.id}/bank-statements`, { text: txt(35, "06.11.2026", OWN, 1180, [{ name: "y", acc: "300-0000000222-22", amount: 5 }]) })).body.message).toMatch(/веќе има изводи/);
  });

  it("naziv na latinica = kirilica", async () => {
    const { normalizeName } = await import("../src/domain/bank-import.js");
    expect(normalizeName("ELEKTRO LINK DOO SKOPJE")).toBe(normalizeName("ЕЛЕКТРО ЛИНК ДОО Скопје"));
    expect(normalizeName("Kjumbe Gjorgjievski DOOEL")).toBe("ЌУМБЕ ЃОРЃИЕВСКИ");
  });

  it("prenos megju sopstveni smetki i trosoci: ne vleguvaat vo trosocite; pregled i CSV", async () => {
    await t.db.update(clients).set({ pdfSettings: { bankAccounts: [{ account: "210-0000000777-11", bank: "НЛБ" }] } }).where(eq(clients.id, t.c1.id));
    const r = (await call("POST", `${C()}/bank-statements`, { text: txt(40, "05.11.2026", OWN, 50000, [
      { name: "МАКЕДОНСКИ ЦЕНТАР", acc: "210-0000000777-11", amount: -20000, purpose: "Пренос меѓу сметки" },
      { name: "Шпаркасе Банка", acc: "250-0000033333-22", amount: -141, code: "666", purpose: "[AutoProv]Провизија за налози" },
      { name: "ШПАРКАСЕ БАНКА-ПЛАТЕЖНИ КАРТИЧКИ", acc: "250-0010022085-73", amount: -720, purpose: "TINEKS MT [Плаќање со Виза к.]" },
      { name: "Вработен", acc: "210-0000000002-22", amount: -9594, code: "188", purpose: "Дневници и трошоци за службени патување" },
    ]) })).body;
    expect(r).toMatchObject({ booked: 0, categorized: 2 });
    const d = (await call("GET", `${C()}/bank-statements/${r.id}`)).body;
    expect(d.lines.map((l: { category: string | null; suggestion: { category: string } | null }) => l.category ?? l.suggestion?.category)).toEqual(["transfer", "fee", "card", "salary"]);
    expect(d.lines[2].status).toBe("open");   // kartica i plata: samo predlog
    await call("POST", `${C()}/bank-lines/${d.lines[2].id}/category`, { category: "card" });
    await call("POST", `${C()}/bank-lines/${d.lines[3].id}/category`, { category: "salary" });
    const e = (await call("GET", `${C()}/bank-expenses?from=2026-11-01&to=2026-11-30`)).body;
    const by = Object.fromEntries(e.byMonth.map((g: { category: string; out: string }) => [g.category, g.out]));
    expect(by).toEqual({ transfer: "20000.00", fee: "141.00", card: "720.00", salary: "9594.00" });
    expect(e.categories.transfer.expense).toBe(false);
    const csv = await app.inject({ method: "GET", url: `${C()}/bank-expenses?format=csv`, headers: { cookie: ana } });
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.body).toContain("Пренос меѓу сопствени сметки");
    // vrati vo obrabotka
    await call("POST", `${C()}/bank-lines/${d.lines[3].id}/category`, { category: null });
    expect((await call("GET", `${C()}/bank-statements/${r.id}`)).body.lines[3].status).toBe("open");
  });

  it("matchLine: nashiot EDB (PP50) ne e partner", () => {
    const r = matchLine({ direction: "out", amount: "525.00", name: "Трезор на РМ", account: "100-0000000630-95", edb: "4030994180119", purpose: "", refDebit: "", refCredit: "" },
      { clientEdb: "4030994180119", prefix: "MC", ownAccounts: new Set(), partners: [{ id: 9, name: "Нешто", edb: "4030994180119", isActive: true }], accounts: new Map(), openIn: [], openOut: [] });
    expect(r.partnerId).toBeNull();
  });
});
