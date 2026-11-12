/**
 * Stopanska banka: izvod vo TXT (fiksna sirina, UTF-8, LF). Proveren na vistinski izvodi 08/2026 (redovi od 317 znaci) i 11/2026 (340 znaci) (docs/08).
 *
 * Red 1 (zaglavje): "1" | smetka 15 cifri | datum dd.MM.yyyy | broj na izvod | broj na stavki (6) |
 *                   pobaruva/priliv (14) | dolguva/odliv (14) | prethodna sostojba (18).  Nova = prethodna + priliv - odliv.
 * Red 2+ (stavki):  "2" + vid | " x " | priliv (14) | odliv (14) | smetka na partnerot (15) | naziv (108) |
 *                   sifra (3 cifri do 2026, potoa 4 bukvi, na pr. GDDS) | povikuvanje zadolzuva | povikuvanje odobruva
 *                   (dvete so ista sirina: 24 ili 35) | cel (70) | datum (10) | referenca na bankata (30).
 * Nema EDB na partnerot (samo nasiot, vo XML/XLS/DAT) -> partnerot se prepoznava po smetka, broj na faktura i naziv.
 */
import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { DomainError } from "./errors.js";
import type { ParsedStatement, StatementLine } from "./bank-txt.js";

const HEAD = /^1(\d{15})(\d{2})\.(\d{2})\.(\d{4})(\d+?)(\d{6})(\d{11}\.\d{2})(\d{11}\.\d{2})(-?\d{15}\.\d{2})\s*$/;
const LINE = /^2\d \d (\d{11}\.\d{2})(\d{11}\.\d{2})(\d{15})/;
const acc = (s: string) => `${s.slice(0, 3)}-${s.slice(3, 13)}-${s.slice(13)}`;
const iso = (s: string) => { const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

export function looksLikeStbTxt(text: string) {
  const l = text.replace(/^﻿/, "").split(/\r?\n/);
  return HEAD.test(l[0] ?? "") && (!(l[1] ?? "").trim() || LINE.test(l[1]!));
}

export function parseStbTxt(text: string): ParsedStatement {
  const clean = text.replace(/^﻿/, "");
  const rows = clean.split(/\r?\n/);
  const h = HEAD.exec(rows[0] ?? "");
  if (!h) throw new DomainError("validation", "Датотеката не е извод од Стопанска банка (TXT).", 422);
  const ownAccount = acc(h[1]!), date = `${h[4]}-${h[3]}-${h[2]}`, statementNo = String(Number(h[5]));
  const count = Number(h[6]), credit = new Decimal(h[7]!), debit = new Decimal(h[8]!), opening = new Decimal(h[9]!);
  const closing = opening.plus(credit).minus(debit);
  const lines: StatementLine[] = [];
  let sIn = new Decimal(0), sOut = new Decimal(0);
  rows.slice(1).forEach((raw) => {
    if (!raw.trim()) return;
    const lineNo = lines.length + 1;
    const m = LINE.exec(raw);
    const bad = (what: string) => new DomainError("validation", `Ставка ${lineNo}: ${what}. Форматот на изводот од Стопанска не е како очекуваниот.`, 422);
    if (!m || raw.length < 156 + 3 + 2 + 110) throw bad("колоните не се на очекуваното место");
    const cIn = new Decimal(m[1]!), cOut = new Decimal(m[2]!);
    if (cIn.isZero() === cOut.isZero()) throw bad("износот мора да е или прилив или одлив");
    const tail = raw.slice(-110);                                  // cel 70 | datum 10 | referenca 30
    const mid = raw.slice(156, raw.length - 110);                 // sifra | povikuvanje x2
    const codeLen = /^[A-Z]{4}/.test(mid) ? 4 : 3;
    const w = (mid.length - codeLen) / 2;
    if (!Number.isInteger(w) || w < 1) throw bad("повикувањето на број не е на очекуваното место");
    const valueDate = iso(tail.slice(70, 80));
    if (!valueDate) throw bad(`датумот „${tail.slice(70, 80)}“ не е датум`);
    const direction = cIn.isZero() ? "out" as const : "in" as const;
    const amount = (direction === "in" ? cIn : cOut);
    if (direction === "in") sIn = sIn.plus(amount); else sOut = sOut.plus(amount);
    const l: StatementLine = { lineNo, direction, amount: amount.toFixed(2), name: raw.slice(48, 156).trim().replace(/\s{2,}/g, " "),
      account: acc(m[3]!), edb: "", paymentCode: mid.slice(0, codeLen).trim(), purpose: tail.slice(0, 70).trim(),
      refDebit: mid.slice(codeLen, codeLen + w).trim(), refCredit: mid.slice(codeLen + w).trim(), extra: valueDate, key: "" };
    const bankRef = tail.slice(80).trim();
    l.key = createHash("sha256").update([ownAccount, date, statementNo, lineNo, l.direction, l.amount, l.account, l.purpose, l.refCredit, bankRef].join("|")).digest("hex");
    lines.push(l);
  });
  // proverka: brojot na stavki i prometot od zaglavjeto = zbirot na stavkite -> izvodot e celosen i tocno procitan
  if (lines.length !== count || !sIn.eq(credit) || !sOut.eq(debit)) {
    throw new DomainError("validation", `Изводот не е целосен или не е точно прочитан: заглавје ${count} ставки, прилив ${credit.toFixed(2)}, одлив ${debit.toFixed(2)}; `
      + `прочитано ${lines.length} ставки, прилив ${sIn.toFixed(2)}, одлив ${sOut.toFixed(2)}.`, 422);
  }
  return { format: "stb-txt", statementNo, date, ownAccount, opening: opening.toFixed(2), closing: closing.toFixed(2), lines,
    warnings: lines.length ? [] : ["Изводот нема ставки."], fileHash: createHash("sha256").update(clean.replace(/\r\n/g, "\n").trimEnd()).digest("hex") };
}
