/**
 * Plakjanja i naplata (docs/08).
 *  - Otvoreni stavki "in": izdadeni fakturi (INV, AV, KZ, KR) - knizni odobrenija (OD) kon nив - uplati.
 *    Fakturi zameneti so korekcija ili stornirani ne se dolg.
 *  - Otvoreni stavki "out": proknizeni vlezni fakturi - isplati.
 *  - Uplata se rasporeduva po fakturi (racno ili avtomatski od najstarata); ostatokot e nerasporeden (preplata).
 *  - Uplata ne se menuva i ne se brise; storno ja iskluchuva so site rasporedi.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { partners, paymentAllocations, payments } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "./errors.js";
import { audit, type Actor } from "./audit.js";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export const RECEIVABLE_STATUSES = ["issued", "json_exported", "sent_to_ujp"] as const;
const RECV_SQL = sql.raw(RECEIVABLE_STATUSES.map((s) => `'${s}'`).join(","));

export interface OpenItem {
  id: number; kind: "invoice" | "purchase"; number: string; docType: string; issueDate: string; dueDate: string | null;
  partnerId: number; partnerName: string; amount: string; credits: string; paid: string; remaining: string; daysOverdue: number;
}

function daysBetween(a: string, b: string) { return Math.round((Date.parse(b) - Date.parse(a)) / 864e5); }

/** Site stavki (i zatvorenite, so remaining = 0) za klientot, po nasoka. */
export async function openItems(db: Db, clientId: number, direction: "in" | "out", opts: { partnerId?: number; asOf?: string; includeClosed?: boolean } = {}): Promise<OpenItem[]> {
  const asOf = opts.asOf ?? new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Skopje" });
  const partnerCond = opts.partnerId ? sql` and x.partner_id = ${opts.partnerId}` : sql``;
  const q = direction === "in" ? sql`
    select x.id, x.number, x.doc_type as "docType", x.issue_date as "issueDate", x.due_date as "dueDate", x.partner_id as "partnerId", p.name as "partnerName",
      coalesce(x.payable_amount, round(x.gross_total, 0)) as amount,
      coalesce((select -sum(abs(coalesce(o.payable_amount, round(o.gross_total, 0)))) from invoices o
        where o.related_invoice_id = x.id and o.doc_type = 'OD' and o.status in (${RECV_SQL})), 0) as credits,
      coalesce((select sum(a.amount) from payment_allocations a join payments y on y.id = a.payment_id
        where a.invoice_id = x.id and y.voided_at is null), 0) as paid
    from invoices x join partners p on p.id = x.partner_id
    where x.client_id = ${clientId} and x.doc_type in ('INV','AV','KZ','KR') and x.status in (${RECV_SQL}) ${partnerCond}`
    : sql`
    select x.id, coalesce(x.number, '') || ' (' || x.supplier_number || ')' as number, 'VF' as "docType", x.issue_date as "issueDate", x.due_date as "dueDate",
      x.partner_id as "partnerId", p.name as "partnerName", x.gross_total as amount, 0 as credits,
      coalesce((select sum(a.amount) from payment_allocations a join payments y on y.id = a.payment_id
        where a.purchase_invoice_id = x.id and y.voided_at is null), 0) as paid
    from purchase_invoices x join partners p on p.id = x.partner_id
    where x.client_id = ${clientId} and x.status = 'posted' ${partnerCond}`;
  const res = await db.execute(q) as unknown as { rows?: Record<string, unknown>[] } | Record<string, unknown>[];
  const rows = (Array.isArray(res) ? res : res.rows ?? []) as Record<string, string | number | null>[];
  return rows.map((r) => {
    const remaining = new D(String(r.amount)).plus(String(r.credits)).minus(String(r.paid));
    const due = (r.dueDate ?? r.issueDate) as string;
    return { id: Number(r.id), kind: direction === "in" ? "invoice" as const : "purchase" as const, number: String(r.number), docType: String(r.docType),
      issueDate: String(r.issueDate), dueDate: (r.dueDate as string | null) ?? null, partnerId: Number(r.partnerId), partnerName: String(r.partnerName),
      amount: new D(String(r.amount)).toFixed(2), credits: new D(String(r.credits)).toFixed(2), paid: new D(String(r.paid)).toFixed(2),
      remaining: D.max(remaining, 0).toFixed(2), daysOverdue: remaining.gt(0) ? Math.max(0, daysBetween(due, asOf)) : 0 };
  }).filter((i) => opts.includeClosed || new D(i.remaining).gt(0))
    .sort((a, b) => (a.dueDate ?? a.issueDate).localeCompare(b.dueDate ?? b.issueDate) || a.issueDate.localeCompare(b.issueDate) || a.id - b.id);
}

/** Starosna struktura: nedospeano, 1-30, 31-60, 61-90, 90+. */
export function aging(items: OpenItem[]) {
  const b = { current: new D(0), d30: new D(0), d60: new D(0), d90: new D(0), over90: new D(0), total: new D(0) };
  for (const i of items) {
    const r = new D(i.remaining);
    b.total = b.total.plus(r);
    if (i.daysOverdue <= 0) b.current = b.current.plus(r);
    else if (i.daysOverdue <= 30) b.d30 = b.d30.plus(r);
    else if (i.daysOverdue <= 60) b.d60 = b.d60.plus(r);
    else if (i.daysOverdue <= 90) b.d90 = b.d90.plus(r);
    else b.over90 = b.over90.plus(r);
  }
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.toFixed(2)])) as Record<keyof typeof b, string>;
}

/** Nerasporedeni (preplata) po partner: iznos na uplatata - rasporedeno, samo aktivni uplati. */
export async function unallocated(db: Db, clientId: number, direction: "in" | "out", partnerId?: number) {
  const res = await db.execute(sql`
    select y.partner_id as "partnerId", sum(y.amount - coalesce((select sum(a.amount) from payment_allocations a where a.payment_id = y.id), 0)) as free
    from payments y where y.client_id = ${clientId} and y.direction = ${direction} and y.voided_at is null
      ${partnerId ? sql`and y.partner_id = ${partnerId}` : sql``}
    group by y.partner_id`) as unknown as { rows?: Record<string, unknown>[] } | Record<string, unknown>[];
  const rows = (Array.isArray(res) ? res : res.rows ?? []) as { partnerId: number; free: string }[];
  return new Map(rows.filter((r) => new D(r.free).gt(0)).map((r) => [Number(r.partnerId), new D(r.free).toFixed(2)]));
}

export interface PaymentIn {
  clientId: number; direction: "in" | "out"; partnerId: number; payDate: string; amount: Decimal.Value;
  method?: "bank" | "cash" | "card" | "compensation" | "other"; reference?: string | null; note?: string | null; statementLineKey?: string | null;
  /** null/undefined = avtomatski od najstarata; [] = nerasporedeno */
  allocations?: { id: number; amount: Decimal.Value }[] | null;
}

/** Vnes na uplata so raspored. Mora da se povika vo transakcija (tx). */
export async function createPayment(tx: Db, p: PaymentIn, actor: Actor & { userId: number }) {
  const amount = new D(p.amount).toDecimalPlaces(2);
  if (amount.lte(0)) throw new DomainError("validation", "Износот мора да е поголем од 0.", 422);
  const [partner] = await tx.select().from(partners).where(and(eq(partners.id, p.partnerId), eq(partners.clientId, p.clientId)));
  if (!partner) throw new DomainError("validation", "Партнерот не постои.", 422);
  // eden po eden po klient: rasporedot cita "ostanato" i mora da e konzistenten
  await tx.execute(sql`select pg_advisory_xact_lock(${7_340_001}, ${p.clientId})`);
  const open = await openItems(tx, p.clientId, p.direction, { partnerId: p.partnerId });
  const byId = new Map(open.map((o) => [o.id, o]));
  let allocs: { id: number; amount: Decimal }[] = [];
  if (p.allocations === null || p.allocations === undefined) {
    let left = amount;
    for (const o of open) {
      if (left.lte(0)) break;
      const take = D.min(left, o.remaining);
      allocs.push({ id: o.id, amount: take }); left = left.minus(take);
    }
  } else {
    allocs = p.allocations.map((a) => ({ id: a.id, amount: new D(a.amount).toDecimalPlaces(2) })).filter((a) => a.amount.gt(0));
    const errors: string[] = [];
    for (const a of allocs) {
      const o = byId.get(a.id);
      if (!o) errors.push(`Документот ${a.id} не е отворен за овој партнер.`);
      else if (a.amount.gt(o.remaining)) errors.push(`${o.number}: останато е ${o.remaining}, а се распоредува ${a.amount.toFixed(2)}.`);
    }
    const sum = allocs.reduce((s, a) => s.plus(a.amount), new D(0));
    if (sum.gt(amount)) errors.push(`Распоредено (${sum.toFixed(2)}) е повеќе од уплатата (${amount.toFixed(2)}).`);
    if (errors.length) throw new DomainError("validation", errors.join(" "), 422);
  }
  const [pay] = await tx.insert(payments).values({ clientId: p.clientId, direction: p.direction, partnerId: p.partnerId, payDate: p.payDate,
    amount: amount.toFixed(2), method: p.method ?? "bank", reference: p.reference ?? null, note: p.note ?? null,
    statementLineKey: p.statementLineKey ?? null, createdBy: actor.userId }).returning();
  for (const a of allocs) await tx.insert(paymentAllocations).values({ paymentId: pay!.id, amount: a.amount.toFixed(2),
    ...(p.direction === "in" ? { invoiceId: a.id } : { purchaseInvoiceId: a.id }) });
  await audit(tx, actor, { clientId: p.clientId, entity: "payment", entityId: pay!.id, action: "create",
    changes: { direction: p.direction, amount: amount.toFixed(2), allocations: allocs.map((a) => ({ id: a.id, amount: a.amount.toFixed(2) })) } });
  const free = amount.minus(allocs.reduce((s, a) => s.plus(a.amount), new D(0)));
  return { ...pay!, allocated: allocs.map((a) => ({ id: a.id, number: byId.get(a.id)?.number ?? "", amount: a.amount.toFixed(2) })), unallocated: free.toFixed(2) };
}

/** Raspored na nerasporedeniot del od postoecka uplata (na pr. preplata, podocna faktura). */
export async function allocateExisting(tx: Db, paymentId: number, clientId: number, items: { id: number; amount: Decimal.Value }[] | null, actor: Actor & { userId: number }) {
  await tx.execute(sql`select pg_advisory_xact_lock(${7_340_001}, ${clientId})`);
  const [pay] = await tx.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.clientId, clientId)));
  if (!pay) throw new DomainError("not_found", "Уплатата не постои.", 404);
  if (pay.voidedAt) throw new DomainError("validation", "Уплатата е сторнирана.", 422);
  const done = await tx.select({ s: sql<string>`coalesce(sum(${paymentAllocations.amount}), 0)` }).from(paymentAllocations).where(eq(paymentAllocations.paymentId, pay.id));
  let free = new D(pay.amount).minus(done[0]!.s);
  if (free.lte(0)) throw new DomainError("validation", "Уплатата е целосно распоредена.", 422);
  const open = await openItems(tx, clientId, pay.direction, { partnerId: pay.partnerId });
  const byId = new Map(open.map((o) => [o.id, o]));
  const plan: { id: number; amount: Decimal }[] = [];
  if (!items) for (const o of open) { if (free.lte(0)) break; const t = D.min(free, o.remaining); plan.push({ id: o.id, amount: t }); free = free.minus(t); }
  else {
    for (const a of items) {
      const o = byId.get(a.id); const amt = new D(a.amount).toDecimalPlaces(2);
      if (!o || amt.gt(o.remaining)) throw new DomainError("validation", `Документот ${o?.number ?? a.id} нема толку отворено.`, 422);
      if (amt.gt(free)) throw new DomainError("validation", "Повеќе од нераспоредениот дел од уплатата.", 422);
      plan.push({ id: a.id, amount: amt }); free = free.minus(amt);
    }
  }
  for (const a of plan) await tx.insert(paymentAllocations).values({ paymentId: pay.id, amount: a.amount.toFixed(2),
    ...(pay.direction === "in" ? { invoiceId: a.id } : { purchaseInvoiceId: a.id }) });
  await audit(tx, actor, { clientId, entity: "payment", entityId: pay.id, action: "allocate", changes: { allocations: plan.map((a) => ({ id: a.id, amount: a.amount.toFixed(2) })) } });
  return plan.map((a) => ({ id: a.id, amount: a.amount.toFixed(2) }));
}

export async function voidPayment(tx: Db, paymentId: number, clientId: number, reason: string, actor: Actor & { userId: number }) {
  if (reason.trim().length < 3) throw new DomainError("validation", "Внесете причина за сторно.", 422);
  const [pay] = await tx.select().from(payments).where(and(eq(payments.id, paymentId), eq(payments.clientId, clientId)));
  if (!pay) throw new DomainError("not_found", "Уплатата не постои.", 404);
  if (pay.voidedAt) throw new DomainError("validation", "Уплатата е веќе сторнирана.", 409);
  const [v] = await tx.update(payments).set({ voidedAt: new Date(), voidedBy: actor.userId, voidReason: reason }).where(eq(payments.id, pay.id)).returning();
  await audit(tx, actor, { clientId, entity: "payment", entityId: pay.id, action: "void", changes: { reason } });
  return v!;
}

export { isNull, inArray };
