import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { calcLine, calcTotals } from "@calc";
import { api, ApiError, type CostCenter, type ClientRef, type DocType, type Invoice, type Item, type Line, type Partner, type VatRate, type Warehouse } from "../api";
import { GRADE, GradeChip, useScore } from "../components/Score";
import { DOC, PAYMENT, addDays, date, money, money0, parseNum, today, statusOf } from "../format";
import { UjpState } from "../components/UjpState";
import { RecurringForm } from "./Recurring";

interface Head { partnerId: number | ""; docType: DocType; issueDate: string; supplyDate: string; dueDate: string;
  paymentMethod: string; note: string; reason: string; voidCode: string; corrCode: string; advanceId: number | ""; advanceAmount: string; warehouseId: number | ""; costCenterId: number | "" }
interface Reason { code: string; name: string; kind: "void" | "correction" }
interface Advance { id: number; number: string; issueDate: string; grossTotal: string; remaining: string }
const DERIVED: DocType[] = ["ST", "OD", "KZ", "KR"];
/** "250.5000" -> "250.5"; kolicinata bez znak (znakot go dava vidot na dokumentot). */
const toEdit = (l: Line): EditLine => ({ ...l, key: ++seq, itemId: l.itemId ?? null, qty: String(Math.abs(Number(l.qty))),
  unitPrice: String(Number(l.unitPrice)), discountPct: String(Number(l.discountPct)) });
const signOf = (d: DocType): 1 | -1 => (d === "OD" || d === "ST" ? -1 : 1);
type EditLine = Omit<Line, "itemId"> & { key: number; itemId: number | null };
let seq = 0;
const blankLine = (vatRateId: number): EditLine => ({ key: ++seq, itemId: null, description: "", unit: "ком", qty: "1",
  unitPrice: "0", discountPct: "0", vatRateId, priceSource: null });

export function InvoiceEditor() {
  const client = useOutletContext<ClientRef>();
  const { id } = useParams();
  const nav = useNavigate();
  const [partners, setPartners] = useState<Partner[]>([]);
  const [allPartners, setAllPartners] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [rates, setRates] = useState<VatRate[]>([]);
  const [inv, setInv] = useState<Invoice | null>(null);
  const [head, setHead] = useState<Head>({ partnerId: Number(new URLSearchParams(window.location.search).get("partner")) || "", docType: new URLSearchParams(window.location.search).get("type") === "PF" ? "PF" : "INV", issueDate: today(), supplyDate: today(),
    dueDate: addDays(today(), 15), paymentMethod: "bank", note: "", reason: "", voidCode: "", corrCode: "", advanceId: "", advanceAmount: "", warehouseId: "", costCenterId: "" });
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [whs, setWhs] = useState<Warehouse[]>([]);
  useEffect(() => { if (client.modules.includes("warehouse")) api.get<Warehouse[]>(`/api/clients/${client.id}/warehouses`).then(setWhs); else setWhs([]); }, [client.id]);
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [lines, setLines] = useState<EditLine[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirmIssue, setConfirmIssue] = useState(false);
  const [recurOpen, setRecurOpen] = useState(false);
  // trosковni mesta (docs/14)
  const ccMode = client.costCenterMode ?? "off";
  const [ccs, setCcs] = useState<CostCenter[]>([]);
  const [ccLines, setCcLines] = useState(false);
  const [ccDirty, setCcDirty] = useState(false);
  useEffect(() => { if (ccMode !== "off") api.get<CostCenter[]>(`/api/clients/${client.id}/cost-centers`).then(setCcs); }, [client.id, ccMode]);

  useEffect(() => {
    Promise.all([
      api.get<Partner[]>(`/api/clients/${client.id}/partners`), api.get<Item[]>(`/api/clients/${client.id}/items`),
      api.get<VatRate[]>("/api/vat-rates"), id ? api.get<Invoice>(`/api/invoices/${id}`) : Promise.resolve(null),
      api.get<Reason[]>("/api/ujp-reasons"),
    ]).then(([p, it, r, i, rs]) => {
      setPartners(p); setItems(it); setRates(r); setInv(i); setReasons(rs); setLoaded(true);
      if (i) {
        setHead({ partnerId: i.partnerId, docType: i.docType, issueDate: i.issueDate,
          supplyDate: i.supplyDate ?? i.issueDate, dueDate: i.dueDate ?? "", paymentMethod: i.paymentMethod, note: i.note ?? "",
          reason: i.correctionReason ?? "", voidCode: i.voidReasonCode ?? "", corrCode: i.correctionReasonCode ?? "",
          advanceId: i.advanceInvoiceId ?? "", advanceAmount: i.advanceAmount ? String(Number(i.advanceAmount)) : "", warehouseId: i.warehouseId ?? "", costCenterId: i.costCenterId ?? "" });
        setLines(i.lines.map(toEdit));
        setCcLines(i.lines.some((l) => l.costCenterId));
      } else {
        // ?item=ID (od „Артикли“): prva stavka so toj artikl i negovata standardna cena
        const pre = it.find((x) => x.id === Number(new URLSearchParams(window.location.search).get("item")) && x.isActive);
        setLines(pre ? [{ ...blankLine(pre.vatRateId), itemId: pre.id, description: pre.name, unit: pre.unit, unitPrice: Number(pre.unitPrice).toString(), priceSource: "Стандардна цена" }] : []);
      }
      setDirty(false);
    }).catch((e) => setMsg({ kind: "err", text: e.message }));
  }, [client.id, id]);

  const editable = !inv || inv.status === "draft";
  const sign = signOf(head.docType);
  const linesEditable = editable && head.docType !== "ST";
  const canAdvance = head.docType === "INV" || head.docType === "KR";

  useEffect(() => {
    if (!editable || !canAdvance || !head.partnerId) return setAdvances([]);
    const q = new URLSearchParams({ partnerId: String(head.partnerId), ...(inv ? { excludeInvoiceId: String(inv.id) } : {}) });
    api.get<Advance[]>(`/api/clients/${client.id}/advances?${q}`).then(setAdvances).catch(() => setAdvances([]));
  }, [client.id, head.partnerId, editable, canAdvance, inv]);
  const rateById = useMemo(() => new Map(rates.map((r) => [r.id, r])), [rates]);
  const defaultRate = rates.find((r) => r.code === "S18")?.id ?? rates[0]?.id ?? 0;

  const computed = useMemo(() => lines.map((l) => {
    const pct = rateById.get(l.vatRateId)?.ratePct ?? l.vatRatePct ?? "0";
    try { return { ...calcLine({ qty: l.qty || 0, unitPrice: l.unitPrice || 0, discountPct: l.discountPct || 0, vatRatePct: pct }, sign), vatRatePct: pct }; }
    catch { return { unitNet: "0", netAmount: "0", vatAmount: "0", vatRatePct: pct }; }
  }), [lines, rateById, sign]);
  const totals = editable ? calcTotals(computed, canAdvance && head.advanceId ? Number(head.advanceAmount || 0).toFixed(2) : 0) : null;

  const set = <K extends keyof Head>(k: K, v: Head[K]) => { setHead((h) => ({ ...h, [k]: v })); setDirty(true); };
  const setLine = (key: number, patch: Partial<EditLine>) => { setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l))); setDirty(true); };

  async function pickItem(key: number, itemId: number) {
    const it = items.find((x) => x.id === itemId);
    if (!it) return setLine(key, { itemId: null });
    setLine(key, { itemId, description: it.name, unit: it.unit, vatRateId: it.vatRateId, unitPrice: Number(it.unitPrice).toString(), priceSource: "Стандардна цена" });
    if (head.partnerId) {
      const q = new URLSearchParams({ partnerId: String(head.partnerId), itemId: String(itemId), date: head.issueDate, ...(inv ? { excludeInvoiceId: String(inv.id) } : {}) });
      const s = await api.get<{ price: string; source: string }>(`/api/clients/${client.id}/price?${q}`).catch(() => null);
      if (s) setLine(key, { unitPrice: Number(s.price).toString(), priceSource: s.source });
    }
  }

  /** Po izdavanje: samo TM (docs/14), so revizija. */
  async function saveCostCenter() {
    if (!inv) return;
    setBusy(true); setMsg(null);
    try {
      await api.post(`/api/invoices/${inv.id}/cost-center`, { costCenterId: head.costCenterId || null,
        lines: lines.filter((l) => l.id).map((l) => ({ id: l.id!, costCenterId: ccLines ? l.costCenterId ?? null : null })) });
      setCcDirty(false); setMsg({ kind: "ok", text: "Трошковното место е зачувано." });
    } catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); } finally { setBusy(false); }
  }

  function payload() {
    return {
      partnerId: Number(head.partnerId), docType: head.docType, issueDate: head.issueDate,
      supplyDate: head.docType === "AV" ? null : head.supplyDate || head.issueDate, dueDate: head.dueDate || null,
      paymentMethod: head.paymentMethod, note: head.note || null, version: inv?.version, warehouseId: head.warehouseId || null,
      costCenterId: head.costCenterId || null,
      correctionReason: head.reason || null, voidReasonCode: head.voidCode || null, correctionReasonCode: head.corrCode || null,
      advanceInvoiceId: canAdvance && head.advanceId ? head.advanceId : null,
      advanceAmount: canAdvance && head.advanceId ? Number(head.advanceAmount || 0) : null,
      lines: realLines().map((l) => ({ itemId: l.itemId, description: l.description.trim(), unit: l.unit, qty: parseNum(l.qty),
        unitPrice: parseNum(l.unitPrice), discountPct: parseNum(l.discountPct || "0"), vatRateId: l.vatRateId, priceSource: l.priceSource,
        stockDocId: l.stockDocId ?? null, costCenterId: ccLines ? l.costCenterId ?? null : null })),
    };
  }

  /** Prazni redovi (bez opis, artikl i cena) ne se prakjaat. */
  const realLines = () => lines.filter((l) => l.description.trim() || l.itemId || parseNum(l.unitPrice) > 0);
  /** Proverka pred zacuvuvanje, so jasna poraka po stavka (ne "Неисправни податоци"). */
  function check(): string | null {
    if (!head.partnerId) return partners.length ? "Изберете купувач." : "Оваа фирма уште нема купувачи. Додајте купувач во „Партнери“ (од регистарот на УЈП или рачно).";
    const errs: string[] = [];
    realLines().forEach((l, i) => {
      const n = `Ставка ${i + 1}`;
      if (!l.description.trim()) errs.push(`${n}: внесете опис.`);
      if (!l.unit.trim()) errs.push(`${n}: внесете единечна мерка.`);
      if (!(parseNum(l.qty) > 0)) errs.push(`${n}: количината мора да е број поголем од 0 („${l.qty}“).`);
      if (Number.isNaN(parseNum(l.unitPrice)) || parseNum(l.unitPrice) < 0) errs.push(`${n}: цената не е број („${l.unitPrice}“).`);
      if (Number.isNaN(parseNum(l.discountPct || "0"))) errs.push(`${n}: попустот не е број.`);
      if (!l.vatRateId) errs.push(`${n}: изберете ДДВ стапка.`);
    });
    return errs.length ? errs.join(" ") : null;
  }

  async function save(): Promise<number | null> {
    const problem = check();
    if (problem) { setMsg({ kind: "err", text: problem }); return null; }
    setBusy(true); setMsg(null);
    try {
      let invId = inv?.id;
      if (invId) await api.put(`/api/invoices/${invId}`, payload());
      else invId = (await api.post<{ id: number }>(`/api/clients/${client.id}/invoices`, payload())).id;
      const fresh = await api.get<Invoice>(`/api/invoices/${invId}`);
      setInv(fresh); setLines(fresh.lines.map(toEdit)); setDirty(false);
      if (!inv) nav(`/c/${client.id}/invoices/${invId}`, { replace: true });
      setMsg({ kind: "ok", text: "Нацртот е зачуван." });
      return invId;
    } catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); return null; }
    finally { setBusy(false); }
  }

  async function issue() {
    const invId = dirty || !inv ? await save() : inv.id;
    if (!invId) return;
    setBusy(true);
    try {
      const r = await api.post<{ number: string; stockDocNumber: string | null; stockWarnings: string[] }>(`/api/invoices/${invId}/issue`);
      setInv(await api.get<Invoice>(`/api/invoices/${invId}`));
      setMsg({ kind: r.stockWarnings?.length ? "err" : "ok", text: `Издаден е документ ${r.number}.${r.stockDocNumber ? ` Испратница ${r.stockDocNumber}.` : ""}`
        + `${r.stockWarnings?.length ? ` Предупредување: ${r.stockWarnings.join(" ")}` : ""}${head.docType === "PF" ? " Понудата не се праќа на УЈП; кога купувачот ќе ја прифати, „Направи фактура“." : " Агентот ќе го потпише и прати до УЈП."}` });
    } catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); }
    finally { setBusy(false); setConfirmIssue(false); }
  }

  async function cancelDraft() {
    if (!inv) return nav(`/c/${client.id}/invoices`);
    setBusy(true);
    try { await api.post(`/api/invoices/${inv.id}/cancel`); nav(`/c/${client.id}/invoices`); }
    catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); setBusy(false); }
  }

  async function copy(as: "same" | "INV") {
    if (!inv) return;
    setBusy(true);
    try { const r = await api.post<{ id: number }>(`/api/invoices/${inv.id}/copy`, { as }); nav(`/c/${client.id}/invoices/${r.id}`); }
    catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); }
    finally { setBusy(false); }
  }
  async function cancelQuote() {
    if (!inv) return;
    setBusy(true);
    try { await api.post(`/api/invoices/${inv.id}/cancel`); setInv(await api.get<Invoice>(`/api/invoices/${inv.id}`)); setMsg({ kind: "ok", text: "Понудата е откажана." }); }
    catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); }
    finally { setBusy(false); }
  }

  async function derive(docType: DocType) {
    if (!inv) return;
    setBusy(true);
    try {
      const r = await api.post<{ id: number }>(`/api/invoices/${inv.id}/derive`, { docType });
      nav(`/c/${client.id}/invoices/${r.id}`);
    } catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); }
    finally { setBusy(false); }
  }

  const partner = partners.find((p) => p.id === head.partnerId);
  const newAmount = totals ? Number(totals.payableAmount ?? totals.grossTotal ?? 0) : 0;
  const score = useScore(client.id, head.partnerId, inv?.status === "draft" || !inv ? newAmount : 0, client.modules.includes("payments") && ["INV", "AV", "KZ", "KR"].includes(head.docType));
  const isDerived = DERIVED.includes(head.docType);
  const canDerive = inv && !editable && (inv.docType === "INV" || inv.docType === "KR") && ["issued", "json_exported", "sent_to_ujp"].includes(inv.status);
  const shown = editable ? totals : inv && { netTotal: inv.netTotal, vatTotal: inv.vatTotal, grossTotal: inv.grossTotal,
    payableAmount: inv.payableAmount ?? String(Math.round(Number(inv.grossTotal))), byRate: inv.byRate };

  return (
    <>
      <header className="page-head">
        <div>
          <Link to={inv ? "../../invoices" : "../invoices"} relative="path" className="back">← Фактури</Link>
          <h1>{inv?.number ?? (inv ? "Нацрт" : head.docType === "PF" ? "Нова понуда" : "Нова фактура")}{inv && inv.docType !== "INV" && <span className="doctype">{DOC[inv.docType]}</span>}</h1>
        </div>
        {inv && <div className="head-state"><span className={`chip st-${inv.status}`}>{statusOf(inv.docType, inv.status)}</span>{inv.docType !== "PF" && <UjpState r={inv} />}
          <a className="btn" href={`/api/invoices/${inv.id}/pdf`} target="_blank" rel="noopener" onClick={(e) => { if (dirty) { e.preventDefault(); setMsg({ kind: "err", text: "Прво зачувајте ги промените, па отворете PDF." }); } }}>PDF</a></div>}
      </header>
      {msg && <p className={msg.kind === "ok" ? "notice" : "alert"} role={msg.kind === "err" ? "alert" : "status"}>{msg.text}</p>}
      {editable && score && score.warnings.length > 0 && <div className="alert" role="status"><strong>Внимание за купувачот:</strong> {score.warnings.join(" ")}
        <span className="muted small"> Фактурата може да се издаде; ова е само предупредување.</span></div>}
      {inv?.ujpError && <p className="alert">УЈП: {inv.ujpError}</p>}

      <section className="doc">
        <div className="doc-head">
          <label className="span2">Купувач
            {editable && !isDerived ? (
              <select value={head.partnerId} onChange={(e) => set("partnerId", e.target.value ? Number(e.target.value) : "")} required>
                <option value="">— изберете —</option>
                {partners.filter((p) => (p.isActive && (allPartners || p.isCustomer)) || p.id === head.partnerId).map((p) => <option key={p.id} value={p.id}>{p.name}{p.edb ? ` (${p.edb})` : ""}</option>)}
              </select>
            ) : <output>{inv?.buyerName}</output>}
            {editable && !isDerived && partners.some((p) => p.isActive && !p.isCustomer) && <label className="check small"><input type="checkbox" checked={allPartners} onChange={(e) => setAllPartners(e.target.checked)} /> прикажи ги и добавувачите</label>}
            {editable && !isDerived && loaded && !partners.some((p) => p.isActive && p.isCustomer) && (
              <small className="alert">Оваа фирма уште нема купувачи. <Link to={`/c/${client.id}/partners`}>Додајте купувач</Link> (од регистарот на УЈП или рачно), па вратете се тука.</small>)}
            {partner && <small className="muted">{[partner.address, partner.city].filter(Boolean).join(", ") || "без адреса"}{partner.vatNumber ? ` · ДДВ ${partner.vatNumber}` : ""}</small>}
            {score && score.grade !== "-" && <small className="score-line"><GradeChip s={score} /> {GRADE[score.grade]!.text}
              {score.avgDaysLate !== null ? `, просечно ${score.avgDaysLate} дена по рокот` : ""}</small>}
          </label>
          <label>Вид
            {editable && !isDerived ? (
              <select value={head.docType} onChange={(e) => set("docType", e.target.value as Head["docType"])}>
                <option value="INV">Фактура</option><option value="AV">Авансна фактура</option><option value="PF">Понуда / профактура</option>
              </select>
            ) : <output>{DOC[head.docType]}</output>}
          </label>
          <label>Датум на издавање
            {editable ? <input type="date" value={head.issueDate} onChange={(e) => set("issueDate", e.target.value)} required /> : <output>{date(inv!.issueDate)}</output>}
          </label>
          {head.docType !== "AV" && head.docType !== "PF" && <label>Датум на промет
            {editable ? <input type="date" value={head.supplyDate} onChange={(e) => set("supplyDate", e.target.value)} /> : <output>{date(inv!.supplyDate)}</output>}
          </label>}
          <label>{head.docType === "PF" ? "Важи до" : "Рок за плаќање"}
            {editable ? <input type="date" value={head.dueDate} onChange={(e) => set("dueDate", e.target.value)} /> : <output>{date(inv!.dueDate)}</output>}
          </label>
          {whs.filter((w) => w.isActive).length > 1 && ["INV", "KR"].includes(head.docType) && <label>Магацин
            {editable ? <select value={head.warehouseId} onChange={(e) => set("warehouseId", e.target.value ? Number(e.target.value) : "")}>
              <option value="">Главен</option>{whs.filter((w) => w.isActive && !w.isDefault).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
              : <output>{whs.find((w) => w.id === inv?.warehouseId)?.name ?? "Главен"}</output>}
          </label>}
          {ccMode !== "off" && head.docType !== "PF" && <label>Трошковно место{ccMode === "required" ? " *" : ""}
            <select value={head.costCenterId} onChange={(e) => { set("costCenterId", e.target.value ? Number(e.target.value) : ""); if (!editable) setCcDirty(true); }}
              disabled={!!inv && ["cancelled_draft", "voided"].includes(inv.status)}>
              <option value="">{ccLines ? "— по ставки —" : "— без —"}</option>
              {ccs.filter((c) => c.isActive || c.id === head.costCenterId).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select>
            
            {!editable && ccDirty && <button className="btn btn-small" onClick={saveCostCenter}>Зачувај ТМ</button>}
          </label>}
          {ccMode !== "off" && head.docType !== "PF" && <label className="check small cc-lines"><input type="checkbox" checked={ccLines} onChange={(e) => { setCcLines(e.target.checked); if (!editable) setCcDirty(true);
              if (!e.target.checked) setLines((ls) => ls.map((l) => ({ ...l, costCenterId: null }))); }} /> по ставки</label>}
          <label>Начин на плаќање
            {editable ? (
              <select value={head.paymentMethod} onChange={(e) => set("paymentMethod", e.target.value)}>
                {Object.entries(PAYMENT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            ) : <output>{PAYMENT[inv!.paymentMethod]}</output>}
          </label>
        </div>

        {isDerived && (
          <div className="doc-head related">
            <label>Поврзана фактура
              <output>{inv?.relatedInvoiceId ? <Link to={`../${inv.relatedInvoiceId}`} relative="path">{inv.relatedNumber}</Link> : "–"}</output>
            </label>
            {head.docType === "ST" && <label>Причина за сторно (УЈП)
              {editable ? <select value={head.voidCode} onChange={(e) => set("voidCode", e.target.value)} required>
                <option value="">— изберете —</option>
                {reasons.filter((r) => r.kind === "void").map((r) => <option key={r.code} value={r.code}>{r.code} · {r.name}</option>)}
              </select> : <output>{reasons.find((r) => r.code === head.voidCode)?.name ?? head.voidCode}</output>}
            </label>}
            {head.docType === "KR" && <label>Причина за корекција (УЈП)
              {editable ? <select value={head.corrCode} onChange={(e) => set("corrCode", e.target.value)} required>
                <option value="">— изберете —</option>
                {reasons.filter((r) => r.kind === "correction").map((r) => <option key={r.code} value={r.code}>{r.code} · {r.name}</option>)}
              </select> : <output>{reasons.find((r) => r.code === head.corrCode)?.name ?? head.corrCode}</output>}
            </label>}
            <label className="span2">Опис на причината
              {editable ? <input value={head.reason} onChange={(e) => set("reason", e.target.value)} placeholder="Зошто се издава документот" required />
                : <output>{head.reason || "–"}</output>}
            </label>
            {head.docType === "ST" && <p className="muted small span-all">Сторното ја поништува целата фактура. Ставките се копија од оригиналот со минус и не се менуваат.</p>}
            {head.docType === "OD" && <p className="muted small span-all">Внесете ги количините што се одобруваат. Износите се со минус.</p>}
          </div>
        )}

        <div className="table-wrap">
          <table className="grid lines">
            <thead><tr>
              <th className="c-no">#</th><th className="c-item">Артикл / опис</th><th className="c-unit">Ед.</th>
              <th className="num c-qty">Кол.</th><th className="num c-price">Цена без ДДВ</th><th className="num c-disc">Попуст %</th>
              <th className="c-vat">ДДВ</th><th className="num c-amt">Износ без ДДВ</th>{linesEditable && <th className="c-x" />}
            </tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.key}>
                  <td className="c-no">{i + 1}</td>
                  <td className="c-item">
                    {linesEditable ? <>
                      <select value={l.itemId ?? ""} onChange={(e) => pickItem(l.key, Number(e.target.value))} aria-label={`Артикл, ставка ${i + 1}`}>
                        <option value="">— без артикл —</option>
                        {items.filter((it) => it.isActive || it.id === l.itemId).map((it) => <option key={it.id} value={it.id}>{it.code} · {it.name}</option>)}
                      </select>
                      <input value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} placeholder="Опис на ставката" aria-label={`Опис, ставка ${i + 1}`} />
                    </> : l.description}
                    {ccMode !== "off" && ccLines && <select className="small" value={l.costCenterId ?? ""} aria-label={`Трошковно место, ставка ${i + 1}`}
                      onChange={(e) => { setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, costCenterId: e.target.value ? Number(e.target.value) : null } : x)));
                        if (editable) setDirty(true); else setCcDirty(true); }}>
                      <option value="">ТМ: од фактурата</option>
                      {ccs.filter((c) => c.isActive || c.id === l.costCenterId).map((c) => <option key={c.id} value={c.id}>ТМ: {c.code} · {c.name}</option>)}</select>}
                  </td>
                  <td className="c-unit">{linesEditable ? <input value={l.unit} onChange={(e) => setLine(l.key, { unit: e.target.value })} aria-label="Единица мерка" /> : l.unit}</td>
                  <td className="num c-qty">{linesEditable ? <input inputMode="decimal" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value.replace(",", ".") })} aria-label="Количина" /> : Number(l.qty)}</td>
                  <td className="num c-price">
                    {linesEditable ? <input inputMode="decimal" value={l.unitPrice} title={l.priceSource ?? undefined}
                      onChange={(e) => setLine(l.key, { unitPrice: e.target.value.replace(",", "."), priceSource: "Рачно внесена" })} aria-label="Цена без ДДВ" /> : money(l.unitPrice)}
                    {linesEditable && l.priceSource && <small className="src">{l.priceSource}</small>}
                    {l.stockDocId ? <small className="src" title="Залихата е веќе издадена со испратницата">од испратница</small> : null}
                  </td>
                  <td className="num c-disc">{linesEditable ? <input inputMode="decimal" value={l.discountPct} onChange={(e) => setLine(l.key, { discountPct: e.target.value.replace(",", ".") })} aria-label="Попуст во проценти" /> : Number(l.discountPct)}</td>
                  <td className="c-vat">
                    {linesEditable ? (
                      <select value={l.vatRateId} onChange={(e) => setLine(l.key, { vatRateId: Number(e.target.value) })} aria-label="ДДВ стапка">
                        {rates.filter((r) => r.isActive).map((r) => <option key={r.id} value={r.id}>{Number(r.ratePct)}% {r.code}</option>)}
                      </select>
                    ) : `${Number(l.vatRatePct)}%`}
                  </td>
                  <td className="num c-amt">{money(linesEditable || editable ? computed[i]!.netAmount : l.netAmount)}</td>
                  {linesEditable && <td className="c-x"><button className="icon" onClick={() => { setLines((ls) => ls.filter((x) => x.key !== l.key)); setDirty(true); }} aria-label={`Избриши ставка ${i + 1}`}>×</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {linesEditable && head.docType !== "ST" && <button className="btn add-line" onClick={() => { setLines((ls) => [...ls, blankLine(defaultRate)]); setDirty(true); }}>Додај ставка</button>}
        {linesEditable && lines.length === 0 && <p className="muted">Додадете барем една ставка.</p>}

        {canAdvance && (editable ? advances.length > 0 || !!head.advanceId : !!inv?.advanceInvoiceId) && (
          <div className="doc-head advance">
            <label className="span2">Одбиј аванс
              {editable ? <select value={head.advanceId} onChange={(e) => {
                const a = advances.find((x) => x.id === Number(e.target.value));
                setHead((h) => ({ ...h, advanceId: a ? a.id : "", advanceAmount: a ? String(Math.floor(Math.min(Number(a.remaining), Math.round(Number(totals?.grossTotal ?? 0))))) : "" }));
                setDirty(true);
              }}>
                <option value="">— без аванс —</option>
                {advances.map((a) => <option key={a.id} value={a.id}>{a.number} од {date(a.issueDate)}, неискористено {money(a.remaining)}</option>)}
              </select> : <output>{inv?.advanceNumber}</output>}
            </label>
            {head.advanceId !== "" && <label>Износ на авансот (со ДДВ, цели денари)
              {editable ? <input inputMode="numeric" value={head.advanceAmount} onChange={(e) => set("advanceAmount", e.target.value.replace(/\D/g, ""))} />
                : <output>{money(inv?.advanceAmount)}</output>}
            </label>}
          </div>
        )}

        <div className="doc-foot">
          <label className="note">Забелешка (на фактурата)
            {editable ? <textarea rows={3} value={head.note} onChange={(e) => set("note", e.target.value)} /> : <output>{inv?.note || "–"}</output>}
          </label>
          {shown && (
            <dl className="totals" aria-label="Вкупно">
              {shown.byRate.map((g) => (
                <div key={g.vatRatePct} className="by-rate"><dt>ДДВ {Number(g.vatRatePct)}% на {money(g.net)}</dt><dd>{money(g.vat)}</dd></div>
              ))}
              <div><dt>Основица</dt><dd>{money(shown.netTotal)}</dd></div>
              <div><dt>ДДВ вкупно</dt><dd>{money(shown.vatTotal)}</dd></div>
              <div><dt>Вкупно</dt><dd>{money(shown.grossTotal)}</dd></div>
              {inv?.advanceAmount && Number(inv.advanceAmount) > 0 && <div><dt>Одбиен аванс</dt><dd>−{money(inv.advanceAmount)}</dd></div>}
              <div className="payable"><dt>{head.docType === "PF" ? "Вкупно по понудата" : "За плаќање"}</dt><dd>{money0(shown.payableAmount)} <span>ден.</span></dd></div>
            </dl>
          )}
        </div>
      </section>

      {inv && !editable && (
        <section className="after">
          {head.docType === "PF" && inv.status === "issued" && <p className="notice">Понуда / профактура: не е фактура ни даночен документ и не се праќа на УЈП.
            Кога купувачот ќе ја прифати, „Направи фактура“ прави нацрт со истите ставки.</p>}
          {(inv.sourceNumber || inv.sourceInvoiceId) && <p className="muted">Направена од <Link to={`/c/${client.id}/invoices/${inv.sourceInvoiceId}`}>{inv.sourceNumber ?? "нацрт"}</Link>
            {inv.recurringId ? " (повторувачка)" : ""}.</p>}
          {(inv.made?.length ?? 0) > 0 && <p className="muted">{head.docType === "PF" ? "Фактури од оваа понуда" : "Копии"}: {inv.made!.map((d, i) => (
            <span key={d.id}>{i > 0 && ", "}<Link to={`/c/${client.id}/invoices/${d.id}`}>{d.number ?? `нацрт (${DOC[d.docType]})`}</Link></span>))}</p>}
          <div className="row-actions wrap">
            {head.docType === "PF" && inv.status === "issued" && <>
              <button className="btn btn-primary" onClick={() => copy("INV")} disabled={busy}>Направи фактура</button>
              <button className="btn btn-quiet" onClick={cancelQuote} disabled={busy}>Откажи понуда</button></>}
            {["INV", "AV", "PF", "KR"].includes(head.docType) && inv.status !== "cancelled_draft" && <button className="btn" onClick={() => copy("same")} disabled={busy}>Копирај</button>}
            {client.modules.includes("recurring") && head.docType === "INV" && !recurOpen && <button className="btn" onClick={() => setRecurOpen(true)}>Повторувај месечно</button>}
          </div>
          {recurOpen && <RecurringForm client={client} invoiceId={inv.id} defaultName={`${inv.buyerName} – месечно`} onDone={(ok) => { setRecurOpen(false); if (ok) setMsg({ kind: "ok", text: "Повторувачката фактура е зачувана. Секој месец на избраниот ден ќе се направи нацрт." }); }} />}
        </section>
      )}

      {inv && !editable && (canDerive || (inv.derived?.length ?? 0) > 0) && (
        <section className="after">
          {(inv.derived?.length ?? 0) > 0 && <p className="muted">Поврзани документи: {inv.derived!.map((d, i) => (
            <span key={d.id}>{i > 0 && ", "}<Link to={`../${d.id}`} relative="path">{d.number ?? `нацрт (${DOC[d.docType]})`}</Link></span>))}</p>}
          {canDerive && <div className="row-actions wrap">
            <button className="btn" onClick={() => derive("OD")} disabled={busy}>Книжно одобрение</button>
            <button className="btn" onClick={() => derive("KZ")} disabled={busy}>Книжно задолжување</button>
            <button className="btn" onClick={() => derive("KR")} disabled={busy}>Корекција</button>
            <button className="btn btn-quiet" onClick={() => derive("ST")} disabled={busy}>Сторнирај</button>
          </div>}
        </section>
      )}

      {editable && (
        <footer className="actions">
          <button className="btn" onClick={save} disabled={busy || !dirty && !!inv}>{dirty || !inv ? "Зачувај нацрт" : "Зачувано"}</button>
          {confirmIssue ? <>
            <button className="btn btn-primary" onClick={issue} disabled={busy}>Потврди издавање</button>
            <button className="link" onClick={() => setConfirmIssue(false)}>Не, назад</button>
            <span className="muted small">По издавањето документот не може да се менува.</span>
          </> : <button className="btn btn-primary" onClick={() => setConfirmIssue(true)} disabled={busy || lines.length === 0 || !head.partnerId}>Издај {DOC[head.docType].toLowerCase()}</button>}
          <span className="spacer" />
          {inv && <button className="btn btn-quiet" onClick={cancelDraft} disabled={busy}>Откажи нацрт</button>}
        </footer>
      )}
    </>
  );
}
