import { usePaged } from "../components/Pager";
import { UNITS_DL, UnitsList } from "../components/UnitsList";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { api, ApiError, type ClientRef, type Item, type VatRate } from "../api";
import { ITEM_TYPE, money, STOCK_TYPES, unitsOf, date } from "../format";

export function Items() {
  const client = useOutletContext<ClientRef>();
  const [rows, setRows] = useState<Item[] | null>(null);
  const [rates, setRates] = useState<VatRate[]>([]);
  const [edit, setEdit] = useState<Item | "new" | null>(null);
  const [q, setQ] = useState("");
  const [onlyActive, setOnlyActive] = useState(true);
  const load = () => api.get<Item[]>(`/api/clients/${client.id}/items`).then(setRows);
  useEffect(() => { setRows(null); setEdit(null); void load(); api.get<VatRate[]>("/api/vat-rates").then(setRates); }, [client.id]);
  const rate = (id: number) => rates.find((r) => r.id === id);
  // prebaruvanje po shifra ili naziv, bez razlika na golemi/mali bukvi; povekje zborovi = site moraat da se najdat
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (rows ?? []).filter((it) => (!onlyActive || it.isActive || edit === it) &&
      words.every((w) => it.code.toLowerCase().includes(w) || it.name.toLowerCase().includes(w)));
  }, [rows, q, onlyActive, edit]);
  const paged = usePaged(shown, "items", [q, onlyActive]);

  return (
    <>
      <header className="page-head"><h1>Артикли и услуги</h1><button className="btn btn-primary" onClick={() => setEdit("new")}>Нов артикл</button></header>
      {edit && <ItemForm key={edit === "new" ? "new" : edit.id} client={client} it={edit === "new" ? null : edit} rates={rates} onDone={() => { setEdit(null); void load(); }} />}
      {rows && rows.length > 0 && (
        <div className="toolbar">
          <input type="search" placeholder="Шифра или назив (на пр. tn 2421)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Пребарај артикли" autoFocus />
          <label className="check"><input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} /> Само активни</label>
          <span className="muted small">{shown.length} од {rows.length}</span>
          <span className="hint">Кирилица и латиница се различни: „тонер“ не го наоѓа „Toner“. Пробајте и со другото писмо.</span>
        </div>
      )}
      {rows && rows.length === 0 && <div className="empty"><p>Сè уште нема артикли. Додадете го првиот.</p></div>}
      {rows && rows.length > 0 && shown.length === 0 && <div className="empty"><p>Нема артикл за „{q}“.</p></div>}
      {shown.length > 0 && (
        <div className="table-wrap"><table className="grid">
          <thead><tr><th>Шифра</th><th>Назив</th><th>Тип</th><th>Ед.</th><th className="num">Цена без ДДВ</th><th>ДДВ</th></tr></thead>
          <tbody>{paged.rows.map((it) => (
            <tr key={it.id} onClick={() => setEdit(it)} className={it.isActive ? "" : "row-inactive"}>
              <td><button className="link" onClick={() => setEdit(it)}>{it.code}</button></td>
              <td>{it.name}{!it.isActive && <span className="doctype">неактивен</span>}</td>
              <td>{ITEM_TYPE[it.type]}{it.trackLots && <span className="doctype">лот</span>}{it.trackSerials && <span className="doctype">сер. бр.</span>}</td><td>{it.unit}</td>
              <td className="num">{money(it.unitPrice)}</td><td>{rate(it.vatRateId) ? `${Number(rate(it.vatRateId)!.ratePct)}%` : "–"}</td>
            </tr>))}
          </tbody>
        </table></div>
      )}
      {paged.bar}
    </>
  );
}

function ItemForm({ client, it, rates, onDone }: { client: ClientRef; it: Item | null; rates: VatRate[]; onDone: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => { ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, []);
  const [type, setType] = useState<string>(it?.type ?? "service");
  const [track, setTrack] = useState<"none" | "lots" | "serials">(it?.trackSerials ? "serials" : it?.trackLots ? "lots" : "none");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const stock = STOCK_TYPES.includes(f.type!);
    const body = { ...f, trackLots: stock && track === "lots", trackSerials: stock && track === "serials",
      warrantyMonths: f.warrantyMonths ? Number(f.warrantyMonths) : null, unitPrice: Number(String(f.unitPrice).replace(",", ".")), vatRateId: Number(f.vatRateId), isActive: f.isActive === "on" };
    try {
      if (it) await api.patch(`/api/clients/${client.id}/items/${it.id}`, body);
      else await api.post(`/api/clients/${client.id}/items`, body);
      onDone();
    } catch (x) { setErr((x as ApiError).message); }
  }
  return (
    <form ref={ref} className="panel form-grid" onSubmit={submit}>
      <h2 className="span-all">{it ? `${it.code} · ${it.name}` : "Нов артикл"}</h2>
      {it && it.isActive && (
        <div className="span-all row-actions">
          <Link className="btn btn-primary" to={`../invoices/new?item=${it.id}`} relative="path">Нова фактура</Link>
          <Link className="btn" to={`../invoices/new?type=PF&item=${it.id}`} relative="path">Нова понуда</Link>
        </div>
      )}
      {err && <p className="alert span-all">{err}</p>}
      <label>Шифра<input name="code" defaultValue={it?.code} required maxLength={30} /></label>
      <div className="span2"><label>Назив<input name="name" defaultValue={it?.name} required minLength={2} /></label></div>
      <label>Вид<select name="type" value={type} onChange={(e) => setType(e.target.value)}>
        {Object.entries(ITEM_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>Единица мерка<input name="unit" list={UNITS_DL} defaultValue={it?.unit ?? unitsOf(client)[0]} required maxLength={10} /><UnitsList client={client} /></label>
      <label>Цена без ДДВ<input name="unitPrice" inputMode="decimal" defaultValue={it ? Number(it.unitPrice) : ""} required /></label>
      <label>ДДВ стапка<select name="vatRateId" defaultValue={it?.vatRateId ?? rates.find((r) => r.code === "S18")?.id}>
        {rates.filter((r) => r.isActive).map((r) => <option key={r.id} value={r.id}>{Number(r.ratePct)}% · {r.name}</option>)}
      </select></label>
      {STOCK_TYPES.includes(type) && <label>Следење по парче / серија
        <select value={track} onChange={(e) => setTrack(e.target.value as typeof track)}>
          <option value="none">Без следење</option>
          <option value="lots">Води лот / рок на траење</option>
          <option value="serials">Води сериски број (по парче)</option>
        </select>
        <small className="muted">{track === "lots" ? "При прием: број на лот и рок; излезот оди по најблискиот рок."
          : track === "serials" ? "При прием и продажба: еден сериски број по парче. Вклучување само кога нема залиха." : ""}</small></label>}
      <label>Гаранција (месеци)<input name="warrantyMonths" type="number" min={1} max={600} defaultValue={it?.warrantyMonths ?? ""} placeholder="без гаранција" />
        <small className="muted">На фактура и испратница: „Гаранција до …“ од датумот на продажба.</small></label>
      <label className="check"><input type="checkbox" name="isActive" defaultChecked={it?.isActive ?? true} /> Активен</label>
      {STOCK_TYPES.includes(type) && <p className="muted small span-all">Води залиха (кога е вклучен модулот Магацин): влегува со приемница или влезна фактура, излегува со фактура.</p>}
      <div className="span-all row-actions"><button className="btn btn-primary">Зачувај</button><button type="button" className="link" onClick={onDone}>Откажи</button></div>
      {it && <ItemPrices client={client} itemId={it.id} />}
    </form>
  );
}

/** Zabeleski 16, 18: site izlezni i vlezni ceni na artiklot i od/kon koj partner. */
export interface PriceRow { direction: "out" | "in"; docId: number; number: string; date: string; partnerId: number; partner: string; qty: string; price: string; discountPct: string; currency: string }
function ItemPrices({ client, itemId }: { client: ClientRef; itemId: number }) {
  const [rows, setRows] = useState<PriceRow[] | null>(null);
  const [dir, setDir] = useState<"all" | "out" | "in">("all");
  const [pid, setPid] = useState<number | "">("");
  useEffect(() => { api.get<PriceRow[]>(`/api/clients/${client.id}/items/${itemId}/prices`).then(setRows, () => setRows([])); }, [client.id, itemId]);
  if (!rows) return <p className="muted span-all">Се вчитуваат цените…</p>;
  const partnersIn = [...new Map(rows.map((r) => [r.partnerId, r.partner])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const shown = rows.filter((r) => (dir === "all" || r.direction === dir) && (!pid || r.partnerId === pid));
  const avg = (d: "out" | "in") => { const x = rows.filter((r) => r.direction === d && r.currency === "MKD"); return x.length ? x.reduce((a, r) => a + Number(r.price), 0) / x.length : null; };
  const docLink = (r: PriceRow) => r.direction === "out" ? `/c/${client.id}/invoices/${r.docId}` : `/c/${client.id}/purchases/${r.docId}`;
  return (
    <section className="span-all item-prices">
      <h3>Цени (излез и влез)</h3>
      {rows.length === 0 ? <p className="muted">Артиклот уште нема издадени фактури ни прокнижени влезни фактури.</p> : <>
        <div className="toolbar">
          <div className="seg" role="tablist" aria-label="Насока">{([["all", "Сите"], ["out", "Излезни (продажба)"], ["in", "Влезни (набавка)"]] as const).map(([k, l]) =>
            <button type="button" key={k} role="tab" aria-selected={dir === k} className={dir === k ? "active" : ""} onClick={() => setDir(k)}>{l}</button>)}</div>
          <select value={pid} onChange={(e) => setPid(e.target.value ? Number(e.target.value) : "")} aria-label="Партнер">
            <option value="">— сите партнери —</option>{partnersIn.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select>
          <span className="muted small">{avg("out") !== null && `просечна продажна ${money(avg("out"))} ден.`}{avg("out") !== null && avg("in") !== null && " · "}{avg("in") !== null && `просечна набавна ${money(avg("in"))} ден.`}</span>
        </div>
        <div className="table-wrap"><table className="grid compact">
          <thead><tr><th>Датум</th><th /><th>Документ</th><th>Партнер</th><th className="num">Кол.</th><th className="num">Цена</th><th className="num">Попуст</th></tr></thead>
          <tbody>{shown.slice(0, 200).map((r) => <tr key={`${r.direction}-${r.docId}-${r.price}-${r.qty}`}>
            <td>{date(r.date)}</td><td><span className={`chip ${r.direction === "out" ? "ok" : ""}`}>{r.direction === "out" ? "излез" : "влез"}</span></td>
            <td><Link to={docLink(r)}>{r.number || "–"}</Link></td><td>{r.partner}</td><td className="num">{Number(r.qty).toLocaleString("de-DE")}</td>
            <td className="num">{money(r.price)}{r.currency !== "MKD" ? ` ${r.currency}` : ""}</td><td className="num">{Number(r.discountPct) ? `${Number(r.discountPct)}%` : ""}</td></tr>)}</tbody>
        </table></div>
        {shown.length > 200 && <p className="muted small">Прикажани последните 200.</p>}
      </>}
    </section>
  );
}
