import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { api, type ClientRef, type InvoiceRow } from "../api";
import { DOC, date, money, money0, statusOf } from "../format";
import { UjpState } from "../components/UjpState";
import { useYears, YearSelect } from "../components/YearSelect";

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
  const { years, year, setYear } = useYears(`/api/clients/${client.id}/invoices/years`);
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setRows(null); setErr(null);
    if (year === null) return;
    api.get<InvoiceRow[]>(`/api/clients/${client.id}/invoices${year ? `?year=${year}` : ""}`).then(setRows).catch((e) => setErr(e.message));
  }, [client.id, year]);

  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const waiting = (rows ?? []).filter((r) => r.status === "issued" && !r.ujpId && r.docType !== "PF" && r.source !== "erpnext" && (r.currency ?? "MKD") === "MKD").length;   // devizni: cekaat pravilo na UJP (docs/16)
  async function sendAll() {
    setBusy(true); setInfo(null); setErr(null);
    try {
      const r = await api.post<{ queued: string[]; skipped: { number: string | null; problems: string[] }[] }>(`/api/clients/${client.id}/ujp-send-all`, {});
      setInfo(`Во редица за УЈП: ${r.queued.length}.` + (r.skipped.length ? ` Не се подготвени: ${r.skipped.map((x) => `${x.number} (${x.problems[0] ?? ""})`).join("; ")}.` : "")
        + " Ги праќа агентот на компјутерот со токенот.");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

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
        <div className="row-actions">{waiting > 0 && <button className="btn" onClick={sendAll} disabled={busy}
            title="Издадените фактури што уште не се на УЈП оди во редицата; ги праќа агентот на компјутерот со токенот">Прати на УЈП ({waiting})</button>}
          <Link className="btn" to="../invoices/new?type=PF" relative="path">Нова понуда</Link>
          <Link className="btn btn-primary" to="../invoices/new" relative="path">Нова фактура</Link></div>
      </header>
      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Статус">
          {FILTERS.map((f) => (
            <button key={f.key} role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</button>
          ))}
        </div>
        <input type="search" placeholder="Број или купувач" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Пребарај" />
        <YearSelect years={years} year={year} onChange={setYear} allowAll />
      </div>
      {err && <p className="alert">{err}</p>}
      {info && <p className="notice">{info}</p>}
      {!rows && !err && <p className="muted">Се вчитува…</p>}
      {rows && shown.length === 0 && (
        <div className="empty">
          <p>{rows.length === 0 ? year ? `Нема фактури за ${year}.` : "Нема фактури." : "Нема фактури за овој филтер."}</p>
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
                    {r.docType !== "INV" && <span className="doctype">{DOC[r.docType]}</span>}{r.source === "erpnext" && <span className="doctype" title="Пренесена од ERPNext: издадена надвор од е-Фактура, не се праќа кон УЈП">ERP</span>}
                  </td>
                  <td>{date(r.issueDate)}</td>
                  <td className="buyer">{r.buyerName}</td>
                  <td className="num">{r.currency && r.currency !== "MKD" ? money(r.payableAmount) : money0(r.payableAmount ?? Math.round(Number(r.grossTotal)))}
                    {r.currency && r.currency !== "MKD" && <small className="muted" title="Девизна фактура: износот лево е во денари по курсот на фактурата"><br />{money(r.fxPayableAmount ?? r.fxGrossTotal)} {r.currency}</small>}</td>
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
