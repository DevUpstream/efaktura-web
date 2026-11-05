/**
 * Plateжna disciplina na kupuvac (docs/08) - od nashite fakturi i uplati, bez nadvoreshni izvori.
 *  - prosecno zadocnuvanje: denovi od rokot do uplatata, ponderirano so iznosot (platenoto vo poslednite 12 meseci);
 *  - otvoreno i zadocneto sega, najstar dolg;
 *  - ocenka A (redovno) / B / V / G (rizik), "–" bez istorija;
 *  - kreditni limit: otvoreno + nova faktura > limit -> predupreduvanje.
 */
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { invoices, partners, paymentAllocations, payments } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { openItems, RECEIVABLE_STATUSES } from "./payments.js";

export type Grade = "A" | "B" | "V" | "G" | "-";
export interface PartnerScore {
  partnerId: number; grade: Grade; avgDaysLate: number | null; paidCount: number; lateShare: number | null;
  open: string; overdue: string; maxDaysOverdue: number; trend: "better" | "worse" | "same" | null;
  creditLimit: string | null; limitUsed: number | null; warnings: string[];
}

const DAY = 864e5;
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Skopje" });
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

export function gradeOf(avgLate: number | null, maxOverdue: number, hasHistory: boolean): Grade {
  if (!hasHistory) return "-";
  const a = avgLate ?? 0;
  if (a <= 5 && maxOverdue <= 30) return "A";
  if (a <= 20 && maxOverdue <= 60) return "B";
  if (a <= 45 && maxOverdue <= 90) return "V";
  return "G";
}

/** Oceni za site (ili eden) kupuvaci na klientot. extra = iznos na nova faktura (za proverka na limitot). */
export async function partnerScores(db: Db, clientId: number, opts: { partnerId?: number; asOf?: string; extra?: number } = {}): Promise<PartnerScore[]> {
  const asOf = opts.asOf ?? today();
  const since = new Date(Date.parse(asOf) - 365 * DAY).toISOString().slice(0, 10);
  const recent = new Date(Date.parse(asOf) - 90 * DAY).toISOString().slice(0, 10);
  const pcond = opts.partnerId ? [eq(invoices.partnerId, opts.partnerId)] : [];
  // platenoto: raspored (aktivni uplati) x rok na fakturata
  const paid = await db.select({ partnerId: invoices.partnerId, due: sql<string>`coalesce(${invoices.dueDate}, ${invoices.issueDate})`, payDate: payments.payDate,
    amount: paymentAllocations.amount })
    .from(paymentAllocations).innerJoin(payments, eq(payments.id, paymentAllocations.paymentId)).innerJoin(invoices, eq(invoices.id, paymentAllocations.invoiceId))
    .where(and(eq(invoices.clientId, clientId), isNull(payments.voidedAt), gte(payments.payDate, since),
      inArray(invoices.status, [...RECEIVABLE_STATUSES]), ...pcond));
  const open = await openItems(db, clientId, "in", { partnerId: opts.partnerId, asOf });
  const ps = await db.select({ id: partners.id, limit: partners.creditLimit }).from(partners)
    .where(and(eq(partners.clientId, clientId), ...(opts.partnerId ? [eq(partners.id, opts.partnerId)] : [])));
  return ps.map((p) => {
    const mine = paid.filter((x) => x.partnerId === p.id);
    const w = (list: typeof mine) => { const tot = list.reduce((s, x) => s + Number(x.amount), 0);
      return tot > 0 ? list.reduce((s, x) => s + Math.max(0, days(x.due, x.payDate)) * Number(x.amount), 0) / tot : null; };
    const avg = w(mine);
    const late = mine.filter((x) => days(x.due, x.payDate) > 5).reduce((s, x) => s + Number(x.amount), 0);
    const tot = mine.reduce((s, x) => s + Number(x.amount), 0);
    const recentAvg = w(mine.filter((x) => x.payDate >= recent)), olderAvg = w(mine.filter((x) => x.payDate < recent));
    const trend = recentAvg === null || olderAvg === null ? null : recentAvg < olderAvg - 5 ? "better" : recentAvg > olderAvg + 5 ? "worse" : "same";
    const items = open.filter((o) => o.partnerId === p.id);
    const openSum = items.reduce((s, o) => s + Number(o.remaining), 0);
    const overdueSum = items.filter((o) => o.daysOverdue > 0).reduce((s, o) => s + Number(o.remaining), 0);
    const maxOver = items.reduce((m, o) => Math.max(m, o.daysOverdue), 0);
    const grade = gradeOf(avg, maxOver, mine.length > 0 || items.length > 0);
    const warnings: string[] = [];
    if (maxOver > 30) warnings.push(`Има задоцнет долг ${overdueSum.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ден., најстар ${maxOver} дена.`);
    const exposure = openSum + (opts.extra ?? 0);
    if (p.limit !== null && exposure > Number(p.limit)) warnings.push(`Кредитниот лимит (${Number(p.limit).toLocaleString("de-DE")} ден.) е надминат: отворено${opts.extra ? " + оваа фактура" : ""} ${exposure.toLocaleString("de-DE", { maximumFractionDigits: 0 })} ден.`);
    if (grade === "G") warnings.push("Оценка Г: купувачот редовно плаќа многу доцна.");
    return { partnerId: p.id, grade, avgDaysLate: avg === null ? null : Math.round(avg), paidCount: mine.length, lateShare: tot > 0 ? Math.round((late / tot) * 100) : null,
      open: openSum.toFixed(2), overdue: overdueSum.toFixed(2), maxDaysOverdue: maxOver, trend, creditLimit: p.limit,
      limitUsed: p.limit !== null && Number(p.limit) > 0 ? Math.round((exposure / Number(p.limit)) * 100) : null, warnings };
  });
}
