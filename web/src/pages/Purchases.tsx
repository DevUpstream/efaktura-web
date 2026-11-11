import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { calcLine, calcTotals } from "@calc";
import { api, ApiError, type ClientRef, type Item, type Partner, type VatRate, type Warehouse } from "../api";
import { date, money, STOCK_KIND, STOCK_TYPES, today } from "../format";
import { useYears, YearSelect } from "../components/YearSelect";

interface PurchaseRow { id: number; number: string | null; status: "draft" | "posted" | "voided"; supplierNumber: string; supplierName: string;
  issueDate: string; receivedDate: string; dueDate: string | null; netTotal: string; vatTotal: string; grossTotal: string; source?: string; fileCount?: number }
interface PFile { id: number; fileName: string; contentType: string; size: number; createdAt: string }
interface PLine { itemId: number | null; description: string; unit: string; qty: string; unitPrice: string; discountPct: string; vatRateId: number;
  allocate: boolean; lotNo: string; expiryDate: string; unitCost?: string | null }
interface Purchase extends PurchaseRow { partnerId: number; warehouseId: number | null; note: string | null; version: number; voidReason: string | null;
  fixedAmounts: boolean; payableAmount: string | null; turnoverDate: string | null; files: PFile[];
  lines: (PLine & { qty: string; netAmount: string; vatAmount: string })[]; stockDocs: { id: number; number: string; kind: string; reversesDocId: number | null }[] }

const STATUS: Record<string, string> = { draft: "Нацрт", posted: "Прокнижена", voided: "Сторнирана" };

export function Purchases() {
  const client = useOutletContext<ClientRef>();
  const [rows, setRows] = useState<PurchaseRow[] | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [importing, setImporting] = useState(false);
  const [reload, setReload] = useState(0);
  const { years, year, setYear } = useYears(`/api/clients/${client.id}/purchases/years?r=${reload}`);
  useEffect(() => {
    setRows(null);
    if (year === null) return;
    const p = new URLSearchParams({ ...(status ? { status } : {}), ...(q.trim() ? { q: q.trim() } : {}), ...(year ? { year: String(year) } : {}) });
    const h = setTimeout(() => api.get<PurchaseRow[]>(`/api/clients/${client.id}/purchases?${p}`).then(setRows), q ? 250 : 0);
    return () => clearTimeout(h);
  }, [client.id, q, status, reload, year]);
  useEffect(() => { setImporting(false); }, [client.id]);
  const sum = (rows ?? []).filter((r) => r.status === "posted").reduce((a, r) => a + Number(r.grossTotal), 0);
  return (
    <>
      <header className="page-head"><h1>Влезни фактури</h1>
        <div className="row-actions"><button className="btn" onClick={() => setImporting(!importing)} aria-expanded={importing}>Увези е-фактура</button>
          <Link className="btn btn-primary" to="new">Нова влезна фактура</Link></div></header>
      {importing && <ImportPanel client={client} onDone={() => setReload((x) => x + 1)} />}
      <div className="toolbar">
        <input type="search" placeholder="Добавувач, број на фактура" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Пребарај" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Статус"><option value="">Сите</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <YearSelect years={years} year={year} onChange={setYear} allowAll />
      </div>
      {rows && rows.length === 0 && <div className="empty"><p>{q || status ? "Нема фактури за овој избор." : "Сè уште нема влезни фактури."}</p></div>}
      {rows && rows.length > 0 && (
        <div className="table-wrap"><table className="grid">
          <thead><tr><th>Наш број</th><th>Добавувач</th><th>Број кај добавувачот</th><th>Примена</th><th>Рок</th><th className="num">Основица</th><th className="num">ДДВ</th><th className="num">Вкупно</th><th>Статус</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className={`row-${r.status === "voided" ? "voided" : r.status}`}>
              <td><Link className="docno" to={String(r.id)}>{r.number ?? "Нацрт"}</Link>{r.source === "ujp_json" && <span className="doctype" title="Увезена е-фактура (JSON)">е-ф</span>}{r.source === "erpnext" && <span className="doctype" title="Пренесена од ERPNext (архива, без залиха)">ERP</span>}
                {!!r.fileCount && <span className="muted small" title="Има прилог (PDF)"> 📎</span>}</td><td className="buyer">{r.supplierName}</td><td>{r.supplierNumber}</td>
              <td>{date(r.receivedDate)}</td><td>{date(r.dueDate)}</td>
              <td className="num">{money(r.netTotal)}</td><td className="num">{money(r.vatTotal)}</td><td className="num">{money(r.grossTotal)}</td>
              <td><span className={`chip ${r.status === "posted" ? "ok" : r.status === "voided" ? "err" : "st-draft"}`}>{STATUS[r.status]}</span></td>
            </tr>))}</tbody>
          <tfoot><tr><td colSpan={7}>Прокнижени: {rows.filter((r) => r.status === "posted").length}</td><td className="num">{money(sum)}</td><td /></tr></tfoot>
        </table></div>
      )}
    </>
  );
}

/* ------------------------------------------------- uvoz na e-fakturi (JSON od UJP format) */
const readText = (f: File) => new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = bad; r.readAsText(f, "utf-8"); });
export const readB64 = (f: File) => new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, "")); r.onerror = bad; r.readAsDataURL(f); });
const isPdf = (f: File) => /\.pdf$/i.test(f.name) || f.type === "application/pdf";
const digitRuns = (s: string) => s.match(/\d{6,}/g) ?? [];
/** PDF кон JSON: ако има по еден – заедно; инаку по ист број (≥ 6 цифри) во имињата или бројот на фактурата во името на PDF. */
function pairFiles(jsons: { f: File; text: string }[], pdfs: File[]) {
  const used = new Set<File>();
  const pairs = jsons.map((j) => {
    let pdf: File | undefined;
    if (jsons.length === 1 && pdfs.length === 1) pdf = pdfs[0];
    else {
      let num = ""; try { const o = JSON.parse(j.text); num = String((o.document ?? o).header?.docNumber ?? "").replace(/\D/g, ""); } catch { /* server ke kaze */ }
      const runs = [...digitRuns(j.f.name), ...(num.length >= 6 ? [num] : [])];
      pdf = pdfs.find((p) => !used.has(p) && runs.some((r) => p.name.replace(/\D/g, "").includes(r) || digitRuns(p.name).some((x) => x.includes(r) || r.includes(x))));
    }
    if (pdf) used.add(pdf);
    return { ...j, pdf };
  });
  return { pairs, loose: pdfs.filter((p) => !used.has(p)) };
}
interface ImportRes { id: number; supplierNumber: string; supplier: { name: string; created: boolean }; payableAmount: string; lines: number; mapped: number; warnings: string[] }

function ImportPanel({ client, onDone }: { client: ClientRef; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ file: string; ok: boolean; text: string; warnings?: string[]; id?: number }[]>([]);
  async function upload(list: FileList) {
    setBusy(true); setRes([]);
    const files = [...list];
    const jsons = await Promise.all(files.filter((f) => !isPdf(f)).map(async (f) => ({ f, text: await readText(f) })));
    const { pairs, loose } = pairFiles(jsons, files.filter(isPdf));
    const out: typeof res = [];
    for (const j of pairs) {
      try {
        if (j.pdf && j.pdf.size > 8 * 1024 * 1024) throw new Error(`PDF ${j.pdf.name} е поголем од 8 MB.`);
        const r = await api.post<ImportRes>(`/api/clients/${client.id}/purchases/import-ujp`,
          { text: j.text, fileName: j.f.name, pdf: j.pdf ? { name: j.pdf.name, base64: await readB64(j.pdf) } : null });
        out.push({ file: j.f.name, ok: true, id: r.id, warnings: r.warnings,
          text: `${r.supplier.name}${r.supplier.created ? " (нов добавувач)" : ""}, фактура ${r.supplierNumber}, за плаќање ${money(r.payableAmount)} ден., ${r.lines} ставки` +
            `${r.mapped ? `, ${r.mapped} поврзани со артикл` : ""}${j.pdf ? ", со PDF" : ", без PDF"}. Внесена како нацрт.` });
      } catch (e) { out.push({ file: j.f.name, ok: false, text: (e as Error).message }); }
    }
    for (const p of loose) out.push({ file: p.name, ok: false, text: "PDF без JSON: увезете го заедно со неговиот JSON или прикачете го во отворената фактура." });
    setRes(out); setBusy(false); onDone();
  }
  return (
    <section className="panel stack">
      <h2>Увоз на е-фактура</h2>
      <div className="row-actions upload-row">
        <label className="drop">JSON од добавувачот (формат на УЈП е-Фактура), заедно со PDF-от. Може повеќе одеднаш.
          <input type="file" multiple accept=".json,.jws,.txt,.pdf,application/json,application/pdf" disabled={busy}
            onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ""; }} /></label>
      </div>
      <p className="muted small">Фирмата се проверува по ЕДБ на купувачот, добавувачот се наоѓа по ЕДБ (ако го нема, се додава). Износите се земаат од фактурата, не се пресметуваат одново.
        Фактурата влегува како нацрт: изберете артикли за стоката и прокнижете. Следниот пат истите ставки од истиот добавувач се поврзуваат сами.</p>
      {busy && <p className="muted">Се увезува…</p>}
      {res.map((r, i) => (
        <div key={i} className={r.ok ? "notice" : "alert"}>
          <strong>{r.file}</strong>: {r.text} {r.id && <Link to={`/c/${client.id}/purchases/${r.id}`}>Отвори</Link>}
          {r.warnings?.map((w, k) => <div key={k} className="small">⚠ {w}</div>)}
        </div>))}
    </section>
  );
}

const blank = (vat: number): PLine => ({ itemId: null, description: "", unit: "ком", qty: "1", unitPrice: "0", discountPct: "0", vatRateId: vat, allocate: false, lotNo: "", expiryDate: "" });

export function PurchaseEditor() {
  const client = useOutletContext<ClientRef>();
  const { id } = useParams();
  const nav = useNavigate();
  const stock = client.modules.includes("warehouse");
  const [p, setP] = useState<Purchase | null>(null);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [itemsList, setItems] = useState<Item[]>([]);
  const [rates, setRates] = useState<VatRate[]>([]);
  const [whs, setWhs] = useState<Warehouse[]>([]);
  const [allPartners, setAllPartners] = useState(false);
  const [head, setHead] = useState({ partnerId: "" as number | "", supplierNumber: "", issueDate: today(), receivedDate: today(), dueDate: "", warehouseId: "" as number | "", note: "" });
  const [lines, setLines] = useState<PLine[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState(false);

  async function load(pid = id) {
    if (!pid || pid === "new") return;
    const x = await api.get<Purchase>(`/api/clients/${client.id}/purchases/${pid}`);
    setP(x);
    setHead({ partnerId: x.partnerId, supplierNumber: x.supplierNumber, issueDate: x.issueDate, receivedDate: x.receivedDate, dueDate: x.dueDate ?? "",
      warehouseId: x.warehouseId ?? "", note: x.note ?? "" });
    setLines(x.lines.map((l) => ({ ...l, qty: String(Number(l.qty)), unitPrice: String(Number(l.unitPrice)), discountPct: String(Number(l.discountPct)),
      lotNo: l.lotNo ?? "", expiryDate: l.expiryDate ?? "" })));
  }
  useEffect(() => {
    void Promise.all([api.get<Partner[]>(`/api/clients/${client.id}/partners`).then(setPartners), api.get<Item[]>(`/api/clients/${client.id}/items`).then(setItems),
      api.get<Warehouse[]>(`/api/clients/${client.id}/warehouses`).then(setWhs),
      api.get<VatRate[]>("/api/vat-rates").then((r) => { setRates(r); if (!id || id === "new") setLines([blank(r.find((x) => x.code === "S18")?.id ?? r[0]!.id)]); })]);
    void load().catch((e) => setMsg({ kind: "err", text: (e as ApiError).message }));
  }, [client.id, id]);

  const editable = !p || p.status === "draft";
  const fixed = !!p?.fixedAmounts;           // uvezena e-faktura: iznosite se od dokumentot
  const free = editable && !fixed;          // polinja sto se menuvaat samo kaj racen vnes
  const itemOf = (iid: number | null) => itemsList.find((i) => i.id === iid);
  const isStock = (l: PLine) => stock && !!l.itemId && STOCK_TYPES.includes(itemOf(l.itemId)?.type ?? "");
  const calc = useMemo(() => lines.map((l) => {
    const r = rates.find((x) => x.id === l.vatRateId);
    return { ...calcLine({ qty: Number(l.qty) || 0, unitPrice: Number(l.unitPrice) || 0, discountPct: Number(l.discountPct) || 0, vatRatePct: r?.ratePct ?? 0 }), vatRatePct: r?.ratePct ?? 0 };
  }), [lines, rates]);
  const totals = calcTotals(calc);
  const set = (i: number, k: keyof PLine, v: unknown) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  function pickItem(i: number, iid: string) {
    const it = itemOf(Number(iid));
    if (p?.fixedAmounts) { setLines((ls) => ls.map((l, j) => (j !== i ? l : { ...l, itemId: it?.id ?? null, allocate: it && it.type !== "service" ? false : l.allocate }))); return; }
    setLines((ls) => ls.map((l, j) => (j !== i ? l : it ? { ...l, itemId: it.id, description: it.name, unit: it.unit, vatRateId: it.vatRateId, allocate: it.type === "service" ? l.allocate : false }
      : { ...l, itemId: null })));
  }

  async function save(): Promise<number | null> {
    if (!head.partnerId) { setMsg({ kind: "err", text: "Изберете добавувач." }); return null; }
    const body = { ...head, partnerId: Number(head.partnerId), warehouseId: head.warehouseId || null, dueDate: head.dueDate || null, version: p?.version,
      lines: lines.filter((l) => l.description.trim()).map((l) => ({ ...l, qty: Number(String(l.qty).replace(",", ".")), unitPrice: Number(String(l.unitPrice).replace(",", ".")),
        discountPct: Number(l.discountPct) || 0, lotNo: l.lotNo || null, expiryDate: l.expiryDate || null })) };
    setBusy(true); setMsg(null);
    try {
      if (p) { await api.put(`/api/clients/${client.id}/purchases/${p.id}`, body); await load(String(p.id)); setMsg({ kind: "ok", text: "Нацртот е зачуван." }); return p.id; }
      const r = await api.post<{ id: number }>(`/api/clients/${client.id}/purchases`, body);
      nav(`../${r.id}`, { relative: "path", replace: true });
      return r.id;
    } catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); return null; } finally { setBusy(false); }
  }
  async function post() {
    const pid = await save(); if (!pid) return;
    setBusy(true);
    try {
      const r = await api.post<{ number: string; receiptNumber: string | null }>(`/api/clients/${client.id}/purchases/${pid}/post`);
      await load(String(pid));
      setMsg({ kind: "ok", text: `Прокнижена како ${r.number}.${r.receiptNumber ? ` Стоката е примена со приемница ${r.receiptNumber}.` : ""}` });
    } catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); } finally { setBusy(false); }
  }

  const supplier = partners.find((x) => x.id === head.partnerId);
  return (
    <>
      <header className="page-head">
        <div><Link to={p ? "../../purchases" : "../purchases"} relative="path" className="back">← Влезни фактури</Link>
          <h1>{p?.number ?? (p ? "Нацрт" : "Нова влезна фактура")}</h1></div>
        {p && <div className="head-state"><span className={`chip ${p.status === "posted" ? "ok" : p.status === "voided" ? "err" : "st-draft"}`}>{STATUS[p.status]}</span></div>}
      </header>
      {msg && <p className={msg.kind === "ok" ? "notice" : "alert"} role={msg.kind === "err" ? "alert" : "status"}>{msg.text}</p>}
      {p?.status === "voided" && <p className="alert">Сторнирана: {p.voidReason}</p>}
      {fixed && editable && <p className="notice">Увезена е-фактура: добавувачот, бројот, датумите и износите се од документот и не се менуваат.
        Изберете артикл за стоката (за магацин) или оставете „без артикл“ за трошок, па прокнижете.</p>}

      <section className="doc">
        <div className="doc-head">
          <label className="span2">Добавувач
            {free ? <select value={head.partnerId} onChange={(e) => setHead({ ...head, partnerId: e.target.value ? Number(e.target.value) : "" })} required>
              <option value="">— изберете —</option>
              {partners.filter((x) => (x.isActive && (allPartners || x.isSupplier)) || x.id === head.partnerId).map((x) => <option key={x.id} value={x.id}>{x.name}{x.edb ? ` (${x.edb})` : ""}</option>)}
            </select> : <output>{supplier?.name}</output>}
            {free && partners.some((x) => x.isActive && !x.isSupplier) && <label className="check small"><input type="checkbox" checked={allPartners} onChange={(e) => setAllPartners(e.target.checked)} /> прикажи ги и купувачите</label>}
            {free && <small className="muted">Нов добавувач се додава во <Link to={`/c/${client.id}/partners`}>Партнери</Link>, од регистарот на УЈП.</small>}
          </label>
          <label>Број кај добавувачот{free ? <input value={head.supplierNumber} onChange={(e) => setHead({ ...head, supplierNumber: e.target.value })} required maxLength={60} /> : <output>{head.supplierNumber}</output>}</label>
          <label>Датум на фактурата{free ? <input type="date" value={head.issueDate} onChange={(e) => setHead({ ...head, issueDate: e.target.value })} /> : <output>{date(head.issueDate)}</output>}</label>
          <label>Датум на прием{editable ? <input type="date" value={head.receivedDate} onChange={(e) => setHead({ ...head, receivedDate: e.target.value })} /> : <output>{date(head.receivedDate)}</output>}</label>
          <label>Рок за плаќање{editable ? <input type="date" value={head.dueDate} onChange={(e) => setHead({ ...head, dueDate: e.target.value })} /> : <output>{date(head.dueDate)}</output>}</label>
          {stock && whs.filter((w) => w.isActive).length > 1 && <label>Магацин{editable ? <select value={head.warehouseId} onChange={(e) => setHead({ ...head, warehouseId: e.target.value ? Number(e.target.value) : "" })}>
            <option value="">Главен</option>{whs.filter((w) => w.isActive && !w.isDefault).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
            : <output>{whs.find((w) => w.id === p?.warehouseId)?.name ?? "Главен"}</output>}</label>}
        </div>

        <div className="table-wrap"><table className="grid lines">
          <thead><tr><th className="c-no">#</th><th className="c-item">Артикл / опис</th><th className="c-unit">Ед.</th><th className="c-qty num">Кол.</th><th className="c-price num">Цена без ДДВ</th>
            <th className="c-disc num">Попуст %</th><th className="c-vat">ДДВ</th><th className="c-amt num">Основица</th>{free && <th className="c-x" />}</tr></thead>
          <tbody>{lines.map((l, i) => {
            const it = itemOf(l.itemId);
            return (
              <tr key={i}>
                <td className="c-no">{i + 1}</td>
                <td className="c-item">
                  {editable ? <>
                    <select value={l.itemId ?? ""} onChange={(e) => pickItem(i, e.target.value)} aria-label={`Артикл ${i + 1}`}>
                      <option value="">— без артикл (трошок) —</option>{itemsList.filter((x) => x.isActive || x.id === l.itemId).map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select>
                    {fixed ? <span className="src">{l.description}</span>
                      : <input value={l.description} onChange={(e) => set(i, "description", e.target.value)} placeholder="Опис" aria-label={`Опис ${i + 1}`} />}
                  </> : <>{l.description}</>}
                  {isStock(l) && it?.trackLots && (editable
                    ? <div className="lot-row"><input value={l.lotNo} onChange={(e) => set(i, "lotNo", e.target.value)} placeholder="Лот" aria-label="Лот" />
                        <input type="date" value={l.expiryDate} onChange={(e) => set(i, "expiryDate", e.target.value)} aria-label="Рок на траење" /></div>
                    : <span className="src">лот {l.lotNo}{l.expiryDate ? `, рок ${date(l.expiryDate)}` : ""}</span>)}
                  {!isStock(l) && (editable
                    ? <label className="check small"><input type="checkbox" checked={l.allocate} onChange={(e) => set(i, "allocate", e.target.checked)} /> Зависен трошок (се распоредува во набавната цена)</label>
                    : l.allocate && <span className="src">зависен трошок</span>)}
                  {!editable && l.unitCost && <span className="src">набавна цена {money(l.unitCost)}</span>}
                </td>
                <td className="c-unit">{free ? <input value={l.unit} onChange={(e) => set(i, "unit", e.target.value)} /> : l.unit}</td>
                <td className="c-qty num">{free ? <input inputMode="decimal" value={l.qty} onChange={(e) => set(i, "qty", e.target.value)} /> : Number(l.qty)}</td>
                <td className="c-price num">{free ? <input inputMode="decimal" value={l.unitPrice} onChange={(e) => set(i, "unitPrice", e.target.value)} /> : money(l.unitPrice)}</td>
                <td className="c-disc num">{free ? <input inputMode="decimal" value={l.discountPct} onChange={(e) => set(i, "discountPct", e.target.value)} /> : Number(l.discountPct)}</td>
                <td className="c-vat">{free ? <select value={l.vatRateId} onChange={(e) => set(i, "vatRateId", Number(e.target.value))}>
                  {rates.filter((r) => r.isActive).map((r) => <option key={r.id} value={r.id}>{Number(r.ratePct)}%</option>)}</select> : `${Number(rates.find((r) => r.id === l.vatRateId)?.ratePct ?? 0)}%`}</td>
                <td className="c-amt num">{money(fixed ? (p!.lines[i]?.netAmount) : calc[i]?.netAmount)}</td>
                {free && <td className="c-x"><button className="icon" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label={`Избриши ставка ${i + 1}`}>×</button></td>}
              </tr>);
          })}</tbody>
        </table></div>
        {free && <button className="btn add-line" onClick={() => setLines([...lines, blank(rates.find((x) => x.code === "S18")?.id ?? rates[0]!.id)])}>Додај ставка</button>}

        <div className="doc-foot">
          <div className="stack">
            <label>Забелешка{editable ? <textarea rows={2} value={head.note} onChange={(e) => setHead({ ...head, note: e.target.value })} /> : <output>{head.note || "–"}</output>}</label>
            {p && p.stockDocs.length > 0 && <p className="small">Магацин: {p.stockDocs.map((d, i) => <span key={d.id}>{i > 0 && ", "}<Link to={`/c/${client.id}/stock/docs/${d.id}`}>{d.number}</Link>
              {d.reversesDocId ? " (сторно)" : ` (${STOCK_KIND[d.kind]})`}</span>)}</p>}
            {editable && stock && <p className="muted small">При книжење, ставките со артикл што води залиха влегуваат во магацин по набавна цена. Зависните трошоци (превоз, царина) се распоредуваат по вредноста на стоката.</p>}
          </div>
          <dl className="totals">
            <div><dt>Основица</dt><dd>{money(free ? totals.netTotal : p!.netTotal)}</dd></div>
            <div><dt>ДДВ</dt><dd>{money(free ? totals.vatTotal : p!.vatTotal)}</dd></div>
            <div className="payable"><dt>Вкупно</dt><dd>{money(free ? totals.grossTotal : p!.grossTotal)} <span>ден.</span></dd></div>
            {p?.payableAmount && Number(p.payableAmount) !== Number(p.grossTotal) && <div><dt>За плаќање</dt><dd>{money(p.payableAmount)}</dd></div>}
          </dl>
        </div>
      </section>

      {p && <Files client={client} p={p} onChange={() => void load(String(p.id))} />}
      {voiding && p && <VoidForm client={client} id={p.id} onDone={async (ok) => { setVoiding(false); if (ok) { await load(String(p.id)); setMsg({ kind: "ok", text: ok }); } }} />}
      <div className="actions">
        {editable && <><button className="btn" disabled={busy} onClick={() => void save()}>Зачувај нацрт</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void post()}>Прокнижи</button>
          {p && <button className="btn btn-quiet" disabled={busy} onClick={async () => {
            try { await api.del(`/api/clients/${client.id}/purchases/${p.id}`); nav("../../purchases", { relative: "path" }); } catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); } }}>Избриши нацрт</button>}</>}
        {p?.status === "posted" && !voiding && <button className="btn" onClick={() => setVoiding(true)}>Сторнирај</button>}
      </div>
    </>
  );
}

function VoidForm({ client, id, onDone }: { client: ClientRef; id: number; onDone: (msg: string | null) => void }) {
  const [reason, setReason] = useState("");
  const [d, setD] = useState(today());
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    try {
      const r = await api.post<{ warnings: string[] }>(`/api/clients/${client.id}/purchases/${id}/void`, { reason, date: d });
      onDone(`Сторнирана.${r.warnings.length ? ` Предупредување: ${r.warnings.join(" ")}` : ""}`);
    } catch (e) { setErr((e as ApiError).message); }
  }
  return (
    <section className="panel stack">
      <h2>Сторно на влезна фактура</h2>
      <p className="muted small">Ако стоката е примена во магацин, се враќа по истата набавна цена. Ако е веќе продадена, важи правилото за залиха во минус од поставките.</p>
      <div className="row-actions"><label className="grow">Причина<input value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} /></label>
        <label>Датум<input type="date" value={d} onChange={(e) => setD(e.target.value)} /></label></div>
      {err && <p className="alert">{err}</p>}
      <div className="row-actions"><button className="btn btn-primary" disabled={reason.trim().length < 3} onClick={go}>Сторнирај</button><button className="link" onClick={() => onDone(null)}>Откажи</button></div>
    </section>
  );
}

function Files({ client, p, onChange }: { client: ClientRef; p: Purchase; onChange: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/clients/${client.id}/purchases/${p.id}/files`;
  async function add(f: File) {
    setErr(null);
    if (f.size > 8 * 1024 * 1024) { setErr("Прилогот е поголем од 8 MB."); return; }
    setBusy(true);
    try { await api.post(base, { name: f.name, base64: await readB64(f) }); onChange(); } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); }
  }
  return (
    <section className="panel stack">
      <h2>Прилози</h2>
      {p.files.length === 0 && <p className="muted small">Нема прилог. Прикачете го PDF-от од добавувачот.</p>}
      {p.files.length > 0 && <ul className="plain">{p.files.map((f) => (
        <li key={f.id}><a href={`${base}/${f.id}`} target="_blank" rel="noreferrer">{f.fileName}</a> <span className="muted small">{Math.max(1, Math.round(f.size / 1024))} KB</span>
          {p.status === "draft" && <> <button className="link danger" onClick={async () => { try { await api.del(`${base}/${f.id}`); onChange(); } catch (e) { setErr((e as ApiError).message); } }}>Отстрани</button></>}</li>))}
      </ul>}
      {p.status !== "voided" && <label className="drop">Додај прилог (PDF, JPG, PNG, до 8 MB)
        <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/*" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void add(f); e.target.value = ""; }} /></label>}
      {err && <p className="alert">{err}</p>}
    </section>
  );
}
