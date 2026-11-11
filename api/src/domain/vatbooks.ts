/**
 * КИФ / КУФ (docs/13): книга на излезни и книга на влезни фактури за период, по ДДВ стапка.
 * [ПРЕТПОСТАВКА] Колоните се вообичаените (основица и ДДВ по стапка, ослободено, вкупно); распоредот го потврдува сметководителот.
 *
 * КИФ: издадени документи по датум на издавање (без понуди, нацрти, откажани и одбиени од УЈП).
 *   Сторно и книжно одобрение се со минус (како во фактурата). Сторнирана фактура останува во својот период; сторното е посебен ред.
 *   Корекција (KR): се книжи само разликата во однос на оригиналот (оригиналот останува во својот период).
 * КУФ: прокнижени влезни фактури по датум на прием (сторнираните – не).
 */
import { sql } from "drizzle-orm";
import { Decimal as D } from "decimal.js";
import type { Db } from "../db/types.js";

export const RATES = ["18", "10", "5"] as const;
export interface BookRow {
  no: number; id: number; date: string; issueDate: string; supplyDate: string | null; number: string; docType: string; supplierNumber?: string;
  partnerName: string; partnerEdb: string | null; partnerVat: string | null;
  base: Record<(typeof RATES)[number], string>; vat: Record<(typeof RATES)[number], string>; exempt: string; total: string; note: string | null;
}
export interface Book { kind: "kif" | "kuf"; from: string; to: string; rows: BookRow[]; totals: Omit<BookRow, "no" | "id" | "date" | "issueDate" | "supplyDate" | "number" | "docType" | "partnerName" | "partnerEdb" | "partnerVat" | "note"> & { count: number } }

const rowsOf = (r: unknown) => (Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? []) as Record<string, string | number | null>[];
const zero = () => ({ "18": new D(0), "10": new D(0), "5": new D(0) });

function build(kind: "kif" | "kuf", from: string, to: string,
  docs: { id: number; date: string; issueDate: string; supplyDate: string | null; number: string; docType: string; supplierNumber?: string;
    partnerName: string; partnerEdb: string | null; partnerVat: string | null; note: string | null; lines: { pct: string; net: D; vat: D }[] }[]): Book {
  const T = { base: zero(), vat: zero(), exempt: new D(0) };
  const rows = docs.map((d, i) => {
    const base = zero(), vat = zero(); let exempt = new D(0);
    for (const l of d.lines) {
      const k = String(Number(l.pct)) as (typeof RATES)[number];
      if ((RATES as readonly string[]).includes(k)) { base[k] = base[k].plus(l.net); vat[k] = vat[k].plus(l.vat); }
      else exempt = exempt.plus(l.net);   // 0 % (oslobodeno, ne e obvrznik, prenesena obvrska)
    }
    const r2 = (x: D) => x.toDecimalPlaces(2);
    const b = Object.fromEntries(RATES.map((k) => [k, r2(base[k])])) as Record<(typeof RATES)[number], D>;
    const v = Object.fromEntries(RATES.map((k) => [k, r2(vat[k])])) as Record<(typeof RATES)[number], D>;
    const e = r2(exempt);
    const total = RATES.reduce((a, k) => a.plus(b[k]).plus(v[k]), e);
    for (const k of RATES) { T.base[k] = T.base[k].plus(b[k]); T.vat[k] = T.vat[k].plus(v[k]); }
    T.exempt = T.exempt.plus(e);
    return { no: i + 1, id: d.id, date: d.date, issueDate: d.issueDate, supplyDate: d.supplyDate, number: d.number, docType: d.docType,
      ...(d.supplierNumber ? { supplierNumber: d.supplierNumber } : {}), partnerName: d.partnerName, partnerEdb: d.partnerEdb, partnerVat: d.partnerVat, note: d.note,
      base: Object.fromEntries(RATES.map((k) => [k, b[k].toFixed(2)])) as BookRow["base"], vat: Object.fromEntries(RATES.map((k) => [k, v[k].toFixed(2)])) as BookRow["vat"],
      exempt: e.toFixed(2), total: total.toFixed(2) };
  });
  const tt = RATES.reduce((a, k) => a.plus(T.base[k]).plus(T.vat[k]), T.exempt);
  return { kind, from, to, rows, totals: { count: rows.length,
    base: Object.fromEntries(RATES.map((k) => [k, T.base[k].toFixed(2)])) as BookRow["base"], vat: Object.fromEntries(RATES.map((k) => [k, T.vat[k].toFixed(2)])) as BookRow["vat"],
    exempt: T.exempt.toFixed(2), total: tt.toFixed(2) } };
}

export async function kif(db: Db, clientId: number, from: string, to: string): Promise<Book> {
  const heads = rowsOf(await db.execute(sql`
    select i.id, i.number, i.doc_type, i.issue_date, i.supply_date, i.related_invoice_id, i.note, coalesce(i.buyer_name, p.name) pname,
      coalesce(i.buyer_edb, p.edb) pedb, coalesce(i.buyer_vat_number, p.vat_number) pvat, r.number rnum
    from invoices i join partners p on p.id = i.partner_id left join invoices r on r.id = i.related_invoice_id
    where i.client_id = ${clientId} and i.doc_type <> 'PF' and i.status in ('issued','json_exported','sent_to_ujp','corrected','voided')
      and i.number is not null and i.issue_date between ${from} and ${to}
    order by i.issue_date, i.year, i.seq_no, i.id`));
  const ids = heads.flatMap((h) => [Number(h.id), ...(h.doc_type === "KR" && h.related_invoice_id ? [Number(h.related_invoice_id)] : [])]);
  const lines = ids.length ? rowsOf(await db.execute(sql`select invoice_id, vat_rate_pct pct, sum(net_amount) net, sum(vat_amount) vat
    from invoice_lines where invoice_id in (${sql.join(ids.map((x) => sql`${x}`), sql`, `)}) group by invoice_id, vat_rate_pct`)) : [];
  const of = (id: number) => lines.filter((l) => Number(l.invoice_id) === id).map((l) => ({ pct: String(l.pct), net: new D(String(l.net)), vat: new D(String(l.vat)) }));
  return build("kif", from, to, heads.map((h) => {
    let ls = of(Number(h.id));
    let note: string | null = null;   // samo vrska so drug dokument (zabeleskata na fakturata ne e za knigata)
    if (h.doc_type === "KR" && h.related_invoice_id) {
      // korekcija: samo razlikata vo odnos na originalot
      ls = [...ls, ...of(Number(h.related_invoice_id)).map((l) => ({ pct: l.pct, net: l.net.neg(), vat: l.vat.neg() }))];
      note = `Корекција на ${h.rnum ?? ""}: книжена разликата`;
    } else if (h.rnum) note = `Кон ${h.rnum}`;
    return { id: Number(h.id), date: String(h.issue_date), issueDate: String(h.issue_date), supplyDate: (h.supply_date as string | null) ?? null,
      number: String(h.number), docType: String(h.doc_type), partnerName: String(h.pname), partnerEdb: (h.pedb as string | null) ?? null,
      partnerVat: (h.pvat as string | null) ?? null, note, lines: ls };
  }));
}

export async function kuf(db: Db, clientId: number, from: string, to: string): Promise<Book> {
  const heads = rowsOf(await db.execute(sql`
    select x.id, x.number, x.supplier_number, x.issue_date, x.received_date, x.turnover_date, x.note, p.name pname, p.edb pedb, p.vat_number pvat
    from purchase_invoices x join partners p on p.id = x.partner_id
    where x.client_id = ${clientId} and x.status = 'posted' and x.received_date between ${from} and ${to}
    order by x.received_date, x.year, x.seq_no, x.id`));
  const ids = heads.map((h) => Number(h.id));
  const lines = ids.length ? rowsOf(await db.execute(sql`select purchase_invoice_id id, vat_rate_pct pct, sum(net_amount) net, sum(vat_amount) vat
    from purchase_lines where purchase_invoice_id in (${sql.join(ids.map((x) => sql`${x}`), sql`, `)}) group by purchase_invoice_id, vat_rate_pct`)) : [];
  return build("kuf", from, to, heads.map((h) => ({
    id: Number(h.id), date: String(h.received_date), issueDate: String(h.issue_date), supplyDate: (h.turnover_date as string | null) ?? null,
    number: String(h.number ?? ""), docType: "VF", supplierNumber: String(h.supplier_number), partnerName: String(h.pname),
    partnerEdb: (h.pedb as string | null) ?? null, partnerVat: (h.pvat as string | null) ?? null, note: null,
    lines: lines.filter((l) => Number(l.id) === Number(h.id)).map((l) => ({ pct: String(l.pct), net: new D(String(l.net)), vat: new D(String(l.vat)) })) })));
}

const DOC: Record<string, string> = { INV: "Фактура", AV: "Авансна", OD: "Книжно одобрение", KZ: "Книжно задолжување", ST: "Сторно", KR: "Корекција", VF: "Влезна" };
const n = (v: string) => v.replace(".", ",");
/** CSV за Excel (UTF-8 со BOM, „;“, децимали со запирка). */
export function bookCsv(b: Book): string {
  const head = ["Р.бр.", b.kind === "kif" ? "Датум на издавање" : "Датум на прием", ...(b.kind === "kuf" ? ["Датум на фактура"] : []), "Датум на промет",
    b.kind === "kif" ? "Број" : "Наш број", ...(b.kind === "kuf" ? ["Број кај добавувачот"] : []), "Вид", b.kind === "kif" ? "Купувач" : "Добавувач", "ЕДБ", "ДДВ број",
    ...RATES.flatMap((r) => [`Основица ${r}%`, `ДДВ ${r}%`]), "Без ДДВ (0 %, ослободено)", "Вкупно", "Забелешка"];
  const q = (s: string | null | undefined) => { const t = s ?? ""; return /[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const lines = b.rows.map((r) => [String(r.no), r.date, ...(b.kind === "kuf" ? [r.issueDate] : []), r.supplyDate ?? "", q(r.number),
    ...(b.kind === "kuf" ? [q(r.supplierNumber)] : []), DOC[r.docType] ?? r.docType, q(r.partnerName), r.partnerEdb ?? "", r.partnerVat ?? "",
    ...RATES.flatMap((k) => [n(r.base[k]), n(r.vat[k])]), n(r.exempt), n(r.total), q(r.note)].join(";"));
  const pad = b.kind === "kuf" ? 9 : 7;
  const tot = ["ВКУПНО", ...Array(pad).fill(""), ...RATES.flatMap((k) => [n(b.totals.base[k]), n(b.totals.vat[k])]), n(b.totals.exempt), n(b.totals.total), ""].join(";");
  return "﻿" + [head.join(";"), ...lines, tot].join("\r\n") + "\r\n";
}
