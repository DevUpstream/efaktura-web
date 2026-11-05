/**
 * Izvod od banka vo tekstualen format so fiksna sirina (docs/08).
 * Proveren na vistinski izvodi od Halkbank i Sparkasse (ist format, 05.11.2026):
 *
 *   red 1  broj na izvod          red 4  prethodna sostojba (1,234.56)
 *   red 2  datum (dd.MM.yyyy)     red 5  nova sostojba
 *   red 3  nasa smetka (XXX-XXXXXXXXXX-XX)
 *   red 6+ stavki (znaci, ne bajti):
 *     0-70 naziv | 70-88 smetka | 88-107 iznos (so znak; - = odliv) | 107-113 sifra na plakjanje
 *     113-185 cel | 185-209 povikuvanje na broj (zadolzuvanje) | 209-233 povikuvanje na broj (odobruvanje)
 *     233-257 EDB (kaj Sparkasse; kaj PP50 kon Trezor e EDB na nalogodavacot = nas) | 257-281 (nepoznato, se cuva)
 *
 * Kaj Halkbank redot zavrsuva po povikuvanjeto (bez EDB). Drugi banki (Stopanska, Komercijalna, NLB)
 * ne se provereni: ako ne go zadovoluvaat ovoj format, parserot odbiva (ne pogoduva).
 */
import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { DomainError } from "./errors.js";

export interface StatementLine {
  lineNo: number; direction: "in" | "out"; amount: string; name: string; account: string; edb: string; paymentCode: string;
  purpose: string; refDebit: string; refCredit: string; extra: string; key: string;
}
export interface ParsedStatement {
  format: "mk-txt" | "csv"; statementNo: string | null; date: string | null; ownAccount: string | null;
  opening: string | null; closing: string | null; lines: StatementLine[]; warnings: string[]; fileHash: string;
}

const ACC = /^\d{3}-\d{10}-\d{2}$/;
const COLS = { name: [0, 70], account: [70, 88], amount: [88, 107], code: [107, 113], purpose: [113, 185], refDebit: [185, 209],
  refCredit: [209, 233], edb: [233, 257], extra: [257, 281] } as const;

/** "1,234.56" / "-68,989.00" -> Decimal (iljadarki so zapirka, decimali so tocka). */
export function parseTxtAmount(s: string): Decimal | null {
  const t = s.trim().replace(/,/g, "");
  return /^[-+]?\d+(\.\d{1,4})?$/.test(t) ? new Decimal(t) : null;
}
const isoDate = (s: string) => { const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s.trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

/** Dali tekstot e izvod vo ovoj format (za avtomatsko prepoznavanje). */
export function looksLikeMkTxt(text: string) {
  const l = text.replace(/^﻿/, "").split(/\r?\n/);
  return l.length >= 5 && /^\d+\s*$/.test(l[0] ?? "") && !!isoDate(l[1] ?? "") && ACC.test((l[2] ?? "").trim()) && !!parseTxtAmount(l[3] ?? "") && !!parseTxtAmount(l[4] ?? "");
}

export function parseMkTxt(text: string): ParsedStatement {
  const clean = text.replace(/^﻿/, "");
  if (!looksLikeMkTxt(clean)) throw new DomainError("validation", "Датотеката не е извод во познат формат (број, датум, сметка, состојби, ставки).", 422);
  const rows = clean.split(/\r?\n/);
  const statementNo = rows[0]!.trim(), date = isoDate(rows[1]!)!, ownAccount = rows[2]!.trim();
  const opening = parseTxtAmount(rows[3]!)!, closing = parseTxtAmount(rows[4]!)!;
  const lines: StatementLine[] = []; const warnings: string[] = [];
  let sum = new Decimal(0);
  rows.slice(5).forEach((raw, i) => {
    if (!raw.trim()) return;
    const lineNo = i + 1;
    const col = (c: readonly [number, number]) => raw.slice(c[0], c[1]).trim();
    const amount = parseTxtAmount(col(COLS.amount));
    const account = col(COLS.account);
    if (!amount || amount.isZero() || (account && !ACC.test(account))) {
      throw new DomainError("validation", `Ставка ${lineNo}: колоните не се на очекуваното место (износ „${col(COLS.amount)}“, сметка „${account}“). Форматот на оваа банка не е проверен.`, 422);
    }
    sum = sum.plus(amount);
    const l = { lineNo, direction: amount.gt(0) ? "in" as const : "out" as const, amount: amount.abs().toFixed(2), name: col(COLS.name).replace(/\s{2,}/g, " "),
      account, edb: /^\d{13}$/.test(col(COLS.edb)) ? col(COLS.edb) : "", paymentCode: col(COLS.code), purpose: col(COLS.purpose),
      refDebit: col(COLS.refDebit), refCredit: col(COLS.refCredit), extra: col(COLS.extra), key: "" };
    l.key = createHash("sha256").update([ownAccount, date, statementNo, lineNo, amount.toFixed(2), account, l.purpose, l.refCredit].join("|")).digest("hex");
    lines.push(l);
  });
  // proverka: prethodna + promet = nova sostojba -> izvodot e celosen i tocno procitan
  if (!opening.plus(sum).eq(closing)) {
    throw new DomainError("validation", `Изводот не е целосен или не е точно прочитан: ${opening.toFixed(2)} + промет ${sum.toFixed(2)} ≠ нова состојба ${closing.toFixed(2)}.`, 422);
  }
  if (!lines.length) warnings.push("Изводот нема ставки.");
  return { format: "mk-txt", statementNo, date, ownAccount, opening: opening.toFixed(2), closing: closing.toFixed(2), lines, warnings,
    fileHash: createHash("sha256").update(clean.replace(/\r\n/g, "\n").trimEnd()).digest("hex") };
}

/** Smetka vo edinstven oblik za sporedba (bez crticki i prazni mesta). */
export const normAccount = (s: string | null | undefined) => (s ?? "").replace(/[\s-]/g, "");
