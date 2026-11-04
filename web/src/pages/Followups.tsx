import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { api, type ClientRef, type FollowUp } from "../api";
import { date, NOTE_KIND } from "../format";

/** Otvoreni potsetnici: zadocneti, denes i narednite denovi. */
export function Followups() {
  const client = useOutletContext<ClientRef>();
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<FollowUp[] | null>(null);
  const load = () => api.get<FollowUp[]>(`/api/clients/${client.id}/followups?days=${days}`).then(setRows);
  const crm = client.modules.includes("crm");
  useEffect(() => { setRows(null); if (crm) void load(); }, [client.id, days, crm]);
  async function done(f: FollowUp) {
    await api.post(`/api/clients/${client.id}/partners/${f.partnerId}/notes/${f.id}/done`);
    void load();
    window.dispatchEvent(new Event("followups-changed"));
  }
  if (!crm) return <p className="alert">Модулот „Купувачи: контакти, историја, потсетници“ не е вклучен за оваа фирма.</p>;
  return (
    <>
      <header className="page-head"><h1>Потсетници</h1>
        <div className="seg" role="tablist" aria-label="Период">{[[0, "Денес"], [7, "7 дена"], [30, "30 дена"]].map(([d, l]) => (
          <button key={d} role="tab" aria-selected={days === d} onClick={() => setDays(d as number)}>{l}</button>))}</div></header>
      {rows && rows.length === 0 && <div className="empty"><p>Нема отворени потсетници во овој период.</p>
        <p className="small">Потсетник се поставува во историјата на купувачот, со „Потсети ме на“.</p></div>}
      {rows && rows.length > 0 && (
        <div className="followups-strip">{rows.map((f) => (
          <div key={f.id} className={`fu ${f.overdue ? "late" : f.isToday ? "now" : ""}`}>
            <span className="fu-date">{f.overdue ? "Задоцнето · " : f.isToday ? "Денес · " : ""}{date(f.followUpAt)}</span>
            <span className="fu-text"><Link className="docno" to={`/c/${client.id}/partners/${f.partnerId}`}>{f.partnerName}</Link>
              <span className="muted"> · {NOTE_KIND[f.kind]}{f.author ? `, ${f.author}` : ""}</span><br />{f.text}</span>
            <button className="btn" onClick={() => done(f)}>Завршено</button>
          </div>))}</div>
      )}
    </>
  );
}
