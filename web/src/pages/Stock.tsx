import { useEffect, useState } from "react";
import { Link, NavLink, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, type ClientRef, type Item, type Partner, type Warehouse } from "../api";
import { date, ITEM_TYPE, money, qtyFmt, STOCK_KIND, STOCK_TYPES, today } from "../format";

interface StockRow { warehouseId: number; warehouseName: string; itemId: number; code: string; name: string; type: string; unit: string; trackLots: boolean;
  qty: string; value: string; avgCost: string; salePrice: string; lots: { lotId: number; lotNo: string; expiryDate: string | null; qty: string }[] }
interface DocRow { id: number; number: string; kind: string; docDate: string; note: string | null; warehouseName: string; reversesDocId: number | null;
  invoiceId: number | null; purchaseInvoiceId: number | null; value: string; lines: number; reversed: boolean }

function useWarehouses(clientId: number) {
  const [w, setW] = useState<Warehouse[]>([]);
  useEffect(() => { api.get<Warehouse[]>(`/api/clients/${clientId}/warehouses`).then(setW); }, [clientId]);
  return w;
}
export function StockTabs({ clientId }: { clientId: number }) {
  return <nav className="seg tabs" aria-label="Магацин"><NavLink to={`/c/${clientId}/stock`} end>Залиха</NavLink><NavLink to={`/c/${clientId}/stock/docs`}>Документи</NavLink><NavLink to={`/c/${clientId}/stock/dispatches`}>Испратници</NavLink></nav>;
}
const soon = (d: string | null) => !!d && d <= new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);

/* ------------------------------------------------------------- zaliha */
export function Stock() {
  const client = useOutletContext<ClientRef>();
  const whs = useWarehouses(client.id);
  const [wh, setWh] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<StockRow[] | null>(null);
  useEffect(() => { setRows(null); api.get<StockRow[]>(`/api/clients/${client.id}/stock${wh ? `?warehouseId=${wh}` : ""}`).then(setRows); }, [client.id, wh]);
  const n = q.trim().toLowerCase();
  const shown = (rows ?? []).filter((r) => !n || r.name.toLowerCase().includes(n) || r.code.toLowerCase().includes(n));
  const total = shown.reduce((a, r) => a + Number(r.value), 0);
  const multi = whs.length > 1;
  return (
    <>
      <header className="page-head"><div><h1>Магацин</h1></div><div className="row-actions"><StockTabs clientId={client.id} /><Link className="btn btn-primary" to="docs/new">Нов документ</Link></div></header>
      <div className="toolbar">
        <input type="search" placeholder="Шифра или назив" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Пребарај" />
        {multi && <select value={wh} onChange={(e) => setWh(e.target.value)} aria-label="Магацин"><option value="">Сите магацини</option>
          {whs.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>}
      </div>
      {rows && shown.length === 0 && <div className="empty"><p>{rows.length ? "Нема артикл со тоа име." : "Магацинот е празен."}</p>
        {!rows.length && <p className="small">Почетна состојба се внесува со „Нов документ“ → Приемница, а стоката влегува и со прокнижена влезна фактура.</p>}</div>}
      {shown.length > 0 && (
        <div className="table-wrap"><table className="grid">
          <thead><tr><th>Шифра</th><th>Артикл</th>{multi && !wh && <th>Магацин</th>}<th className="num">Количина</th><th className="num">Просечна наб. цена</th><th className="num">Вредност</th><th className="num">Продажна цена</th></tr></thead>
          <tbody>{shown.map((r) => (
            <tr key={`${r.warehouseId}-${r.itemId}`} className={Number(r.qty) < 0 ? "row-neg" : ""}>
              <td><Link className="docno" to={`card/${r.itemId}${wh ? `?warehouseId=${wh}` : ""}`}>{r.code}</Link></td>
              <td>{r.name} <span className="doctype">{ITEM_TYPE[r.type]}</span>
                {r.lots.length > 0 && <div className="lots">{r.lots.map((l) => <span key={l.lotId} className={`chip ${soon(l.expiryDate) ? "wait" : ""}`}>
                  {l.lotNo}{l.expiryDate ? ` · до ${date(l.expiryDate)}` : ""} · {qtyFmt(l.qty)}</span>)}</div>}</td>
              {multi && !wh && <td>{r.warehouseName}</td>}
              <td className="num">{qtyFmt(r.qty)} {r.unit}</td><td className="num">{money(r.avgCost)}</td><td className="num">{money(r.value)}</td><td className="num muted">{money(r.salePrice)}</td>
            </tr>))}</tbody>
          <tfoot><tr><td colSpan={multi && !wh ? 5 : 4}>Вкупно {shown.length} артикли</td><td className="num">{money(total)}</td><td /></tr></tfoot>
        </table></div>
      )}
    </>
  );
}

/* ---------------------------------------------------- kartica na artikl */
interface CardMove { id: number; docId: number; number: string; kind: string; docDate: string; note: string | null; warehouseName: string; lotNo: string | null;
  qty: string; unitCost: string; value: string; balanceQty: string; balanceValue: string; invoiceId: number | null; purchaseInvoiceId: number | null }
export function StockCard() {
  const client = useOutletContext<ClientRef>();
  const { itemId } = useParams();
  const [sp] = useSearchParams();
  const whs = useWarehouses(client.id);
  const [wh, setWh] = useState(sp.get("warehouseId") ?? "");
  const [d, setD] = useState<{ item: Item; moves: CardMove[] } | null>(null);
  useEffect(() => {
    if (!wh && whs.length) setWh(String(whs.find((w) => w.isDefault)?.id ?? whs[0]!.id));
  }, [whs]);
  useEffect(() => { if (wh) api.get<{ item: Item; moves: CardMove[] }>(`/api/clients/${client.id}/stock/card?itemId=${itemId}&warehouseId=${wh}`).then(setD); }, [client.id, itemId, wh]);
  if (!d) return <p className="muted">Се вчитува…</p>;
  const last = d.moves[d.moves.length - 1];
  return (
    <>
      <Link className="back" to="../.." relative="path">← Залиха</Link>
      <header className="page-head"><div><h1>{d.item.name}</h1><p className="muted small">{d.item.code} · {ITEM_TYPE[d.item.type]} · {d.item.unit}</p></div>
        {whs.length > 1 && <select value={wh} onChange={(e) => setWh(e.target.value)} aria-label="Магацин">{whs.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>}</header>
      {d.moves.length === 0 ? <div className="empty"><p>Нема движења во овој магацин.</p></div> : (
        <div className="table-wrap"><table className="grid card">
          <thead><tr><th>Датум</th><th>Документ</th><th>Опис</th><th className="num">Влез</th><th className="num">Излез</th><th className="num">Цена</th><th className="num">Вредност</th><th className="num">Состојба</th><th className="num">Вредност на залиха</th></tr></thead>
          <tbody>{d.moves.map((m) => (
            <tr key={m.id}>
              <td>{date(m.docDate)}</td>
              <td><Link className="docno" to={`../../docs/${m.docId}`} relative="path">{m.number}</Link><br /><span className="muted small">{STOCK_KIND[m.kind]}</span></td>
              <td className="small">{m.note}{m.lotNo && <><br /><span className="muted">лот {m.lotNo}</span></>}
                {m.invoiceId && <> · <Link to={`../../../invoices/${m.invoiceId}`} relative="path">фактура</Link></>}
                {m.purchaseInvoiceId && <> · <Link to={`../../../purchases/${m.purchaseInvoiceId}`} relative="path">влезна ф-ра</Link></>}</td>
              <td className="num">{Number(m.qty) > 0 ? qtyFmt(m.qty) : ""}</td><td className="num">{Number(m.qty) < 0 ? qtyFmt(-Number(m.qty)) : ""}</td>
              <td className="num">{money(m.unitCost)}</td><td className="num">{money(m.value)}</td>
              <td className="num"><strong>{qtyFmt(m.balanceQty)}</strong></td><td className="num">{money(m.balanceValue)}</td>
            </tr>))}</tbody>
          {last && <tfoot><tr><td colSpan={7}>Состојба</td><td className="num">{qtyFmt(last.balanceQty)} {d.item.unit}</td><td className="num">{money(last.balanceValue)}</td></tr></tfoot>}
        </table></div>
      )}
    </>
  );
}

/* ----------------------------------------------------------- dokumenti */
export function StockDocs() {
  const client = useOutletContext<ClientRef>();
  const [kind, setKind] = useState("");
  const [rows, setRows] = useState<DocRow[] | null>(null);
  useEffect(() => { setRows(null); api.get<DocRow[]>(`/api/clients/${client.id}/stock-docs${kind ? `?kind=${kind}` : ""}`).then(setRows); }, [client.id, kind]);
  return (
    <>
      <header className="page-head"><h1>Магацин</h1><div className="row-actions"><StockTabs clientId={client.id} /><Link className="btn btn-primary" to="new">Нов документ</Link></div></header>
      <div className="toolbar"><select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Вид"><option value="">Сите видови</option>
        {Object.entries(STOCK_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
      {rows && rows.length === 0 && <div className="empty"><p>Нема магацински документи.</p></div>}
      {rows && rows.length > 0 && (
        <div className="table-wrap"><table className="grid">
          <thead><tr><th>Број</th><th>Вид</th><th>Датум</th><th>Магацин</th><th>Опис</th><th className="num">Ставки</th><th className="num">Вредност</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className={r.reversed ? "row-voided" : ""}>
              <td><Link className="docno" to={String(r.id)}>{r.number}</Link></td>
              <td>{STOCK_KIND[r.kind]}{r.reversesDocId && <span className="doctype">сторно</span>}{r.reversed && <span className="doctype">сторниран</span>}</td>
              <td>{date(r.docDate)}</td><td>{r.warehouseName}</td><td className="small">{r.note}</td><td className="num">{r.lines}</td><td className="num">{money(r.value)}</td>
            </tr>))}</tbody>
        </table></div>
      )}
    </>
  );
}

interface DocDetail { id: number; number: string; kind: string; docDate: string; note: string | null; author: string | null; invoiceId: number | null; purchaseInvoiceId: number | null;
  reversedBy: { id: number; number: string } | null; reverses: { id: number; number: string } | null;
  partner: { id: number; name: string } | null; billedBy: { id: number; number: string | null; status: string }[];
  moves: { id: number; code: string; name: string; unit: string; warehouseName: string; lotNo: string | null; expiryDate: string | null; qty: string; unitCost: string; value: string }[] }
export function StockDocView() {
  const client = useOutletContext<ClientRef>();
  const { docId } = useParams();
  const nav = useNavigate();
  const [d, setD] = useState<DocDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api.get<DocDetail>(`/api/clients/${client.id}/stock-docs/${docId}`).then(setD, (e) => setErr((e as ApiError).message));
  useEffect(() => { void load(); }, [client.id, docId]);
  if (err && !d) return <p className="alert">{err}</p>;
  if (!d) return <p className="muted">Се вчитува…</p>;
  const manual = !d.invoiceId && !d.purchaseInvoiceId && !d.reverses && !d.reversedBy && !d.billedBy?.length;
  async function reverse() {
    try { const r = await api.post<{ id: number }>(`/api/clients/${client.id}/stock-docs/${d!.id}/reverse`, { date: today() }); nav(`../${r.id}`, { relative: "path" }); }
    catch (e) { setErr((e as ApiError).message); }
  }
  const multiWh = new Set(d.moves.map((m) => m.warehouseName)).size > 1;
  return (
    <>
      <Link className="back" to=".." relative="path">← Документи</Link>
      <header className="page-head"><div><h1>{d.number}</h1><p className="muted small">{STOCK_KIND[d.kind]} · {date(d.docDate)}{d.author ? ` · ${d.author}` : ""}</p></div>
        <div className="row-actions"><a className="btn" href={`/api/clients/${client.id}/stock-docs/${d.id}/pdf`} target="_blank" rel="noreferrer">PDF</a>
        {manual && <button className="btn" onClick={reverse}>Сторнирај</button>}</div></header>
      {d.partner && <p>Купувач: <Link to={`../../../partners/${d.partner.id}`} relative="path">{d.partner.name}</Link>
        {d.kind === "issue" && !d.reversedBy && (d.billedBy?.length
          ? <> · фактурирана во {d.billedBy.map((b) => <Link key={b.id} to={`../../../invoices/${b.id}`} relative="path">{b.number ?? "нацрт"}</Link>)}</>
          : <> · <span className="chip wait">не е фактурирана</span> <Link to="../../dispatches" relative="path">Направи фактура</Link></>)}</p>}
      {err && <p className="alert">{err}</p>}
      {d.note && <p>{d.note}</p>}
      <p className="small">
        {d.reverses && <>Сторно на <Link to={`../${d.reverses.id}`} relative="path">{d.reverses.number}</Link>. </>}
        {d.reversedBy && <>Сторниран со <Link to={`../${d.reversedBy.id}`} relative="path">{d.reversedBy.number}</Link>. </>}
        {d.invoiceId && <Link to={`../../../invoices/${d.invoiceId}`} relative="path">Отвори ја фактурата</Link>}
        {d.purchaseInvoiceId && <Link to={`../../../purchases/${d.purchaseInvoiceId}`} relative="path">Отвори ја влезната фактура</Link>}
      </p>
      <div className="table-wrap"><table className="grid">
        <thead><tr><th>Шифра</th><th>Артикл</th>{multiWh && <th>Магацин</th>}<th>Лот</th><th className="num">Количина</th><th className="num">Цена</th><th className="num">Вредност</th></tr></thead>
        <tbody>{d.moves.map((m) => (
          <tr key={m.id}><td>{m.code}</td><td>{m.name}</td>{multiWh && <td>{m.warehouseName}</td>}
            <td className="small">{m.lotNo ? `${m.lotNo}${m.expiryDate ? `, до ${date(m.expiryDate)}` : ""}` : "–"}</td>
            <td className="num">{qtyFmt(m.qty)} {m.unit}</td><td className="num">{money(m.unitCost)}</td><td className="num">{money(m.value)}</td></tr>))}</tbody>
      </table></div>
    </>
  );
}

/* ------------------------------------------------------ nov racen dokument */
interface NLine { itemId: number | ""; qty: string; unitCost: string; lotNo: string; expiryDate: string; lotId: number | "" }
const KIND_HELP: Record<string, string> = {
  receipt: "Прием без влезна фактура, на пр. почетна состојба. Внесете набавна цена.",
  issue: "Испратница без фактура (реверс, консигнација, испорака пред фактура). Стоката излегува веднаш; фактурата ја правите подоцна од „Испратници“.",
  writeoff: "Отпис на расипана, исчезната или потрошена стока. Излегува по просечна набавна цена.",
  inventory: "Внесете ја изброената количина. Се книжи само разликата (вишок или кусок).",
  transfer: "Пренос меѓу магацини по истата набавна цена (и лот).",
};
export function StockDocNew() {
  const client = useOutletContext<ClientRef>();
  const nav = useNavigate();
  const whs = useWarehouses(client.id).filter((w) => w.isActive);
  const [itemsList, setItems] = useState<Item[]>([]);
  const [stock, setStock] = useState<StockRow[]>([]);
  const sp = new URLSearchParams(window.location.search);   // ?kind=issue (od „Испратници“)
  const [kind, setKind] = useState(sp.get("kind") === "issue" ? "issue" : "receipt");
  const [partners, setPartners] = useState<Partner[]>([]);
  const [partnerId, setPartnerId] = useState<number | "">("");
  const [wh, setWh] = useState<number | "">("");
  const [toWh, setToWh] = useState<number | "">("");
  const [docDate, setDocDate] = useState(today());
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<NLine[]>([{ itemId: "", qty: "", unitCost: "", lotNo: "", expiryDate: "", lotId: "" }]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<Item[]>(`/api/clients/${client.id}/items`).then((x) => setItems(x.filter((i) => i.isActive && STOCK_TYPES.includes(i.type))));
    api.get<StockRow[]>(`/api/clients/${client.id}/stock`).then(setStock);
    api.get<Partner[]>(`/api/clients/${client.id}/partners`).then((p) => setPartners(p.filter((x) => x.isActive)));
  }, [client.id]);
  useEffect(() => { if (wh === "" && whs.length) setWh(whs.find((w) => w.isDefault)?.id ?? whs[0]!.id); }, [whs.length]);
  const set = (i: number, k: keyof NLine, v: unknown) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const cur = (iid: number | "") => stock.find((s) => s.itemId === iid && s.warehouseId === wh);
  async function submit() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ id: number; warnings: string[] }>(`/api/clients/${client.id}/stock-docs`, {
        kind, warehouseId: wh, toWarehouseId: kind === "transfer" ? toWh || null : null, docDate, note, partnerId: kind === "issue" ? partnerId || null : null,
        lines: lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, qty: Number(l.qty.replace(",", ".")),
          ...(l.unitCost !== "" ? { unitCost: Number(l.unitCost.replace(",", ".")) } : {}), lotNo: l.lotNo || null, expiryDate: l.expiryDate || null, lotId: l.lotId || null })) });
      nav(`../${r.id}`, { relative: "path" });
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  }
  return (
    <>
      <Link className="back" to=".." relative="path">← Документи</Link>
      <header className="page-head"><h1>Нов магацински документ</h1></header>
      <section className="doc">
        <div className="seg" role="tablist" aria-label="Вид">{["receipt", "issue", "writeoff", "inventory", ...(whs.length > 1 ? ["transfer"] : [])].map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>{k === "receipt" ? "Приемница / почетна состојба" : STOCK_KIND[k]}</button>))}</div>
        <p className="muted small">{KIND_HELP[kind]}</p>
        <div className="doc-head">
          {whs.length > 1 && <label>{kind === "transfer" ? "Од магацин" : "Магацин"}<select value={wh} onChange={(e) => setWh(Number(e.target.value))}>{whs.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
          {kind === "transfer" && <label>Во магацин<select value={toWh} onChange={(e) => setToWh(e.target.value ? Number(e.target.value) : "")}><option value="">— изберете —</option>
            {whs.filter((w) => w.id !== wh).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
          {kind === "issue" && <label className="span2">Купувач<select value={partnerId} onChange={(e) => setPartnerId(e.target.value ? Number(e.target.value) : "")} required>
            <option value="">— изберете —</option>{partners.filter((p) => p.isCustomer || !p.isSupplier).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
          <label>Датум<input type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} /></label>
          <label className="span2">Опис<input value={note} onChange={(e) => setNote(e.target.value)} placeholder={kind === "writeoff" ? "Причина за отпис" : ""} /></label>
        </div>
        {itemsList.length === 0 && <p className="alert">Нема артикли што водат залиха. Во „Артикли и услуги“ поставете вид Стока, Материјал или Готов производ.</p>}
        <div className="table-wrap"><table className="grid lines">
          <thead><tr><th className="c-item">Артикл</th><th className="num">Сега</th><th className="c-qty num">{kind === "inventory" ? "Изброено" : "Количина"}</th>
            {(kind === "receipt" || kind === "inventory") && <th className="c-price num">Набавна цена</th>}<th>Лот</th><th className="c-x" /></tr></thead>
          <tbody>{lines.map((l, i) => {
            const it = itemsList.find((x) => x.id === l.itemId);
            const c = cur(l.itemId);
            return (
              <tr key={i}>
                <td className="c-item"><select value={l.itemId} onChange={(e) => set(i, "itemId", e.target.value ? Number(e.target.value) : "")} aria-label={`Артикл ${i + 1}`}>
                  <option value="">— изберете —</option>{itemsList.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></td>
                <td className="num muted">{c ? `${qtyFmt(c.qty)} ${c.unit}` : "–"}</td>
                <td className="c-qty num"><input inputMode="decimal" value={l.qty} onChange={(e) => set(i, "qty", e.target.value)} aria-label="Количина" /></td>
                {(kind === "receipt" || kind === "inventory") && <td className="c-price num"><input inputMode="decimal" value={l.unitCost} onChange={(e) => set(i, "unitCost", e.target.value)}
                  placeholder={kind === "inventory" ? (c ? money(c.avgCost) : "просечна") : ""} aria-label="Набавна цена" /></td>}
                <td>{it?.trackLots ? (kind === "receipt"
                  ? <div className="lot-row"><input value={l.lotNo} onChange={(e) => set(i, "lotNo", e.target.value)} placeholder="Лот" aria-label="Лот" />
                      <input type="date" value={l.expiryDate} onChange={(e) => set(i, "expiryDate", e.target.value)} aria-label="Рок" /></div>
                  : <select value={l.lotId} onChange={(e) => set(i, "lotId", e.target.value ? Number(e.target.value) : "")} aria-label="Лот">
                      <option value="">{kind === "inventory" ? "— изберете лот —" : "автоматски (најблизок рок)"}</option>
                      {(c?.lots ?? []).map((x) => <option key={x.lotId} value={x.lotId}>{x.lotNo} ({qtyFmt(x.qty)})</option>)}</select>) : <span className="muted">–</span>}</td>
                <td className="c-x"><button className="icon" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label={`Избриши ставка ${i + 1}`}>×</button></td>
              </tr>);
          })}</tbody>
        </table></div>
        <button className="btn add-line" onClick={() => setLines([...lines, { itemId: "", qty: "", unitCost: "", lotNo: "", expiryDate: "", lotId: "" }])}>Додај ставка</button>
      </section>
      {err && <p className="alert" role="alert">{err}</p>}
      <div className="actions"><button className="btn btn-primary" disabled={busy || !lines.some((l) => l.itemId) || (kind === "issue" && !partnerId)} onClick={submit}>Книжи {kind === "receipt" ? "приемница" : STOCK_KIND[kind]!.toLowerCase()}</button>
        <span className="muted small">Книжен документ не се менува. Грешка се исправа со сторно.</span></div>
    </>
  );
}
