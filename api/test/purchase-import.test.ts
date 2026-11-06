import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { clientAccess, clients, items, partners, supplierItemMap, users } from "../src/db/schema.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { countryCode, parseUjpText } from "../src/domain/ujp-import.js";
import { openItems } from "../src/domain/payments.js";

const JSON_TEXT = readFileSync(new URL("./fixtures/ujp/einvoice-100.json", import.meta.url), "utf8");
const PDF = Buffer.from("%PDF-1.4\n% test\n%%EOF\n").toString("base64");
const b64url = (s: string) => Buffer.from(s).toString("base64url");

let t: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let ana: string;
beforeEach(async () => {
  t = await testDb();
  app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64") });
  const [a] = await t.db.insert(users).values({ email: "ana@x.mk", displayName: "Ана", provider: "entra", role: "accountant" }).returning();
  await t.db.insert(clientAccess).values({ clientId: t.c1.id, userId: a!.id });
  await t.db.insert(clientAccess).values({ clientId: t.c2.id, userId: a!.id });
  ana = `${SESSION_COOKIE}=${await createSession(t.db, a!.id, true, {})}`;
  for (const c of [t.c1.id, t.c2.id]) await t.db.update(clients).set({ modules: ["invoices", "incoming", "warehouse", "payments"] }).where(eq(clients.id, c));
});
async function call(method: string, url: string, payload?: unknown) {
  const r = await app.inject({ method: method as never, url, payload: payload as never, headers: { cookie: ana, ...(method === "GET" ? {} : { "x-efaktura": "1" }) } });
  return { status: r.statusCode, body: r.headers["content-type"]?.toString().includes("json") ? r.json() : r.rawPayload };
}
const C = (id = t.c1.id) => `/api/clients/${id}`;

describe("uvoz na vlezna e-faktura (UJP JSON)", () => {
  it("cita JSON, obvivka so jws i potpisan JWS; MK na kirilica", () => {
    const doc = JSON.parse(JSON_TEXT).document;
    expect(parseUjpText(JSON_TEXT).header.docNumber).toBe("26-307-006229");
    const jws = `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(JSON.parse(JSON_TEXT)))}.sig`;
    expect(parseUjpText(jws).seller.sellerTin).toBe("4030005549311");
    expect(parseUjpText(JSON.stringify({ requestTimestamp: "x", jws })).docItems).toHaveLength(2);
    expect(parseUjpText(JSON.stringify(doc)).docItems).toHaveLength(2);
    expect(countryCode("МК")).toBe("MK");
    expect(() => parseUjpText("ова не е json")).toThrow(/не е JSON/);
    expect(() => parseUjpText('{"document":{"header":{}}}')).toThrow(/форматот на УЈП/);
  });

  it("uvezuva: klient po EDB, nov dobavuvac, iznosi od dokumentot, PDF, duplikat", async () => {
    const r = await call("POST", `${C()}/purchases/import-ujp`, { text: JSON_TEXT, fileName: "eInvoice.json", pdf: { name: "faktura.pdf", base64: PDF } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ supplierNumber: "26-307-006229", grossTotal: "10559.00", payableAmount: "10559.00", lines: 2, mapped: 0,
      supplier: { name: "ДАТАЛАБ МК", created: true } });
    // DDV kaj dobavuvacot e zaokruzen po stavka (54,00 namesto 53,64) -> predupreduvanje, se zacuvuva iznosot od fakturata
    expect(r.body.warnings.join(" ")).toMatch(/1\.610,64.*1\.611,00/);
    const [sup] = await t.db.select().from(partners).where(eq(partners.edb, "4030005549311"));
    expect(sup).toMatchObject({ clientId: t.c1.id, vatNumber: "MK4030005549311", country: "MK", city: "СКОПЈЕ", email: "fakturi@prodavac.test" });

    const p = (await call("GET", `${C()}/purchases/${r.body.id}`)).body;
    expect(p).toMatchObject({ status: "draft", source: "ujp_json", fixedAmounts: true, grossTotal: "10559.00", vatTotal: "1611.00", dueDate: "2026-10-15",
      issueDate: "2026-09-30", turnoverDate: "2026-09-30", hasSource: true });
    expect(p.lines[1]).toMatchObject({ unit: "КОЛ", vatAmount: "54.0000", netAmount: "298.0000" });
    expect(p.files).toHaveLength(1);
    const f = await call("GET", `${C()}/purchases/${r.body.id}/files/${p.files[0].id}`);
    expect(f.status).toBe(200);
    expect(Buffer.from(f.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");

    const again = await call("POST", `${C()}/purchases/import-ujp`, { text: JSON_TEXT });
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/веќе внесена/);
  });

  it("pogresna firma, izlezna faktura, devizna, drug tip -> jasna poraka", async () => {
    const wrong = await call("POST", `${C(t.c2.id)}/purchases/import-ujp`, { text: JSON_TEXT });
    expect(wrong.status).toBe(422);
    expect(wrong.body.message).toMatch(/Купувач на фактурата е МЦМС Скопје/);
    const o = JSON.parse(JSON_TEXT);
    const mut = (f: (d: typeof o.document) => void) => { const c = structuredClone(o); f(c.document); return JSON.stringify(c); };
    expect((await call("POST", `${C()}/purchases/import-ujp`, { text: mut((d) => { d.seller.sellerTin = d.buyer.buyerTin; }) })).body.message).toMatch(/излезна/);
    expect((await call("POST", `${C()}/purchases/import-ujp`, { text: mut((d) => { d.docPayment.docCurrencyCode = "EUR"; }) })).body.message).toMatch(/EUR/);
    expect((await call("POST", `${C()}/purchases/import-ujp`, { text: mut((d) => { d.header.docType = "110"; d.header.docTypeName = "Книжно одобрение"; }) })).body.message).toMatch(/тип 110/);
    expect((await call("POST", `${C()}/purchases/import-ujp`, { text: mut((d) => { d.docTotals.docVatAmount = 1700; }) })).body.message).toMatch(/не е усогласен/);
  });

  it("uvezena: iznosite ne se menuvaat; artiklot se izbira; knizenje so iznosite od dokumentot; ucenje; plakjanje po tocen iznos", async () => {
    const r = (await call("POST", `${C()}/purchases/import-ujp`, { text: JSON_TEXT })).body;
    const p = (await call("GET", `${C()}/purchases/${r.id}`)).body;
    const [svc] = await t.db.insert(items).values({ clientId: t.c1.id, code: "SW", name: "Софтвер", type: "service", unit: "мес", unitPrice: "0", vatRateId: t.vat18.id }).returning();
    const body = (over: (l: { qty: number }[]) => void = () => {}) => {
      const lines = p.lines.map((l: Record<string, string>, i: number) => ({ itemId: i === 0 ? svc!.id : null, description: l.description, unit: l.unit,
        qty: Number(l.qty), unitPrice: Number(l.unitPrice), discountPct: Number(l.discountPct), vatRateId: l.vatRateId, allocate: false }));
      over(lines);
      return { partnerId: p.partnerId, supplierNumber: p.supplierNumber, issueDate: p.issueDate, receivedDate: "2026-10-07", dueDate: p.dueDate, lines, version: p.version };
    };
    expect((await call("PUT", `${C()}/purchases/${r.id}`, body((ls) => { ls[0]!.qty = 6; }))).status).toBe(422);
    expect((await call("PUT", `${C()}/purchases/${r.id}`, body())).status).toBe(200);
    const posted = (await call("POST", `${C()}/purchases/${r.id}/post`)).body;
    expect(posted.number).toBe("MC-VF-2026-00001");
    const after = (await call("GET", `${C()}/purchases/${r.id}`)).body;
    expect(after).toMatchObject({ grossTotal: "10559.00", vatTotal: "1611.00", receivedDate: "2026-10-07" });
    expect(after.lines[0].itemId).toBe(svc!.id);
    expect(await t.db.select().from(supplierItemMap)).toHaveLength(1);
    // prilog na proknizena: ne se brise
    const f = await call("POST", `${C()}/purchases/${r.id}/files`, { name: "x.pdf", base64: PDF });
    expect(f.status).toBe(201);
    expect((await call("DELETE", `${C()}/purchases/${r.id}/files/${f.body.id}`)).status).toBe(409);
    expect((await call("POST", `${C()}/purchases/${r.id}/files`, { name: "x.exe", base64: Buffer.from("MZ....").toString("base64") })).status).toBe(422);

    const open = await openItems(t.db, t.c1.id, "out");
    expect(open[0]).toMatchObject({ amount: "10559.00", supplierNumber: "26-307-006229" });

    // storno -> povtoren uvoz e dozvolen i ja koristi nauchenata stavka
    expect((await call("POST", `${C()}/purchases/${r.id}/void`, { reason: "Тест", date: "2026-10-08" })).status).toBe(200);
    const r2 = (await call("POST", `${C()}/purchases/import-ujp`, { text: JSON_TEXT })).body;
    expect(r2.mapped).toBe(1);
  });
});
