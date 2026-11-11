/**
 * Izvod od banka vo SWIFT MT940 formatot (docs/08).
 * Proveren na vistinski izvod od NLB Banka (BIC TUTNMK22, smetki 210-..., 09.10.2026).
 *
 *   :20:  referenca na izvodot            :60F:/:60M: prethodna sostojba  C/D + YYMMDD + valuta + iznos (zapirka = decimali)
 *   :25:  nasha smetka (15 cifri)         :62F:/:62M: nova sostojba (datumot e datum na izvodot)
 *   :28C: broj na izvod (n ili n/m)
 *   :61:  YYMMDD [MMDD] C|D|RC|RD [bukva na sredstva] iznos N+3 <ref. za klientot>//<ref. na bankata>
 *         kaj NLB: ref. za klientot = smetka na drugata strana; ref. na bankata = povikuvanje na broj (na pr. "01344/99/26").
 *   :86:  /BENM/ smetka (primac, pri odliv) ili /ORDP/ smetka (nalogodavac, pri priliv), /BNAME/ naziv, /PRPD/ cel, /CODE/ shifra na plakjanje.
 *         Redovite na :86: se prekinati na 65 znaci i usred zbor -> se spojuvaat BEZ prazno mesto.
 *
 * Drugi banki shto davaat MT940 (Stopanska, Komercijalna...) ne se provereni: sostojbata (prethodna + promet = nova) mora da se sovpadne,
 * inaku parserot odbiva.
 */
import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { DomainError } from "./errors.js";
import type { ParsedStatement, StatementLine } from "./bank-txt.js";

/** Dali tekstot e MT940 (za avtomatsko prepoznavanje). */
export function looksLikeMt940(text: string) {
  const t = text.replace(/\r/g, "");
  return /(^|\n):20:/.test(t) && /\n:25:/.test(t) && /\n:60[FM]:/.test(t) && /\n:62[FM]:/.test(t);
}

/** "130212,00" -> Decimal. */
export function parseMtAmount(s: string): Decimal | null {
  const t = s.trim();
  return /^\d+(,\d{0,4})?$/.test(t) ? new Decimal(t.replace(",", ".").replace(/\.$/, "")) : null;
}

/** YYMMDD -> ISO (godini 00-79 = 20xx). */
function ymd(s: string) {
  const y = Number(s.slice(0, 2)), iso = `${y < 80 ? 2000 + y : 1900 + y}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** 15 cifri (210076965310159) -> 210-0769653101-59; se drugo ostanuva kakvo shto e. */
export function mkAccount(s: string) {
  const d = s.replace(/[\s-]/g, "");
  const m = /^(?:MK\d{2})?(\d{15})$/.exec(d);
  return m ? `${m[1]!.slice(0, 3)}-${m[1]!.slice(3, 13)}-${m[1]!.slice(13)}` : s.trim();
}

/** Tagovite na edna poraka: [tag, vrednost] (povekje redovi se spojuvaat; :86: bez prazno mesto). */
function tags(body: string): [string, string][] {
  const out: [string, string][] = [];
  for (const raw of body.split(/\r?\n/)) {
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(raw);
    if (m) out.push([m[1]!, m[2]!]);
    else if (out.length && raw.trim() && !/^-?\}?$/.test(raw.trim())) {
      const last = out[out.length - 1]!;
      last[1] += last[0] === "86" ? raw : `\n${raw}`;
    }
  }
  return out;
}

/** /KEY/vrednost/KEY2/... -> mapa (samo poznatite klucevi, za da "/" vo tekstot ne go raskine poleto). */
const K86 = ["BENM", "ORDP", "BNAME", "PRPD", "CODE", "REMI", "EREF"];
export function parse86(s: string): Record<string, string> {
  const re = new RegExp(`/(${K86.join("|")})/`, "g");
  const hits = [...s.matchAll(re)];
  const out: Record<string, string> = {};
  hits.forEach((h, i) => { out[h[1]!] = s.slice(h.index! + h[0].length, i + 1 < hits.length ? hits[i + 1]!.index : undefined).trim(); });
  if (!hits.length && s.trim()) out.PRPD = s.trim();
  return out;
}

const BAL = /^([CD])(\d{6})([A-Z]{3})(\d+,\d*)$/;
const L61 = /^(\d{6})(\d{4})?(R?[CD])([A-Z])?(\d+,\d*)([NSF][A-Z0-9]{3})([^\n]*?)(?:\/\/([^\n]*))?(?:\n([\s\S]*))?$/;

export function parseMt940(text: string): ParsedStatement {
  const clean = text.replace(/^\uFEFF/, "");
  const t = tags(clean.replace(/^[\s\S]*?\{4:\s*\r?\n/, ""));
  const count = (k: string) => t.filter(([g]) => g === k).length;
  if (count("20") !== 1) {
    throw new DomainError("validation", count("20") ? `Датотеката содржи ${count("20")} изводи. Преземете ги од е-банкарство секој посебно.` : "Датотеката не е MT940 извод.", 422);
  }
  const get = (...k: string[]) => t.find(([g]) => k.includes(g))?.[1];
  const acc = get("25"), no = get("28C", "28"), op = get("60F", "60M"), cl = get("62F", "62M");
  const mo = BAL.exec(op ?? ""), mc = BAL.exec(cl ?? "");
  if (!acc || !mo || !mc) throw new DomainError("validation", "MT940: недостасува сметка (:25:) или состојба (:60F:/:62F:).", 422);
  if (mo[3] !== "MKD" || mc[3] !== "MKD") throw new DomainError("validation", `MT940: изводот е во ${mo[3]}. Засега се увезуваат само денарски изводи.`, 422);
  const sign = (cd: string, a: string) => (cd === "D" ? parseMtAmount(a)!.neg() : parseMtAmount(a)!);
  const opening = sign(mo[1]!, mo[4]!), closing = sign(mc[1]!, mc[4]!);
  const date = ymd(mc[2]!);
  const ownAccount = mkAccount(acc.split("/").pop()!);
  const statementNo = (no ?? get("20")!).split("/")[0]!.trim();

  const lines: StatementLine[] = []; const warnings: string[] = [];
  let sum = new Decimal(0);
  t.forEach(([g, v], i) => {
    if (g !== "61") return;
    const lineNo = lines.length + 1;
    const m = L61.exec(v);
    const amount = m ? parseMtAmount(m[5]!) : null;
    if (!m || !amount || amount.isZero()) throw new DomainError("validation", `MT940 ставка ${lineNo}: не може да се прочита („${v.slice(0, 40)}“).`, 422);
    const dc = m[3]!; // C, D, RC (storno na priliv = odliv), RD (storno na odliv = priliv)
    const direction = dc === "C" || dc === "RD" ? "in" as const : "out" as const;
    sum = direction === "in" ? sum.plus(amount) : sum.minus(amount);
    const f86 = t[i + 1]?.[0] === "86" ? parse86(t[i + 1]![1]) : {};
    const party = f86.BENM ?? f86.ORDP ?? m[7]!.trim();
    const account = /^\d{15}$/.test(party.replace(/[\s-]/g, "")) ? mkAccount(party) : "";
    const l: StatementLine = { lineNo, direction, amount: amount.toFixed(2), name: (f86.BNAME ?? "").replace(/\s{2,}/g, " ").trim(), account, edb: "",
      paymentCode: (f86.CODE ?? "").trim(), purpose: (f86.PRPD ?? f86.REMI ?? "").replace(/\s{2,}/g, " ").trim(), refDebit: "",
      refCredit: (m[8] ?? "").trim(), extra: ymd(m[1]!) ?? "", key: "" };
    l.key = createHash("sha256").update([ownAccount, date, statementNo, lineNo, amount.toFixed(2), direction, account, l.purpose, l.refCredit].join("|")).digest("hex");
    lines.push(l);
  });
  if (!opening.plus(sum).eq(closing)) {
    throw new DomainError("validation", `Изводот не е целосен или не е точно прочитан: ${opening.toFixed(2)} + промет ${sum.toFixed(2)} ≠ нова состојба ${closing.toFixed(2)}.`, 422);
  }
  if (!lines.length) warnings.push("Изводот нема ставки.");
  return { format: "mt940", statementNo, date, ownAccount, opening: opening.toFixed(2), closing: closing.toFixed(2), lines, warnings,
    fileHash: createHash("sha256").update(clean.replace(/\r\n/g, "\n").trimEnd()).digest("hex") };
}
