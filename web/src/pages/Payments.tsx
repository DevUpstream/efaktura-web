import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useOutletContext } from "react-router-dom";
import { api, ApiError, type ClientRef, type Partner } from "../api";
import { date, money, today } from "../format";

type Dir = "in" | "out";
interface OpenItem { id: number; number: string; docType: string; issueDate: string; dueDate: string | null; partnerId: number; partnerName: string;
  amount: string; credits: string; paid: string; remaining: string; daysOverdue: number }
interface Aging { current: string; d30: string; d60: string; d90: string; over90: string; total: string }
interface PartnerSum extends Aging { partnerId: number; partnerName: string; count: number; unallocated: string }
interface PaymentRow { id: number; direction: Dir; payDate: string; amount: string; method: string; reference: string | null; partnerId: number; partnerName: string;
  voidedAt: string | null; allocated: string; fromStatement: boolean }

const METHOD: Record<string, string> = { bank: "Банка", cash: "Готовина", card: "Картичка", compensation: "Компензација", other: "Друго" };
const AGING: [keyof Aging, string][] = [["current", "Не е доспеано"], ["d30", "1–30 дена"], ["d60", "31–60"], ["d90", "61–90"], ["over90", "Над 90"]];

function Tabs({ c }: { c: number }) {
  return <nav className="seg tabs" aria-label="Плаќања">
    <NavLink to={`/c/${c}/payments`} end>Наплата</NavLink><NavLink to={`/c/${c}/payments/out`}>Обврски</NavLink>
    <NavLink to={`/c/${c}/payments/list`}>Уплати</NavLink><NavLink to={`/c/${c}/payments/import`}>Увоз на извод</NavLink></nav>;
}

/* ------------------------------------------------- otvoreni stavki */
export function OpenItems({ direction }: { direction: Dir }) {
  const client = useOutletContext<ClientRef>();
  const [d, setD] = useState<{ items: OpenItem[]; aging: Aging; byPartner: PartnerSum[] } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [paying, setPaying] = useState<number | null | "new">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api.get<typeof d>(`/api/clients/${client.id}/open-items?direction=${direction}`).then(setD);
  useEffect(() => { setD(null); setOpen(null); setPaying(null); void load(); }, [client.id, direction]);
  const inDir = direction === "in";
  return (
    <>
      <header className="page-head"><h1>{inDir ? "Наплата од купувачи" : "Обврски кон добавувачи"}</h1>
        <div className="row-actions"><Tabs c={client.id} /><button className="btn btn-primary" onClick={() => setPaying("new")}>{inDir ? "Нова уплата" : "Ново плаќање"}</button></div></header>
      {msg && <p className="notice" role="status">{msg}</p>}
      {paying !== null && <PaymentForm client={client} direction={direction} partnerId={paying === "new" ? null : paying}
        onDone={async (t) => { setPaying(null); if (t) { setMsg(t); await load(); } }} />}
      {d && (
        <div className="aging" role="group" aria-label="По доспевање">
          {AGING.map(([k, l]) => <div key={k} className={`ag ${k !== "current" && Number(d.aging[k]) > 0 ? "late" : ""}`}><span>{l}</span><strong>{money(d.aging[k])}</strong></div>)}
          <div className="ag total"><span>Вкупно {inDir ? "побарувања" : "обврски"}</span><strong>{money(d.aging.total)}</strong></div>
        </div>
      )}
      {d && d.byPartner.length === 0 && <div className="empty"><p>{inDir ? "Нема ненаплатени фактури." : "Нема неплатени влезни фактури."}</p></div>}
      {d && d.byPartner.length > 0 && (
        <div className="table-wrap"><table className="grid">
          <thead><tr><th>{inDir ? "Купувач" : "Добавувач"}</th><th className="num">Документи</th><th className="num">Не е доспеано</th><th className="num">Задоцнето</th>
            <th className="num">Нераспоредено</th><th className="num">Вкупно</th><th /></tr></thead>
          <tbody>{d.byPartner.map((p) => {
            const late = Number(p.d30) + Number(p.d60) + Number(p.d90) + Number(p.over90);
            const items = d.items.filter((i) => i.partnerId === p.partnerId);
            return [
              <tr key={p.partnerId} onClick={() => setOpen(open === p.partnerId ? null : p.partnerId)} aria-expanded={open === p.partnerId}>
                <td className="buyer"><button className="link">{p.partnerName}</button></td><td className="num">{p.count}</td><td className="num">{money(p.current)}</td>
                <td className={`num ${late > 0 ? "late-amt" : ""}`}>{late > 0 ? money(late) : "–"}</td>
                <td className="num">{Number(p.unallocated) > 0 ? money(p.unallocated) : "–"}</td><td className="num"><strong>{money(p.total)}</strong></td>
                <td><button className="btn btn-small" onClick={(e) => { e.stopPropagation(); setPaying(p.partnerId); }}>{inDir ? "Уплата" : "Плати"}</button></td>
              </tr>,
              open === p.partnerId && <tr key={`${p.partnerId}-x`} className="sub"><td colSpan={7}>
                <table className="grid compact"><thead><tr><th>Документ</th><th>Датум</th><th>Рок</th><th className="num">Износ</th><th className="num">Одобрено</th><th className="num">Платено</th><th className="num">Останато</th></tr></thead>
                  <tbody>{items.map((i) => (
                    <tr key={i.id}><td>{inDir ? <Link to={`/c/${client.id}/invoices/${i.id}`}>{i.number}</Link> : <Link to={`/c/${client.id}/purchases/${i.id}`}>{i.number}</Link>}</td>
                      <td>{date(i.issueDate)}</td><td>{date(i.dueDate)}{i.daysOverdue > 0 && <span className="chip err">{i.daysOverdue} дена</span>}</td>
                      <td className="num">{money(i.amount)}</td><td className="num">{Number(i.credits) ? money(i.credits) : "–"}</td><td className="num">{Number(i.paid) ? money(i.paid) : "–"}</td>
                      <td className="num"><strong>{money(i.remaining)}</strong></td></tr>))}</tbody></table>
                {Number(p.unallocated) > 0 && <p className="small muted">Нераспоредено (преплата или аванс): {money(p.unallocated)} ден. Се распоредува во „Уплати“.</p>}
              </td></tr>,
            ];
          })}</tbody>
        </table></div>
      )}
    </>
  );
}

/* ------------------------------------------------------- nova uplata */
function PaymentForm({ client, direction, partnerId, onDone }: { client: ClientRef; direction: Dir; partnerId: number | null; onDone: (msg: string | null) => void }) {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [pid, setPid] = useState<number | "">(partnerId ?? "");
  const [items, setItems] = useState<OpenItem[]>([]);
  const [f, setF] = useState({ payDate: today(), amount: "", method: "bank", reference: "" });
  const [manual, setManual] = useState(false);
  const [alloc, setAlloc] = useState<Record<number, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<Partner[]>(`/api/clients/${client.id}/partners`).then(setPartners); }, [client.id]);
  useEffect(() => {
    setItems([]); setAlloc({});
    if (pid) api.get<{ items: OpenItem[] }>(`/api/clients/${client.id}/open-items?direction=${direction}&partnerId=${pid}`).then((x) => setItems(x.items));
  }, [pid]);
  const total = items.reduce((s, i) => s + Number(i.remaining), 0);
  const allocSum = Object.values(alloc).reduce((s, v) => s + (Number(v.replace(",", ".")) || 0), 0);
  // avtomatski predlog: od najstarata
  const auto = useMemo(() => { let left = Number(f.amount.replace(",", ".")) || 0; return items.map((i) => { const a = Math.min(left, Number(i.remaining)); left -= a; return a; }); }, [items, f.amount]);
  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ allocated: { number: string; amount: string }[]; unallocated: string }>(`/api/clients/${client.id}/payments`, {
        direction, partnerId: pid, payDate: f.payDate, amount: Number(f.amount.replace(",", ".")), method: f.method, reference: f.reference || null,
        allocations: manual ? Object.entries(alloc).filter(([, v]) => Number(v.replace(",", ".")) > 0).map(([id, v]) => ({ id: Number(id), amount: Number(v.replace(",", ".")) })) : null });
      onDone(`Внесено ${money(f.amount.replace(",", "."))} ден.${r.allocated.length ? ` Затворено: ${r.allocated.map((a) => `${a.number} (${money(a.amount)})`).join(", ")}.` : ""}${Number(r.unallocated) > 0 ? ` Нераспоредено ${money(r.unallocated)}.` : ""}`);
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  }
  return (
    <section className="panel stack">
      <h2>{direction === "in" ? "Уплата од купувач" : "Плаќање на добавувач"}</h2>
      <div className="form-grid pay-grid">
        <label className="span2">{direction === "in" ? "Купувач" : "Добавувач"}<select value={pid} onChange={(e) => setPid(e.target.value ? Number(e.target.value) : "")}>
          <option value="">— изберете —</option>{partners.filter((p) => p.isActive || p.id === pid).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Датум<input type="date" value={f.payDate} onChange={(e) => setF({ ...f, payDate: e.target.value })} /></label>
        <label>Износ (ден.)<input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder={total ? money(total) : ""} /></label>
        <label>Начин<select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="span2">Референца (извод, налог)<input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></label>
      </div>
      {pid !== "" && (items.length === 0 ? <p className="muted small">Нема отворени документи. Уплатата ќе остане нераспоредена (аванс или преплата).</p> : <>
        <div className="row-actions"><label className="check"><input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} /> Распореди рачно</label>
          <span className="muted small">{manual ? `Распоредено ${money(allocSum)} од ${money(f.amount.replace(",", ".") || 0)}` : "Автоматски: од најстариот документ."}</span>
          {!f.amount && <button className="link small" onClick={() => setF({ ...f, amount: total.toFixed(2) })}>Цел долг ({money(total)})</button>}</div>
        <table className="grid compact"><thead><tr><th>Документ</th><th>Рок</th><th className="num">Останато</th><th className="num">Се затвора</th></tr></thead>
          <tbody>{items.map((i, k) => (
            <tr key={i.id}><td>{i.number}</td><td>{date(i.dueDate)}{i.daysOverdue > 0 && <span className="chip err">{i.daysOverdue} д.</span>}</td><td className="num">{money(i.remaining)}</td>
              <td className="num">{manual ? <input className="amt-in" inputMode="decimal" value={alloc[i.id] ?? ""} onChange={(e) => setAlloc({ ...alloc, [i.id]: e.target.value })}
                onFocus={() => { if (!alloc[i.id]) setAlloc({ ...alloc, [i.id]: i.remaining }); }} aria-label={`Износ за ${i.number}`} /> : auto[k] ? money(auto[k]) : "–"}</td></tr>))}</tbody></table>
      </>)}
      {err && <p className="alert">{err}</p>}
      <div className="row-actions"><button className="btn btn-primary" disabled={busy || !pid || !(Number(f.amount.replace(",", ".")) > 0)} onClick={save}>Внеси</button>
        <button className="link" onClick={() => onDone(null)}>Откажи</button></div>
    </section>
  );
}

/* ------------------------------------------------------ lista uplati */
export function PaymentsList() {
  const client = useOutletContext<ClientRef>();
  const [rows, setRows] = useState<PaymentRow[] | null>(null);
  const [dir, setDir] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [voidId, setVoidId] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const load = () => api.get<PaymentRow[]>(`/api/clients/${client.id}/payments${dir ? `?direction=${dir}` : ""}`).then(setRows);
  useEffect(() => { setRows(null); void load(); }, [client.id, dir]);
  async function act(f: () => Promise<string>) { setMsg(null); try { setMsg({ kind: "ok", text: await f() }); await load(); } catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); } }
  return (
    <>
      <header className="page-head"><h1>Уплати и плаќања</h1><div className="row-actions"><Tabs c={client.id} /></div></header>
      <div className="toolbar"><select value={dir} onChange={(e) => setDir(e.target.value)} aria-label="Насока"><option value="">Сите</option><option value="in">Уплати од купувачи</option><option value="out">Плаќања на добавувачи</option></select></div>
      {msg && <p className={msg.kind === "ok" ? "notice" : "alert"} role="status">{msg.text}</p>}
      {rows && rows.length === 0 && <div className="empty"><p>Нема внесени уплати.</p></div>}
      {rows && rows.length > 0 && (
        <div className="table-wrap"><table className="grid">
          <thead><tr><th>Датум</th><th>Партнер</th><th>Референца</th><th>Начин</th><th className="num">Износ</th><th className="num">Нераспоредено</th><th /></tr></thead>
          <tbody>{rows.map((r) => {
            const free = Number(r.amount) - Number(r.allocated);
            return (
              <tr key={r.id} className={r.voidedAt ? "row-voided" : ""}>
                <td>{date(r.payDate)}</td><td className="buyer">{r.partnerName} <span className={`chip ${r.direction === "in" ? "ok" : "wait"}`}>{r.direction === "in" ? "уплата" : "плаќање"}</span></td>
                <td className="small">{r.reference}{r.fromStatement && <span className="doctype">извод</span>}</td><td>{METHOD[r.method]}</td>
                <td className="num">{money(r.amount)}</td><td className="num">{free > 0.004 && !r.voidedAt ? money(free) : "–"}</td>
                <td className="row-actions">{r.voidedAt ? <span className="chip err">сторно</span> : <>
                  {free > 0.004 && <button className="link small" onClick={() => act(async () => { const x = await api.post<{ allocated: unknown[] }>(`/api/clients/${client.id}/payments/${r.id}/allocate`, {}); return x.allocated.length ? "Распоредено на отворените документи." : "Нема отворени документи за распоредување."; })}>Распореди</button>}
                  {voidId === r.id ? <span className="void-inline"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Причина" aria-label="Причина за сторно" autoFocus />
                    <button className="btn btn-small" disabled={reason.trim().length < 3} onClick={() => act(async () => { await api.post(`/api/clients/${client.id}/payments/${r.id}/void`, { reason }); setVoidId(null); setReason(""); return "Уплатата е сторнирана."; })}>Сторнирај</button>
                    <button className="link small" onClick={() => setVoidId(null)}>Откажи</button></span>
                  : <button className="link small danger" onClick={() => { setVoidId(r.id); setReason(""); }}>Сторно</button>}</>}</td>
              </tr>);
          })}</tbody>
        </table></div>
      )}
    </>
  );
}

/* ---------------------------------------------------- uvoz na izvod */
interface Mapping { delimiter: string; skipRows: number; dateCol: number; dateFormat: string; amountMode: "signed" | "split"; amountCol?: number; creditCol?: number; debitCol?: number;
  decimal: "," | "."; nameCol?: number; accountCol?: number; referenceCols: number[] }
interface PreviewRow { line: number; key: string; date: string; amount: string; direction: Dir; name: string; account: string; reference: string; imported: boolean;
  partnerId: number | null; partnerName: string | null; matchedBy: string; allocations: { id: number; number: string; amount: string }[] | null;
  openForPartner: { id: number; number: string; remaining: string }[] }
const DEFAULT_MAP: Mapping = { delimiter: ";", skipRows: 1, dateCol: 0, dateFormat: "dd.MM.yyyy", amountMode: "split", creditCol: 1, debitCol: 2, decimal: ",", referenceCols: [] };

export function StatementImport() {
  const client = useOutletContext<ClientRef>();
  const [text, setText] = useState("");
  const [enc, setEnc] = useState("utf-8");
  const [map, setMap] = useState<Mapping | null>(null);
  const [editMap, setEditMap] = useState(false);
  const [rows, setRows] = useState<(PreviewRow & { use: boolean })[] | null>(null);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<Mapping | null>(`/api/clients/${client.id}/bank-mapping`).then((m) => { setMap(m ?? DEFAULT_MAP); setEditMap(!m); });
    api.get<Partner[]>(`/api/clients/${client.id}/partners`).then(setPartners);
  }, [client.id]);
  const sample = useMemo(() => {
    const delim = map?.delimiter === "\\t" ? "\t" : map?.delimiter ?? ";";
    return text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 6).map((l) => l.split(delim).map((c) => c.replace(/^"|"$/g, "").trim()));
  }, [text, map?.delimiter]);
  const cols = Math.max(0, ...sample.map((r) => r.length));
  function readFile(file: File) {
    const r = new FileReader();
    r.onload = () => { setText(String(r.result)); setRows(null); };
    r.readAsText(file, enc);
  }
  async function preview() {
    if (!map) return;
    setBusy(true); setMsg(null);
    try {
      if (editMap) { await api.put(`/api/clients/${client.id}/bank-mapping`, map); setEditMap(false); }
      const r = await api.post<{ rows: PreviewRow[]; skipped: { line: number; reason: string }[] }>(`/api/clients/${client.id}/payments/import/preview`, { text, mapping: map });
      setRows(r.rows.map((x) => ({ ...x, use: !x.imported && !!x.partnerId })));
      if (r.skipped.length) setMsg({ kind: "err", text: `Прескокнати редови: ${r.skipped.map((s) => `${s.line} (${s.reason})`).join(", ")}.` });
    } catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); } finally { setBusy(false); }
  }
  async function commit() {
    const chosen = (rows ?? []).filter((r) => r.use && r.partnerId);
    setBusy(true);
    try {
      const r = await api.post<{ imported: number; results: { key: string; ok: boolean; message?: string }[] }>(`/api/clients/${client.id}/payments/import/commit`, {
        rows: chosen.map((x) => ({ key: x.key, payDate: x.date, amount: Number(x.amount), direction: x.direction, partnerId: x.partnerId, reference: `${x.name} ${x.reference}`.trim().slice(0, 200),
          allocations: x.allocations ? x.allocations.map((a) => ({ id: a.id, amount: Number(a.amount) })) : null })) });
      const bad = r.results.filter((x) => !x.ok);
      setMsg({ kind: bad.length ? "err" : "ok", text: `Увезени ${r.imported} од ${chosen.length}.${bad.length ? ` Не се увезени: ${bad.map((b) => `ред ${rows!.find((x) => x.key === b.key)?.line}: ${b.message}`).join("; ")}` : ""}` });
      await preview();
    } catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); } finally { setBusy(false); }
  }
  const setRow = (i: number, p: Partial<PreviewRow & { use: boolean }>) => setRows((rs) => rs!.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const colSel = (label: string, v: number | undefined, on: (n: number | undefined) => void, optional = true) => (
    <label>{label}<select value={v ?? ""} onChange={(e) => on(e.target.value === "" ? undefined : Number(e.target.value))}>
      {optional && <option value="">—</option>}{Array.from({ length: Math.max(cols, 8) }, (_, i) => <option key={i} value={i}>Колона {i + 1}{sample[map!.skipRows] ? `: ${(sample[Math.min(map!.skipRows, sample.length - 1)]![i] ?? "").slice(0, 18)}` : ""}</option>)}</select></label>);
  return (
    <>
      <header className="page-head"><h1>Увоз на извод</h1><div className="row-actions"><Tabs c={client.id} /></div></header>
      <section className="panel stack">
        <p className="muted small">Извезете го изводот од е-банкарство како CSV. Секоја банка има свој распоред на колони: поставете го еднаш, се памти за оваа фирма. Ист ред не се увезува двапати.</p>
        <div className="row-actions">
          <label>Датотека<input type="file" accept=".csv,.txt,text/csv" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} /></label>
          <label>Кодирање<select value={enc} onChange={(e) => setEnc(e.target.value)}><option value="utf-8">UTF-8</option><option value="windows-1251">Windows-1251 (кирилица)</option></select></label>
          {map && !editMap && <button className="link" onClick={() => setEditMap(true)}>Промени ги колоните</button>}
        </div>
        <label>или залепете ја содржината<textarea rows={4} value={text} onChange={(e) => { setText(e.target.value); setRows(null); }} spellCheck={false} className="mono-in" /></label>
        {map && editMap && text && (
          <div className="stack">
            <div className="table-wrap"><table className="grid compact sample">
              <thead><tr><th>Ред</th>{Array.from({ length: cols }, (_, i) => <th key={i}>Колона {i + 1}</th>)}</tr></thead>
              <tbody>{sample.map((r, i) => <tr key={i} className={i < map.skipRows ? "row-inactive" : ""}><td>{i + 1}</td>{Array.from({ length: cols }, (_, j) => <td key={j}>{r[j]}</td>)}</tr>)}</tbody>
            </table></div>
            <div className="form-grid map-grid">
              <label>Разделувач<select value={map.delimiter} onChange={(e) => setMap({ ...map, delimiter: e.target.value })}><option value=";">;</option><option value=",">,</option><option value="\t">Tab</option><option value="|">|</option></select></label>
              <label>Прескокни редови (заглавје)<input type="number" min={0} max={50} value={map.skipRows} onChange={(e) => setMap({ ...map, skipRows: Number(e.target.value) })} /></label>
              {colSel("Датум", map.dateCol, (n) => setMap({ ...map, dateCol: n ?? 0 }), false)}
              <label>Формат на датум<select value={map.dateFormat} onChange={(e) => setMap({ ...map, dateFormat: e.target.value })}><option>dd.MM.yyyy</option><option>dd/MM/yyyy</option><option>yyyy-MM-dd</option></select></label>
              <label>Износ<select value={map.amountMode} onChange={(e) => setMap({ ...map, amountMode: e.target.value as Mapping["amountMode"] })}><option value="split">Посебни колони прилив / одлив</option><option value="signed">Една колона (минус = одлив)</option></select></label>
              {map.amountMode === "signed" ? colSel("Колона износ", map.amountCol, (n) => setMap({ ...map, amountCol: n }))
                : <>{colSel("Прилив (уплата)", map.creditCol, (n) => setMap({ ...map, creditCol: n }))}{colSel("Одлив (плаќање)", map.debitCol, (n) => setMap({ ...map, debitCol: n }))}</>}
              <label>Децимали<select value={map.decimal} onChange={(e) => setMap({ ...map, decimal: e.target.value as "," | "." })}><option value=",">1.234,56</option><option value=".">1,234.56</option></select></label>
              {colSel("Назив на налогодавач / примач", map.nameCol, (n) => setMap({ ...map, nameCol: n }))}
              {colSel("Жиро-сметка на партнерот", map.accountCol, (n) => setMap({ ...map, accountCol: n }))}
              {colSel("Цел / опис (за број на фактура)", map.referenceCols[0], (n) => setMap({ ...map, referenceCols: n === undefined ? [] : [n, ...map.referenceCols.slice(1)] }))}
              {colSel("Референца 2", map.referenceCols[1], (n) => setMap({ ...map, referenceCols: [map.referenceCols[0] ?? 0, ...(n === undefined ? [] : [n])] }))}
            </div>
          </div>
        )}
        <div className="row-actions"><button className="btn btn-primary" disabled={!text.trim() || busy} onClick={preview}>{editMap ? "Зачувај колони и прегледај" : "Прегледај"}</button></div>
      </section>
      {msg && <p className={msg.kind === "ok" ? "notice" : "alert"} role="status">{msg.text}</p>}
      {rows && (
        <>
          <div className="table-wrap"><table className="grid">
            <thead><tr><th /><th>Датум</th><th>Од / до</th><th>Цел</th><th className="num">Износ</th><th>Партнер</th><th>Затвора</th></tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={r.key} className={r.imported ? "row-inactive" : ""}>
                <td><input type="checkbox" checked={r.use} disabled={r.imported || !r.partnerId} onChange={(e) => setRow(i, { use: e.target.checked })} aria-label={`Увези ред ${r.line}`} /></td>
                <td>{date(r.date)}</td><td className="small">{r.name}<br /><span className="muted">{r.account}</span></td><td className="small">{r.reference}</td>
                <td className="num"><span className={`chip ${r.direction === "in" ? "ok" : "wait"}`}>{r.direction === "in" ? "+" : "−"}</span> {money(r.amount)}</td>
                <td>{r.imported ? <span className="chip">веќе увезено</span> : <>
                  <select value={r.partnerId ?? ""} onChange={(e) => setRow(i, { partnerId: e.target.value ? Number(e.target.value) : null, allocations: null, use: !!e.target.value, matchedBy: "рачно" })} aria-label="Партнер">
                    <option value="">— не е препознат —</option>{partners.filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                  {r.matchedBy && <div className="muted small">по {r.matchedBy}</div>}</>}</td>
                <td className="small">{r.allocations?.length ? r.allocations.map((a) => `${a.number} (${money(a.amount)})`).join(", ") : r.partnerId ? <span className="muted">автоматски од најстарата</span> : "–"}</td>
              </tr>))}</tbody>
          </table></div>
          <div className="actions"><button className="btn btn-primary" disabled={busy || !rows.some((r) => r.use)} onClick={commit}>Увези {rows.filter((r) => r.use).length} уплати</button>
            <span className="muted small">Непрепознатите редови (на пр. кирија, плати) се прескокнуваат. Партнерот може да се избере рачно.</span></div>
        </>
      )}
    </>
  );
}
