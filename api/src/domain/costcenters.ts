/**
 * Трошковни места (docs/14). Правило: ставката го зема своето ТМ, инаку ТМ од документот, инаку „без ТМ“.
 * ТМ не е дел од фактурата кон купувачот (не оди во PDF ни кон УЈП) → смее да се смени и по издавање, со запис во ревизијата.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Decimal as D } from "decimal.js";
import * as s from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "./errors.js";
import { audit, type Actor } from "./audit.js";

const rowsOf = (r: unknown) => (Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? []) as Record<string, string | number | null>[];

/** Сите ТМ (освен null) мора да се на фирмата и активни. */
export async function assertCostCenters(tx: Db, clientId: number, ids: (number | null | undefined)[]) {
  const want = [...new Set(ids.filter((x): x is number => !!x))];
  if (!want.length) return;
  const got = await tx.select().from(s.costCenters).where(and(eq(s.costCenters.clientId, clientId), inArray(s.costCenters.id, want)));
  if (got.length !== want.length) throw new DomainError("validation", "Непознато трошковно место.", 422);
  const off = got.filter((c) => !c.isActive);
  if (off.length) throw new DomainError("validation", `Трошковното место ${off.map((c) => c.code).join(", ")} е исклучено.`, 422);
}

/** Режим „задолжително“: документот или секоја ставка мора да има ТМ. Враќа порака за грешка или null. */
export function missingCostCenter(mode: string, header: number | null, lines: { costCenterId: number | null }[]): string | null {
  if (mode !== "required" || header) return null;
  return lines.length && lines.every((l) => l.costCenterId) ? null : "Изберете трошковно место (задолжително за оваа фирма).";
}

type Kind = "invoice" | "purchase";
const T = {
  invoice: { head: s.invoices, line: s.invoiceLines, fk: s.invoiceLines.invoiceId, entity: "invoice" },
  purchase: { head: s.purchaseInvoices, line: s.purchaseLines, fk: s.purchaseLines.purchaseInvoiceId, entity: "purchase" },
} as const;

/** Промена на ТМ (и пред и по издавање/книжење). lines: само ставките што се менуваат. */
export async function setCostCenter(db: Db, kind: Kind, clientId: number, id: number,
  b: { costCenterId: number | null; lines?: { id: number; costCenterId: number | null }[] }, actor: Actor & { userId: number }) {
  return db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const t = T[kind];
    const [doc] = kind === "invoice"
      ? await tx.select({ id: s.invoices.id, cc: s.invoices.costCenterId, status: s.invoices.status, number: s.invoices.number }).from(s.invoices)
        .where(and(eq(s.invoices.id, id), eq(s.invoices.clientId, clientId))).for("update")
      : await tx.select({ id: s.purchaseInvoices.id, cc: s.purchaseInvoices.costCenterId, status: s.purchaseInvoices.status, number: s.purchaseInvoices.number }).from(s.purchaseInvoices)
        .where(and(eq(s.purchaseInvoices.id, id), eq(s.purchaseInvoices.clientId, clientId))).for("update");
    if (!doc) throw new DomainError("not_found", "Документот не постои.", 404);
    if (["cancelled_draft", "voided"].includes(doc.status)) throw new DomainError("validation", "Откажан или сторниран документ не се менува.", 422);
    await assertCostCenters(tx, clientId, [b.costCenterId, ...(b.lines ?? []).map((l) => l.costCenterId)]);
    const cur = await tx.select({ id: t.line.id, cc: t.line.costCenterId }).from(t.line).where(eq(t.fk, id));
    const changes: Record<string, unknown> = {};
    const lineChanges: unknown[] = [];
    if ((doc.cc ?? null) !== (b.costCenterId ?? null)) {
      await tx.update(t.head).set({ costCenterId: b.costCenterId }).where(eq(t.head.id, id));
      changes.costCenter = { from: doc.cc, to: b.costCenterId };
    }
    for (const l of b.lines ?? []) {
      const c = cur.find((x) => x.id === l.id);
      if (!c) throw new DomainError("validation", "Непозната ставка.", 422);
      if ((c.cc ?? null) === (l.costCenterId ?? null)) continue;
      await tx.update(t.line).set({ costCenterId: l.costCenterId }).where(eq(t.line.id, l.id));
      lineChanges.push({ line: l.id, from: c.cc, to: l.costCenterId });
    }
    if (lineChanges.length) changes.lines = lineChanges;
    if (Object.keys(changes).length) await audit(tx, actor, { clientId, entity: t.entity, entityId: id, action: "cost_center", changes });
    return { ok: true, changed: Object.keys(changes).length > 0 };
  });
}

export interface AssignFilter { kind: Kind; from: string; to: string; partnerId?: number | null; onlyEmpty: boolean; costCenterId: number; dryRun: boolean }

/** Масовно доделување ТМ на документи (на ниво на документ). Ставките со свое ТМ остануваат. */
export async function assignCostCenter(db: Db, clientId: number, f: AssignFilter, actor: Actor & { userId: number }) {
  await assertCostCenters(db, clientId, [f.costCenterId]);
  const ids = rowsOf(await db.execute(f.kind === "invoice"
    ? sql`select id from invoices where client_id = ${clientId} and doc_type <> 'PF' and status not in ('cancelled_draft','voided')
        and issue_date between ${f.from} and ${f.to} ${f.partnerId ? sql`and partner_id = ${f.partnerId}` : sql``}
        ${f.onlyEmpty ? sql`and cost_center_id is null` : sql`and cost_center_id is distinct from ${f.costCenterId}`} order by id`
    : sql`select id from purchase_invoices where client_id = ${clientId} and status <> 'voided'
        and received_date between ${f.from} and ${f.to} ${f.partnerId ? sql`and partner_id = ${f.partnerId}` : sql``}
        ${f.onlyEmpty ? sql`and cost_center_id is null` : sql`and cost_center_id is distinct from ${f.costCenterId}`} order by id`)).map((r) => Number(r.id));
  if (f.dryRun || !ids.length) return { count: ids.length, applied: false };
  await db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const t = T[f.kind];
    for (let i = 0; i < ids.length; i += 500)
      await tx.update(t.head).set({ costCenterId: f.costCenterId }).where(inArray(t.head.id, ids.slice(i, i + 500)));
    await audit(tx, actor, { clientId, entity: "cost_center", entityId: f.costCenterId, action: "assign",
      changes: { kind: f.kind, from: f.from, to: f.to, partnerId: f.partnerId ?? null, onlyEmpty: f.onlyEmpty, count: ids.length } });
  });
  return { count: ids.length, applied: true };
}

/**
 * Извештај по ТМ за период. Приходи = КИФ (иста селекција: издадени по датум на издавање, сторно со минус, корекција = разлика),
 * трошоци = КУФ (прокнижени по датум на прием). Нето износи (без ДДВ).
 */
export async function costCenterReport(db: Db, clientId: number, from: string, to: string) {
  const rev = rowsOf(await db.execute(sql`
    with docs as (
      select i.id, i.cost_center_id hcc, 1 sgn from invoices i
      where i.client_id = ${clientId} and i.doc_type <> 'PF' and i.number is not null
        and i.status in ('issued','json_exported','sent_to_ujp','corrected','voided') and i.issue_date between ${from} and ${to}
      union all
      select o.id, o.cost_center_id, -1 from invoices k join invoices o on o.id = k.related_invoice_id
      where k.client_id = ${clientId} and k.doc_type = 'KR' and k.number is not null
        and k.status in ('issued','json_exported','sent_to_ujp','corrected','voided') and k.issue_date between ${from} and ${to})
    select coalesce(l.cost_center_id, d.hcc) cc, sum(d.sgn * l.net_amount) net, count(distinct d.id) filter (where d.sgn = 1) docs
    from docs d join invoice_lines l on l.invoice_id = d.id group by 1`));
  const cost = rowsOf(await db.execute(sql`
    select coalesce(l.cost_center_id, x.cost_center_id) cc, sum(l.net_amount) net, count(distinct x.id) docs
    from purchase_invoices x join purchase_lines l on l.purchase_invoice_id = x.id
    where x.client_id = ${clientId} and x.status = 'posted' and x.received_date between ${from} and ${to} group by 1`));
  const ccs = await db.select().from(s.costCenters).where(eq(s.costCenters.clientId, clientId)).orderBy(asc(s.costCenters.code));
  const key = (v: unknown) => (v === null || v === undefined ? "none" : String(v));
  const rows = [...ccs.map((c) => ({ id: c.id as number | null, code: c.code, name: c.name, isActive: c.isActive })),
    { id: null, code: "", name: "Без трошковно место", isActive: true }].map((c) => {
    const r = rev.find((x) => key(x.cc) === key(c.id)), k = cost.find((x) => key(x.cc) === key(c.id));
    const revenue = new D(String(r?.net ?? 0)).toDecimalPlaces(2), costs = new D(String(k?.net ?? 0)).toDecimalPlaces(2);
    return { ...c, revenue: revenue.toFixed(2), costs: costs.toFixed(2), result: revenue.minus(costs).toFixed(2),
      revenueDocs: Number(r?.docs ?? 0), costDocs: Number(k?.docs ?? 0) };
  }).filter((r) => r.id !== null || Number(r.revenue) || Number(r.costs));
  const sum = (f: "revenue" | "costs" | "result") => rows.reduce((a, r) => a.plus(r[f]), new D(0)).toFixed(2);
  return { from, to, rows, totals: { revenue: sum("revenue"), costs: sum("costs"), result: sum("result") } };
}

/** Документи за едно ТМ (null = без ТМ) за drill-down. */
export async function costCenterDocs(db: Db, clientId: number, ccId: number | null, from: string, to: string) {
  const ccCond = (expr: ReturnType<typeof sql>) => (ccId === null ? sql`${expr} is null` : sql`${expr} = ${ccId}`);
  const inv = rowsOf(await db.execute(sql`
    select i.id, i.number, i.doc_type, i.issue_date d, coalesce(i.buyer_name, p.name) partner, sum(l.net_amount) net
    from invoices i join partners p on p.id = i.partner_id join invoice_lines l on l.invoice_id = i.id
    where i.client_id = ${clientId} and i.doc_type <> 'PF' and i.number is not null
      and i.status in ('issued','json_exported','sent_to_ujp','corrected','voided') and i.issue_date between ${from} and ${to}
      and ${ccCond(sql`coalesce(l.cost_center_id, i.cost_center_id)`)}
    group by i.id, p.name order by i.issue_date, i.id limit 2000`));
  const pur = rowsOf(await db.execute(sql`
    select x.id, x.number, x.supplier_number, x.received_date d, p.name partner, sum(l.net_amount) net
    from purchase_invoices x join partners p on p.id = x.partner_id join purchase_lines l on l.purchase_invoice_id = x.id
    where x.client_id = ${clientId} and x.status = 'posted' and x.received_date between ${from} and ${to}
      and ${ccCond(sql`coalesce(l.cost_center_id, x.cost_center_id)`)}
    group by x.id, p.name order by x.received_date, x.id limit 2000`));
  return {
    invoices: inv.map((r) => ({ id: Number(r.id), number: String(r.number), docType: String(r.doc_type), date: String(r.d), partner: String(r.partner), net: new D(String(r.net)).toFixed(2) })),
    purchases: pur.map((r) => ({ id: Number(r.id), number: String(r.number ?? ""), supplierNumber: String(r.supplier_number), date: String(r.d), partner: String(r.partner), net: new D(String(r.net)).toFixed(2) })),
  };
}
