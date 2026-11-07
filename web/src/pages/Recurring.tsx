import { useEffect, useState, type FormEvent } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { api, ApiError, type ClientRef } from "../api";
import { date, money, today } from "../format";

interface Rec { id: number; name: string; partnerName: string; partnerActive: boolean; dayOfMonth: number; nextDate: string; endDate: string | null;
  isActive: boolean; generated: number; grossTotal: string; last: { id: number; number: string | null; status: string; issueDate: string } | null }

const dayLabel = (d: number) => (d === 0 ? "последен ден" : `${d}.`);
const DAYS = [...Array.from({ length: 28 }, (_, i) => i + 1), 0];

export function Recurring() {
  const client = useOutletContext<ClientRef>();
  const [rows, setRows] = useState<Rec[] | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [edit, setEdit] = useState<number | null>(null);
  const load = () => api.get<Rec[]>(`/api/clients/${client.id}/recurring`).then(setRows, (e) => setMsg({ kind: "err", text: (e as ApiError).message }));
  useEffect(() => { setRows(null); setMsg(null); void load(); }, [client.id]);
  const act = async (f: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try { await f(); setMsg({ kind: "ok", text: ok }); await load(); } catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); }
  };
  const run = () => act(async () => {
    const r = await api.post<{ created: unknown[] }>(`/api/clients/${client.id}/recurring/run`);
    if (!r.created.length) throw new ApiError(200, "none", "Нема доспеани: следните нацрти се прават на нивниот ден.");
  }, "Направени се доспеаните нацрти. Прегледајте ги и издадете ги во „Фактури“.");
  const total = (rows ?? []).filter((r) => r.isActive).reduce((a, r) => a + Number(r.grossTotal), 0);
  return (
    <>
      <header className="page-head"><h1>Повторувачки фактури</h1><button className="btn" onClick={run}>Направи доспеани сега</button></header>
      <p className="muted small">Секој месец на избраниот ден се прави <strong>нацрт</strong> на фактура; никогаш не се издава сама (издавањето оди на УЈП).
        Нова повторувачка: отворете фактура и „Повторувај месечно“. Во описот на ставка <code>{"{месец}"}</code> станува месецот на фактурата, <code>{"{претходен месец}"}</code> претходниот.</p>
      {msg && <p className={msg.kind === "ok" ? "notice" : "alert"}>{msg.text}</p>}
      {rows && rows.length === 0 && <div className="empty"><p>Нема повторувачки фактури. Отворете издадена фактура (на пр. месечна претплата) и кликнете „Повторувај месечно“.</p></div>}
      {rows && rows.length > 0 && <div className="table-wrap"><table className="grid">
        <thead><tr><th>Назив</th><th>Купувач</th><th>Ден</th><th>Следна</th><th>Крај</th><th className="num">Износ</th><th>Последна</th><th /></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id} className={r.isActive ? "" : "row-inactive"}>
          <td>{r.name}{!r.isActive && <span className="doctype">запрена</span>}</td>
          <td className="buyer">{r.partnerName}{!r.partnerActive && <span className="chip err">исклучен</span>}</td>
          <td>{dayLabel(r.dayOfMonth)}</td><td>{r.isActive ? date(r.nextDate) : "–"}</td><td>{r.endDate ? date(r.endDate) : "без крај"}</td>
          <td className="num">{money(r.grossTotal)}</td>
          <td>{r.last ? <Link to={`/c/${client.id}/invoices/${r.last.id}`}>{r.last.number ?? `нацрт ${date(r.last.issueDate)}`}</Link> : <span className="muted">–</span>}
            {r.generated > 1 && <span className="muted small"> ({r.generated})</span>}</td>
          <td className="row-actions">
            <button className="link" onClick={() => setEdit(edit === r.id ? null : r.id)}>Измени</button>
            {r.isActive ? <button className="link" onClick={() => act(() => api.patch(`/api/clients/${client.id}/recurring/${r.id}`, { isActive: false }), `„${r.name}“ е запрена.`)}>Запри</button>
              : <button className="link" onClick={() => act(() => api.patch(`/api/clients/${client.id}/recurring/${r.id}`, { isActive: true }), `„${r.name}“ продолжува од следниот ден во месецот (пропуштените месеци не се прават).`)}>Продолжи</button>}
            {r.last && <button className="link" title="Ако сте ја сменале цената или количината во последниот нацрт, тие стануваат шаблон за следните месеци"
              onClick={() => act(() => api.post(`/api/clients/${client.id}/recurring/${r.id}/template-from-last`), "Шаблонот е ажуриран од последната фактура.")}>Земи ставки од последната</button>}
            {r.generated === 0 && <button className="link danger" onClick={() => act(() => api.del(`/api/clients/${client.id}/recurring/${r.id}`), "Избришана.")}>Избриши</button>}
          </td></tr>)}
          {edit && (() => { const r = rows.find((x) => x.id === edit)!; return <tr key="edit"><td colSpan={8}><EditRec client={client} r={r} onDone={(ok) => { setEdit(null); if (ok) void act(async () => {}, "Зачувано."); }} /></td></tr>; })()}
        </tbody>
        <tfoot><tr><td colSpan={5}>Активни: {rows.filter((r) => r.isActive).length}</td><td className="num">{money(total)}</td><td colSpan={2} className="muted small">месечно со ДДВ</td></tr></tfoot>
      </table></div>}
    </>
  );
}

function EditRec({ client, r, onDone }: { client: ClientRef; r: Rec; onDone: (ok: boolean) => void }) {
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try { await api.patch(`/api/clients/${client.id}/recurring/${r.id}`, { name: f.name, dayOfMonth: Number(f.dayOfMonth), endDate: f.endDate || null }); onDone(true); }
    catch (x) { setErr((x as ApiError).message); }
  }
  return <form className="row-actions wrap" onSubmit={submit}>
    <label>Назив<input name="name" defaultValue={r.name} required minLength={2} /></label>
    <label>Ден во месецот<select name="dayOfMonth" defaultValue={r.dayOfMonth}>{DAYS.map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}</select></label>
    <label>Крај (опционално)<input type="date" name="endDate" defaultValue={r.endDate ?? ""} /></label>
    <button className="btn btn-primary">Зачувај</button><button type="button" className="link" onClick={() => onDone(false)}>Откажи</button>
    {err && <p className="alert">{err}</p>}
  </form>;
}

/** Од фактура: шаблон со истите ставки (се повикува од прегледот на фактурата). */
export function RecurringForm({ client, invoiceId, defaultName, onDone }: { client: ClientRef; invoiceId: number; defaultName: string; onDone: (ok: boolean) => void }) {
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      await api.post(`/api/clients/${client.id}/recurring`, { invoiceId, name: f.name, dayOfMonth: Number(f.dayOfMonth), startDate: f.startDate, endDate: f.endDate || null });
      onDone(true);
    } catch (x) { setErr((x as ApiError).message); }
  }
  return (
    <form className="panel stack" onSubmit={submit}>
      <h2>Повторувај месечно</h2>
      <p className="muted small">Ставките од оваа фактура стануваат шаблон. На избраниот ден секој месец се прави нацрт со истите ставки и рок; вие го прегледувате и издавате.
        Совет: во описот ставете <code>{"{месец}"}</code> (на пр. „Претплата за {"{месец}"}“) за месецот да се менува сам.</p>
      <div className="row-actions wrap">
        <label className="grow">Назив<input name="name" defaultValue={defaultName} required minLength={2} maxLength={120} /></label>
        <label>Ден во месецот<select name="dayOfMonth" defaultValue={1}>{DAYS.map((d) => <option key={d} value={d}>{dayLabel(d)}</option>)}</select></label>
        <label>Почеток<input type="date" name="startDate" defaultValue={today()} required /></label>
        <label>Крај (опционално)<input type="date" name="endDate" /></label>
      </div>
      {err && <p className="alert">{err}</p>}
      <div className="row-actions"><button className="btn btn-primary">Зачувај повторувачка</button><button type="button" className="link" onClick={() => onDone(false)}>Откажи</button>
        <Link className="link" to={`/c/${client.id}/recurring`}>Сите повторувачки</Link></div>
    </form>
  );
}
