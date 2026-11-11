/**
 * Побарувања и обврски кон партнер (docs/12): ИОС на ден, изјава за компензација, опомени.
 * Сите износи во денари; извор: издадени фактури, прокнижени влезни, плаќања (без сторнираните).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { Decimal as D } from "decimal.js";
import * as s from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "./errors.js";
import { audit, type Actor } from "./audit.js";
import { createPayment, openItems, voidPayment, RECEIVABLE_STATUSES } from "./payments.js";

const RECV = sql.raw(RECEIVABLE_STATUSES.map((x) => `'${x}'`).join(","));
const rowsOf = (r: unknown) => (Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? []) as Record<string, string | number | null>[];

export interface IosLine { kind: "invoice" | "purchase" | "advance_in" | "advance_out"; number: string; date: string; dueDate: string | null; amount: string; remaining: string }
export interface Ios { asOf: string; partner: typeof s.partners.$inferSelect; receivable: IosLine[]; payable: IosLine[]; unallocated: IosLine[];
  totalReceivable: string; totalPayable: string; totalUnallocated: string; balance: string }

/** ИОС на ден: документи до тој ден, плаќања до тој ден. balance > 0 = партнерот ни должи. */
export async function iosFor(db: Db, clientId: number, partnerId: number, asOf: string): Promise<Ios> {
  const [partner] = await db.select().from(s.partners).where(and(eq(s.partners.id, partnerId), eq(s.partners.clientId, clientId)));
  if (!partner) throw new DomainError("not_found", "Партнерот не постои.", 404);
  const paidTo = (col: string) => sql.raw(`coalesce((select sum(a.amount) from payment_allocations a join payments y on y.id = a.payment_id
    where a.${col} = x.id and y.voided_at is null and y.pay_date <= '${asOf}'), 0)`);
  const inv = rowsOf(await db.execute(sql`
    select x.number, x.issue_date d, x.due_date due, coalesce(x.payable_amount, round(x.gross_total, 0)) amount,
      coalesce((select -sum(abs(coalesce(o.payable_amount, round(o.gross_total, 0)))) from invoices o
        where o.related_invoice_id = x.id and o.doc_type = 'OD' and o.status in (${RECV}) and o.issue_date <= ${asOf}), 0) credits,
      ${paidTo("invoice_id")} paid
    from invoices x where x.client_id = ${clientId} and x.partner_id = ${partnerId} and x.doc_type in ('INV','AV','KZ','KR')
      and x.status in (${RECV}) and x.issue_date <= ${asOf} order by x.issue_date, x.id`));
  const pur = rowsOf(await db.execute(sql`
    select coalesce(x.number, '') || ' (' || x.supplier_number || ')' as number, x.issue_date d, x.due_date due,
      coalesce(x.payable_amount, x.gross_total) amount, 0 credits, ${paidTo("purchase_invoice_id")} paid
    from purchase_invoices x where x.client_id = ${clientId} and x.partner_id = ${partnerId} and x.status = 'posted'
      and x.received_date <= ${asOf} order by x.issue_date, x.id`));
  const una = rowsOf(await db.execute(sql`
    select y.direction, coalesce(y.reference, '') ref, y.pay_date d,
      y.amount - coalesce((select sum(a.amount) from payment_allocations a where a.payment_id = y.id), 0) free
    from payments y where y.client_id = ${clientId} and y.partner_id = ${partnerId} and y.voided_at is null and y.pay_date <= ${asOf} order by y.pay_date`));
  const line = (kind: IosLine["kind"]) => (r: Record<string, string | number | null>): IosLine => {
    const rem = new D(String(r.amount)).plus(String(r.credits)).minus(String(r.paid));
    return { kind, number: String(r.number), date: String(r.d), dueDate: (r.due as string | null) ?? null, amount: new D(String(r.amount)).toFixed(2), remaining: rem.toFixed(2) };
  };
  const receivable = inv.map(line("invoice")).filter((l) => new D(l.remaining).gt(0));
  const payable = pur.map(line("purchase")).filter((l) => new D(l.remaining).gt(0));
  const unallocated = una.filter((r) => new D(String(r.free)).gt(0)).map((r) => ({
    kind: r.direction === "in" ? "advance_in" as const : "advance_out" as const, number: String(r.ref || "уплата"), date: String(r.d), dueDate: null,
    amount: new D(String(r.free)).toFixed(2), remaining: new D(String(r.free)).toFixed(2) }));
  const sum = (ls: IosLine[]) => ls.reduce((a, l) => a.plus(l.remaining), new D(0));
  const tr = sum(receivable), tp = sum(payable);
  // nerasporedena uplata od partnerot go namaluva negoviot dolg; nashe nerasporedeno plakjanje go namaluva nashiot
  const ui = sum(unallocated.filter((u) => u.kind === "advance_in")), uo = sum(unallocated.filter((u) => u.kind === "advance_out"));
  const balance = tr.minus(ui).minus(tp.minus(uo));
  return { asOf, partner, receivable, payable, unallocated, totalReceivable: tr.toFixed(2), totalPayable: tp.toFixed(2),
    totalUnallocated: ui.minus(uo).toFixed(2), balance: balance.toFixed(2) };
}

/** Партнери со отворени ставки на ден (за листата ИОС). */
export async function iosSummary(db: Db, clientId: number, asOf: string) {
  const ids = rowsOf(await db.execute(sql`
    select distinct partner_id id from invoices where client_id = ${clientId} and status in (${RECV}) and issue_date <= ${asOf}
    union select distinct partner_id from purchase_invoices where client_id = ${clientId} and status = 'posted' and received_date <= ${asOf}
    union select distinct partner_id from payments where client_id = ${clientId} and voided_at is null and pay_date <= ${asOf}`)).map((r) => Number(r.id));
  const out = [];
  for (const id of ids) {
    const i = await iosFor(db, clientId, id, asOf);
    if (!i.receivable.length && !i.payable.length && !i.unallocated.length) continue;
    out.push({ partnerId: id, partnerName: i.partner.name, edb: i.partner.edb, receivable: i.totalReceivable, payable: i.totalPayable,
      unallocated: i.totalUnallocated, balance: i.balance });
  }
  return out.sort((a, b) => Math.abs(Number(b.balance)) - Math.abs(Number(a.balance)));
}

/* ------------------------------------------------------------- компензации */

export async function compensationCandidates(db: Db, clientId: number, partnerId: number) {
  const inn = await openItems(db, clientId, "in", { partnerId });
  const out = await openItems(db, clientId, "out", { partnerId });
  const a = inn.reduce((x, i) => x.plus(i.remaining), new D(0)), b = out.reduce((x, i) => x.plus(i.remaining), new D(0));
  return { receivable: inn, payable: out, max: D.min(a, b).toFixed(2) };
}

export async function createCompensation(db: Db, clientId: number, b: { partnerId: number; date: string; note?: string | null;
  invoices: { id: number; amount: number | string }[]; purchases: { id: number; amount: number | string }[] }, actor: Actor & { userId: number }) {
  const ti = b.invoices.reduce((x, i) => x.plus(i.amount), new D(0)), tp = b.purchases.reduce((x, i) => x.plus(i.amount), new D(0));
  if (!ti.gt(0) || !ti.eq(tp)) throw new DomainError("validation", `Износите мора да се еднакви и поголеми од 0 (побарувања ${ti.toFixed(2)}, обврски ${tp.toFixed(2)}).`, 422);
  return db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const [client] = await tx.select().from(s.clients).where(eq(s.clients.id, clientId));
    await tx.execute(sql`select pg_advisory_xact_lock(${7_340_002}, ${clientId})`);
    const year = Number(b.date.slice(0, 4));
    const [last] = await tx.select({ n: sql<number>`coalesce(max(${s.compensations.seqNo}), 0)::int` }).from(s.compensations)
      .where(and(eq(s.compensations.clientId, clientId), eq(s.compensations.year, year)));
    const seqNo = last!.n + 1;
    const number = `${client!.invoicePrefix}-KMP-${year}-${String(seqNo).padStart(5, "0")}`;
    const common = { clientId, partnerId: b.partnerId, payDate: b.date, amount: ti.toFixed(2), method: "compensation" as const, reference: number, note: `Компензација ${number}` };
    const pin = await createPayment(tx, { ...common, direction: "in", allocations: b.invoices }, actor);
    const pout = await createPayment(tx, { ...common, direction: "out", allocations: b.purchases }, actor);
    if (new D(pin.unallocated).gt(0) || new D(pout.unallocated).gt(0)) throw new DomainError("validation", "Целиот износ мора да се распореди на документи.", 422);
    const [c] = await tx.insert(s.compensations).values({ clientId, partnerId: b.partnerId, year, seqNo, number, docDate: b.date, amount: ti.toFixed(2),
      inPaymentId: pin.id, outPaymentId: pout.id, note: b.note ?? null, createdBy: actor.userId }).returning();
    await audit(tx, actor, { clientId, entity: "compensation", entityId: c!.id, action: "create", changes: { number, amount: ti.toFixed(2) } });
    return c!;
  });
}

export async function voidCompensation(db: Db, clientId: number, id: number, reason: string, actor: Actor & { userId: number }) {
  return db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const [c] = await tx.select().from(s.compensations).where(and(eq(s.compensations.id, id), eq(s.compensations.clientId, clientId))).for("update");
    if (!c) throw new DomainError("not_found", "Компензацијата не постои.", 404);
    if (c.voidedAt) throw new DomainError("validation", "Компензацијата е веќе сторнирана.", 409);
    await voidPayment(tx, c.inPaymentId, clientId, `Сторно на ${c.number}: ${reason}`, actor);
    await voidPayment(tx, c.outPaymentId, clientId, `Сторно на ${c.number}: ${reason}`, actor);
    await tx.update(s.compensations).set({ voidedAt: new Date(), voidReason: reason }).where(eq(s.compensations.id, c.id));
    await audit(tx, actor, { clientId, entity: "compensation", entityId: c.id, action: "void", changes: { reason } });
    return { ok: true };
  });
}

/** Документите во компензацијата (за PDF и преглед). */
export async function compensationDetail(db: Db, clientId: number, id: number) {
  const [c] = await db.select().from(s.compensations).where(and(eq(s.compensations.id, id), eq(s.compensations.clientId, clientId)));
  if (!c) throw new DomainError("not_found", "Компензацијата не постои.", 404);
  const [partner] = await db.select().from(s.partners).where(eq(s.partners.id, c.partnerId));
  const inv = rowsOf(await db.execute(sql`select i.number, i.issue_date d, a.amount from payment_allocations a join invoices i on i.id = a.invoice_id
    where a.payment_id = ${c.inPaymentId} order by i.issue_date, i.id`));
  const pur = rowsOf(await db.execute(sql`select coalesce(p.number,'') || ' (' || p.supplier_number || ')' as number, p.issue_date d, a.amount
    from payment_allocations a join purchase_invoices p on p.id = a.purchase_invoice_id where a.payment_id = ${c.outPaymentId} order by p.issue_date, p.id`));
  return { ...c, partner: partner!, invoices: inv.map((r) => ({ number: String(r.number), date: String(r.d), amount: new D(String(r.amount)).toFixed(2) })),
    purchases: pur.map((r) => ({ number: String(r.number), date: String(r.d), amount: new D(String(r.amount)).toFixed(2) })) };
}

/* ----------------------------------------------------------------- опомени */

export const DUNNING_TITLE = ["", "Опомена", "Втора опомена", "Последна опомена пред присилна наплата"] as const;

/** Купувачи со доспеани ненаплатени фактури и предлог за ниво (следно по последната опомена во 90 дена). */
export async function dunningCandidates(db: Db, clientId: number, minDays = 1) {
  const open = (await openItems(db, clientId, "in")).filter((i) => i.daysOverdue >= minDays);
  const by = new Map<number, typeof open>();
  for (const i of open) by.set(i.partnerId, [...(by.get(i.partnerId) ?? []), i]);
  const out = [];
  for (const [partnerId, items] of by) {
    const [last] = await db.select().from(s.dunningLetters).where(and(eq(s.dunningLetters.clientId, clientId), eq(s.dunningLetters.partnerId, partnerId)))
      .orderBy(desc(s.dunningLetters.docDate), desc(s.dunningLetters.id)).limit(1);
    const recent = last && Date.now() - Date.parse(`${last.docDate}T12:00:00Z`) < 90 * 864e5;
    out.push({ partnerId, partnerName: items[0]!.partnerName, count: items.length, amount: items.reduce((a, i) => a.plus(i.remaining), new D(0)).toFixed(2),
      maxDays: Math.max(...items.map((i) => i.daysOverdue)), lastLetter: last ? { id: last.id, date: last.docDate, level: last.level } : null,
      nextLevel: recent ? Math.min(3, last!.level + 1) : 1 });
  }
  return out.sort((a, b) => Number(b.amount) - Number(a.amount));
}

export async function createDunning(db: Db, clientId: number, b: { partnerId: number; level: number; date: string; minDays?: number }, actor: Actor & { userId: number }) {
  const items = (await openItems(db, clientId, "in", { partnerId: b.partnerId, asOf: b.date })).filter((i) => i.daysOverdue >= (b.minDays ?? 1));
  if (!items.length) throw new DomainError("validation", "Купувачот нема доспеани ненаплатени фактури.", 422);
  const amount = items.reduce((a, i) => a.plus(i.remaining), new D(0)).toFixed(2);
  const [l] = await db.insert(s.dunningLetters).values({ clientId, partnerId: b.partnerId, docDate: b.date, level: b.level, amount,
    items: items.map((i) => ({ id: i.id, number: i.number, dueDate: i.dueDate, remaining: i.remaining, daysOverdue: i.daysOverdue })), createdBy: actor.userId }).returning();
  await audit(db, actor, { clientId, entity: "dunning", entityId: l!.id, action: "create", changes: { level: b.level, amount } });
  return l!;
}
