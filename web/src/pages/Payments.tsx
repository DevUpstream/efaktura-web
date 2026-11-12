import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useOutletContext, useParams } from "react-router-dom";
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

export function Tabs({ c }: { c: number }) {
  return <nav className="seg tabs" aria-label="Плаќања">
    <NavLink to={`/c/${c}/payments`} end>Наплата</NavLink><NavLink to={`/c/${c}/payments/out`}>Обврски</NavLink>
    <NavLink to={`/c/${c}/payments/list`}>Уплати</NavLink><NavLink to={`/c/${c}/payments/statements`}>Изводи</NavLink>
    <NavLink to={`/c/${c}/payments/expenses`}>Трошоци</NavLink><NavLink to={`/c/${c}/payments/ios`}>ИОС</NavLink>
    <NavLink to={`/c/${c}/payments/compensations`}>Компензации</NavLink><NavLink to={`/c/${c}/payments/dunning`}>Опомени</NavLink><NavLink to={`/c/${c}/payments/ledgers`}>Картици</NavLink></nav>;
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

/* ------------------------------------------------------------ izvodi */
interface Mapping { delimiter: string; skipRows: number; dateCol: number; dateFormat: string; amountMode: "signed" | "split"; amountCol?: number; creditCol?: number; debitCol?: number;
  decimal: "," | "."; nameCol?: number; accountCol?: number; referenceCols: number[] }
const DEFAULT_MAP: Mapping = { delimiter: ";", skipRows: 1, dateCol: 0, dateFormat: "dd.MM.yyyy", amountMode: "split", creditCol: 1, debitCol: 2, decimal: ",", referenceCols: [] };
interface StatementRow { id: number; format: string; ownAccount: string | null; statementNo: string | null; statementDate: string | null; openingBalance: string | null;
  closingBalance: string | null; fileName: string | null; createdAt: string; lines: number; open: number; inflow: string; outflow: string;
  prevClosing: string | null; prevNo: string | null }
/** Praznina pred izvodot: novata sostojba na prethodniot (po datum) ne e ednakva na prethodnata sostojba na ovoj. */
const gapBefore = (r: StatementRow) => r.prevClosing !== null && r.openingBalance !== null && Number(r.prevClosing).toFixed(2) !== Number(r.openingBalance).toFixed(2);
type Peek = { ok: true; date: string | null; statementNo: string | null } | { ok: false };
const noNum = (x: string | null) => { const d = (x ?? "").replace(/\D/g, ""); return d ? Number(d) : Number.MAX_SAFE_INTEGER; };

/** Cita datoteka so izbranoto kodiranje (izvodite od bankite se UTF-8 ili Windows-1251). */
const readText = (f: File, enc: string) => new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = bad; r.readAsText(f, enc); });

export function Statements() {
  const client = useOutletContext<ClientRef>();
  const [rows, setRows] = useState<StatementRow[] | null>(null);
  const [enc, setEnc] = useState("utf-8");
  const [autoBook, setAutoBook] = useState(true);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ file: string; ok: boolean; text: string; id?: number; warn?: string[] }[]>([]);
  const [csv, setCsv] = useState<{ text: string; name: string } | null>(null);
  const load = () => api.get<StatementRow[]>(`/api/clients/${client.id}/bank-statements`).then(setRows);
  useEffect(() => { setRows(null); setResults([]); void load(); }, [client.id]);
  async function upload(files: FileList | File[], textOverride?: { text: string; name: string }) {
    setBusy(true);
    const out: typeof results = [];
    let list = textOverride ? [textOverride] : await Promise.all([...files].map(async (f) => ({ text: await readText(f, enc), name: f.name })));
    if (list.length > 1) {
      // prvo se citaat site, pa se uvezuvaat po datum na izvodot (pa po broj); necitlivite odat na kraj, po redot na izbor
      const peeks = await Promise.all(list.map((f) => api.post<Peek>(`/api/clients/${client.id}/bank-statements/peek`, { text: f.text }).catch((): Peek => ({ ok: false }))));
      const key = (i: number) => { const p = peeks[i]!; return p.ok && p.date ? [p.date, noNum(p.statementNo)] as const : ["9999", 0] as const; };
      list = list.map((f, i) => ({ f, i })).sort((a, b) => { const [da, na] = key(a.i), [db, nb] = key(b.i); return da < db ? -1 : da > db ? 1 : na - nb || a.i - b.i; }).map((x) => x.f);
    }
    for (const f of list) {
      try {
        const r = await api.post<{ id: number; statementNo: string | null; lines: number; booked: number; categorized: number; warnings: string[] }>(`/api/clients/${client.id}/bank-statements`,
          { text: f.text, fileName: f.name, autoBook });
        out.push({ file: f.name, ok: true, id: r.id, warn: r.warnings, text: `Извод${r.statementNo ? ` бр. ${r.statementNo}` : ""}: ${r.lines} ставки, автоматски прокнижени ${r.booked} уплати/плаќања и ${r.categorized} трошоци/преноси.` });
      } catch (e) {
        const m = (e as ApiError).message;
        if (/CSV прво поставете/.test(m)) setCsv(f);
        out.push({ file: f.name, ok: false, text: m });
      }
    }
    setResults(out); setBusy(false); await load();
  }
  return (
    <>
      <header className="page-head"><h1>Изводи од банка</h1><div className="row-actions"><Tabs c={client.id} /></div></header>
      <section className="panel stack">
        <div className="row-actions upload-row">
          <label className="drop">Изберете изводи (TXT или MT940 од е-банкарство, може повеќе одеднаш; кај Стопанска – TXT)
            <input type="file" multiple accept=".txt,.sta,.mt940,.940,.csv,text/plain,text/csv" disabled={busy} onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ""; }} /></label>
          <label>Кодирање<select value={enc} onChange={(e) => setEnc(e.target.value)}><option value="utf-8">UTF-8</option><option value="windows-1251">Windows-1251</option></select></label>
          <label className="check"><input type="checkbox" checked={autoBook} onChange={(e) => setAutoBook(e.target.checked)} /> Автоматски прокнижи ги сигурните</label>
        </div>
        <p className="muted small">Проверени формати: Халкбанк, Шпаркасе и Стопанска (TXT), НЛБ (MT940). Други банки: MT940 или CSV. Секој извод се проверува: дали сметката е на оваа фирма, дали претходна состојба + промет = нова состојба
          и дали се надоврзува на соседните изводи по датум. Повеќе датотеки се увезуваат по датум на изводот, без разлика на редоследот на избор.
          Сигурно е кога купувачот е препознаен по ЕДБ, жиро-сметка или број на фактура, <em>и</em> фактурата по број, точен износ или точен збир.</p>
        {busy && <p className="muted">Се увезува…</p>}
        {results.map((r, i) => <div key={i} className={!r.ok ? "alert" : r.warn?.length ? "notice wait" : "notice"}><strong>{r.file}</strong>: {r.text} {r.id && <Link to={`/c/${client.id}/payments/statements/${r.id}`}>Отвори</Link>}
          {r.warn?.map((w, j) => <div key={j} className="small">⚠ {w}</div>)}</div>)}
      </section>
      {csv && <CsvMapping client={client} sample={csv.text} onSaved={() => { const f = csv; setCsv(null); void upload([], f); }} onCancel={() => setCsv(null)} />}
      {rows && rows.length === 0 && <div className="empty"><p>Сè уште нема увезени изводи.</p></div>}
      {rows && rows.length > 0 && (
        <div className="table-wrap"><table className="grid">
          <thead><tr><th>Извод</th><th>Датум</th><th>Сметка</th><th className="num">Прилив</th><th className="num">Одлив</th><th className="num">Нова состојба</th><th>Ставки</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td><Link className="docno" to={`/c/${client.id}/payments/statements/${r.id}`}>{r.statementNo ? `бр. ${r.statementNo}` : r.fileName ?? `#${r.id}`}</Link>
                {r.format !== "mk-txt" && r.format !== "stb-txt" && <span className="doctype">{r.format === "mt940" ? "MT940" : "CSV"}</span>}
                {gapBefore(r) && <div><span className="chip err" title={`Нова состојба на бр. ${r.prevNo ?? "?"}: ${money(r.prevClosing)}; претходна состојба тука: ${money(r.openingBalance)}`}>недостасува извод пред овој</span></div>}</td>
              <td>{date(r.statementDate)}</td><td className="small">{r.ownAccount ?? "–"}</td>
              <td className="num">{money(r.inflow)}</td><td className="num">{money(r.outflow)}</td><td className="num">{r.closingBalance ? money(r.closingBalance) : "–"}</td>
              <td>{r.open > 0 ? <span className="chip wait">{r.open} за обработка</span> : <span className="chip ok">готово</span>} <span className="muted small">од {r.lines}</span></td>
            </tr>))}</tbody>
        </table></div>
      )}
    </>
  );
}

/* --------------------------------------------------------- eden izvod */
type Cats = Record<string, { name: string; expense: boolean }>;
let catsCache: Promise<Cats> | null = null;
function useCats() {
  const [c, setC] = useState<Cats>({});
  useEffect(() => { (catsCache ??= api.get<Cats>("/api/bank-expense-categories")).then(setC, () => { catsCache = null; }); }, []);
  return c;
}
interface Suggestion { partnerId: number | null; partnerBy: string | null; allocations: { id: number; number: string; amount: string }[] | null; allocBy: string | null;
  confidence: "sure" | "likely" | "none"; hint: string | null; category: string | null; categorySure: boolean }
interface Line { id: number; lineNo: number; direction: Dir; amount: string; counterpartyName: string | null; counterpartyAccount: string | null; counterpartyEdb: string | null;
  paymentCode: string | null; purpose: string | null; refDebit: string | null; refCredit: string | null; ignored: boolean; ignoreReason: string | null;
  category: string | null; categorySource: string | null;
  status: "open" | "booked" | "ignored"; suggestion: Suggestion | null; openForPartner: { id: number; number: string; remaining: string; dueDate: string | null }[];
  booking: { paymentId: number; partnerName: string; allocated: string; documents: string | null } | null }
interface Detail { id: number; statementNo: string | null; statementDate: string | null; ownAccount: string | null; openingBalance: string | null; closingBalance: string | null;
  fileName: string | null; lines: Line[]; counts: { open: number; booked: number; ignored: number; sure: number } }
const BY: Record<string, string> = { edb: "ЕДБ", account: "жиро-сметка", invoice: "број на фактура", "edb-text": "ЕДБ во целта", name: "назив" };
const ALLOC: Record<string, string> = { number: "број на фактура", "short-number": "број/година", "supplier-number": "број кај добавувачот", exact: "точен износ",
  combination: "точен збир на фактури", fifo: "од најстарата" };

export function StatementView() {
  const client = useOutletContext<ClientRef>();
  const { id } = useParams();
  const [d, setD] = useState<Detail | null>(null);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const cats = useCats();
  const load = () => api.get<Detail>(`/api/clients/${client.id}/bank-statements/${id}`).then(setD);
  useEffect(() => { void load(); api.get<Partner[]>(`/api/clients/${client.id}/partners`).then(setPartners); }, [client.id, id]);
  async function act(f: () => Promise<string>) { setBusy(true); setMsg(null); try { setMsg({ kind: "ok", text: await f() }); } catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); } await load(); setBusy(false); }
  if (!d) return <p className="muted">Се вчитува…</p>;
  const lines = d.lines.filter((l) => filter === "all" || l.status === "open");
  return (
    <>
      <Link className="back" to={`/c/${client.id}/payments/statements`}>← Изводи</Link>
      <header className="page-head"><div><h1>Извод {d.statementNo ? `бр. ${d.statementNo}` : d.fileName}</h1>
        <p className="muted small">{[d.statementDate && date(d.statementDate), d.ownAccount, d.openingBalance && `${money(d.openingBalance)} → ${money(d.closingBalance)}`].filter(Boolean).join(" · ")}</p></div>
        <div className="row-actions">
          <div className="seg" role="tablist" aria-label="Приказ"><button role="tab" aria-selected={filter === "open"} onClick={() => setFilter("open")}>За обработка ({d.counts.open})</button>
            <button role="tab" aria-selected={filter === "all"} onClick={() => setFilter("all")}>Сите ({d.lines.length})</button></div>
          {d.counts.sure > 0 && <button className="btn btn-primary" disabled={busy} onClick={() => act(async () => {
            const r = await api.post<{ booked: number; errors: string[] }>(`/api/clients/${client.id}/bank-statements/${d.id}/book-sure`);
            return `Прокнижени ${r.booked}.${r.errors.length ? ` ${r.errors.join(" ")}` : ""}`; })}>Прокнижи ги сигурните ({d.counts.sure})</button>}
        </div></header>
      {msg && <p className={msg.kind === "ok" ? "notice" : "alert"} role="status">{msg.text}</p>}
      {lines.length === 0 && <div className="empty"><p>Сите ставки се обработени. Прокнижени {d.counts.booked}, без книжење {d.counts.ignored}.</p></div>}
      <div className="stmt-lines">{lines.map((l) => <LineCard key={l.id} l={l} client={client} partners={partners} busy={busy} act={act} cats={cats} />)}</div>
    </>
  );
}

function LineCard({ l, client, partners, busy, act, cats }: { l: Line; client: ClientRef; partners: Partner[]; busy: boolean; act: (f: () => Promise<string>) => Promise<void>; cats: Cats }) {
  const s = l.suggestion;
  const setCat = (category: string) => act(async () => { await api.post(`/api/clients/${client.id}/bank-lines/${l.id}/category`, { category }); return `Ставка ${l.lineNo}: ${cats[category]?.name}.`; });
  const [pid, setPid] = useState<number | "">(s?.partnerId ?? "");
  const [open, setOpen] = useState<Line["openForPartner"]>(l.openForPartner);
  const [manual, setManual] = useState(false);
  const [alloc, setAlloc] = useState<Record<number, string>>({});
  useEffect(() => { setPid(s?.partnerId ?? ""); setOpen(l.openForPartner); setManual(false); setAlloc({}); }, [l.id, l.status, s?.partnerId]);
  useEffect(() => {
    if (!pid || pid === s?.partnerId) { setOpen(l.openForPartner); return; }
    api.get<{ items: Line["openForPartner"] }>(`/api/clients/${client.id}/open-items?direction=${l.direction}&partnerId=${pid}`).then((x) => setOpen(x.items));
  }, [pid]);
  const changed = pid !== (s?.partnerId ?? "");
  const conf = changed ? "manual" : s?.confidence ?? "none";
  const book = () => act(async () => {
    const allocations = manual ? Object.entries(alloc).filter(([, v]) => Number(v.replace(",", ".")) > 0).map(([i, v]) => ({ id: Number(i), amount: Number(v.replace(",", ".")) }))
      : changed ? null : s?.allocations?.map((a) => ({ id: a.id, amount: Number(a.amount) })) ?? null;
    const r = await api.post<{ allocated: { number: string; amount: string }[]; unallocated: string; learned: boolean }>(`/api/clients/${client.id}/bank-lines/${l.id}/book`, { partnerId: pid, allocations });
    return `Ставка ${l.lineNo}: ${r.allocated.length ? r.allocated.map((a) => `${a.number} (${money(a.amount)})`).join(", ") : "нераспоредено"}${Number(r.unallocated) > 0 ? `, преплата ${money(r.unallocated)}` : ""}.${r.learned ? " Жиро-сметката е запаметена за следниот пат." : ""}`;
  });
  return (
    <article className={`stmt-line st-${l.status} conf-${l.status === "open" ? conf : ""}`}>
      <div className="sl-amount"><span className={l.direction === "in" ? "in" : "out"}>{l.direction === "in" ? "+" : "−"}{money(l.amount)}</span><span className="muted small">ставка {l.lineNo}</span></div>
      <div className="sl-who">
        <strong>{l.counterpartyName}</strong>
        <div className="muted small">{[l.counterpartyAccount, l.counterpartyEdb && `ЕДБ ${l.counterpartyEdb}`, l.paymentCode && `шифра ${l.paymentCode}`].filter(Boolean).join(" · ")}</div>
        <div className="small">{l.purpose}{(l.refCredit || l.refDebit) && <span className="muted"> · повик.: {[l.refDebit, l.refCredit].filter(Boolean).join(" / ")}</span>}</div>
      </div>
      <div className="sl-act">
        {l.status === "booked" && l.booking && <><span className="chip ok">прокнижено</span> {l.booking.partnerName}<div className="small">{l.booking.documents ?? "нераспоредено (преплата)"}</div></>}
        {l.status === "ignored" && <><span className={`chip ${cats[l.category ?? "skip"]?.expense ? "wait" : ""}`}>{cats[l.category ?? "skip"]?.name ?? "Не се книжи"}</span>
          {l.categorySource === "auto" && <span className="muted small"> автоматски</span>}
          {cats[l.category ?? "skip"] && !cats[l.category ?? "skip"]!.expense && <div className="muted small">Не е приход ни трошок.</div>}
          <div><button className="link small" disabled={busy} onClick={() => act(async () => { await api.post(`/api/clients/${client.id}/bank-lines/${l.id}/category`, { category: null }); return "Вратено за обработка."; })}>Врати</button></div></>}
        {l.status === "open" && <>
          <div className="sl-conf">{s?.category && !changed ? <span className="chip wait">предлог: {cats[s.category]?.name}</span> : conf === "sure" ? <span className="chip ok">сигурно</span> : conf === "likely" ? <span className="chip wait">предлог</span> : conf === "manual" ? <span className="chip">рачно</span> : <span className="chip err">непознат</span>}
            {s?.partnerBy && !changed && <span className="muted small"> партнер по {BY[s.partnerBy]}{s.allocBy ? `, фактура по ${ALLOC[s.allocBy]}` : ""}</span>}
            {s?.hint && <span className="muted small"> {s.hint}</span>}</div>
          <select value={pid} onChange={(e) => setPid(e.target.value ? Number(e.target.value) : "")} aria-label={`Партнер за ставка ${l.lineNo}`}>
            <option value="">— изберете партнер —</option>{partners.filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          {pid !== "" && (manual
            ? <table className="grid compact"><tbody>{open.map((o) => <tr key={o.id}><td>{o.number}</td><td className="num">{money(o.remaining)}</td>
                <td className="num"><input className="amt-in" inputMode="decimal" value={alloc[o.id] ?? ""} onChange={(e) => setAlloc({ ...alloc, [o.id]: e.target.value })} aria-label={`Износ за ${o.number}`} /></td></tr>)}</tbody></table>
            : <div className="small">{!changed && s?.allocations?.length ? `Затвора: ${s.allocations.map((a) => `${a.number} (${money(a.amount)})`).join(", ")}`
                : open.length ? `Од најстарата: ${open.slice(0, 3).map((o) => o.number).join(", ")}${open.length > 3 ? "…" : ""}` : "Нема отворени документи: останува како преплата."}</div>)}
          <div className="row-actions">
            <button className="btn btn-primary btn-small" disabled={busy || !pid} onClick={book}>Прокнижи</button>
            {pid !== "" && open.length > 0 && <button className="link small" onClick={() => setManual(!manual)}>{manual ? "Автоматски" : "Рачно по фактура"}</button>}
          </div>
          <div className="row-actions cat-row">
            {s?.category && <button className="btn btn-small" disabled={busy} onClick={() => setCat(s.category!)}>Книжи како: {cats[s.category]?.name}</button>}
            <select value="" disabled={busy} onChange={(e) => e.target.value && setCat(e.target.value)} aria-label={`Не е по фактура, ставка ${l.lineNo}`}>
              <option value="">Не е по фактура…</option>
              {Object.entries(cats).map(([k, c]) => <option key={k} value={k}>{c.name}{c.expense ? "" : " (не е трошок)"}</option>)}</select>
          </div>
        </>}
      </div>
    </article>
  );
}

/* -------------------------------------------- CSV: postavki na kolonite */
function CsvMapping({ client, sample: text, onSaved, onCancel }: { client: ClientRef; sample: string; onSaved: () => void; onCancel: () => void }) {
  const [map, setMap] = useState<Mapping>(DEFAULT_MAP);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.get<Mapping | null>(`/api/clients/${client.id}/bank-mapping`).then((m) => m && setMap(m)); }, [client.id]);
  const delim = map.delimiter === "\\t" ? "\t" : map.delimiter;
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 6).map((l) => l.split(delim).map((c) => c.replace(/^"|"$/g, "").trim()));
  const cols = Math.max(0, ...sample.map((r) => r.length));
  const colSel = (label: string, v: number | undefined, on: (n: number | undefined) => void, optional = true) => (
    <label>{label}<select value={v ?? ""} onChange={(e) => on(e.target.value === "" ? undefined : Number(e.target.value))}>
      {optional && <option value="">—</option>}{Array.from({ length: Math.max(cols, 8) }, (_, i) => <option key={i} value={i}>Колона {i + 1}{sample[map.skipRows] ? `: ${(sample[Math.min(map.skipRows, sample.length - 1)]![i] ?? "").slice(0, 18)}` : ""}</option>)}</select></label>);
  async function save() { try { await api.put(`/api/clients/${client.id}/bank-mapping`, map); onSaved(); } catch (e) { setErr((e as ApiError).message); } }
  return (
    <section className="panel stack">
      <h2>CSV: кои колони што содржат</h2>
      <p className="muted small">Датотеката не е TXT извод во проверениот формат. Поставете ги колоните еднаш; се паметат за оваа фирма.</p>
      <div className="table-wrap"><table className="grid compact sample">
        <thead><tr><th>Ред</th>{Array.from({ length: cols }, (_, i) => <th key={i}>Колона {i + 1}</th>)}</tr></thead>
        <tbody>{sample.map((r, i) => <tr key={i} className={i < map.skipRows ? "row-inactive" : ""}><td>{i + 1}</td>{Array.from({ length: cols }, (_, j) => <td key={j}>{r[j]}</td>)}</tr>)}</tbody>
      </table></div>
      <div className="form-grid map-grid">
        <label>Разделувач<select value={map.delimiter} onChange={(e) => setMap({ ...map, delimiter: e.target.value })}><option value=";">;</option><option value=",">,</option><option value="\t">Tab</option><option value="|">|</option></select></label>
        <label>Прескокни редови<input type="number" min={0} max={50} value={map.skipRows} onChange={(e) => setMap({ ...map, skipRows: Number(e.target.value) })} /></label>
        {colSel("Датум", map.dateCol, (n) => setMap({ ...map, dateCol: n ?? 0 }), false)}
        <label>Формат на датум<select value={map.dateFormat} onChange={(e) => setMap({ ...map, dateFormat: e.target.value })}><option>dd.MM.yyyy</option><option>dd/MM/yyyy</option><option>yyyy-MM-dd</option></select></label>
        <label>Износ<select value={map.amountMode} onChange={(e) => setMap({ ...map, amountMode: e.target.value as Mapping["amountMode"] })}><option value="split">Прилив / одлив посебно</option><option value="signed">Една колона (минус = одлив)</option></select></label>
        {map.amountMode === "signed" ? colSel("Колона износ", map.amountCol, (n) => setMap({ ...map, amountCol: n }))
          : <>{colSel("Прилив", map.creditCol, (n) => setMap({ ...map, creditCol: n }))}{colSel("Одлив", map.debitCol, (n) => setMap({ ...map, debitCol: n }))}</>}
        <label>Децимали<select value={map.decimal} onChange={(e) => setMap({ ...map, decimal: e.target.value as "," | "." })}><option value=",">1.234,56</option><option value=".">1,234.56</option></select></label>
        {colSel("Назив", map.nameCol, (n) => setMap({ ...map, nameCol: n }))}
        {colSel("Жиро-сметка", map.accountCol, (n) => setMap({ ...map, accountCol: n }))}
        {colSel("Цел / повикување", map.referenceCols[0], (n) => setMap({ ...map, referenceCols: n === undefined ? [] : [n] }))}
      </div>
      {err && <p className="alert">{err}</p>}
      <div className="row-actions"><button className="btn btn-primary" onClick={save}>Зачувај и увези</button><button className="link" onClick={onCancel}>Откажи</button></div>
    </section>
  );
}

/* ------------------------------------------------- trosoci od izvodi */
interface ExpLine { id: number; valueDate: string; category: string; categorySource: string | null; direction: Dir; amount: string; counterpartyName: string | null;
  purpose: string | null; statementId: number; statementNo: string | null; ownAccount: string | null }
export function BankExpenses() {
  const client = useOutletContext<ClientRef>();
  const y = today().slice(0, 4);
  const [from, setFrom] = useState(`${y}-01-01`);
  const [to, setTo] = useState(today());
  const [d, setD] = useState<{ categories: Cats; byMonth: { month: string; category: string; count: number; out: string; in: string }[]; lines: ExpLine[] } | null>(null);
  const [show, setShow] = useState<string | null>(null);
  useEffect(() => { setD(null); api.get<typeof d>(`/api/clients/${client.id}/bank-expenses?from=${from}&to=${to}`).then(setD); }, [client.id, from, to]);
  if (!d) return <p className="muted">Се вчитува…</p>;
  const months = [...new Set(d.byMonth.map((g) => g.month))].sort();
  const cats = Object.entries(d.categories);
  const cell = (m: string, c: string) => { const g = d.byMonth.find((x) => x.month === m && x.category === c); return g ? Number(g.out) - Number(g.in) : 0; };
  const total = (c: string) => months.reduce((s, m) => s + cell(m, c), 0);
  const MON = ["јан", "фев", "мар", "апр", "мај", "јун", "јул", "авг", "сеп", "окт", "ное", "дек"];
  const exp = cats.filter(([, c]) => c.expense), non = cats.filter(([, c]) => !c.expense);
  const table = (list: typeof cats, title: string) => (
    <div className="table-wrap"><table className="grid">
      <thead><tr><th>{title}</th>{months.map((m) => <th key={m} className="num">{MON[Number(m.slice(5)) - 1]} {m.slice(2, 4)}</th>)}<th className="num">Вкупно</th></tr></thead>
      <tbody>{list.map(([k, c]) => total(k) !== 0 && (
        <tr key={k} onClick={() => setShow(show === k ? null : k)} aria-expanded={show === k}><td><button className="link">{c.name}</button></td>
          {months.map((m) => <td key={m} className="num">{cell(m, k) ? money(cell(m, k)) : "–"}</td>)}<td className="num"><strong>{money(total(k))}</strong></td></tr>))}</tbody>
      {list === exp && <tfoot><tr><td>Вкупно трошоци</td>{months.map((m) => <td key={m} className="num">{money(exp.reduce((s, [k]) => s + cell(m, k), 0))}</td>)}
        <td className="num">{money(exp.reduce((s, [k]) => s + total(k), 0))}</td></tr></tfoot>}
    </table></div>);
  return (
    <>
      <header className="page-head"><h1>Трошоци од изводи</h1><div className="row-actions"><Tabs c={client.id} /></div></header>
      <div className="toolbar">
        <label>Од<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>До<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <a className="btn" href={`/api/clients/${client.id}/bank-expenses?from=${from}&to=${to}&format=csv`}>Преземи CSV (Excel)</a>
      </div>
      {d.lines.length === 0 ? <div className="empty"><p>Нема трошоци од изводи во овој период.</p>
        <p className="small">Провизиите, Трезорот и преносите меѓу сопствени сметки се книжат автоматски при увоз на извод. Другите ги означувате во изводот со „Не е по фактура…“.</p></div> : <>
        {table(exp, "Трошоци (одлив)")}
        {non.some(([k]) => total(k) !== 0) && <><h2 className="sec-gap">Не се ни приход ни трошок</h2>{table(non, "Вид")}</>}
        {show && <section className="panel stack"><h2>{d.categories[show]?.name}</h2>
          <table className="grid compact"><thead><tr><th>Датум</th><th>Извод</th><th>Налогодавач / примач</th><th>Цел</th><th className="num">Износ</th></tr></thead>
            <tbody>{d.lines.filter((l) => l.category === show).map((l) => (
              <tr key={l.id}><td>{date(l.valueDate)}</td><td><Link to={`/c/${client.id}/payments/statements/${l.statementId}`}>бр. {l.statementNo ?? l.statementId}</Link></td>
                <td>{l.counterpartyName}</td><td className="small">{l.purpose}{l.categorySource === "auto" && <span className="muted"> · автоматски</span>}</td>
                <td className="num">{l.direction === "in" ? "+" : "−"}{money(l.amount)}</td></tr>))}</tbody></table></section>}
      </>}
    </>
  );
}
