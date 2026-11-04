import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";

export interface UjpCompany { name: string; address: string; city: string; postalCode: string; vatNumber: string; embs: string; countryCode: string }
export interface Diff { field: string; label: string; ours: string | null; ujp: string | null }
interface Req { id: number; status: "pending" | "done" | "error"; result: UjpCompany | null; error: string | null; diff: Diff[] | null; agentLastSeen: string | null }

const ago = (iso: string | null) => {
  if (!iso) return null;
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "пред помалку од минута" : m < 60 ? `пред ${m} мин.` : `пред ${Math.round(m / 60)} ч.`;
};

/**
 * Baranje do registarot na UJP. Go izvrsuva agentot na kompjuterot so pristap do UJP (serverot ne moze - IP filter),
 * pa ekranot ceka i proveruva na sekoi 2,5 sekundi.
 */
export function useUjpPull() {
  const [req, setReq] = useState<Req | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function start(body: { edb?: string; clientId?: number; partnerId?: number }) {
    window.clearTimeout(timer.current); setErr(null); setReq(null);
    try {
      const { id } = await api.post<{ id: number }>("/api/ujp/registry-requests", body);
      const started = Date.now();
      const poll = async () => {
        const r = await api.get<Req>(`/api/ujp/registry-requests/${id}`);
        setReq(r);
        if (r.status === "pending" && Date.now() - started < 180_000) timer.current = window.setTimeout(poll, 2500);
        else if (r.status === "pending") setErr("Агентот не одговори 3 минути. Проверете дали работи на компјутерот со токенот, па обидете се повторно.");
      };
      await poll();
    } catch (e) { setErr((e as ApiError).message); }
  }
  return { req, err, start, reset: () => { window.clearTimeout(timer.current); setReq(null); setErr(null); } };
}

export function UjpPullStatus({ req, err }: { req: Req | null; err: string | null }) {
  if (err) return <p className="alert">{err}</p>;
  if (!req) return null;
  if (req.status === "pending") return (
    <p className="notice wait" role="status">
      Чека агентот да го праша УЈП… {req.agentLastSeen ? `(агентот последно се јавил ${ago(req.agentLastSeen)})`
        : "(агентот уште не се јавил – пуштете Sync-ServerRegistry.ps1 -Watch на компјутерот со токенот)"}
    </p>);
  if (req.status === "error") return <p className="alert">УЈП: {req.error}</p>;
  return null;
}

export function CompanyCard({ c }: { c: UjpCompany }) {
  return (
    <dl className="facts ujp">
      <div><dt>Назив (УЈП)</dt><dd>{c.name}</dd></div>
      <div><dt>Адреса</dt><dd>{c.address}, {c.postalCode} {c.city}</dd></div>
      <div><dt>ДДВ број</dt><dd>{c.vatNumber || "не е ДДВ обврзник"}</dd></div>
      <div><dt>ЕМБС</dt><dd>{c.embs || "–"}</dd></div>
    </dl>
  );
}

export function DiffTable({ diff }: { diff: Diff[] }) {
  if (diff.length === 0) return <p className="notice">Податоците се совпаѓаат со регистарот на УЈП.</p>;
  return (
    <div className="table-wrap"><table className="grid diff">
      <thead><tr><th>Поле</th><th>Кај нас</th><th>Во регистарот на УЈП</th></tr></thead>
      <tbody>{diff.map((d) => <tr key={d.field}><td>{d.label}</td><td className="muted">{d.ours ?? "–"}</td><td><strong>{d.ujp ?? "–"}</strong></td></tr>)}</tbody>
    </table></div>
  );
}
