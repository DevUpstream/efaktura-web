/**
 * Izvodi od banka (docs/08): uvoz -> stavki -> prepoznavanje -> knizenje (avtomatski za sigurnite) -> ucenje na smetkite.
 */
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { bankStatementLines, bankStatements, clients, EXPENSE_CATEGORIES, type BankImportMapping, type ExpenseCategory, partnerAccounts, partners, payments } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "./errors.js";
import { audit, type Actor } from "./audit.js";
import { createPayment, openItems } from "./payments.js";
import { looksLikeMkTxt, normAccount, parseMkTxt, type ParsedStatement } from "./bank-txt.js";
import { parseStatement } from "./bank-import.js";
import { looksLikeMt940, parseMt940 } from "./bank-mt940.js";
import { matchLine, type MatchContext, type MatchResult } from "./matching.js";

type Client = typeof clients.$inferSelect;
export const clientOwnAccounts = (c: Client) =>
  new Set([c.iban, ...(c.pdfSettings?.bankAccounts ?? []).map((b) => b.account)].map(normAccount).filter(Boolean));

/** TXT ili MT940 (avtomatski) ili CSV (po mapiranjeto na firmata). */
export function parseAny(text: string, mapping: BankImportMapping | null): ParsedStatement {
  if (looksLikeMkTxt(text)) return parseMkTxt(text);
  if (looksLikeMt940(text)) return parseMt940(text);
  if (!mapping) throw new DomainError("validation", "Форматот не е препознаен како извод од банка (TXT или MT940). За CSV прво поставете ги колоните.", 422);
  const { rows, skipped } = parseStatement(text, mapping);
  if (!rows.length) throw new DomainError("validation", "Нема ставки во датотеката (провери ги колоните).", 422);
  return { format: "csv", statementNo: null, date: null, ownAccount: null, opening: null, closing: null,
    warnings: skipped.length ? [`Прескокнати редови: ${skipped.map((s) => `${s.line} (${s.reason})`).join(", ")}.`] : [],
    fileHash: createHash("sha256").update(text.replace(/\r\n/g, "\n").trimEnd()).digest("hex"),
    lines: rows.map((r, i) => ({ lineNo: i + 1, direction: r.direction, amount: r.amount, name: r.name, account: r.account, edb: "", paymentCode: "",
      purpose: r.reference, refDebit: "", refCredit: "", extra: r.date, key: r.key })) };
}

export async function matchContext(db: Db, client: Client): Promise<MatchContext> {
  const ps = await db.select({ id: partners.id, name: partners.name, edb: partners.edb, isActive: partners.isActive }).from(partners).where(eq(partners.clientId, client.id));
  const accs = await db.select().from(partnerAccounts).where(eq(partnerAccounts.clientId, client.id));
  const legacy = await db.select({ id: partners.id, a: partners.bankAccount }).from(partners).where(and(eq(partners.clientId, client.id), sql`${partners.bankAccount} is not null`));
  return { clientEdb: client.edb, prefix: client.invoicePrefix, ownAccounts: clientOwnAccounts(client), partners: ps,
    accounts: new Map([...legacy.map((l) => [normAccount(l.a), l.id] as [string, number]), ...accs.map((a) => [a.account, a.partnerId] as [string, number])]),
    openIn: await openItems(db, client.id, "in"), openOut: client.modules.includes("incoming") ? await openItems(db, client.id, "out") : [] };
}

const lineInput = (l: typeof bankStatementLines.$inferSelect) => ({ direction: l.direction, amount: l.amount, name: l.counterpartyName, account: l.counterpartyAccount,
  edb: l.counterpartyEdb, purpose: l.purpose, refDebit: l.refDebit, refCredit: l.refCredit });

/** Ja povrzuva smetkata od izvodot so partnerot (ako ne e nasha i ne e vekje na drug partner). */
export async function learnAccount(tx: Db, clientId: number, partnerId: number, account: string | null, own: Set<string>) {
  const a = normAccount(account);
  if (!a || own.has(a)) return false;
  const r = await tx.insert(partnerAccounts).values({ clientId, partnerId, account: a, source: "learned" }).onConflictDoNothing().returning();
  return r.length > 0;
}

/** Knizenje na edna stavka (uplata/isplata so raspored). */
export async function bookLine(db: Db, clientId: number, lineId: number, b: { partnerId: number; allocations: { id: number; amount: number | string }[] | null; learn?: boolean },
  actor: Actor & { userId: number }) {
  return db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const [l] = await tx.select().from(bankStatementLines).where(and(eq(bankStatementLines.id, lineId), eq(bankStatementLines.clientId, clientId))).for("update");
    if (!l) throw new DomainError("not_found", "Ставката не постои.", 404);
    if (l.ignored) throw new DomainError("validation", "Ставката е означена како „не се книжи“.", 422);
    if (l.paymentId) {
      const [p] = await tx.select({ v: payments.voidedAt }).from(payments).where(eq(payments.id, l.paymentId));
      if (p && !p.v) throw new DomainError("validation", "Ставката е веќе прокнижена.", 409);
    }
    const [client] = await tx.select().from(clients).where(eq(clients.id, clientId));
    const pay = await createPayment(tx, { clientId, direction: l.direction, partnerId: b.partnerId, payDate: l.valueDate, amount: l.amount, method: "bank",
      reference: [l.counterpartyName, l.purpose, l.refCredit].filter(Boolean).join(" ").slice(0, 200), statementLineKey: l.lineKey, allocations: b.allocations }, actor);
    await tx.update(bankStatementLines).set({ paymentId: pay.id }).where(eq(bankStatementLines.id, l.id));
    const learned = b.learn !== false ? await learnAccount(tx, clientId, b.partnerId, l.counterpartyAccount, clientOwnAccounts(client!)) : false;
    return { ...pay, learned };
  });
}

export async function importStatement(db: Db, clientId: number, text: string, fileName: string | null, actor: Actor & { userId: number }, opts: { autoBook: boolean }) {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  const parsed = parseAny(text, client!.bankImportMapping);
  const warnings = [...parsed.warnings];
  // --- dali izvodot e za ovaa firma
  if (parsed.ownAccount) {
    const acc = normAccount(parsed.ownAccount);
    const own = clientOwnAccounts(client!);
    if (own.size && !own.has(acc)) throw new DomainError("validation", `Изводот е за сметка ${parsed.ownAccount}, која не е меѓу сметките на ${client!.name}. Изберете ја вистинската фирма.`, 422);
    const [other] = await db.select({ name: clients.name }).from(bankStatements).innerJoin(clients, eq(clients.id, bankStatements.clientId))
      .where(and(eq(bankStatements.ownAccount, parsed.ownAccount), ne(bankStatements.clientId, clientId))).limit(1);
    if (other) throw new DomainError("validation", `Сметката ${parsed.ownAccount} веќе има изводи кај фирмата ${other.name}.`, 422);
    if (!own.size) warnings.push(`Фирмата нема внесени жиро-сметки (Поставки и PDF). Изводот е за ${parsed.ownAccount}: внесете ја, за да се спречи увоз во погрешна фирма.`);
  }
  const [dup] = await db.select({ id: bankStatements.id, no: bankStatements.statementNo }).from(bankStatements).where(and(eq(bankStatements.clientId, clientId),
    parsed.ownAccount && parsed.statementNo && parsed.date
      ? sql`(${bankStatements.fileHash} = ${parsed.fileHash} or (${bankStatements.ownAccount} = ${parsed.ownAccount} and ${bankStatements.statementNo} = ${parsed.statementNo} and ${bankStatements.statementDate} = ${parsed.date}))`
      : eq(bankStatements.fileHash, parsed.fileHash)));
  if (dup) throw new DomainError("duplicate", `Изводот${dup.no ? ` бр. ${dup.no}` : ""} е веќе увезен.`, 409);

  const st = await db.transaction(async (tx) => {
    const [s] = await tx.insert(bankStatements).values({ clientId, format: parsed.format, ownAccount: parsed.ownAccount, statementNo: parsed.statementNo,
      statementDate: parsed.date, openingBalance: parsed.opening, closingBalance: parsed.closing, fileName, fileHash: parsed.fileHash, importedBy: actor.userId }).returning();
    // CSV mozhe da se preklopuva so prethoden izvod: istite redovi se preskoknuvaat
    const existing = new Set((await tx.select({ k: bankStatementLines.lineKey }).from(bankStatementLines)
      .where(and(eq(bankStatementLines.clientId, clientId), inArray(bankStatementLines.lineKey, parsed.lines.map((l) => l.key).concat("-"))))).map((x) => x.k));
    let skipped = 0;
    for (const l of parsed.lines) {
      if (existing.has(l.key)) { skipped++; continue; }
      await tx.insert(bankStatementLines).values({ statementId: s!.id, clientId, lineNo: l.lineNo, lineKey: l.key, direction: l.direction, amount: l.amount,
        valueDate: parsed.format === "mt940" ? l.extra || parsed.date! : parsed.date ?? l.extra, counterpartyName: l.name || null, counterpartyAccount: l.account || null, counterpartyEdb: l.edb || null,
        paymentCode: l.paymentCode || null, purpose: l.purpose || null, refDebit: l.refDebit || null, refCredit: l.refCredit || null,
        extra: parsed.format === "mk-txt" ? l.extra || null : null });
    }
    if (skipped) warnings.push(`${skipped} ставки се веќе увезени со претходен извод и се прескокнати.`);
    await audit(tx, actor, { clientId, entity: "bank_statement", entityId: s!.id, action: "import", changes: { no: parsed.statementNo, lines: parsed.lines.length - skipped } });
    return s!;
  });

  warnings.push(...await continuityWarnings(db, clientId, st.id));

  let booked = 0, categorized = 0; const errors: string[] = [];
  if (opts.autoBook) {
    // ednа po edna: sekoe knizenje go menuva "otvoreno", pa prepoznavanjeto se pravi odnovo
    const lines = await db.select().from(bankStatementLines).where(eq(bankStatementLines.statementId, st.id)).orderBy(asc(bankStatementLines.lineNo));
    for (const l of lines) {
      const m = matchLine(lineInput(l), await matchContext(db, (await db.select().from(clients).where(eq(clients.id, clientId)))[0]!));
      if (m.category && m.categorySure) { await setCategory(db, clientId, l.id, m.category, "auto"); categorized++; continue; }
      if (m.confidence !== "sure") continue;
      try { await bookLine(db, clientId, l.id, { partnerId: m.partnerId!, allocations: m.allocations?.map((a) => ({ id: a.id, amount: a.amount })) ?? null }, actor); booked++; }
      catch (e) { errors.push(`Ставка ${l.lineNo}: ${(e as Error).message}`); }
    }
  }
  return { id: st.id, statementNo: st.statementNo, lines: (await db.select({ n: sql<number>`count(*)::int` }).from(bankStatementLines).where(eq(bankStatementLines.statementId, st.id)))[0]!.n,
    booked, categorized, warnings: [...warnings, ...errors] };
}

/** Redosled na izvodite na edna smetka: datum, pa broj na izvod (kako broj), pa id. */
export const STATEMENT_ORDER = sql.raw(`statement_date, nullif(regexp_replace(coalesce(statement_no, ''), '\\D', '', 'g'), '')::numeric nulls last, id`);

/**
 * Kontinuitet (docs/08): prethodnata sostojba na izvodot = novata sostojba na prethodniot izvod (po datum, ne po vreme na uvoz).
 * Postar izvod uvezen podocna si go zazema mestoto po datum; se predupreduva, bidejki avtomatskoto povrzuvanje gi gleda
 * fakturite otvoreni vo momentot na uvozot.
 */
export async function continuityWarnings(db: Db, clientId: number, statementId: number): Promise<string[]> {
  const [me] = await db.select().from(bankStatements).where(eq(bankStatements.id, statementId));
  if (!me?.ownAccount || !me.statementDate) return [];
  const rows = (await db.execute(sql`select id, statement_no, statement_date, opening_balance, closing_balance from bank_statements
    where client_id = ${clientId} and own_account = ${me.ownAccount} and statement_date is not null order by ${STATEMENT_ORDER}`)) as unknown;
  const list = (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows) as { id: number; statement_no: string | null; statement_date: string; opening_balance: string | null; closing_balance: string | null }[];
  const i = list.findIndex((r) => Number(r.id) === me.id);
  const prev = list[i - 1], next = list[i + 1];
  const d = (x: string) => `${x.slice(8, 10)}.${x.slice(5, 7)}.${x.slice(0, 4)}`;
  const name = (r: typeof prev) => `бр. ${r!.statement_no ?? "?"} од ${d(r!.statement_date)}`;
  const eq2 = (a: string | null, b: string | null) => a === null || b === null || Number(a).toFixed(2) === Number(b).toFixed(2);
  const out: string[] = [];
  if (next) out.push(`Изводот е постар од веќе увезениот ${name(next)}. Се подредува по датум. Автоматски се прокнижени само сигурните ставки; проверете ги ставките „за обработка“.`);
  if (prev && !eq2(prev.closing_balance, me.openingBalance))
    out.push(`Недостасува извод помеѓу ${name(prev)} и овој: новата состојба таму е ${Number(prev.closing_balance).toFixed(2)}, а претходната состојба тука е ${Number(me.openingBalance).toFixed(2)}.`);
  if (next && !eq2(me.closingBalance, next.opening_balance))
    out.push(`Недостасува извод помеѓу овој и ${name(next)}: новата состојба тука е ${Number(me.closingBalance).toFixed(2)}, а претходната состојба таму е ${Number(next.opening_balance).toFixed(2)}.`);
  return out;
}

/** Samo citanje (bez zapis): datum, broj i smetka - za uvoz na povekje datoteki po red na datum. */
export async function peekStatement(db: Db, clientId: number, text: string) {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  try {
    const p = parseAny(text, client!.bankImportMapping);
    const dates = p.lines.map((l) => (p.format === "csv" ? l.extra : null)).filter((x): x is string => !!x).sort();
    return { ok: true as const, date: p.date ?? dates[0] ?? null, statementNo: p.statementNo, ownAccount: p.ownAccount, lines: p.lines.length };
  } catch (e) { return { ok: false as const, error: (e as Error).message }; }
}

export type LineStatus = "booked" | "ignored" | "open";
/** Stavki na izvodot so status i (za otvorenite) predlog. */
export async function statementDetail(db: Db, clientId: number, statementId: number) {
  const [s] = await db.select().from(bankStatements).where(and(eq(bankStatements.id, statementId), eq(bankStatements.clientId, clientId)));
  if (!s) throw new DomainError("not_found", "Изводот не постои.", 404);
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  const rows = await db.select({ l: bankStatementLines, voided: payments.voidedAt, pPartner: payments.partnerId, pName: partners.name,
    allocated: sql<string>`(select coalesce(sum(a.amount), 0) from payment_allocations a where a.payment_id = ${payments.id})`,
    docs: sql<string | null>`(select string_agg(coalesce(i.number, pi.number || ' (' || pi.supplier_number || ')'), ', ' order by a.id) from payment_allocations a
      left join invoices i on i.id = a.invoice_id left join purchase_invoices pi on pi.id = a.purchase_invoice_id where a.payment_id = ${payments.id})` })
    .from(bankStatementLines).leftJoin(payments, eq(payments.id, bankStatementLines.paymentId)).leftJoin(partners, eq(partners.id, payments.partnerId))
    .where(eq(bankStatementLines.statementId, s.id)).orderBy(asc(bankStatementLines.lineNo));
  const ctx = await matchContext(db, client!);
  const lines = rows.map((r) => {
    const status: LineStatus = r.l.ignored ? "ignored" : r.l.paymentId && !r.voided ? "booked" : "open";
    const suggestion: MatchResult | null = status === "open" ? matchLine(lineInput(r.l), ctx) : null;
    const openForPartner = suggestion?.partnerId ? (r.l.direction === "in" ? ctx.openIn : ctx.openOut).filter((o) => o.partnerId === suggestion.partnerId)
      .map((o) => ({ id: o.id, number: o.number, remaining: o.remaining, dueDate: o.dueDate })) : [];
    // stari "ne se knizi" bez vid -> prikaz kako "Не се книжи"
    return { ...r.l, status, suggestion, openForPartner,
      booking: status === "booked" ? { paymentId: r.l.paymentId, partnerId: r.pPartner, partnerName: r.pName, allocated: r.allocated, documents: r.docs } : null };
  });
  const sum = (st: LineStatus) => lines.filter((l) => l.status === st).length;
  return { ...s, lines, counts: { open: sum("open"), booked: sum("booked"), ignored: sum("ignored"),
    sure: lines.filter((l) => l.suggestion?.confidence === "sure" || (l.suggestion?.category && l.suggestion.categorySure)).length } };
}

/** Knizenje na site sigurni otvoreni stavki. */
export async function bookSure(db: Db, clientId: number, statementId: number, actor: Actor & { userId: number }) {
  let booked = 0; const errors: string[] = [];
  for (;;) {
    const d = await statementDetail(db, clientId, statementId);
    for (const l of d.lines.filter((x) => x.status === "open" && x.suggestion?.category && x.suggestion.categorySure)) {
      await setCategory(db, clientId, l.id, l.suggestion!.category!, "auto"); booked++;
    }
    const next = d.lines.find((l) => l.status === "open" && l.suggestion?.confidence === "sure" && !errors.some((e) => e.startsWith(`Ставка ${l.lineNo}:`)));
    if (!next) break;
    try {
      await bookLine(db, clientId, next.id, { partnerId: next.suggestion!.partnerId!, allocations: next.suggestion!.allocations?.map((a) => ({ id: a.id, amount: a.amount })) ?? null }, actor);
      booked++;
    } catch (e) { errors.push(`Ставка ${next.lineNo}: ${(e as Error).message}`); }
  }
  return { booked, errors };
}

/** Vid na stavka sto ne e plakjanje po faktura (trosok, prenos, pozajmica) ili null = vrati vo obrabotka. */
export async function setCategory(db: Db, clientId: number, lineId: number, category: ExpenseCategory | null, source: "auto" | "manual") {
  const [l] = await db.select().from(bankStatementLines).where(and(eq(bankStatementLines.id, lineId), eq(bankStatementLines.clientId, clientId)));
  if (!l) throw new DomainError("not_found", "Ставката не постои.", 404);
  if (category && l.paymentId) {
    const [p] = await db.select({ v: payments.voidedAt }).from(payments).where(eq(payments.id, l.paymentId));
    if (p && !p.v) throw new DomainError("validation", "Ставката е прокнижена како уплата: прво сторнирајте ја уплатата.", 422);
  }
  await db.update(bankStatementLines).set({ ignored: !!category, category, categorySource: category ? source : null, ignoreReason: category ? EXPENSE_CATEGORIES[category].name : null })
    .where(eq(bankStatementLines.id, l.id));
}
