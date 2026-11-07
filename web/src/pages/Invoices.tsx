import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { api, type ClientRef, type InvoiceRow } from "../api";
import { DOC, date, money0, statusOf } from "../format";
import { UjpState } from "../components/UjpState";

/** Понудите (PF) не се фактури: само во „Понуди“ и „Сите“, и не влегуваат во збирот. */
const FILTERS: { key: string; label: string; match: (r: InvoiceRow) => boolean }[] = [
  { key: "all", label: "Сите", match: (r) => r.status !== "cancelled_draft" },
  { key: "draft", label: "Нацрти", match: (r) => r.status === "draft" && r.docType !== "PF" },
  { key: "issued", label: "Издадени", match: (r) => r.docType !== "PF" && ["issued", "json_exported", "sent_to_ujp", "corrected"].includes(r.status) },
  { key: "voided", label: "Сторнирани", match: (r) => r.docType !== "PF" && (r.status === "voided" || r.status === "rejected") },
  { key: "quotes", label: "Понуди", match: (r) => r.docType === "PF" && r.status !== "cancelled_draft" },
];

export function Invoices() {
  const client = useOutletContext<ClientRef>();
  const nav = useNavigate();
  const [year, setYear] = useState(new Date().getFullYear());
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setRows(null); setErr(null);
    api.get<InvoiceRow[]>(`/api/clients/${client.id}/invoices?year=${year}`).then(setRows).catch((e) => setErr(e.message));
  }, [client.id, year]);

  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter)!;
    const needle = q.trim().toLowerCase();
    return (rows ?? []).filter((r) => f.match(r) &&
      (!needle || (r.number ?? "").toLowerCase().includes(needle) || r.buyerName.toLowerCase().includes(needle)));
  }, [rows, filter, q]);
  const total = shown.filter((r) => r.status !== "draft" && r.docType !== "PF").reduce((s, r) => s + Number(r.payableAmount ?? Math.round(Number(r.grossTotal))), 0);

  return (
    <>
      <header className="page-head">
        <h1>Фактури</h1>
        <div className="row-actions"><Link className="btn" to="../invoices/new?type=PF" relative="path">Нова понуда</Link>
          <Link className="btn btn-primary" to="../invoices/new" relative="path">Нова фактура</Link></div>
      </header>
      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Статус">
          {FILTERS.map((f) => (
            <button key={f.key} role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</button>
          ))}
        </div>
        <input type="search" placeholder="Број или купувач" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Пребарај" />
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Година">
          {[0, 1, 2].map((d) => new Date().getFullYear() - d).map((y) => <option key={y}>{y}</option>)}
        </select>
      </div>
      {err && <p className="alert">{err}</p>}
      {!rows && !err && <p className="muted">Се вчитува…</p>}
      {rows && shown.length === 0 && (
        <div className="empty">
          <p>{rows.length === 0 ? `Нема фактури за ${year}.` : "Нема фактури за овој филтер."}</p>
          {rows.length === 0 && <Link className="btn" to="../invoices/new" relative="path">Направи прва фактура</Link>}
        </div>
      )}
      {shown.length > 0 && (
        <div className="table-wrap">
          <table className="grid">
            <thead><tr>
              <th>Број</th><th>Датум</th><th>Купувач</th><th className="num">За плаќање</th><th>Статус</th><th>УЈП</th>
            </tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} onClick={() => nav(`../invoices/${r.id}`, { relative: "path" })} className={`row-${r.status}`}>
                  <td>
                    <Link to={`../invoices/${r.id}`} relative="path" onClick={(e) => e.stopPropagation()} className="docno">
                      {r.number ?? "нацрт"}
                    </Link>
                    {r.docType !== "INV" && <span className="doctype">{DOC[r.docType]}</span>}
                  </td>
                  <td>{date(r.issueDate)}</td>
                  <td className="buyer">{r.buyerName}</td>
                  <td className="num">{money0(r.payableAmount ?? Math.round(Number(r.grossTotal)))}</td>
                  <td><span className={`chip st-${r.status}`}>{statusOf(r.docType, r.status)}</span></td>
                  <td>{r.docType === "PF" ? <span className="muted small">не се праќа</span> : <UjpState r={r} />}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={3}>{shown.length} документи (нацртите и понудите не влегуваат во збирот)</td><td className="num">{money0(total)}</td><td colSpan={2} /></tr></tfoot>
          </table>
        </div>
      )}
    </>
  );
}
