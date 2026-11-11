import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { api, ApiError, type ClientRef } from "../api";
import { date, qtyFmt } from "../format";
import { StockTabs } from "./Stock";

interface Dispatch {
  id: number; number: string; docDate: string; partnerId: number; partnerName: string; warehouseName: string; note: string | null;
  lines: { itemId: number; code: string; name: string; unit: string; qty: string }[];
  billedBy: { id: number; number: string | null; status: string } | null; reversed: boolean;
}

/** Испратници без фактура: преглед и фактура од избраните (docs/12). */
export function Dispatches() {
  const client = useOutletContext<ClientRef>();
  const nav = useNavigate();
  const [open, setOpen] = useState(true);
  const [rows, setRows] = useState<Dispatch[] | null>(null);
  const [sel, setSel] = useState<number[]>([]);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRows(null); setSel([]); api.get<Dispatch[]>(`/api/clients/${client.id}/dispatches?open=${open ? 1 : 0}`).then(setRows); }, [client.id, open]);
  const shown = useMemo(() => (rows ?? []).filter((r) => !q.trim() || r.partnerName.toLowerCase().includes(q.trim().toLowerCase()) || r.number.toLowerCase().includes(q.trim().toLowerCase())), [rows, q]);
  const selPartner = rows?.find((r) => r.id === sel[0])?.partnerId;
  const toggle = (r: Dispatch) => setSel((s) => (s.includes(r.id) ? s.filter((x) => x !== r.id) : [...s, r.id]));
  async function invoice() {
    setBusy(true); setErr(null);
    try { const r = await api.post<{ id: number }>(`/api/clients/${client.id}/dispatches/invoice`, { docIds: sel }); nav(`../../invoices/${r.id}`, { relative: "path" }); }
    catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  }
  return (
    <>
      <header className="page-head"><h1>Магацин</h1><div className="row-actions"><StockTabs clientId={client.id} />
        <Link className="btn btn-primary" to="../docs/new?kind=issue" relative="path">Нова испратница</Link></div></header>
      <p className="muted small">Испратница без фактура: стоката излегува од магацин веднаш. Изберете една или повеќе испратници на ист купувач и направете фактура.
        Фактурата не ја намалува залихата повторно. Ако фактурата се сторнира, испратницата повторно е „нефактурирана“.</p>
      <div className="toolbar">
        <div className="seg" role="tablist"><button role="tab" aria-selected={open} onClick={() => setOpen(true)}>Нефактурирани</button>
          <button role="tab" aria-selected={!open} onClick={() => setOpen(false)}>Сите</button></div>
        <input type="search" placeholder="Купувач или број" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Пребарај" />
        {sel.length > 0 && <button className="btn btn-primary" disabled={busy} onClick={invoice}>Направи фактура ({sel.length})</button>}
      </div>
      {err && <p className="alert" role="alert">{err}</p>}
      {rows && shown.length === 0 && <div className="empty"><p>{open ? "Нема нефактурирани испратници." : "Нема испратници."}</p></div>}
      {shown.length > 0 && (
        <div className="table-wrap"><table className="grid">
          <thead><tr><th /><th>Број</th><th>Датум</th><th>Купувач</th><th>Ставки</th><th>Статус</th></tr></thead>
          <tbody>{shown.map((r) => {
            const can = !r.billedBy && !r.reversed && (!selPartner || selPartner === r.partnerId);
            return (
              <tr key={r.id}>
                <td><input type="checkbox" checked={sel.includes(r.id)} disabled={!can && !sel.includes(r.id)} onChange={() => toggle(r)}
                  aria-label={`Избери ${r.number}`} title={!can && !r.billedBy && !r.reversed ? "Само испратници на ист купувач" : undefined} /></td>
                <td><Link className="docno" to={`../docs/${r.id}`} relative="path">{r.number}</Link></td>
                <td>{date(r.docDate)}</td><td>{r.partnerName}</td>
                <td className="small">{r.lines.map((l) => `${l.code} × ${qtyFmt(l.qty)} ${l.unit}`).join(", ")}</td>
                <td>{r.reversed ? <span className="chip err">сторнирана</span> : r.billedBy
                  ? <Link to={`../../invoices/${r.billedBy.id}`} relative="path"><span className="chip ok">{r.billedBy.number ?? "во нацрт"}</span></Link>
                  : <span className="chip wait">нефактурирана</span>}</td>
              </tr>);
          })}</tbody>
        </table></div>
      )}
    </>
  );
}
