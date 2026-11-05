/**
 * Prepoznavanje na stavka od izvod (docs/08).
 *
 * PARTNER (po redosled na sigurnost):
 *   1. EDB vo kolonata na izvodot (Sparkasse)                       -> sigurno
 *   2. ziro-smetka (racno vnesena ili naucena od porano)            -> sigurno
 *   3. poln broj na nasa faktura vo celta / povikuvanjeto           -> sigurno
 *   4. EDB (13 cifri) vo tekstot na celta                           -> verojatno
 *   5. naziv (bez DOOEL/DOO/AD), samo ako e edinstven               -> verojatno
 *   Nashiot EDB i nashite smetki nikogas ne se partner (PP50 kon Trezor go nosi nashiot EDB).
 *
 * FAKTURI (koga partnerot e poznat):
 *   a. poln broj (MC-2026-00004, MC-2026-4)                         -> sigurno
 *   b. kratok broj so godina (4/2026, 2026-4) kaj fakturite na partnerot -> sigurno
 *   c. tocen iznos na edna otvorena faktura                          -> sigurno
 *   d. edinstvena kombinacija na otvoreni fakturi so tocen zbir      -> sigurno
 *   e. inaku od najstarata                                          -> verojatno
 *   Vlezni fakturi (plakjanja): brojot na dobavuvacot vo tekstot, pa (c)-(e).
 *
 * SIGURNO = partner po 1-3 I fakturi po a-d. Samo sigurnite se knizat avtomatski.
 */
import { Decimal } from "decimal.js";
import { findInvoiceNumbers, normalizeName } from "./bank-import.js";
import { normAccount } from "./bank-txt.js";
import type { OpenItem } from "./payments.js";
import type { ExpenseCategory } from "../db/schema.js";

export type Confidence = "sure" | "likely" | "none";
export interface MatchLine { direction: "in" | "out"; amount: string; name: string | null; account: string | null; edb: string | null;
  purpose: string | null; refDebit: string | null; refCredit: string | null }
export interface MatchContext {
  clientEdb: string | null; prefix: string; ownAccounts: Set<string>;
  partners: { id: number; name: string; edb: string | null; isActive: boolean }[];
  accounts: Map<string, number>;                  // normalizirana smetka -> partnerId
  openIn: OpenItem[]; openOut: (OpenItem & { supplierNumber?: string })[];
}
export interface MatchResult {
  partnerId: number | null; partnerBy: "edb" | "account" | "invoice" | "edb-text" | "name" | null;
  allocations: { id: number; number: string; amount: string }[] | null;   // null = od najstarata
  allocBy: "number" | "short-number" | "supplier-number" | "exact" | "combination" | "fifo" | null;
  confidence: Confidence; hint: string | null;
  /** Vid trosok/prenos koga stavkata ne e plakjanje po faktura; categorySure = se knizi avtomatski. */
  category: ExpenseCategory | null; categorySure: boolean;
}

const PARTNER_SURE = new Set(["edb", "account", "invoice"]);
const ALLOC_SURE = new Set(["number", "short-number", "supplier-number", "exact", "combination"]);
const cents = (v: string | number) => Math.round(Number(v) * 100);
const normRef = (s: string) => s.toUpperCase().replace(/[\s.]/g, "");

/** Godina i reden broj od nash broj (PREFIX[-KOD]-GGGG-NNNNN). */
function yearSeq(number: string) { const p = number.split("-"); return { year: Number(p[p.length - 2]), seq: Number(p[p.length - 1]) }; }

/** Raspored po red na rok; ostatokot (preplata) ostanuva nerasporeden. */
function spread(items: OpenItem[], amount: string) {
  let left = new Decimal(amount);
  const out: { id: number; number: string; amount: string }[] = [];
  for (const o of items) { if (left.lte(0)) break; const a = Decimal.min(left, o.remaining); out.push({ id: o.id, number: o.number, amount: a.toFixed(2) }); left = left.minus(a); }
  return out;
}

/** Edinstvena kombinacija na stavki so tocen zbir (najmnogu 16 stavki = 65.536 kombinacii). */
export function uniqueSubset(items: OpenItem[], amount: string): OpenItem[] | null {
  const list = items.slice(0, 16); const target = cents(amount);
  let found: OpenItem[] | null = null; let count = 0;
  const n = list.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    let s = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) s += cents(list[i]!.remaining);
    if (s === target) { count++; if (count > 1) return null; found = list.filter((_, i) => mask & (1 << i)); }
  }
  return found;
}

export function matchLine(l: MatchLine, ctx: MatchContext): MatchResult {
  const text = [l.refCredit, l.refDebit, l.purpose].filter(Boolean).join(" ");
  const open = l.direction === "in" ? ctx.openIn : ctx.openOut;
  const active = ctx.partners.filter((p) => p.isActive);
  const res: MatchResult = { partnerId: null, partnerBy: null, allocations: null, allocBy: null, confidence: "none", hint: null, category: null, categorySure: false };
  const acc = normAccount(l.account);

  // --- trosoci i prenosi (sigurni pravila, pred partnerot)
  const cat = (c: ExpenseCategory, sure: boolean, hint: string) => ({ ...res, category: c, categorySure: sure, hint });
  if (acc && ctx.ownAccounts.has(acc)) return cat("transfer", true, "сметката е на нашата фирма");
  if (l.direction === "out" && /провизи/i.test(l.purpose ?? "") ) return cat("fee", true, "банката ја означила како провизија");
  if (l.direction === "out" && acc.startsWith("100")) return cat("tax", true, "уплатна сметка на Трезор (100-…)");

  // --- partner
  const edb = l.edb && l.edb !== ctx.clientEdb ? l.edb : "";
  let p = edb ? active.find((x) => x.edb === edb) : undefined;
  if (p) res.partnerBy = "edb";
  if (!p && acc && !ctx.ownAccounts.has(acc) && ctx.accounts.has(acc)) { p = active.find((x) => x.id === ctx.accounts.get(acc)); if (p) res.partnerBy = "account"; }
  const fullNums = l.direction === "in" ? findInvoiceNumbers(text, [ctx.prefix]) : [];
  const byFull = open.filter((o) => fullNums.some((n) => o.number.toUpperCase() === n));
  if (!p && byFull.length && new Set(byFull.map((o) => o.partnerId)).size === 1) { p = active.find((x) => x.id === byFull[0]!.partnerId); if (p) res.partnerBy = "invoice"; }
  if (!p) {
    const edbs = [...new Set(text.match(/(?<!\d)\d{13}(?!\d)/g) ?? [])].filter((e) => e !== ctx.clientEdb);
    const c = active.filter((x) => x.edb && edbs.includes(x.edb));
    if (c.length === 1) { p = c[0]; res.partnerBy = "edb-text"; }
  }
  if (!p && l.name) {
    const n = normalizeName(l.name);
    const c = active.filter((x) => { const pn = normalizeName(x.name); return pn.length > 3 && n.length > 3 && (n.includes(pn) || pn.includes(n)); });
    if (c.length === 1) { p = c[0]; res.partnerBy = "name"; }
  }
  if (!p) {
    const t = `${l.purpose ?? ""} ${l.refDebit ?? ""} ${l.refCredit ?? ""}`;
    if (l.direction === "out" && /виза|visa|master|маестро|maestro|картичк/i.test(t)) return cat("card", false, "плаќање со платежна картичка");
    if (l.direction === "out" && /дневниц|плата|плати|надомест|патни/i.test(t)) return cat("salary", false, "плата / дневница");
    if (l.direction === "out" && !l.edb) res.hint = "физичко лице?";
    return res;
  }
  res.partnerId = p.id;
  const mine = open.filter((o) => o.partnerId === p!.id);

  // --- fakturi
  const full = byFull.filter((o) => o.partnerId === p!.id);
  if (full.length) { res.allocations = spread(full, l.amount); res.allocBy = "number"; }
  if (!res.allocations && l.direction === "in") {
    const pairs = [...text.matchAll(/(?<!\d)(\d{1,5})\s*[/-]\s*(20\d{2})(?!\d)/g)].map((m) => ({ seq: Number(m[1]), year: Number(m[2]) }))
      .concat([...text.matchAll(/(?<!\d)(20\d{2})\s*[/-]\s*(\d{1,5})(?!\d)/g)].map((m) => ({ seq: Number(m[2]), year: Number(m[1]) })));
    const hit = mine.filter((o) => { const ys = yearSeq(o.number); return pairs.some((x) => x.seq === ys.seq && x.year === ys.year); });
    if (hit.length) { res.allocations = spread(hit, l.amount); res.allocBy = "short-number"; }
  }
  if (!res.allocations && l.direction === "out") {
    const t = normRef(text);
    const hit = (mine as (OpenItem & { supplierNumber?: string })[]).filter((o) => { const s = normRef(o.supplierNumber ?? ""); return s.length >= 3 && t.includes(s); });
    if (hit.length) { res.allocations = spread(hit, l.amount); res.allocBy = "supplier-number"; }
  }
  if (!res.allocations) {
    const exact = mine.filter((o) => cents(o.remaining) === cents(l.amount));
    if (exact.length === 1) { res.allocations = spread(exact, l.amount); res.allocBy = "exact"; }
  }
  if (!res.allocations && mine.length > 1) {
    const sub = uniqueSubset(mine, l.amount);
    if (sub) { res.allocations = spread(sub, l.amount); res.allocBy = "combination"; }
  }
  if (!res.allocations) { res.allocBy = mine.length ? "fifo" : null; res.allocations = null; }
  res.confidence = PARTNER_SURE.has(res.partnerBy!) && res.allocBy && ALLOC_SURE.has(res.allocBy) ? "sure" : "likely";
  if (!mine.length) res.hint = l.direction === "in" ? "нема отворени фактури: ќе остане како аванс/преплата" : "нема отворени влезни фактури";
  return res;
}
