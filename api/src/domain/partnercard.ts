/**
 * Картица на партнер (docs/14): движења со почетно салдо и тековно салдо.
 *   customer: фактури (должи) – уплати, одобренија, сторна (побарува); салдо > 0 = партнерот ни должи.
 *   supplier: влезни фактури (побарува) – наши плаќања (должи); салдо > 0 = ние должиме.
 *   both:     сè заедно од страна на купувач (наши плаќања и нивни фактури се спротивни); салдо = салдото во ИОС.
 * Сторнирана фактура + сторно = 0; корекција: оригиналот + разлика (KR − оригинал) = KR. Исто како КИФ и ИОС.
 */
import { and, eq, sql } from "drizzle-orm";
import { Decimal as D } from "decimal.js";
import * as s from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "./errors.js";

export type Side = "customer" | "supplier" | "both";
const rowsOf = (r: unknown) => (Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? []) as Record<string, string | number | null>[];
const DOC: Record<string, string> = { INV: "Фактура", AV: "Авансна фактура", KZ: "Книжно задолжување", KR: "Корекција (разлика)", OD: "Книжно одобрение",
  ST: "Сторно", VF: "Влезна фактура", PIN: "Уплата", POUT: "Плаќање" };

/** Сите движења на партнерите на фирмата (или на еден) до датум; amount > 0 = должи, < 0 = побарува (од страна на купувач). */
function movements(clientId: number, partnerId: number | null, to: string) {
  const p = (col: string) => (partnerId ? sql.raw(`and ${col} = ${Number(partnerId)}`) : sql``);
  return sql`
    select i.partner_id pid, i.issue_date d, i.doc_type::text t, i.number no, i.id doc, 'invoice' src, 'customer' side, r.number rel,
      case when i.doc_type in ('ST','OD') then -abs(coalesce(i.payable_amount, round(i.gross_total, 0)))
           when i.doc_type = 'KR' then coalesce(i.payable_amount, round(i.gross_total, 0)) - coalesce(r.payable_amount, round(r.gross_total, 0))
           else coalesce(i.payable_amount, round(i.gross_total, 0)) end amt
    from invoices i left join invoices r on r.id = i.related_invoice_id
    where i.client_id = ${clientId} ${p("i.partner_id")} and i.doc_type <> 'PF' and i.number is not null
      and i.status in ('issued','json_exported','sent_to_ujp','corrected','voided') and i.issue_date <= ${to}
    union all
    select x.partner_id, x.received_date, 'VF', coalesce(x.number, '') || ' (' || x.supplier_number || ')', x.id, 'purchase', 'supplier', null,
      -coalesce(x.payable_amount, x.gross_total)
    from purchase_invoices x where x.client_id = ${clientId} ${p("x.partner_id")} and x.status = 'posted' and x.received_date <= ${to}
    union all
    select y.partner_id, y.pay_date, case when y.direction = 'in' then 'PIN' else 'POUT' end,
      coalesce(nullif(y.reference, ''), y.note, ''), y.id, 'payment', case when y.direction = 'in' then 'customer' else 'supplier' end, y.method::text,
      case when y.direction = 'in' then -y.amount else y.amount end
    from payments y where y.client_id = ${clientId} ${p("y.partner_id")} and y.voided_at is null and y.pay_date <= ${to} and y.partner_id is not null`;
}
const sideFilter = (side: Side) => (side === "both" ? sql`true` : sql`side = ${side}`);

export interface CardRow { date: string; type: string; typeName: string; number: string; doc: number; src: string; note: string | null; debit: string; credit: string; balance: string }

export async function partnerCard(db: Db, clientId: number, partnerId: number, side: Side, from: string, to: string) {
  const [partner] = await db.select().from(s.partners).where(and(eq(s.partners.id, partnerId), eq(s.partners.clientId, clientId)));
  if (!partner) throw new DomainError("not_found", "Партнерот не постои.", 404);
  const all = rowsOf(await db.execute(sql`select * from (${movements(clientId, partnerId, to)}) m where ${sideFilter(side)} order by d, src, doc`));
  // kaj dobavuvac saldoto e od nasa strana: pozitivno = nie dolzime -> se prevrtuva znakot
  const sign = side === "supplier" ? -1 : 1;
  let bal = new D(0);
  for (const m of all.filter((x) => String(x.d) < from)) bal = bal.plus(new D(String(m.amt)).times(sign));
  const opening = bal;
  let deb = new D(0), cred = new D(0);
  const rows: CardRow[] = all.filter((x) => String(x.d) >= from).map((m) => {
    const a = new D(String(m.amt));
    // kolonite: kaj kupuvac "должи" = a > 0; kaj dobavuvac "должи" = nase placanje (a > 0 vo kupuvac-perspektiva)
    const debit = a.gt(0) ? a : new D(0), credit = a.lt(0) ? a.neg() : new D(0);
    deb = deb.plus(debit); cred = cred.plus(credit);
    bal = bal.plus(a.times(sign));
    const t = String(m.t);
    const note = m.src === "payment" ? (m.rel === "compensation" ? "компензација" : null)
      : t === "KR" ? `кон ${m.rel ?? ""}` : (t === "ST" || t === "OD") && m.rel ? `кон ${m.rel}` : null;
    return { date: String(m.d), type: t, typeName: DOC[t] ?? t, number: String(m.no ?? ""), doc: Number(m.doc), src: String(m.src), note,
      debit: debit.toFixed(2), credit: credit.toFixed(2), balance: bal.toFixed(2) };
  });
  return { partner: { id: partner.id, name: partner.name, edb: partner.edb, address: partner.address, city: partner.city }, side, from, to,
    opening: opening.toFixed(2), debit: deb.toFixed(2), credit: cred.toFixed(2), closing: bal.toFixed(2), rows };
}

/** Збирно по партнери: почетно, промет, крајно. */
export async function partnerCardSummary(db: Db, clientId: number, side: Side, from: string, to: string) {
  const sign = side === "supplier" ? -1 : 1;
  const r = rowsOf(await db.execute(sql`
    select m.pid, p.name, p.edb,
      coalesce(sum(m.amt) filter (where m.d < ${from}), 0) * ${sign} opening,
      coalesce(sum(m.amt) filter (where m.d >= ${from} and m.amt > 0), 0) debit,
      coalesce(-sum(m.amt) filter (where m.d >= ${from} and m.amt < 0), 0) credit,
      coalesce(sum(m.amt), 0) * ${sign} closing
    from (${movements(clientId, null, to)}) m join partners p on p.id = m.pid
    where ${sideFilter(side)} group by m.pid, p.name, p.edb
    having coalesce(sum(m.amt), 0) <> 0 or count(*) filter (where m.d >= ${from}) > 0
    order by abs(coalesce(sum(m.amt), 0)) desc, p.name`));
  const rows = r.map((x) => ({ partnerId: Number(x.pid), name: String(x.name), edb: (x.edb as string | null) ?? null,
    opening: new D(String(x.opening)).toFixed(2), debit: new D(String(x.debit)).toFixed(2), credit: new D(String(x.credit)).toFixed(2), closing: new D(String(x.closing)).toFixed(2) }));
  const sum = (k: "opening" | "debit" | "credit" | "closing") => rows.reduce((a, x) => a.plus(x[k]), new D(0)).toFixed(2);
  return { side, from, to, rows, totals: { opening: sum("opening"), debit: sum("debit"), credit: sum("credit"), closing: sum("closing") } };
}
