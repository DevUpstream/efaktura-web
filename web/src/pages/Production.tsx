import { useEffect, useState } from "react";
import { Link, NavLink, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { api, ApiError, type ClientRef, type Item, type Warehouse } from "../api";
import { date, ITEM_TYPE, money, qtyFmt, STOCK_KIND, STOCK_TYPES, today } from "../format";

export interface ProductionSettings { useWaste: boolean; labor: "none" | "hour" | "piece"; laborRate: number; overhead: "none" | "percent" | "piece"; overheadValue: number }
const STATUS: Record<string, string> = { draft: "Нацрт", posted: "Прокнижен", voided: "Сторниран" };
const chip = (s: string) => (s === "posted" ? "ok" : s === "voided" ? "err" : "st-draft");

function Tabs({ clientId }: { clientId: number }) {
  return <nav className="seg tabs" aria-label="Производство"><NavLink to={`/c/${clientId}/production`} end>Работни налози</NavLink>
    <NavLink to={`/c/${clientId}/production/boms`}>Нормативи</NavLink></nav>;
}

/* ------------------------------------------------------------ nalozi */
interface OrderRow { id: number; number: string | null; status: string; docDate: string; qty: string; productName: string; productCode: string; unit: string;
  totalCost: string | null; unitCost: string | null }
export function WorkOrders() {
  const client = useOutletContext<ClientRef>();
  const [rows, setRows] = useState<OrderRow[] | null>(null);
  useEffect(() => { setRows(null); api.get<OrderRow[]>(`/api/clients/${client.id}/work-orders`).then(setRows); }, [client.id]);
  return (
    <>
      <header className="page-head"><h1>Производство</h1><div className="row-actions"><Tabs clientId={client.id} /><Link className="btn btn-primary" to="new">Нов работен налог</Link></div></header>
      {rows && rows.length === 0 && <div className="empty"><p>Сè уште нема работни налози.</p>
        <p className="small">Прво внесете норматив (од што е направен производот) во „Нормативи“, па налогот сам ги пресметува деловите.</p></div>}
      {rows && rows.length > 0 && (
        <div className="table-wrap"><table className="grid">
          <thead><tr><th>Број</th><th>Датум</th><th>Производ</th><th className="num">Количина</th><th className="num">Цена на чинење</th><th className="num">Вкупно</th><th>Статус</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className={r.status === "voided" ? "row-voided" : ""}>
              <td><Link className="docno" to={String(r.id)}>{r.number ?? "Нацрт"}</Link></td><td>{date(r.docDate)}</td>
              <td>{r.productName} <span className="muted small">{r.productCode}</span></td>
              <td className="num">{qtyFmt(r.qty)} {r.unit}</td><td className="num">{r.unitCost ? money(r.unitCost) : "–"}</td><td className="num">{r.totalCost ? money(r.totalCost) : "–"}</td>
              <td><span className={`chip ${chip(r.status)}`}>{STATUS[r.status]}</span></td>
            </tr>))}</tbody>
        </table></div>
      )}
    </>
  );
}

interface OrderLine { id?: number; itemId: number; plannedQty: string; qty: string; code?: string; name?: string; unit?: string; stockQty?: string; avgCost?: string }
interface Order { id: number; number: string | null; status: string; productItemId: number; qty: string; docDate: string; warehouseId: number | null; outputWarehouseId: number | null;
  laborHours: string | null; laborCost: string | null; overheadCost: string | null; materialCost: string | null; totalCost: string | null; unitCost: string | null;
  note: string | null; version: number; voidReason: string | null; product: Item; hasBom: boolean; settings: ProductionSettings; lines: OrderLine[];
  stockDocs: { id: number; number: string; kind: string; reversesDocId: number | null }[];
  estimate: { material: string; labor: string; overhead: string; total: string; unit: string; laborHours: string } | null }

export function WorkOrderEditor() {
  const client = useOutletContext<ClientRef>();
  const { id } = useParams();
  const nav = useNavigate();
  const [o, setO] = useState<Order | null>(null);
  const [itemsList, setItems] = useState<Item[]>([]);
  const [whs, setWhs] = useState<Warehouse[]>([]);
  const [head, setHead] = useState({ productItemId: (Number(new URLSearchParams(window.location.search).get("product")) || "") as number | "", qty: "1", docDate: today(), warehouseId: "" as number | "", outputWarehouseId: "" as number | "",
    laborHours: "", laborCost: "", overheadCost: "", note: "" });
  const [lines, setLines] = useState<OrderLine[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [dirty, setDirty] = useState(false);

  async function load(oid = id) {
    if (!oid || oid === "new") return;
    const x = await api.get<Order>(`/api/clients/${client.id}/work-orders/${oid}`);
    setO(x); setDirty(false);
    const n = (v: string | null) => (v === null ? "" : String(Number(v)));
    setHead({ productItemId: x.productItemId, qty: String(Number(x.qty)), docDate: x.docDate, warehouseId: x.warehouseId ?? "", outputWarehouseId: x.outputWarehouseId ?? "",
      laborHours: n(x.laborHours), laborCost: x.status === "draft" ? n(x.laborCost) : n(x.laborCost), overheadCost: n(x.overheadCost), note: x.note ?? "" });
    setLines(x.lines.map((l) => ({ ...l, qty: String(Number(l.qty)) })));
  }
  useEffect(() => {
    api.get<Item[]>(`/api/clients/${client.id}/items`).then((x) => setItems(x.filter((i) => STOCK_TYPES.includes(i.type))));
    api.get<Warehouse[]>(`/api/clients/${client.id}/warehouses`).then(setWhs);
    void load().catch((e) => setMsg({ kind: "err", text: (e as ApiError).message }));
  }, [client.id, id]);

  const editable = !o || o.status === "draft";
  const s = o?.settings;
  const products = itemsList.filter((i) => i.isActive && i.type !== "goods");
  const parts = itemsList.filter((i) => i.isActive && i.id !== head.productItemId);
  const product = itemsList.find((i) => i.id === head.productItemId);
  const multiWh = whs.filter((w) => w.isActive).length > 1;
  const upd = (h: Partial<typeof head>) => { setHead({ ...head, ...h }); setDirty(true); };
  const setLine = (i: number, k: keyof OrderLine, v: unknown) => { setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l))); setDirty(true); };
  const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".")));

  async function save(replan = false): Promise<number | null> {
    if (!head.productItemId) { setMsg({ kind: "err", text: "Изберете производ." }); return null; }
    const body = { productItemId: head.productItemId, qty: Number(head.qty.replace(",", ".")), docDate: head.docDate, warehouseId: head.warehouseId || null,
      outputWarehouseId: head.outputWarehouseId || null, laborHours: numOrNull(head.laborHours), laborCost: numOrNull(head.laborCost), overheadCost: numOrNull(head.overheadCost),
      note: head.note, version: o?.version, replan, ...(o && !replan ? { lines: lines.map((l) => ({ itemId: l.itemId, plannedQty: Number(l.plannedQty), qty: Number(String(l.qty).replace(",", ".")) })) } : {}) };
    setBusy(true); setMsg(null);
    try {
      if (o) { await api.put(`/api/clients/${client.id}/work-orders/${o.id}`, body); await load(String(o.id)); return o.id; }
      const r = await api.post<{ id: number }>(`/api/clients/${client.id}/work-orders`, body);
      nav(`../${r.id}`, { relative: "path", replace: true });
      return r.id;
    } catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); return null; } finally { setBusy(false); }
  }
  async function post() {
    const oid = dirty || !o ? await save() : o.id; if (!oid) return;
    setBusy(true);
    try {
      const r = await api.post<{ number: string; unitCost: string; warnings: string[] }>(`/api/clients/${client.id}/work-orders/${oid}/post`);
      await load(String(oid));
      setMsg({ kind: r.warnings.length ? "err" : "ok", text: `Прокнижен ${r.number}. Цена на чинење ${money(r.unitCost)} ден. по ${product?.unit ?? "ком"}.${r.warnings.length ? ` ${r.warnings.join(" ")}` : ""}` });
    } catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); } finally { setBusy(false); }
  }

  const est = o?.estimate;
  const short = (l: OrderLine) => l.stockQty !== undefined && Number(l.qty) > Number(l.stockQty);
  return (
    <>
      <header className="page-head">
        <div><Link to={`/c/${client.id}/production`} className="back">← Работни налози</Link><h1>{o?.number ?? (o ? "Нацрт налог" : "Нов работен налог")}</h1></div>
        {o && <div className="head-state"><span className={`chip ${chip(o.status)}`}>{STATUS[o.status]}</span></div>}
      </header>
      {msg && <p className={msg.kind === "ok" ? "notice" : "alert"} role={msg.kind === "err" ? "alert" : "status"}>{msg.text}</p>}
      {o?.status === "voided" && <p className="alert">Сторниран: {o.voidReason}</p>}

      <section className="doc">
        <div className="doc-head">
          <label className="span2">Производ
            {editable && !o ? <select value={head.productItemId} onChange={(e) => upd({ productItemId: e.target.value ? Number(e.target.value) : "" })}>
              <option value="">— изберете —</option>{products.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name} ({ITEM_TYPE[x.type]})</option>)}</select>
              : <output>{o?.product.name} <span className="muted small">{o?.product.code}</span></output>}
            {editable && !o && products.length === 0 && <small className="alert">Нема артикли од вид „Готов производ“. Поставете вид во „Артикли и услуги“.</small>}
          </label>
          <label>Количина{editable ? <input inputMode="decimal" value={head.qty} onChange={(e) => upd({ qty: e.target.value })} /> : <output>{qtyFmt(head.qty)} {o?.product.unit}</output>}</label>
          <label>Датум{editable ? <input type="date" value={head.docDate} onChange={(e) => upd({ docDate: e.target.value })} /> : <output>{date(head.docDate)}</output>}</label>
          {multiWh && <label>Делови од магацин{editable ? <select value={head.warehouseId} onChange={(e) => upd({ warehouseId: e.target.value ? Number(e.target.value) : "" })}>
            <option value="">Главен</option>{whs.filter((w) => w.isActive && !w.isDefault).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
            : <output>{whs.find((w) => w.id === o?.warehouseId)?.name}</output>}</label>}
          {multiWh && <label>Производ во магацин{editable ? <select value={head.outputWarehouseId} onChange={(e) => upd({ outputWarehouseId: e.target.value ? Number(e.target.value) : "" })}>
            <option value="">Ист</option>{whs.filter((w) => w.isActive).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
            : <output>{whs.find((w) => w.id === o?.outputWarehouseId)?.name}</output>}</label>}
        </div>

        {o && (<>
          <div className="sec-head"><h2>Потрошени делови</h2>
            {editable && o.hasBom && <button className="link" disabled={busy} onClick={() => void save(true)}>Пресметај повторно од нормативот за {qtyFmt(head.qty)} {o.product.unit}</button>}</div>
          {!o.hasBom && editable && <p className="notice">Производот нема норматив. Додадете ги деловите рачно или <Link to={`/c/${client.id}/production/boms/${o.productItemId}`}>внесете норматив</Link>.</p>}
          <div className="table-wrap"><table className="grid lines">
            <thead><tr><th className="c-item">Дел / материјал</th><th className="num">По норматив</th><th className="c-qty num">Потрошено</th>
              {editable && <th className="num">На залиха</th>}{editable && <th className="num">Просечна цена</th>}{editable && <th className="c-x" />}</tr></thead>
            <tbody>{lines.map((l, i) => (
              <tr key={i} className={short(l) && editable ? "row-neg" : ""}>
                <td className="c-item">{editable && !l.id ? <select value={l.itemId || ""} onChange={(e) => setLine(i, "itemId", Number(e.target.value))} aria-label={`Дел ${i + 1}`}>
                  <option value="">— изберете —</option>{parts.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select>
                  : <>{l.name} <span className="muted small">{l.code}</span></>}</td>
                <td className="num muted">{Number(l.plannedQty) ? qtyFmt(l.plannedQty) : "–"}</td>
                <td className="c-qty num">{editable ? <input inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, "qty", e.target.value)} aria-label="Потрошено" /> : qtyFmt(l.qty)} {l.unit}</td>
                {editable && <td className="num">{l.stockQty !== undefined ? qtyFmt(l.stockQty) : "–"}</td>}
                {editable && <td className="num">{l.avgCost !== undefined ? money(l.avgCost) : "–"}</td>}
                {editable && <td className="c-x"><button className="icon" onClick={() => { setLines(lines.filter((_, j) => j !== i)); setDirty(true); }} aria-label={`Избриши ${i + 1}`}>×</button></td>}
              </tr>))}</tbody>
          </table></div>
          {editable && <button className="btn add-line" onClick={() => { setLines([...lines, { itemId: 0, plannedQty: "0", qty: "" }]); setDirty(true); }}>Додај дел</button>}

          <div className="doc-foot">
            <div className="stack">
              {editable && s && <div className="form-grid cost-in">
                {s.labor === "hour" && <label>Часови труд<input inputMode="decimal" value={head.laborHours} onChange={(e) => upd({ laborHours: e.target.value })} placeholder={est?.laborHours} />
                  <small className="muted">× {money(s.laborRate)} ден./час</small></label>}
                {s.labor !== "none" && <label>Труд (рачно, ден.)<input inputMode="decimal" value={head.laborCost} onChange={(e) => upd({ laborCost: e.target.value })} placeholder="пресметано" /></label>}
                {s.overhead !== "none" && <label>Струја и општи (рачно, ден.)<input inputMode="decimal" value={head.overheadCost} onChange={(e) => upd({ overheadCost: e.target.value })} placeholder="пресметано" />
                  <small className="muted">{s.overhead === "percent" ? `${s.overheadValue}% од материјалите` : `${money(s.overheadValue)} ден. по парче`}</small></label>}
              </div>}
              <label>Забелешка{editable ? <textarea rows={2} value={head.note} onChange={(e) => upd({ note: e.target.value })} /> : <output>{head.note || "–"}</output>}</label>
              {o.stockDocs.length > 0 && <p className="small">Магацин: {o.stockDocs.map((d, i) => <span key={d.id}>{i > 0 && ", "}<Link to={`/c/${client.id}/stock/docs/${d.id}`}>{d.number}</Link>
                {d.reversesDocId ? " (сторно)" : ` (${STOCK_KIND[d.kind]})`}</span>)}</p>}
            </div>
            <dl className="totals">
              <div><dt>Материјали{editable ? " (проценка)" : ""}</dt><dd>{money(editable ? est?.material : o.materialCost)}</dd></div>
              {(editable ? Number(est?.labor) : Number(o.laborCost)) > 0 && <div><dt>Труд</dt><dd>{money(editable ? est?.labor : o.laborCost)}</dd></div>}
              {(editable ? Number(est?.overhead) : Number(o.overheadCost)) > 0 && <div><dt>Струја и општи</dt><dd>{money(editable ? est?.overhead : o.overheadCost)}</dd></div>}
              <div><dt>Вкупно</dt><dd>{money(editable ? est?.total : o.totalCost)}</dd></div>
              <div className="payable"><dt>Цена на чинење / {o.product.unit}</dt><dd>{money(editable ? est?.unit : o.unitCost)} <span>ден.</span></dd></div>
            </dl>
          </div>
          {editable && dirty && <p className="muted small">Проценката се освежува по „Зачувај нацрт“.</p>}
        </>)}
      </section>

      {voiding && o && <VoidOrder client={client} id={o.id} onDone={async (t) => { setVoiding(false); if (t) { await load(String(o.id)); setMsg({ kind: "ok", text: t }); } }} />}
      <div className="actions">
        {editable && <><button className={o ? "btn" : "btn btn-primary"} disabled={busy || (!!o && !dirty)} onClick={() => void save()}>{o ? (dirty ? "Зачувај нацрт" : "Зачувано") : "Креирај налог од нормативот"}</button>
          {o && <button className="btn btn-primary" disabled={busy} onClick={() => void post()}>Прокнижи</button>}
          {o && <button className="btn btn-quiet" disabled={busy} onClick={async () => { try { await api.del(`/api/clients/${client.id}/work-orders/${o.id}`); nav(`/c/${client.id}/production`); }
            catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); } }}>Избриши нацрт</button>}</>}
        {o?.status === "posted" && !voiding && <button className="btn" onClick={() => setVoiding(true)}>Сторнирај</button>}
        {editable && o && <span className="muted small">При книжење деловите излегуваат од магацин, а производот влегува по цена на чинење.</span>}
      </div>
    </>
  );
}

function VoidOrder({ client, id, onDone }: { client: ClientRef; id: number; onDone: (t: string | null) => void }) {
  const [reason, setReason] = useState("");
  const [d, setD] = useState(today());
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    try { const r = await api.post<{ warnings: string[] }>(`/api/clients/${client.id}/work-orders/${id}/void`, { reason, date: d }); onDone(`Сторниран.${r.warnings.length ? ` ${r.warnings.join(" ")}` : ""}`); }
    catch (e) { setErr((e as ApiError).message); }
  }
  return (
    <section className="panel stack">
      <h2>Сторно на работен налог</h2>
      <p className="muted small">Готовиот производ излегува од магацин, а деловите се враќаат по истите цени. Ако производот е веќе продаден, важи правилото за залиха во минус.</p>
      <div className="row-actions"><label className="grow">Причина<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <label>Датум<input type="date" value={d} onChange={(e) => setD(e.target.value)} /></label></div>
      {err && <p className="alert">{err}</p>}
      <div className="row-actions"><button className="btn btn-primary" disabled={reason.trim().length < 3} onClick={go}>Сторнирај</button><button className="link" onClick={() => onDone(null)}>Откажи</button></div>
    </section>
  );
}

/* ---------------------------------------------------------- normativi */
interface BomRow { productItemId: number; code: string; name: string; unit: string; type: string; isActiveItem: boolean; bomId: number | null; outputQty: string | null;
  laborHours: string | null; isActive: boolean | null; lines: number | null }
export function Boms() {
  const client = useOutletContext<ClientRef>();
  const [rows, setRows] = useState<BomRow[] | null>(null);
  useEffect(() => { setRows(null); api.get<BomRow[]>(`/api/clients/${client.id}/boms`).then(setRows); }, [client.id]);
  return (
    <>
      <header className="page-head"><h1>Производство</h1><div className="row-actions"><Tabs clientId={client.id} /></div></header>
      <p className="muted small">Нормативот кажува од што е направен производот. Тука се прикажуваат артиклите од вид „Готов производ“. Полупроизвод (на пр. рамка) е исто готов производ што влегува во друг норматив.</p>
      {rows && rows.length === 0 && <div className="empty"><p>Нема артикли од вид „Готов производ“.</p><p className="small">Во <Link to={`/c/${client.id}/items`}>Артикли и услуги</Link> поставете вид „Готов производ“.</p></div>}
      {rows && rows.length > 0 && (
        <div className="table-wrap"><table className="grid">
          <thead><tr><th>Шифра</th><th>Производ</th><th>Норматив</th><th className="num">Делови</th><th className="num">Труд (часови)</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.productItemId} className={r.isActiveItem ? "" : "row-inactive"}>
              <td><Link className="docno" to={String(r.productItemId)}>{r.code}</Link></td><td>{r.name}</td>
              <td>{r.bomId ? <span className="chip ok">за {qtyFmt(r.outputQty)} {r.unit}</span> : <span className="chip wait">нема</span>}</td>
              <td className="num">{r.lines ?? "–"}</td><td className="num">{r.laborHours ? qtyFmt(r.laborHours) : "–"}</td>
            </tr>))}</tbody>
        </table></div>
      )}
    </>
  );
}

interface BomLine { itemId: number | ""; qty: string; wastePct: string; avgCost?: string | null; unit?: string }
export function BomEditor() {
  const client = useOutletContext<ClientRef>();
  const { productId } = useParams();
  const [d, setD] = useState<{ product: Item; bom: { outputQty: string; laborHours: string; laborCost: string | null; note: string | null } | null; lines: (BomLine & { name: string; code: string })[] } | null>(null);
  const [itemsList, setItems] = useState<Item[]>([]);
  const [settings, setSettings] = useState<ProductionSettings | null>(null);
  const [h, setH] = useState({ outputQty: "1", laborHours: "0", laborCost: "", note: "" });
  const [lines, setLines] = useState<BomLine[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  async function load() {
    const x = await api.get<NonNullable<typeof d>>(`/api/clients/${client.id}/boms/${productId}`);
    setD(x);
    setH({ outputQty: String(Number(x.bom?.outputQty ?? 1)), laborHours: String(Number(x.bom?.laborHours ?? 0)), laborCost: x.bom?.laborCost ? String(Number(x.bom.laborCost)) : "", note: x.bom?.note ?? "" });
    setLines(x.lines.map((l) => ({ itemId: l.itemId, qty: String(Number(l.qty)), wastePct: String(Number(l.wastePct)), avgCost: l.avgCost, unit: l.unit })));
  }
  useEffect(() => {
    void load();
    api.get<Item[]>(`/api/clients/${client.id}/items`).then((x) => setItems(x.filter((i) => i.isActive && STOCK_TYPES.includes(i.type))));
    api.get<{ productionSettings: ProductionSettings | null }>(`/api/clients/${client.id}`).then((c) => setSettings({ useWaste: false, labor: "none", laborRate: 0, overhead: "none", overheadValue: 0, ...(c.productionSettings ?? {}) }));
  }, [client.id, productId]);
  if (!d) return <p className="muted">Се вчитува…</p>;
  const set = (i: number, k: keyof BomLine, v: unknown) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const material = lines.reduce((a, l) => a + (Number(l.qty) || 0) * Number(l.avgCost ?? itemsList.find((x) => x.id === l.itemId)?.unitPrice ?? 0) / (1 - (settings?.useWaste ? Number(l.wastePct) || 0 : 0) / 100), 0);
  async function save() {
    setMsg(null);
    try {
      await api.put(`/api/clients/${client.id}/boms/${productId}`, { outputQty: Number(h.outputQty.replace(",", ".")), laborHours: Number(h.laborHours.replace(",", ".")) || 0,
        laborCost: h.laborCost.trim() ? Number(h.laborCost.replace(",", ".")) : null, note: h.note,
        lines: lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, qty: Number(l.qty.replace(",", ".")), wastePct: Number(l.wastePct) || 0 })) });
      await load(); setMsg({ kind: "ok", text: "Нормативот е зачуван. Важи за новите работни налози." });
    } catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); }
  }
  return (
    <>
      <Link className="back" to={`/c/${client.id}/production/boms`}>← Нормативи</Link>
      <header className="page-head"><div><h1>{d.product.name}</h1><p className="muted small">{d.product.code} · норматив</p></div>
        {d.bom && <Link className="btn" to={`/c/${client.id}/production/new?product=${d.product.id}`}>Нов налог за овој производ</Link>}</header>
      {msg && <p className={msg.kind === "ok" ? "notice" : "alert"} role="status">{msg.text}</p>}
      <section className="doc">
        <div className="doc-head">
          <label>Нормативот е за<span className="inline-unit"><input inputMode="decimal" value={h.outputQty} onChange={(e) => setH({ ...h, outputQty: e.target.value })} /> {d.product.unit}</span></label>
          {settings?.labor === "hour" && <label>Труд (часови)<input inputMode="decimal" value={h.laborHours} onChange={(e) => setH({ ...h, laborHours: e.target.value })} /></label>}
          {settings?.labor === "piece" && <label>Труд по парче (ден.)<input inputMode="decimal" value={h.laborCost} onChange={(e) => setH({ ...h, laborCost: e.target.value })} placeholder={money(settings.laborRate)} /></label>}
          <label className="span2">Забелешка<input value={h.note} onChange={(e) => setH({ ...h, note: e.target.value })} /></label>
        </div>
        <div className="table-wrap"><table className="grid lines">
          <thead><tr><th className="c-item">Дел / материјал</th><th className="c-qty num">Количина</th>{settings?.useWaste && <th className="c-disc num">Отпад %</th>}<th className="num">Просечна цена</th><th className="c-x" /></tr></thead>
          <tbody>{lines.map((l, i) => {
            const it = itemsList.find((x) => x.id === l.itemId);
            return (
              <tr key={i}>
                <td className="c-item"><select value={l.itemId} onChange={(e) => set(i, "itemId", e.target.value ? Number(e.target.value) : "")} aria-label={`Дел ${i + 1}`}>
                  <option value="">— изберете —</option>{itemsList.filter((x) => x.id !== d.product.id).map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></td>
                <td className="c-qty num"><input inputMode="decimal" value={l.qty} onChange={(e) => set(i, "qty", e.target.value)} aria-label="Количина" /></td>
                {settings?.useWaste && <td className="c-disc num"><input inputMode="decimal" value={l.wastePct} onChange={(e) => set(i, "wastePct", e.target.value)} aria-label="Отпад %" /></td>}
                <td className="num muted">{l.avgCost ? money(l.avgCost) : "–"}{it ? ` / ${it.unit}` : ""}</td>
                <td className="c-x"><button className="icon" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label={`Избриши ${i + 1}`}>×</button></td>
              </tr>);
          })}</tbody>
        </table></div>
        <button className="btn add-line" onClick={() => setLines([...lines, { itemId: "", qty: "1", wastePct: "0" }])}>Додај дел</button>
        <div className="doc-foot"><div className="muted small">{settings?.useWaste ? "Со отпад X% се троши повеќе: потребно = количина / (1 − X%)." : "Отпадот е исклучен во поставките на фирмата."}
          {settings && settings.labor !== "none" && ` Трудот се пресметува ${settings.labor === "hour" ? `по ${money(settings.laborRate)} ден./час` : "по парче"}.`}</div>
          <dl className="totals"><div><dt>Материјали (проценка, по сегашни цени)</dt><dd>{money(material)}</dd></div></dl></div>
      </section>
      <div className="actions"><button className="btn btn-primary" onClick={save}>Зачувај норматив</button>
        <span className="muted small">Промена на нормативот не ги менува веќе креираните налози.</span></div>
    </>
  );
}
