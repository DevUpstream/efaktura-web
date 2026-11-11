import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { api, type ClientRef } from "../api";
import { date, dateTime, money0 } from "../format";

interface Top { id: number; number: string; partnerName: string; dueDate: string | null; remaining: string; daysOverdue: number }
interface Bucket { count: number; amount: string; top: Top[] }
interface Agent { configured: boolean; ok: boolean; name: string | null; lastSeenAt: string | null; pendingRequests: number }
interface TodayData {
  date: string; modules: string[];
  receivables?: { overdue: Bucket; dueSoon: Bucket; open: { count: number; amount: string } };
  payables?: { overdue: Bucket; dueSoon: Bucket };
  invoices: { drafts: number; waitingUjp: number; oldestWaiting: string | null; ujpErrors: number };
  dispatches?: { count: number; oldest: string | null };
  followupsDue?: number; statementLinesOpen?: number; agent: Agent;
}

/** Преглед „Денес“: што доспева, што е ненаплатено, што чека (docs/12). */
export function Today() {
  const client = useOutletContext<ClientRef>();
  const [d, setD] = useState<TodayData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setD(null); api.get<TodayData>(`/api/clients/${client.id}/today`).then(setD).catch((e) => setErr(e.message)); }, [client.id]);
  const c = `/c/${client.id}`;
  if (err) return <p className="alert">{err}</p>;
  if (!d) return <p className="muted">Се вчитува…</p>;
  const r = d.receivables, p = d.payables;
  return (
    <>
      <header className="page-head"><h1>Денес</h1><span className="muted">{date(d.date)}</span></header>
      <div className="kpis">
        {r && <Link className={`kpi ${r.overdue.count ? "bad" : "good"}`} to={`${c}/payments`}>
          <div className="k-label">Доспеано, ненаплатено</div><div className="k-value">{money0(r.overdue.amount)}</div>
          <div className="k-sub">{r.overdue.count} фактури</div></Link>}
        {r && <Link className={`kpi ${r.dueSoon.count ? "warn" : ""}`} to={`${c}/payments`}>
          <div className="k-label">Доспева во 7 дена</div><div className="k-value">{money0(r.dueSoon.amount)}</div>
          <div className="k-sub">{r.dueSoon.count} фактури</div></Link>}
        {p && <Link className={`kpi ${p.overdue.count ? "bad" : "good"}`} to={`${c}/payments/out`}>
          <div className="k-label">Наши доспеани обврски</div><div className="k-value">{money0(p.overdue.amount)}</div>
          <div className="k-sub">{p.overdue.count} фактури · во 7 дена: {money0(p.dueSoon.amount)}</div></Link>}
        <Link className={`kpi ${d.invoices.waitingUjp ? "warn" : "good"}`} to={`${c}/invoices`}>
          <div className="k-label">Чекаат УЈП</div><div className="k-value">{d.invoices.waitingUjp}</div>
          <div className="k-sub">{d.invoices.oldestWaiting ? `најстара од ${date(d.invoices.oldestWaiting)}` : "нема"}{d.invoices.ujpErrors ? ` · грешки: ${d.invoices.ujpErrors}` : ""}</div></Link>
        <Link className="kpi" to={`${c}/invoices`}><div className="k-label">Нацрти фактури</div><div className="k-value">{d.invoices.drafts}</div></Link>
        {d.dispatches && <Link className={`kpi ${d.dispatches.count ? "warn" : ""}`} to={`${c}/stock/dispatches`}>
          <div className="k-label">Нефактурирани испратници</div><div className="k-value">{d.dispatches.count}</div>
          <div className="k-sub">{d.dispatches.oldest ? `најстара од ${date(d.dispatches.oldest)}` : "нема"}</div></Link>}
        {d.statementLinesOpen !== undefined && <Link className={`kpi ${d.statementLinesOpen ? "warn" : ""}`} to={`${c}/payments/statements`}>
          <div className="k-label">Ставки од изводи за обработка</div><div className="k-value">{d.statementLinesOpen}</div></Link>}
        {d.followupsDue !== undefined && <Link className={`kpi ${d.followupsDue ? "warn" : ""}`} to={`${c}/followups`}>
          <div className="k-label">Потсетници за денес</div><div className="k-value">{d.followupsDue}</div></Link>}
        <div className={`kpi ${d.agent.ok ? "good" : "bad"}`}>
          <div className="k-label">Агент кон УЈП</div><div className="k-value">{d.agent.ok ? "работи" : d.agent.configured ? "НЕ РАБОТИ" : "нема"}</div>
          <div className="k-sub">{d.agent.lastSeenAt ? `последно: ${dateTime(d.agent.lastSeenAt)}` : "никогаш не се јавил"}{d.agent.pendingRequests ? ` · чекаат: ${d.agent.pendingRequests}` : ""}</div></div>
      </div>
      {r && r.overdue.top.length > 0 && <List title="Најголеми доспеани побарувања" rows={r.overdue.top} link={(t) => `${c}/invoices/${t.id}`} />}
      {r && r.dueSoon.top.length > 0 && <List title="Доспева наскоро" rows={r.dueSoon.top} link={(t) => `${c}/invoices/${t.id}`} />}
      {p && p.overdue.top.length > 0 && <List title="Наши доспеани обврски" rows={p.overdue.top} link={(t) => `${c}/purchases/${t.id}`} />}
    </>
  );
}

function List({ title, rows, link }: { title: string; rows: Top[]; link: (t: Top) => string }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      <div className="table-wrap"><table className="grid">
        <thead><tr><th>Документ</th><th>Партнер</th><th>Рок</th><th className="num">Денови</th><th className="num">Отворено</th></tr></thead>
        <tbody>{rows.map((t) => <tr key={t.id}><td><Link className="docno" to={link(t)}>{t.number}</Link></td><td>{t.partnerName}</td>
          <td>{date(t.dueDate)}</td><td className="num">{t.daysOverdue || "–"}</td><td className="num">{money0(t.remaining)}</td></tr>)}</tbody>
      </table></div>
    </section>
  );
}
