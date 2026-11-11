/**
 * ИОС, компензации, опомени (docs/12). Модул „Плаќања и наплата“.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { clients, compensations, dunningLetters, partners } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "../domain/errors.js";
import { renderSimpleDoc, m2, day } from "../domain/pdf-docs.js";
import { compensationCandidates, compensationDetail, createCompensation, createDunning, DUNNING_TITLE, dunningCandidates, iosFor, iosSummary, voidCompensation } from "../domain/receivables.js";
import { assertModule, requireUser } from "../auth/context.js";
import { Id } from "./master.js";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Датум ГГГГ-ММ-ДД");
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Skopje" });
const Amount = z.coerce.number().positive().max(1e12);

export async function receivableRoutes(app: FastifyInstance, { db }: { db: Db }) {
  const ctx = async (req: FastifyRequest) => {
    const u = requireUser(req);
    const p = z.object({ clientId: Id, id: Id.optional(), partnerId: Id.optional() }).parse(req.params);
    await assertModule(db, u, p.clientId, "payments");
    const [client] = await db.select().from(clients).where(eq(clients.id, p.clientId));
    return { u, client: client!, ...p, actor: { userId: u.id, ip: req.ip } };
  };
  const pdf = (reply: { header: (k: string, v: string) => unknown; send: (b: Buffer) => unknown }, name: string, b: Buffer) => {
    (reply.header("content-type", "application/pdf") as typeof reply).header("content-disposition", `inline; filename="${encodeURIComponent(name)}.pdf"`);
    return reply.send(b);
  };
  const party = (p: typeof partners.$inferSelect) => ({ name: p.name, edb: p.edb, address: p.address, city: p.city });
  const banks = (c: typeof clients.$inferSelect) => (c.pdfSettings?.bankAccounts?.length ? c.pdfSettings.bankAccounts : c.iban ? [{ account: c.iban, bank: c.bankName ?? "" }] : [])
    .map((b) => `${b.account}${b.bank ? ` (${b.bank})` : ""}`).join(", ");

  /* ------------------------------------------------------------------ ИОС */
  app.get("/api/clients/:clientId/ios", async (req) => {
    const { client } = await ctx(req);
    const { asOf } = z.object({ asOf: Day.default(today()) }).parse(req.query);
    return iosSummary(db, client.id, asOf);
  });
  app.get("/api/clients/:clientId/ios/:partnerId", async (req) => {
    const { client, partnerId } = await ctx(req);
    const { asOf } = z.object({ asOf: Day.default(today()) }).parse(req.query);
    return iosFor(db, client.id, partnerId!, asOf);
  });
  app.get("/api/clients/:clientId/ios/:partnerId/pdf", async (req, reply) => {
    const { client, partnerId } = await ctx(req);
    const { asOf } = z.object({ asOf: Day.default(today()) }).parse(req.query);
    const i = await iosFor(db, client.id, partnerId!, asOf);
    const bal = Number(i.balance);
    const cols = [{ title: "Документ", width: 34 }, { title: "Датум", width: 14 }, { title: "Рок", width: 14 },
      { title: "Износ", width: 19, align: "right" as const }, { title: "Отворено", width: 19, align: "right" as const }];
    const rows = (ls: typeof i.receivable) => ls.map((l) => [l.number, day(l.date), day(l.dueDate), m2(l.amount), m2(l.remaining)]);
    const b = await renderSimpleDoc({
      client, title: "Извод на отворени ставки (ИОС)", date: today(), meta: [["Состојба на ден", day(asOf)]], partner: party(i.partner), partnerLabel: "До",
      intro: [`Според нашата евиденција, на ден ${day(asOf)} отворени се следните ставки.`],
      sections: [
        ...(i.receivable.length ? [{ heading: "Наши побарувања (наши фактури)", cols, rows: rows(i.receivable), total: ["Вкупно", "", "", "", m2(i.totalReceivable)] }] : []),
        ...(i.payable.length ? [{ heading: "Наши обврски (ваши фактури)", cols, rows: rows(i.payable), total: ["Вкупно", "", "", "", m2(i.totalPayable)] }] : []),
        ...(i.unallocated.length ? [{ heading: "Нераспоредени уплати / плаќања", cols, rows: i.unallocated.map((u) => [`${u.kind === "advance_in" ? "Ваша уплата" : "Наше плаќање"} ${u.number}`, day(u.date), "", m2(u.amount), m2(u.remaining)]) }] : []),
      ],
      outro: [
        bal > 0 ? `САЛДО: Вие ни должите ${m2(bal)} ден.` : bal < 0 ? `САЛДО: Ние ви должиме ${m2(-bal)} ден.` : "САЛДО: нема меѓусебен долг.",
        "Ве молиме да го потврдите или оспорите салдото и да ни вратите еден потпишан и заверен примерок.",
        "[   ] Го потврдуваме салдото.        [   ] Го оспоруваме салдото. Причина: ________________________________________",
      ],
      signatures: [`За ${client.name}`, `За ${i.partner.name}`],
    });
    return pdf(reply, `ИОС ${i.partner.name} ${asOf}`, b);
  });

  /* ---------------------------------------------------------- компензации */
  app.get("/api/clients/:clientId/compensations", async (req) => {
    const { client } = await ctx(req);
    return db.select({ c: compensations, partnerName: partners.name }).from(compensations).innerJoin(partners, eq(partners.id, compensations.partnerId))
      .where(eq(compensations.clientId, client.id)).orderBy(desc(compensations.docDate), desc(compensations.id)).limit(500)
      .then((r) => r.map((x) => ({ ...x.c, partnerName: x.partnerName })));
  });
  app.get("/api/clients/:clientId/compensations/candidates/:partnerId", async (req) => {
    const { client, partnerId } = await ctx(req);
    return compensationCandidates(db, client.id, partnerId!);
  });
  app.post("/api/clients/:clientId/compensations", async (req, reply) => {
    const { client, actor } = await ctx(req);
    const b = z.object({ partnerId: Id, date: Day, note: z.string().trim().max(1000).optional().nullable(),
      invoices: z.array(z.object({ id: Id, amount: Amount })).min(1), purchases: z.array(z.object({ id: Id, amount: Amount })).min(1) }).parse(req.body);
    const c = await createCompensation(db, client.id, b, actor);
    return reply.status(201).send(c);
  });
  app.post("/api/clients/:clientId/compensations/:id/void", async (req) => {
    const { client, id, actor } = await ctx(req);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    return voidCompensation(db, client.id, id!, reason, actor);
  });
  app.get("/api/clients/:clientId/compensations/:id/pdf", async (req, reply) => {
    const { client, id } = await ctx(req);
    const c = await compensationDetail(db, client.id, id!);
    const cols = [{ title: "Документ", width: 50 }, { title: "Датум", width: 20 }, { title: "Износ за компензација", width: 30, align: "right" as const }];
    const b = await renderSimpleDoc({
      client, title: c.voidedAt ? "Изјава за компензација – СТОРНИРАНА" : "Изјава за компензација", number: c.number, date: c.docDate,
      partner: party(c.partner), partnerLabel: "Втора страна",
      intro: [`${client.name} и ${c.partner.name} се согласуваат меѓусебните побарувања и обврски да ги пребијат (компензираат) во износ од ${m2(c.amount)} ден.`],
      sections: [
        { heading: `Побарувања на ${client.name} (фактури кон ${c.partner.name})`, cols, rows: c.invoices.map((x) => [x.number, day(x.date), m2(x.amount)]), total: ["Вкупно", "", m2(c.amount)] },
        { heading: `Побарувања на ${c.partner.name} (фактури кон ${client.name})`, cols, rows: c.purchases.map((x) => [x.number, day(x.date), m2(x.amount)]), total: ["Вкупно", "", m2(c.amount)] },
      ],
      outro: [`Со оваа изјава наведените износи се сметаат за платени на ден ${day(c.docDate)}. Изјавата е изготвена во два истоветни примерока, по еден за секоја страна.`,
        ...(c.note ? [c.note] : []), ...(c.voidedAt ? [`Сторнирана: ${c.voidReason ?? ""}`] : [])],
      signatures: [`За ${client.name}`, `За ${c.partner.name}`],
    });
    return pdf(reply, c.number, b);
  });

  /* -------------------------------------------------------------- опомени */
  app.get("/api/clients/:clientId/dunning", async (req) => {
    const { client } = await ctx(req);
    const { minDays } = z.object({ minDays: z.coerce.number().int().min(1).max(3650).default(1) }).parse(req.query);
    return dunningCandidates(db, client.id, minDays);
  });
  app.get("/api/clients/:clientId/dunning/letters", async (req) => {
    const { client } = await ctx(req);
    return db.select({ l: dunningLetters, partnerName: partners.name }).from(dunningLetters).innerJoin(partners, eq(partners.id, dunningLetters.partnerId))
      .where(eq(dunningLetters.clientId, client.id)).orderBy(desc(dunningLetters.docDate), desc(dunningLetters.id)).limit(500)
      .then((r) => r.map((x) => ({ ...x.l, partnerName: x.partnerName })));
  });
  app.post("/api/clients/:clientId/dunning", async (req, reply) => {
    const { client, actor } = await ctx(req);
    const b = z.object({ partnerId: Id, level: z.number().int().min(1).max(3), date: Day.default(today()), minDays: z.number().int().min(1).optional() }).parse(req.body);
    const [p] = await db.select({ id: partners.id }).from(partners).where(and(eq(partners.id, b.partnerId), eq(partners.clientId, client.id)));
    if (!p) throw new DomainError("validation", "Купувачот не постои.", 422);
    return reply.status(201).send(await createDunning(db, client.id, b, actor));
  });
  app.get("/api/clients/:clientId/dunning/letters/:id/pdf", async (req, reply) => {
    const { client, id } = await ctx(req);
    const [l] = await db.select().from(dunningLetters).where(and(eq(dunningLetters.id, id!), eq(dunningLetters.clientId, client.id)));
    if (!l) throw new DomainError("not_found", "Опомената не постои.", 404);
    const [p] = await db.select().from(partners).where(eq(partners.id, l.partnerId));
    const text: Record<number, string[]> = {
      1: ["Според нашата евиденција, следните фактури не се платени до рокот на плаќање.",
        "Ве молиме да ги платите во рок од 8 дена од приемот на оваа опомена."],
      2: ["Ве потсетуваме дека следните фактури сè уште не се платени, иако веќе ви испративме опомена.",
        "Ве молиме да ги платите во рок од 8 дена. Ако имате приговор за износот, известете нè веднаш."],
      3: ["Следните фактури не се платени и покрај претходните опомени.",
        "Ако не ги платите во рок од 8 дена, ќе побараме присилна наплата преку надлежен орган. Тогаш ќе ги побараме и трошоците на постапката и законската казнена камата."],
    };
    const b = await renderSimpleDoc({
      client, title: DUNNING_TITLE[l.level]!, date: l.docDate, partner: party(p!), partnerLabel: "До",
      intro: text[l.level],
      sections: [{ cols: [{ title: "Фактура", width: 34 }, { title: "Рок", width: 18 }, { title: "Денови доцнење", width: 18, align: "right" }, { title: "Неплатено", width: 30, align: "right" }],
        rows: l.items.map((i) => [i.number, day(i.dueDate), String(i.daysOverdue), m2(i.remaining)]), total: ["Вкупно", "", "", m2(l.amount)] }],
      outro: [`Уплатата направете ја на жиро-сметка ${banks(client) || "(внесете ја во Поставки)"}. Во „повикување на број“ наведете го бројот на фактурата.`,
        "Ако сте ги платиле фактурите во меѓувреме, занемарете ја оваа опомена и испратете ни доказ за плаќањето."],
      signatures: [`За ${client.name}`],
    });
    return pdf(reply, `${DUNNING_TITLE[l.level]} ${p!.name} ${l.docDate}`, b);
  });
}
