/** Картица на партнер и збирен преглед (docs/14): JSON, CSV (Excel), PDF. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { clients } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { partnerCard, partnerCardSummary } from "../domain/partnercard.js";
import { renderSimpleDoc, m2, day } from "../domain/pdf-docs.js";
import { assertClientAccess, requireUser } from "../auth/context.js";
import { Id } from "./master.js";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Датум ГГГГ-ММ-ДД");
const Q = z.object({ side: z.enum(["customer", "supplier", "both"]).default("both"), from: Day, to: Day, format: z.enum(["json", "csv", "pdf"]).default("json") });
const n = (v: string) => v.replace(".", ",");
const q = (s: string | null) => { const t = s ?? ""; return /[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
const TITLE = { customer: "Картица на купувач", supplier: "Картица на добавувач", both: "Картица на партнер" } as const;
const csvOut = (reply: { header: (k: string, v: string) => unknown; send: (b: string) => unknown }, name: string, lines: string[]) => {
  (reply.header("content-type", "text/csv; charset=utf-8") as typeof reply).header("content-disposition", `attachment; filename="${encodeURIComponent(name)}.csv"`);
  return reply.send(`﻿${lines.join("\r\n")}\r\n`);
};

export async function partnerCardRoutes(app: FastifyInstance, { db }: { db: Db }) {
  const ctx = async (req: FastifyRequest) => {
    const u = requireUser(req);
    const p = z.object({ clientId: Id, partnerId: Id.optional() }).parse(req.params);
    await assertClientAccess(db, u, p.clientId);
    return p;
  };

  app.get("/api/clients/:clientId/partners/:partnerId/card", async (req, reply) => {
    const { clientId, partnerId } = await ctx(req);
    const o = Q.parse(req.query);
    const c = await partnerCard(db, clientId, partnerId!, o.side, o.from, o.to);
    if (o.format === "json") return c;
    const name = `${TITLE[o.side]} ${c.partner.name} ${o.from}_${o.to}`;
    if (o.format === "csv") return csvOut(reply, name, ["Датум;Вид;Документ;Забелешка;Должи;Побарува;Салдо",
      `${o.from};Почетно салдо;;;;;${n(c.opening)}`,
      ...c.rows.map((r) => [r.date, r.typeName, q(r.number), q(r.note), n(r.debit), n(r.credit), n(r.balance)].join(";")),
      `${o.to};Промет и крајно салдо;;;${n(c.debit)};${n(c.credit)};${n(c.closing)}`]);
    const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
    const pdf = await renderSimpleDoc({
      client: client!, title: TITLE[o.side], date: o.to, meta: [["Период", `${day(o.from)} – ${day(o.to)}`]], partner: c.partner, partnerLabel: "Партнер",
      intro: [o.side === "supplier" ? "Салдото е нашата обврска кон добавувачот (позитивно = ние должиме)." : "Салдото е побарувањето од партнерот (позитивно = партнерот ни должи)."],
      sections: [{ cols: [{ title: "Датум", width: 13 }, { title: "Вид", width: 18 }, { title: "Документ", width: 27 }, { title: "Должи", width: 14, align: "right" },
        { title: "Побарува", width: 14, align: "right" }, { title: "Салдо", width: 14, align: "right" }],
        rows: [[day(o.from), "Почетно салдо", "", "", "", m2(c.opening)],
          ...c.rows.map((r) => [day(r.date), r.typeName, `${r.number}${r.note ? ` (${r.note})` : ""}`, m2(r.debit), m2(r.credit), m2(r.balance)])],
        total: ["", "Промет / салдо", "", m2(c.debit), m2(c.credit), m2(c.closing)] }],
      signatures: [`За ${client!.name}`],
    });
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="${encodeURIComponent(name)}.pdf"`).send(pdf);
  });

  app.get("/api/clients/:clientId/partner-cards", async (req, reply) => {
    const { clientId } = await ctx(req);
    const o = Q.parse(req.query);
    const r = await partnerCardSummary(db, clientId, o.side, o.from, o.to);
    if (o.format === "json") return r;
    return csvOut(reply, `Картици ${o.side} ${o.from}_${o.to}`, ["Партнер;ЕДБ;Почетно салдо;Должи;Побарува;Крајно салдо",
      ...r.rows.map((x) => [q(x.name), x.edb ?? "", n(x.opening), n(x.debit), n(x.credit), n(x.closing)].join(";")),
      ["ВКУПНО", "", n(r.totals.opening), n(r.totals.debit), n(r.totals.credit), n(r.totals.closing)].join(";")]);
  });
}
