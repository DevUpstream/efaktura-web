import { useEffect, useState } from "react";
import { api, ApiError, type Invoice } from "../api";

interface Job { id: number; status: "queued" | "sending" | "sent" | "error" | "cancelled"; queuedAt: string; takenAt: string | null; doneAt: string | null; note: string | null }
interface Log { id: number; at: string; success: boolean; httpStatus: number | null; euid: string | null; message: string | null }
interface AgentState { active: boolean; agents: { name: string; own: boolean; lastUsedAt: string | null; version: string | null; active: boolean }[] }
interface State { problems: string[]; warnings: string[]; waitFor: string | null; active: Job | null; stuck: boolean; jobs: Job[]; log: Log[]; agent: AgentState }
/** „12.11 18:49“ по Скопје (без зависност од јазикот на прелистувачот). */
const tm = (s: string | null) => { if (!s) return ""; const x = new Date(s).toLocaleString("sv-SE", { timeZone: "Europe/Skopje" }); return `${x.slice(8, 10)}.${x.slice(5, 7)} ${x.slice(11, 16)}`; };

/** Праќање на УЈП (docs/15): копче, редица, грешка, EUID. Потпишува агентот на компјутерот со токенот. */
export function UjpPanel({ inv, onChange }: { inv: Invoice; onChange: () => void }) {
  const [s, setS] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api.get<State>(`/api/invoices/${inv.id}/ujp`).then(setS).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); }, [inv.id, inv.ujpId, inv.ujpError]);
  // додека чека агентот: освежување на секои 5 с
  useEffect(() => {
    if (!s?.active) return;
    const t = setInterval(async () => {
      const n = await api.get<State>(`/api/invoices/${inv.id}/ujp`).catch(() => null);
      if (n) { setS(n); if (!n.active) onChange(); }
    }, 5000);
    return () => clearInterval(t);
  }, [s?.active?.id, inv.id]);
  async function act(path: "ujp-send" | "ujp-cancel") {
    setBusy(true); setErr(null);
    try { await api.post(`/api/invoices/${inv.id}/${path}`, {}); await load(); onChange(); } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  }
  if ((inv as { source?: string }).source === "erpnext") return null;
  const a = s?.active;
  return (
    <section className="after ujp-panel">
      <h2 className="small-h">е-Фактура УЈП</h2>
      {inv.ujpId ? <p className="notice">✓ Испратена на УЈП{inv.ujpSentAt ? ` (${tm(inv.ujpSentAt)})` : ""}. EUID <span className="docno">{inv.ujpId}</span>
        {inv.ujpQrLink && <> · <a href={inv.ujpQrLink} target="_blank" rel="noopener">отвори кај УЈП</a></>}. QR кодот е на PDF.</p>
        : !s ? <p className="muted">Се вчитува…</p>
        : a ? <div className="notice wait">
            {a.status === "queued" ? <>Чека агентот (во редица од {tm(a.queuedAt)}). Агентот на компјутерот со токенот ја потпишува и праќа.</>
              : <>Агентот ја праќа (од {tm(a.takenAt)})…</>}
            {a.note && <div className="small">{a.note}</div>}
            {!s.agent.active && <AgentOff agent={s.agent} />}
            {(a.status === "queued" || s.stuck) && <div className="row-actions">
              {s.stuck && <span className="small">Нема одговор од агентот подолго од 15 мин. Проверете на efakturatest.ujp.gov.mk дали е примена, па откажете.</span>}
              <button className="btn btn-small" onClick={() => act("ujp-cancel")} disabled={busy}>Откажи праќање</button></div>}
          </div>
        : <>
            {inv.ujpError && <p className="alert">Последен обид: {inv.ujpError}</p>}
            {s.problems.length > 0 ? <div className="alert"><strong>Не е подготвена за УЈП:</strong><ul>{s.problems.map((p, i) => <li key={i}>{p}</li>)}</ul></div>
              : <div className="row-actions">
                  <button className="btn btn-primary" onClick={() => act("ujp-send")} disabled={busy}>{inv.ujpError ? "Прати повторно на УЈП" : "Прати на УЈП"}</button>
                  {s.waitFor && <span className="muted small">{s.waitFor}</span>}
                </div>}
            {s.problems.length === 0 && s.warnings.length > 0 && <p className="muted small">Агентот ќе ги земе од регистарот на УЈП: {s.warnings.join(" ")}</p>}
          </>}
      {err && <p className="alert">{err}</p>}
      {!inv.ujpId && !a && s && !s.agent.active && s.problems.length === 0 && <AgentOff agent={s.agent} />}
      <p className="muted small"><a href={`/api/invoices/${inv.id}/ujp.json`}>JSON (преглед)</a>
        {s && s.log.length > 0 && <> · <details className="inline"><summary>Записи ({s.log.length})</summary>
          <ul className="small">{s.log.map((l) => <li key={l.id}>{tm(l.at)} {l.success ? `✓ ${l.euid}` : `✗ HTTP ${l.httpStatus ?? "?"} ${l.message?.slice(0, 300) ?? ""}`}</li>)}</ul></details></>}</p>
    </section>
  );
}

/** Агентот за фирмата не се јавил 3 мин.: линк „efaktura-agent:“ (прелистувачот прашува за дозвола; Install-Agent.ps1 го регистрира). */
function AgentOff({ agent }: { agent: AgentState }) {
  if (!agent.agents.length) return <p className="small muted">Нема агент за оваа фирма. Администраторот: Администрација → Агенти → нов клуч → „Преземи агент“.</p>;
  const last = agent.agents.map((x) => x.lastUsedAt).filter(Boolean).sort().pop();
  return <div className="small">Агентот не работи{last ? ` (последно: ${tm(last)})` : ""}. Вклучете го компјутерот со токенот, или:{" "}
    <a className="btn btn-small" href="efaktura-agent:start">Вклучи агент</a>
    <span className="muted"> (само на компјутерот каде е инсталиран агентот)</span></div>;
}
