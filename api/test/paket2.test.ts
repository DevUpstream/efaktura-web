/** Пакет 2 (забелешки 24, 28, 9): краток назив, поништи извод, гаранција и сериски броеви. */
import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { clientAccess, clients, invoiceLines, invoices, items, partners, payments, serialNumbers, users, warehouses } from "../src/db/schema.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { calcLine, addMonths } from "../src/domain/calc.js";
import { issueInvoice } from "../src/domain/issue.js";

let t: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let ana: string, admin: string;
const OWN = "250-0103024933-98";
beforeEach(async () => {
  t = await testDb();
  app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64") });
  const [a] = await t.db.insert(users).values({ email: "ana@x.mk", displayName: "Ана", provider: "entra", role: "accountant" }).returning();
  await t.db.insert(clientAccess).values({ clientId: t.c1.id, userId: a!.id });
  ana = `${SESSION_COOKIE}=${await createSession(t.db, a!.id, true, {})}`;
  admin = `${SESSION_COOKIE}=${await createSession(t.db, t.user.id, true, {})}`;
});
async function call(who: string, method: string, url: string, payload?: unknown) {
  const r = await app.inject({ method: method as never, url, payload: payload as never, headers: { cookie: who, ...(method === "GET" ? {} : { "x-efaktura": "1" }) } });
  return { status: r.statusCode, body: r.headers["content-type"]?.includes("json") && r.body ? r.json() : r.rawPayload };
}
const C = () => `/api/clients/${t.c1.id}`;

describe("24: краток назив", () => {
  it("се менува и кај партнер проверен во УЈП; називот останува заклучен", async () => {
    await t.db.update(partners).set({ ujpRegistryAt: new Date(), name: "ДРУШТВО ЗА ТРГОВИЈА ТОНЕР ЦЕНТАР ДООЕЛ Скопје" }).where(eq(partners.id, t.p1.id));
    const r = await call(ana, "PATCH", `${C()}/partners/${t.p1.id}`, { shortName: "Тонер Центар" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ shortName: "Тонер Центар", name: "ДРУШТВО ЗА ТРГОВИЈА ТОНЕР ЦЕНТАР ДООЕЛ Скопје" });
    expect((await call(ana, "PATCH", `${C()}/partners/${t.p1.id}`, { name: "Тонер Центар" })).status).toBe(409);
    expect((await call(ana, "PATCH", `${C()}/partners/${t.p1.id}`, { shortName: "" })).body.shortName).toBeNull();
  });
});

/** Извод во формат Халкбанк/Шпаркасе (фиксна ширина). */
function txt(no: number, date: string, own: string, opening: number, rows: { name: string; acc: string; amount: number; refC?: string }[]) {
  const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  const closing = rows.reduce((s, r) => s + r.amount, opening);
  return [pad(String(no), 6), pad(date, 12), pad(own, 18), pad(fmt(opening), 19), pad(fmt(closing), 19),
    ...rows.map((r) => pad(r.name, 70) + pad(r.acc, 18) + pad(fmt(r.amount), 19) + pad("220", 6) + pad("", 72) + pad("", 24)
      + pad(r.refC ?? "", 24) + pad("", 24) + pad("10", 24))].join("\r\n") + "\r\n";
}

describe("28: поништи извод", () => {
  beforeEach(async () => {
    await t.db.update(clients).set({ modules: ["invoices", "payments"], iban: OWN }).where(eq(clients.id, t.c1.id));
  });
  async function inv(price: number) {
    const [i] = await t.db.insert(invoices).values({ clientId: t.c1.id, partnerId: t.p1.id, year: 2026, issueDate: "2026-10-01", supplyDate: "2026-10-01", dueDate: "2026-10-15" }).returning();
    await t.db.insert(invoiceLines).values({ invoiceId: i!.id, lineNo: 1, description: "У", unit: "ком", qty: "1", unitPrice: String(price), vatRateId: t.vat18.id, vatRatePct: "18",
      ...calcLine({ qty: 1, unitPrice: price, vatRatePct: 18 }) });
    return issueInvoice(t.db, i!.id, { userId: t.user.id });
  }

  it("уплатите се сторнираат, фактурата е пак отворена, изводот може повторно да се увезе", async () => {
    await inv(1000);
    const st = txt(34, "05.11.2026", OWN, 0, [{ name: "Купувач", acc: "300-0000000111-22", amount: 1180, refC: "MC-2026-00001" }, { name: "Провизија", acc: "", amount: -50 }]);
    const r = (await call(ana, "POST", `${C()}/bank-statements`, { text: st })).body;
    expect(r.booked).toBe(1);
    const open0 = (await call(ana, "GET", `${C()}/open-items?direction=in`)).body;
    expect(open0.items ?? open0).toHaveLength(0);

    // само администратор; причина задолжителна
    expect((await call(ana, "POST", `${C()}/bank-statements/${r.id}/void`, { reason: "Повторен увоз" })).status).toBe(403);
    expect((await call(admin, "POST", `${C()}/bank-statements/${r.id}/void`, { reason: "x" })).status).toBe(400);
    const v = await call(admin, "POST", `${C()}/bank-statements/${r.id}/void`, { reason: "Повторен увоз" });
    expect(v.body).toMatchObject({ paymentsVoided: 1 });
    expect((await call(admin, "POST", `${C()}/bank-statements/${r.id}/void`, { reason: "Повторен увоз" })).status).toBe(409);

    // ништо не е избришано: уплатата е сторнирана, изводот е видлив како поништен
    const pays = await t.db.select().from(payments).where(eq(payments.clientId, t.c1.id));
    expect(pays).toHaveLength(1);
    expect(pays[0]!.voidReason).toMatch(/Поништен извод бр. 34: Повторен увоз/);
    const open1 = (await call(ana, "GET", `${C()}/open-items?direction=in`)).body;
    expect((open1.items ?? open1).length).toBe(1);
    const d = (await call(ana, "GET", `${C()}/bank-statements/${r.id}`)).body;
    expect(d.voidReason).toBe("Повторен увоз");
    expect(d.lines.every((l: { status: string }) => l.status === "voided")).toBe(true);
    expect((await call(ana, "POST", `${C()}/bank-lines/${d.lines[0].id}/book`, { partnerId: t.p1.id })).status).toBe(422);
    expect((await call(ana, "POST", `${C()}/bank-statements/${r.id}/book-sure`)).status).toBe(422);
    // трошоците не го бројат поништениот извод
    const exp = (await call(ana, "GET", `${C()}/bank-expenses`)).body;
    expect(JSON.stringify(exp)).not.toContain("50.00");

    // повторен увоз на истиот извод
    const again = await call(ana, "POST", `${C()}/bank-statements`, { text: st });
    expect(again.status).toBe(201);
    expect(again.body.booked).toBe(1);
    expect(JSON.stringify(again.body.warnings)).not.toMatch(/Недостасува извод/);
    const list = (await call(ana, "GET", `${C()}/bank-statements`)).body as { id: number; voidedAt: string | null; prevNo: string | null }[];
    expect(list).toHaveLength(2);
    expect(list.find((x) => x.id === r.id)!.voidedAt).not.toBeNull();
  });
});

describe("9: гаранција и сериски броеви", () => {
  let wh: number, wh2: number, tv: number;
  beforeEach(async () => {
    await t.db.update(clients).set({ modules: ["invoices", "incoming", "warehouse"] }).where(eq(clients.id, t.c1.id));
    [{ id: wh }] = await t.db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.clientId, t.c1.id));
    wh2 = (await t.db.insert(warehouses).values({ clientId: t.c1.id, code: "M2", name: "Продавница" }).returning())[0]!.id;
    const r = await call(ana, "POST", `${C()}/items`, { code: "TV55", name: "Телевизор 55", type: "goods", unit: "парче", unitPrice: 30000, vatRateId: t.vat18.id,
      trackSerials: true, warrantyMonths: 24 });
    expect(r.status).toBe(201);
    tv = r.body.id;
  });
  const receipt = (serials: unknown, qty = 2) => call(ana, "POST", `${C()}/stock-docs`, { kind: "receipt", warehouseId: wh, docDate: "2026-11-01",
    lines: [{ itemId: tv, qty, unitCost: 20000, serials }] });
  const serial = async (no: string) => (await t.db.select().from(serialNumbers).where(eq(serialNumbers.serialNo, no)))[0];

  it("артикл: лот и сериски број не заедно; вклучување само без залиха", async () => {
    expect((await call(ana, "POST", `${C()}/items`, { code: "X", name: "Икс", type: "goods", unit: "парче", unitPrice: 1, vatRateId: t.vat18.id, trackLots: true, trackSerials: true })).status).toBe(422);
    const g = (await call(ana, "POST", `${C()}/items`, { code: "G", name: "Стока", type: "goods", unit: "парче", unitPrice: 1, vatRateId: t.vat18.id })).body;
    await call(ana, "POST", `${C()}/stock-docs`, { kind: "receipt", warehouseId: wh, docDate: "2026-11-01", lines: [{ itemId: g.id, qty: 3, unitCost: 1 }] });
    expect((await call(ana, "PATCH", `${C()}/items/${g.id}`, { trackSerials: true })).body.message).toMatch(/има залиха без сериски броеви/);
    expect((await call(ana, "PATCH", `${C()}/items/${g.id}`, { warrantyMonths: 12 })).body.warrantyMonths).toBe(12);
  });

  it("прием: точно по еден број по парче, без двоен прием", async () => {
    expect((await receipt("SN-1")).body.message).toMatch(/внесете 2 сериски број/);
    expect((await receipt("SN-1\nSN-1")).body.message).toMatch(/внесени: 1/);
    expect((await receipt(["SN-1", "SN-2"], 1.5)).body.message).toMatch(/цел број/);
    expect((await receipt("SN-1\nSN-2")).status).toBe(201);
    expect((await receipt("SN-2, SN-3")).body.message).toMatch(/SN-2 е веќе на залиха/);
    expect((await serial("SN-1"))!.warehouseId).toBe(wh);
    // попис не се прави по сериски број
    expect((await call(ana, "POST", `${C()}/stock-docs`, { kind: "inventory", warehouseId: wh, docDate: "2026-11-02", lines: [{ itemId: tv, qty: 1 }] })).body.message).toMatch(/води сериски број/);
  });

  it("продажба со фактура -> гаранција до; сторно ги враќа; пренос и негово сторно", async () => {
    await receipt("SN-1\nSN-2");
    const line = (serials?: unknown) => ({ itemId: tv, description: "Телевизор 55", unit: "парче", qty: 1, unitPrice: 30000, vatRateId: t.vat18.id, serials });
    const draft = (serials?: unknown) => call(ana, "POST", `${C()}/invoices`, { partnerId: t.p1.id, issueDate: "2026-11-10", supplyDate: "2026-11-10", lines: [line(serials)] });

    // без сериски број -> издавањето одбива
    const bad = await draft();
    expect((await call(ana, "POST", `/api/invoices/${bad.body.id}/issue`)).body.message).toMatch(/внесете 1 сериски број/);
    // со непознат број
    const unk = await draft("XX-9");
    expect((await call(ana, "POST", `/api/invoices/${unk.body.id}/issue`)).body.message).toMatch(/XX-9 не постои/);

    const ok = await draft("SN-1");
    const d = (await call(ana, "GET", `/api/invoices/${ok.body.id}`)).body;
    expect(d.lines[0]).toMatchObject({ serials: ["SN-1"], warrantyMonths: 24 });
    expect((await call(ana, "POST", `/api/invoices/${ok.body.id}/issue`)).status).toBe(200);
    expect((await serial("SN-1"))!.warehouseId).toBeNull();
    const pdf = await call(ana, "GET", `/api/invoices/${ok.body.id}/pdf`);
    expect(pdf.status).toBe(200);

    // истиот број не може да се продаде двапати
    const twice = await draft("SN-1");
    expect((await call(ana, "POST", `/api/invoices/${twice.body.id}/issue`)).body.message).toMatch(/SN-1 не е на залиха/);

    // картица: продаден, гаранција 24 месеци од датумот на промет
    const found = (await call(ana, "GET", `${C()}/serials?q=sn-1`)).body;
    expect(found).toHaveLength(1);
    const card = (await call(ana, "GET", `${C()}/serials/${found[0].id}`)).body;
    expect(card).toMatchObject({ soldAt: "2026-11-10", warrantyUntil: addMonths("2026-11-10", 24), warehouseId: null });
    expect(card.moves).toHaveLength(2);
    expect(card.soldTo).toBeTruthy();
    expect((await call(ana, "GET", `${C()}/serials?itemId=${tv}&available=1`)).body.map((x: { serialNo: string }) => x.serialNo)).toEqual(["SN-2"]);

    // сторно на фактурата -> SN-1 пак на залиха
    const st = await call(ana, "POST", `/api/invoices/${ok.body.id}/derive`, { docType: "ST" });
    const s = (await call(ana, "GET", `/api/invoices/${st.body.id}`)).body;
    expect(s.lines[0].serials).toEqual(["SN-1"]);
    await call(ana, "PUT", `/api/invoices/${s.id}`, { partnerId: s.partnerId, issueDate: "2026-11-12", version: s.version, voidReasonCode: "S-1",
      correctionReason: "Погрешен купувач", lines: [line("SN-1")] });
    expect((await call(ana, "POST", `/api/invoices/${s.id}/issue`)).status).toBe(200);
    expect((await serial("SN-1"))!.warehouseId).toBe(wh);

    // пренос SN-2 во продавница и сторно на преносот
    const tr = await call(ana, "POST", `${C()}/stock-docs`, { kind: "transfer", warehouseId: wh, toWarehouseId: wh2, docDate: "2026-11-13", lines: [{ itemId: tv, qty: 1, serials: ["SN-2"] }] });
    expect(tr.status).toBe(201);
    expect((await serial("SN-2"))!.warehouseId).toBe(wh2);
    expect((await call(ana, "POST", `${C()}/stock-docs/${tr.body.id}/reverse`, { date: "2026-11-14" })).status).toBe(200);
    expect((await serial("SN-2"))!.warehouseId).toBe(wh);
  });

  it("влезна фактура со сериски броеви -> приемница; испратница го носи бројот на фактурата", async () => {
    const p = await call(ana, "POST", `${C()}/purchases`, { partnerId: t.p1.id, supplierNumber: "F-1", issueDate: "2026-11-01", receivedDate: "2026-11-02",
      lines: [{ itemId: tv, description: "ТВ", unit: "парче", qty: 2, unitPrice: 20000, vatRateId: t.vat18.id, serials: "A1\nA2" }] });
    expect(p.status).toBe(201);
    expect((await call(ana, "POST", `${C()}/purchases/${p.body.id}/post`)).status).toBe(200);
    expect((await serial("A2"))!.warehouseId).toBe(wh);
    // испратница без фактура, па фактура од испратницата
    const disp = await call(ana, "POST", `${C()}/stock-docs`, { kind: "issue", warehouseId: wh, partnerId: t.p1.id, docDate: "2026-11-05", lines: [{ itemId: tv, qty: 1, serials: ["A1"] }] });
    expect(disp.status).toBe(201);
    expect((await call(ana, "GET", `${C()}/stock-docs/${disp.body.id}/pdf`)).status).toBe(200);
    const inv = await call(ana, "POST", `${C()}/dispatches/invoice`, { docIds: [disp.body.id] });
    expect(inv.status).toBe(201);
    const d = (await call(ana, "GET", `/api/invoices/${inv.body.id}`)).body;
    expect(d.lines[0]).toMatchObject({ serials: ["A1"], stockDocId: disp.body.id, warrantyMonths: 24 });
    // фактурата од испратница не издава повторно од магацин
    expect((await call(ana, "POST", `/api/invoices/${d.id}/issue`)).status).toBe(200);
    expect((await serial("A1"))!.warehouseId).toBeNull();
    const [it] = await t.db.select().from(items).where(eq(items.id, tv));
    expect(it!.warrantyMonths).toBe(24);
  });
});
