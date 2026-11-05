/**
 * Uvoz na izvod od banka (docs/08). Formatite na bankite se razlikuvaat i ne se izmisluvaat:
 * korisnikot ednash gi mapira kolonite (clients.bankImportMapping), a parserot cita CSV po toa mapiranje.
 */
import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import type { BankImportMapping } from "../db/schema.js";
import { DomainError } from "./errors.js";

export interface StatementRow { line: number; date: string; amount: string; direction: "in" | "out"; name: string; account: string; reference: string; key: string }

/** CSV red -> kolони, so navodnici ("a;b" ostanuva edna kolona, "" = navodnik). */
export function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseAmount(s: string, decimal: "," | "."): Decimal | null {
  let t = s.replace(/\s| /g, "").replace(/(MKD|ден\.?)$/i, "");
  if (!t) return null;
  t = decimal === "," ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  if (!/^[-+]?\d+(\.\d+)?$/.test(t)) return null;
  return new Decimal(t);
}

export function parseDate(s: string, fmt: BankImportMapping["dateFormat"]): string | null {
  const t = s.trim().slice(0, 10);
  const m = fmt === "yyyy-MM-dd" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(t) : /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(t);
  if (!m) return null;
  const [y, mo, d] = fmt === "yyyy-MM-dd" ? [m[1]!, m[2]!, m[3]!] : [m[3]!, m[2]!.padStart(2, "0"), m[1]!.padStart(2, "0")];
  const iso = `${y}-${mo}-${d}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

export function parseStatement(text: string, m: BankImportMapping): { rows: StatementRow[]; skipped: { line: number; reason: string }[] } {
  if (text.length > 2_000_000) throw new DomainError("validation", "Изводот е преголем (најмногу 2 MB).", 422);
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const rows: StatementRow[] = []; const skipped: { line: number; reason: string }[] = [];
  const delim = m.delimiter === "\\t" ? "\t" : m.delimiter;
  lines.forEach((raw, idx) => {
    const line = idx + 1;
    if (idx < m.skipRows || !raw.trim()) return;
    const c = splitCsvLine(raw, delim);
    const get = (i?: number) => (i === undefined || i < 0 ? "" : c[i] ?? "");
    const date = parseDate(get(m.dateCol), m.dateFormat);
    if (!date) { skipped.push({ line, reason: "датум" }); return; }
    let amount: Decimal | null;
    if (m.amountMode === "signed") amount = parseAmount(get(m.amountCol), m.decimal);
    else {
      const cr = parseAmount(get(m.creditCol), m.decimal) ?? new Decimal(0);
      const db = parseAmount(get(m.debitCol), m.decimal) ?? new Decimal(0);
      amount = cr.abs().minus(db.abs());
    }
    if (!amount || amount.isZero()) { skipped.push({ line, reason: "износ" }); return; }
    const name = get(m.nameCol), account = get(m.accountCol).replace(/\s/g, "");
    const reference = m.referenceCols.map((i) => get(i)).filter(Boolean).join(" ");
    const key = createHash("sha256").update([date, amount.toFixed(2), account, name, reference].join("|")).digest("hex").slice(0, 64);
    rows.push({ line, date, amount: amount.abs().toFixed(2), direction: amount.gt(0) ? "in" : "out", name, account, reference, key });
  });
  // ist red dvapati vo ist izvod (na pr. dve isti uplati vo ist den) -> razlicen kluc po redosled
  const seen = new Map<string, number>();
  for (const r of rows) { const n = (seen.get(r.key) ?? 0) + 1; seen.set(r.key, n); if (n > 1) r.key = createHash("sha256").update(`${r.key}#${n}`).digest("hex"); }
  return { rows, skipped };
}

/** Broevi na fakturi vo tekstot (MC-2026-00001, MC-OD-2026-00001...) za prepoznavanje. */
export function findInvoiceNumbers(text: string, prefixes: string[]): string[] {
  if (!prefixes.length) return [];
  const esc = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`(?:${esc})(?:-[A-Z]{2})?-\\d{4}-\\d{1,5}`, "gi");
  return [...new Set((text.match(re) ?? []).map((s) => {
    const parts = s.toUpperCase().split("-"); parts[parts.length - 1] = parts[parts.length - 1]!.padStart(5, "0"); return parts.join("-");
  }))];
}

/** Latinica -> kirilica (makedonska), za da se sporedat nazivi napishani razlicno (ELEKTRO LINK = ЕЛЕКТРО ЛИНК). */
const LAT2: [string, string][] = [["DZH", "Џ"], ["DŽ", "Џ"], ["DZ", "Ѕ"], ["GJ", "Ѓ"], ["KJ", "Ќ"], ["LJ", "Љ"], ["NJ", "Њ"], ["CH", "Ч"], ["ZH", "Ж"], ["SH", "Ш"]];
const LAT1: Record<string, string> = { A: "А", B: "Б", C: "Ц", Č: "Ч", Ć: "Ќ", D: "Д", Đ: "Ѓ", E: "Е", F: "Ф", G: "Г", H: "Х", I: "И", J: "Ј", K: "К", L: "Л", M: "М",
  N: "Н", O: "О", P: "П", Q: "К", R: "Р", S: "С", Š: "Ш", T: "Т", U: "У", V: "В", W: "В", X: "КС", Y: "И", Z: "З", Ž: "Ж" };
export function toCyrillic(s: string) {
  let t = s.toUpperCase();
  for (const [a, b] of LAT2) t = t.split(a).join(b);
  return [...t].map((c) => LAT1[c] ?? c).join("");
}

/** Naziv za sporedba: kirilica, golemi bukvi, bez interpunkcija i pravna forma (\b ne raboti so kirilica -> prazni mesta). */
export const normalizeName = (s: string) => ` ${toCyrillic(s).replace(/["„“”'.,()]/g, " ")} `
  .replace(/\s(ДООЕЛ|ДОО|АД|ТП)(?=\s)/g, " ").replace(/\s+/g, " ").trim();
