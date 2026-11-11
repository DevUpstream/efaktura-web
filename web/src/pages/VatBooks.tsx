import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { api, type ClientRef } from "../api";
import { date, money } from "../format";

const RATES = ["18", "10", "5"] as const;
type R = (typeof RATES)[number];
interface Row { no: number; id: number; date: string; issueDate: string; supplyDate: string | null; number: string; docType: string; supplierNumber?: string;
  partnerName: string; partnerEdb: string | null; base: Record<R, string>; vat: Record<R, string>; exempt: string; total: string; note: string | null }
interface Book { rows: Row[]; totals: { count: number; base: Record<R, string>; vat: Record<R, string>; exempt: string; total: string } }
const DOC: Record<string, string> = { INV: "Фактура", AV: "Авансна", OD: "Одобрение", KZ: "Задолжување", ST: "Сторно", KR: "Корекција", VF: "Влезна" };

/** Првиот и последниот ден на месецот (ГГГГ-ММ). */
const range = (m: string) => { const [y, mo] = m.split("-").map(Number); const last = new Date(Date.UTC(y!, mo!, 0)).getUTCDate(); return [`${m}-01`, `${m}-${String(last).padStart(2, "0")}`] as const; };
const prevMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

/** КИФ / КУФ по период (docs/13). */
export function VatBooks() {
  const client = useOutletContext<ClientRef>();
  const hasKuf = client.modules.includes("incoming");
  const [kind, setKind] = useState<"kif" | "kuf">("kif");
  const [[from, to], setRange] = useState<readonly [string, string]>(range(prevMonth()));
  const [b, setB] = useState<Book | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setB(null); setErr(null); api.get<Book>(`/api/clients/${client.id}/vat-books/${kind}?from=${from}&to=${to}`).then(setB, (e) => setErr(e.message)); }, [client.id, kind, from, to]);
  const used = b ? RATES.filter((r) => b.rows.some((x) => Number(x.base[r]) || Number(x.vat[r]))) : [];
  const showExempt = !!b?.rows.some((x) => Number(x.exempt));
  return (
    <>
      <header className="page-head"><h1>КИФ / КУФ</h1>
        <div className="row-actions"><a className="btn btn-primary" href={`/api/clients/${client.id}/vat-books/${kind}?from=${from}&to=${to}&format=csv`}>Преземи за Excel (CSV)</a></div></header>
      <p className="muted small">Книга на излезни фактури (КИФ) и книга на влезни фактури (КУФ) за период, по ДДВ стапка. КИФ: по датум на издавање; сторно и одобрение со минус;
        кај корекција се книжи разликата. КУФ: прокнижени влезни по датум на прием. Распоредот на колоните нека го потврди сметководителот.</p>
      <div className="toolbar">
        <div className="seg" role="tablist"><button role="tab" aria-selected={kind === "kif"} onClick={() => setKind("kif")}>КИФ (излезни)</button>
          {hasKuf && <button role="tab" aria-selected={kind === "kuf"} onClick={() => setKind("kuf")}>КУФ (влезни)</button>}</div>
        <label>Месец <input type="month" value={from.slice(0, 7)} onChange={(e) => e.target.value && setRange(range(e.target.value))} /></label>
        <label>од <input type="date" value={from} onChange={(e) => e.target.value && setRange([e.target.value, to])} /></label>
        <label>до <input type="date" value={to} onChange={(e) => e.target.value && setRange([from, e.target.value])} /></label>
      </div>
      {err && <p className="alert">{err}</p>}
      {!b && !err && <p className="muted">Се вчитува…</p>}
      {b && b.rows.length === 0 && <div className="empty"><p>Нема документи од {date(from)} до {date(to)}.</p></div>}
      {b && b.rows.length > 0 && (
        <div className="table-wrap"><table className="grid">
          <thead><tr><th className="num">Р.бр.</th><th>Датум</th><th>Број</th><th>Вид</th><th>{kind === "kif" ? "Купувач" : "Добавувач"}</th>
            {used.map((r) => <th key={r} className="num" colSpan={2}>{r} %: основица · ДДВ</th>)}{showExempt && <th className="num">Без ДДВ</th>}<th className="num">Вкупно</th></tr></thead>
          <tbody>{b.rows.map((x) => <tr key={`${x.docType}${x.id}`} className={Number(x.total) < 0 ? "row-neg" : ""}>
            <td className="num">{x.no}</td><td>{date(x.date)}</td>
            <td><Link className="docno" to={`../${kind === "kif" ? "invoices" : "purchases"}/${x.id}`} relative="path">{x.number}</Link>{x.supplierNumber && <div className="muted small">{x.supplierNumber}</div>}</td>
            <td>{DOC[x.docType] ?? x.docType}</td><td>{x.partnerName}<div className="muted small">{x.partnerEdb ?? ""}{x.note ? ` · ${x.note}` : ""}</div></td>
            {used.map((r) => [<td key={`b${r}`} className="num">{money(x.base[r])}</td>, <td key={`v${r}`} className="num">{money(x.vat[r])}</td>])}
            {showExempt && <td className="num">{money(x.exempt)}</td>}<td className="num">{money(x.total)}</td></tr>)}</tbody>
          <tfoot><tr><td colSpan={5}><strong>Вкупно ({b.totals.count})</strong></td>
            {used.map((r) => [<td key={`b${r}`} className="num"><strong>{money(b.totals.base[r])}</strong></td>, <td key={`v${r}`} className="num"><strong>{money(b.totals.vat[r])}</strong></td>])}
            {showExempt && <td className="num"><strong>{money(b.totals.exempt)}</strong></td>}<td className="num"><strong>{money(b.totals.total)}</strong></td></tr></tfoot>
        </table></div>
      )}
    </>
  );
}
