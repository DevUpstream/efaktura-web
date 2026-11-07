/**
 * Повторувачки фактури (модул "recurring", docs/10).
 *
 * Шаблон = снимка на ставките од постоечка фактура. На денот (nextDate) се прави НАЦРТ на фактура -
 * никогаш не се издава сама (издавањето оди на УЈП и бара човек). Во описите:
 *   {месец} / {година} = месецот/годината на датумот на фактурата, {претходен месец} = претходниот месец.
 * Ако серверот не работел, се надоместуваат пропуштените месеци (најмногу 12 одеднаш).
 * Двојна фактура за ист датум е невозможна (уникатен индекс recurring_id + issue_date), и откажан нацрт не се прави повторно.
 */
import { and, eq, lte, sql } from "drizzle-orm";
import { clients, invoiceLines, invoices, partners, recurringInvoices, type RecurringLine } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "./errors.js";
import { writeDraft } from "../routes/invoices.js";

const MONTHS = ["јануари", "февруари", "март", "април", "мај", "јуни", "јули", "август", "септември", "октомври", "ноември", "декември"];
export const todaySkopje = (d = new Date()) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Skopje" });

/** Датум во месецот: day 1-28, 0 = последен ден. */
export function dateIn(year: number, month0: number, day: number) {
  const last = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const d = day === 0 ? last : Math.min(day, last);
  return new Date(Date.UTC(year, month0, d)).toISOString().slice(0, 10);
}
export function nextMonth(date: string, day: number) {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)) - 1;
  return dateIn(m === 11 ? y + 1 : y, (m + 1) % 12, day);
}
/** Прв датум >= from за даден ден во месецот. */
export function firstOnOrAfter(from: string, day: number) {
  const y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7)) - 1;
  const d = dateIn(y, m, day);
  return d >= from ? d : nextMonth(d, day);
}
export function fillPlaceholders(text: string, date: string) {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)) - 1;
  const pm = (m + 11) % 12, py = m === 0 ? y - 1 : y;
  return text.replace(/\{претходен месец\}/gi, `${MONTHS[pm]} ${py}`).replace(/\{месец\}/gi, MONTHS[m]!).replace(/\{година\}/gi, String(y));
}

export interface RecurringIn { name: string; dayOfMonth: number; startDate: string; endDate?: string | null }

export async function createRecurring(db: Db, clientId: number, invoiceId: number, b: RecurringIn, userId: number) {
  const [inv] = await db.select().from(invoices).where(and(eq(invoices.id, invoiceId), eq(invoices.clientId, clientId)));
  if (!inv) throw new DomainError("not_found", "Фактурата не постои.", 404);
  if (inv.docType !== "INV" || inv.status === "cancelled_draft") throw new DomainError("validation", "Повторувачка се прави од фактура (не авансна, понуда, одобрение или откажан нацрт).", 422);
  if (b.endDate && b.endDate < b.startDate) throw new DomainError("validation", "Крајот е пред почетокот.", 422);
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id)).orderBy(invoiceLines.lineNo);
  if (!lines.length) throw new DomainError("validation", "Фактурата нема ставки.", 422);
  const tpl: RecurringLine[] = lines.map((l) => ({ itemId: l.itemId, description: l.description, unit: l.unit, qty: Math.abs(Number(l.qty)),
    unitPrice: Number(l.unitPrice), discountPct: Number(l.discountPct), vatRateId: l.vatRateId }));
  const dueDays = inv.dueDate ? Math.max(0, Math.round((Date.parse(inv.dueDate) - Date.parse(inv.issueDate)) / 86400000)) : null;
  const [r] = await db.insert(recurringInvoices).values({ clientId, partnerId: inv.partnerId, name: b.name, lines: tpl, paymentMethod: inv.paymentMethod,
    dueDays, note: inv.note, clauses: inv.clauses, warehouseId: inv.warehouseId, dayOfMonth: b.dayOfMonth,
    nextDate: firstOnOrAfter(b.startDate, b.dayOfMonth), endDate: b.endDate ?? null, sourceInvoiceId: inv.id, createdBy: userId }).returning();
  return r!;
}

/** Ставките на шаблонот се заменуваат со ставките од дадена фактура (обично последната генерирана, ако ја поправиле). */
export async function updateTemplateFrom(db: Db, recurringId: number, invoiceId: number) {
  const [r] = await db.select().from(recurringInvoices).where(eq(recurringInvoices.id, recurringId));
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!r || !inv || inv.clientId !== r.clientId || inv.partnerId !== r.partnerId || inv.docType !== "INV")
    throw new DomainError("validation", "Фактурата не е за истиот купувач.", 422);
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id)).orderBy(invoiceLines.lineNo);
  if (!lines.length) throw new DomainError("validation", "Фактурата нема ставки.", 422);
  // описите од генерираната фактура се веќе пополнети ("ноември") - се враќаат од стариот шаблон каде што се совпаѓаат
  const old = new Map(r.lines.map((l) => [fillPlaceholders(l.description, inv.issueDate), l.description]));
  const tpl: RecurringLine[] = lines.map((l) => ({ itemId: l.itemId, description: old.get(l.description) ?? l.description, unit: l.unit,
    qty: Math.abs(Number(l.qty)), unitPrice: Number(l.unitPrice), discountPct: Number(l.discountPct), vatRateId: l.vatRateId }));
  await db.update(recurringInvoices).set({ lines: tpl, note: inv.note, clauses: inv.clauses, updatedAt: new Date() }).where(eq(recurringInvoices.id, r.id));
}

/** Ги прави доспеаните нацрти. clientId = само за една фирма (копче „Генерирај сега“). */
export async function runRecurring(db: Db, opts: { clientId?: number; today?: string } = {}) {
  const today = opts.today ?? todaySkopje();
  const due = await db.select({ id: recurringInvoices.id }).from(recurringInvoices)
    .innerJoin(clients, eq(clients.id, recurringInvoices.clientId))
    .where(and(eq(recurringInvoices.isActive, true), lte(recurringInvoices.nextDate, today), sql`'recurring' = any(${clients.modules})`,
      opts.clientId ? eq(recurringInvoices.clientId, opts.clientId) : sql`true`));
  const created: { recurringId: number; invoiceId: number; issueDate: string }[] = [];
  const skipped: { recurringId: number; reason: string }[] = [];
  for (const { id } of due) {
    await db.transaction(async (tx0) => {
      const tx = tx0 as unknown as Db;
      const [r] = await tx.select().from(recurringInvoices).where(eq(recurringInvoices.id, id)).for("update", { skipLocked: true });
      if (!r || !r.isActive) return;
      const [p] = await tx.select({ isActive: partners.isActive }).from(partners).where(eq(partners.id, r.partnerId));
      if (!p?.isActive) { skipped.push({ recurringId: r.id, reason: "Купувачот е исклучен." }); return; }
      let next = r.nextDate, n = 0;
      while (next <= today && (!r.endDate || next <= r.endDate) && n < 12) {
        const [exists] = await tx.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.recurringId, r.id), eq(invoices.issueDate, next)));
        if (!exists) {
          const [inv] = await tx.insert(invoices).values({ clientId: r.clientId, partnerId: r.partnerId, docType: "INV", recurringId: r.id,
            sourceInvoiceId: r.sourceInvoiceId, year: Number(next.slice(0, 4)), issueDate: next, createdBy: r.createdBy }).returning();
          const dueDate = r.dueDays !== null ? new Date(Date.parse(`${next}T12:00:00Z`) + r.dueDays * 86400000).toISOString().slice(0, 10) : null;
          await writeDraft(tx, inv!.id, r.clientId, { partnerId: r.partnerId, docType: "INV", issueDate: next, supplyDate: next, dueDate,
            paymentMethod: r.paymentMethod, note: r.note ? fillPlaceholders(r.note, next) : null, clauses: r.clauses, warehouseId: r.warehouseId,
            lines: r.lines.map((l) => ({ ...l, description: fillPlaceholders(l.description, next), priceSource: `Повторувачка: ${r.name}`.slice(0, 80) })) }, null);
          created.push({ recurringId: r.id, invoiceId: inv!.id, issueDate: next });
        }
        next = nextMonth(next, r.dayOfMonth); n++;
      }
      const ended = !!r.endDate && next > r.endDate;
      await tx.update(recurringInvoices).set({ nextDate: next, isActive: !ended, updatedAt: new Date() }).where(eq(recurringInvoices.id, r.id));
    });
  }
  return { created, skipped };
}
