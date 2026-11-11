import { useEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { api, ApiError, type ClientRef, type Partner } from "../api";
import { date, money, today } from "../format";
import { Tabs } from "./Payments";

const pdfLink = (url: string, label = "PDF") => <a className="btn btn-small" href={url} target="_blank" rel="noreferrer">{label}</a>;

/* ------------------------------------------------------------------ ИОС */
interface IosRow { partnerId: number; partnerName: string; edb: string | null; receivable: string; payable: string; unallocated: string; balance: string }
export function Ios() {
  const client = useOutletContext<ClientRef>();
  const [asOf, setAsOf] = useState(today());
  const [rows, setRows] = useState<IosRow[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => { setRows(null); api.get<IosRow[]>(`/api/clients/${client.id}/ios?asOf=${asOf}`).then(setRows); }, [client.id, asOf]);
  const shown = (rows ?? []).filter((r) => !q.trim() || r.partnerName.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <header className="page-head"><h1>Плаќања и наплата</h1><div className="row-actions"><Tabs c={client.id} /></div></header>
      <p className="muted small">Извод на отворени ставки (ИОС) по партнер на избран ден. Вообичаено се праќа со состојба на 31.12. Партнерот го потврдува или оспорува салдото.</p>
      <div className="toolbar">
        <label>Состојба на ден <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value || today())} /></label>
        <button className="btn btn-small" onClick={() => setAsOf(`${new Date().getFullYear() - 1}-12-31`)}>31.12.{new Date().getFullYear() - 1}</button>
        <input type="search" placeholder="Партнер" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Пребарај" />
      </div>
      {!rows && <p className="muted">Се вчитува…</p>}
      {rows && shown.length === 0 && <div className="empty"><p>Нема отворени ставки на {date(asOf)}.</p></div>}
      {shown.length > 0 && <div className="table-wrap"><table className="grid">
        <thead><tr><th>Партнер</th><th className="num">Ни должи</th><th className="num">Должиме</th><th className="num">Нераспоредено</th><th className="num">Салдо</th><th /></tr></thead>
        <tbody>{shown.map((r) => <tr key={r.partnerId}>
          <td><Link to={`../../partners/${r.partnerId}`} relative="path">{r.partnerName}</Link></td>
          <td className="num">{money(r.receivable)}</td><td className="num">{money(r.payable)}</td><td className="num">{money(r.unallocated)}</td>
          <td className="num"><strong>{money(r.balance)}</strong> <span className="muted small">{Number(r.balance) > 0 ? "ни должи" : Number(r.balance) < 0 ? "должиме" : ""}</span></td>
          <td>{pdfLink(`/api/clients/${client.id}/ios/${r.partnerId}/pdf?asOf=${asOf}`, "ИОС (PDF)")}</td>
        </tr>)}</tbody>
      </table></div>}
    </>
  );
}

/* ---------------------------------------------------------- компензации */
interface Open { id: number; number: string; issueDate: string; dueDate: string | null; remaining: string }
interface Comp { id: number; number: string; docDate: string; partnerName: string; amount: string; voidedAt: string | null; voidReason: string | null }
export function Compensations() {
  const client = useOutletContext<ClientRef>();
  const [rows, setRows] = useState<Comp[] | null>(null);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [pid, setPid] = useState<number | "">("");
  const [cand, setCand] = useState<{ receivable: Open[]; payable: Open[]; max: string } | null>(null);
  const [inA, setInA] = useState<Record<number, string>>({});
  const [outA, setOutA] = useState<Record<number, string>>({});
  const [day, setDay] = useState(today());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => api.get<Comp[]>(`/api/clients/${client.id}/compensations`).then(setRows);
  useEffect(() => { void load(); api.get<Partner[]>(`/api/clients/${client.id}/partners`).then((p) => setPartners(p.filter((x) => x.isCustomer && x.isSupplier))); }, [client.id]);
  useEffect(() => {
    setCand(null); setInA({}); setOutA({});
    if (!pid) return;
    api.get<{ receivable: Open[]; payable: Open[]; max: string }>(`/api/clients/${client.id}/compensations/candidates/${pid}`).then((c) => {
      setCand(c);
      // predlog: najstarite dokumenti do najgolemiot mozen iznos, na dvete strani
      const fill = (xs: Open[]) => { let left = Number(c.max); const o: Record<number, string> = {};
        for (const x of xs) { if (left <= 0) break; const t = Math.min(left, Number(x.remaining)); o[x.id] = t.toFixed(2); left = Math.round((left - t) * 100) / 100; } return o; };
      setInA(fill(c.receivable)); setOutA(fill(c.payable));
    });
  }, [pid, client.id]);
  const sum = (o: Record<number, string>) => Object.values(o).reduce((a, v) => a + (Number(v.replace(",", ".")) || 0), 0);
  const si = sum(inA), so = sum(outA);
  async function save() {
    setMsg(null);
    try {
      const toArr = (o: Record<number, string>) => Object.entries(o).map(([id, a]) => ({ id: Number(id), amount: Number(a.replace(",", ".")) })).filter((x) => x.amount > 0);
      const c = await api.post<{ number: string }>(`/api/clients/${client.id}/compensations`, { partnerId: pid, date: day, invoices: toArr(inA), purchases: toArr(outA) });
      setMsg({ ok: true, text: `Направена е компензација ${c.number}.` }); setPid(""); void load();
    } catch (e) { setMsg({ ok: false, text: (e as ApiError).message }); }
  }
  async function voidIt(c: Comp) {
    const reason = window.prompt(`Причина за сторно на ${c.number}:`);
    if (!reason) return;
    try { await api.post(`/api/clients/${client.id}/compensations/${c.id}/void`, { reason }); void load(); } catch (e) { setMsg({ ok: false, text: (e as ApiError).message }); }
  }
  const table = (title: string, xs: Open[], a: Record<number, string>, setA: (f: (o: Record<number, string>) => Record<number, string>) => void) => (
    <div><h2>{title}</h2><div className="table-wrap"><table className="grid">
      <thead><tr><th>Документ</th><th>Датум</th><th className="num">Отворено</th><th className="num">За компензација</th></tr></thead>
      <tbody>{xs.map((x) => <tr key={x.id}><td>{x.number}</td><td>{date(x.issueDate)}</td><td className="num">{money(x.remaining)}</td>
        <td className="num"><input inputMode="decimal" value={a[x.id] ?? ""} onChange={(e) => setA((o) => ({ ...o, [x.id]: e.target.value }))} aria-label={`Износ за ${x.number}`} /></td></tr>)}</tbody>
    </table></div></div>);
  return (
    <>
      <header className="page-head"><h1>Плаќања и наплата</h1><div className="row-actions"><Tabs c={client.id} /></div></header>
      <section className="panel stack">
        <h2>Нова компензација</h2>
        <p className="muted small">Нашите фактури кон партнерот се пребиваат со неговите фактури кон нас, во ист износ. Се прават две плаќања со начин „Компензација“.
          Во листата се само партнери што се и купувачи и добавувачи.</p>
        <div className="toolbar">
          <label>Партнер<select value={pid} onChange={(e) => setPid(e.target.value ? Number(e.target.value) : "")}><option value="">— изберете —</option>
            {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label>Датум<input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></label>
        </div>
        {cand && (Number(cand.max) <= 0 ? <p className="notice wait">Нема отворени ставки на двете страни за компензација.</p> : <>
          <div className="card-cols">{table("Наши побарувања", cand.receivable, inA, setInA)}{table("Наши обврски", cand.payable, outA, setOutA)}</div>
          <p>Побарувања: <strong>{money(si)}</strong> · Обврски: <strong>{money(so)}</strong> · Најмногу: {money(cand.max)}
            {Math.abs(si - so) > 0.004 && <span className="chip err"> Износите мора да се еднакви</span>}</p>
          <div className="row-actions"><button className="btn btn-primary" disabled={!(si > 0) || Math.abs(si - so) > 0.004} onClick={save}>Направи компензација</button></div>
        </>)}
        {msg && <p className={msg.ok ? "notice" : "alert"}>{msg.text}</p>}
      </section>
      {rows && rows.length > 0 && <div className="table-wrap"><table className="grid">
        <thead><tr><th>Број</th><th>Датум</th><th>Партнер</th><th className="num">Износ</th><th /></tr></thead>
        <tbody>{rows.map((c) => <tr key={c.id} className={c.voidedAt ? "row-voided" : ""}><td className="docno">{c.number}</td><td>{date(c.docDate)}</td><td>{c.partnerName}</td>
          <td className="num">{money(c.amount)}</td>
          <td className="row-actions">{pdfLink(`/api/clients/${client.id}/compensations/${c.id}/pdf`, "Изјава (PDF)")}
            {c.voidedAt ? <span className="chip err" title={c.voidReason ?? undefined}>сторнирана</span> : <button className="link" onClick={() => voidIt(c)}>Сторнирај</button>}</td></tr>)}</tbody>
      </table></div>}
    </>
  );
}

/* -------------------------------------------------------------- опомени */
interface DunRow { partnerId: number; partnerName: string; count: number; amount: string; maxDays: number; lastLetter: { id: number; date: string; level: number } | null; nextLevel: number }
interface Letter { id: number; docDate: string; level: number; amount: string; partnerName: string }
const LEVEL = ["", "Опомена", "Втора опомена", "Последна опомена"];
export function Dunning() {
  const client = useOutletContext<ClientRef>();
  const [minDays, setMinDays] = useState(8);
  const [rows, setRows] = useState<DunRow[] | null>(null);
  const [letters, setLetters] = useState<Letter[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => {
    api.get<DunRow[]>(`/api/clients/${client.id}/dunning?minDays=${minDays}`).then(setRows);
    api.get<Letter[]>(`/api/clients/${client.id}/dunning/letters`).then(setLetters);
  };
  useEffect(() => { setRows(null); load(); }, [client.id, minDays]);
  const total = useMemo(() => (rows ?? []).reduce((a, r) => a + Number(r.amount), 0), [rows]);
  async function make(r: DunRow, level: number) {
    setMsg(null);
    try {
      const l = await api.post<{ id: number }>(`/api/clients/${client.id}/dunning`, { partnerId: r.partnerId, level, minDays });
      window.open(`/api/clients/${client.id}/dunning/letters/${l.id}/pdf`, "_blank"); load();
    } catch (e) { setMsg((e as ApiError).message); }
  }
  return (
    <>
      <header className="page-head"><h1>Плаќања и наплата</h1><div className="row-actions"><Tabs c={client.id} /></div></header>
      <p className="muted small">Купувачи со доспеани ненаплатени фактури. „Опомена“ ја зачувува и го отвора PDF-от за печатење или праќање.
        Следното ниво се предлага според последната опомена во последните 90 дена.</p>
      <div className="toolbar"><label>Доцнење најмалку <input type="number" min={1} value={minDays} onChange={(e) => setMinDays(Math.max(1, Number(e.target.value) || 1))} style={{ width: 70 }} /> дена</label>
        {rows && <span className="muted">{rows.length} купувачи · {money(total)} ден.</span>}</div>
      {msg && <p className="alert">{msg}</p>}
      {rows && rows.length === 0 && <div className="empty"><p>Нема доспеани ненаплатени фактури.</p></div>}
      {rows && rows.length > 0 && <div className="table-wrap"><table className="grid">
        <thead><tr><th>Купувач</th><th className="num">Фактури</th><th className="num">Најдолго (дена)</th><th className="num">Неплатено</th><th>Последна опомена</th><th /></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.partnerId}>
          <td><Link to={`../../partners/${r.partnerId}`} relative="path">{r.partnerName}</Link></td><td className="num">{r.count}</td><td className="num">{r.maxDays}</td>
          <td className="num">{money(r.amount)}</td>
          <td>{r.lastLetter ? <a href={`/api/clients/${client.id}/dunning/letters/${r.lastLetter.id}/pdf`} target="_blank" rel="noreferrer">{LEVEL[r.lastLetter.level]} · {date(r.lastLetter.date)}</a> : <span className="muted">–</span>}</td>
          <td><button className="btn btn-small" onClick={() => make(r, r.nextLevel)}>{LEVEL[r.nextLevel]}</button></td>
        </tr>)}</tbody>
      </table></div>}
      {letters.length > 0 && <section className="panel"><h2>Испратени опомени</h2><div className="table-wrap"><table className="grid">
        <thead><tr><th>Датум</th><th>Купувач</th><th>Ниво</th><th className="num">Износ</th><th /></tr></thead>
        <tbody>{letters.slice(0, 50).map((l) => <tr key={l.id}><td>{date(l.docDate)}</td><td>{l.partnerName}</td><td>{LEVEL[l.level]}</td><td className="num">{money(l.amount)}</td>
          <td>{pdfLink(`/api/clients/${client.id}/dunning/letters/${l.id}/pdf`)}</td></tr>)}</tbody>
      </table></div></section>}
    </>
  );
}
