import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { testDb } from "./helpers.js";
import { buildApp } from "../src/app.js";
import { clientAccess, partnerNotes, users } from "../src/db/schema.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";

let t: Awaited<ReturnType<typeof testDb>>;
let app: FastifyInstance;
let ana: string;
beforeEach(async () => {
  t = await testDb();
  app = await buildApp({ db: t.db, version: "t", logLevel: "silent", publicUrl: "https://ef.test", appKey: randomBytes(32).toString("base64") });
  const [a] = await t.db.insert(users).values({ email: "ana@x.mk", displayName: "Ана", provider: "entra", role: "accountant" }).returning();
  await t.db.insert(clientAccess).values({ clientId: t.c1.id, userId: a!.id });
  ana = `${SESSION_COOKIE}=${await createSession(t.db, a!.id, true, {})}`;
});
async function call(method: string, url: string, payload?: unknown) {
  const r = await app.inject({ method: method as never, url, payload: payload as never, headers: { cookie: ana, ...(method === "GET" ? {} : { "x-efaktura": "1" }) } });
  return { status: r.statusCode, body: r.body ? r.json() : null };
}
const base = () => `/api/clients/${t.c1.id}/partners/${t.p1.id}`;
const day = (d: number) => new Date(Date.now() + d * 864e5).toLocaleDateString("sv-SE", { timeZone: "Europe/Skopje" });

describe("kupuvaci: kontakti, istorija, potsetnici", () => {
  it("kontakti: samo eden glaven; tug kupuvac 404", async () => {
    const a = (await call("POST", `${base()}/contacts`, { name: "Марија Петровска", role: "Сметководство", mobile: "070 123 456", isPrimary: true })).body;
    const b = (await call("POST", `${base()}/contacts`, { name: "Петар Илиев", phone: "02 3123 456", isPrimary: true })).body;
    const card = (await call("GET", base())).body;
    expect(card.contacts.map((c: { name: string; isPrimary: boolean }) => [c.name, c.isPrimary])).toEqual([["Петар Илиев", true], ["Марија Петровска", false]]);
    expect(a.id).not.toBe(b.id);
    expect((await call("POST", `${base()}/contacts`, { name: "X", email: "не-е-пошта" })).status).toBe(400);
    expect((await call("GET", `/api/clients/${t.c2.id}/partners/${t.p2.id}`)).status).toBe(404);
  });

  it("istorija: zapis so kontakt i potsetnik; potsetnicite po datum; zatvoranje", async () => {
    const c = (await call("POST", `${base()}/contacts`, { name: "Марија" })).body;
    await call("POST", `${base()}/notes`, { kind: "call", text: "Бара попуст за 2027, да се јави по Нова година.", contactId: c.id, followUpAt: day(-1) });
    await call("POST", `${base()}/notes`, { kind: "note", text: "Плаќа редовно, но секогаш на последниот ден." });
    const n3 = (await call("POST", `${base()}/notes`, { kind: "meeting", text: "Состанок за договор.", followUpAt: day(3) })).body;
    await call("POST", `${base()}/notes`, { kind: "email", text: "Далечна задача.", followUpAt: day(30) });
    const card = (await call("GET", base())).body;
    expect(card.notes).toHaveLength(4);
    expect(card.notes[0].author).toBe("Ана");
    const f = (await call("GET", `/api/clients/${t.c1.id}/followups`)).body;
    expect(f.map((x: { overdue: boolean; followUpAt: string }) => [x.followUpAt, x.overdue])).toEqual([[day(-1), true], [day(3), false]]);
    expect(f[0].partnerName).toBe("Купувач А");
    await call("POST", `${base()}/notes/${n3.id}/done`);
    expect((await call("GET", `/api/clients/${t.c1.id}/followups`)).body).toHaveLength(1);
  });

  it("zapisite ne se menuvaat i ne se brisat (baza)", async () => {
    const n = (await call("POST", `${base()}/notes`, { text: "Првичен запис" })).body;
    const err = async (p: PromiseLike<unknown>) => { try { await p; return ""; } catch (e) { return ((e as { cause?: Error }).cause ?? (e as Error)).message; } };
    expect(await err(t.db.update(partnerNotes).set({ text: "сменето" }).where(eq(partnerNotes.id, n.id)))).toMatch(/не се менуваат/);
    expect(await err(t.db.execute(sql`delete from partner_notes`))).toMatch(/не се бришат/);
  });
});
