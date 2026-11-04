import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { calcLine, calcTotals } from "@calc";
import { api, ApiError, type ClientRef, type DocType, type Invoice, type Item, type Line, type Partner, type VatRate } from "../api";
import { DOC, PAYMENT, STATUS, addDays, date, money, money0, today } from "../format";
import { UjpState } from "../components/UjpState";

interface Head { partnerId: number | ""; docType: DocType; issueDate: string; supplyDate: string; dueDate: string;
  paymentMethod: string; note: string; reason: string; voidCode: string; corrCode: string; advanceId: number | ""; advanceAmount: string }
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
  const [items, setItems] = useState<Item[]>([]);
  const [rates, setRates] = useState<VatRate[]>([]);
  const [inv, setInv] = useState<Invoice | null>(null);
  const [head, setHead] = useState<Head>({ partnerId: "", docType: "INV", issueDate: today(), supplyDate: today(),
    dueDate: addDays(today(), 15), paymentMethod: "bank", note: "", reason: "", voidCode: "", corrCode: "", advanceId: "", advanceAmount: "" });
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [lines, setLines] = useState<EditLine[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirmIssue, setConfirmIssue] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get<Partner[]>(`/api/clients/${client.id}/partners`), api.get<Item[]>(`/api/clients/${client.id}/items`),
      api.get<VatRate[]>("/api/vat-rates"), id ? api.get<Invoice>(`/api/invoices/${id}`) : Promise.resolve(null),
      api.get<Reason[]>("/api/ujp-reasons"),
    ]).then(([p, it, r, i, rs]) => {
      setPartners(p); setItems(it); setRates(r); setInv(i); setReasons(rs);
      if (i) {
        setHead({ partnerId: i.partnerId, docType: i.docType, issueDate: i.issueDate,
          supplyDate: i.supplyDate ?? i.issueDate, dueDate: i.dueDate ?? "", paymentMethod: i.paymentMethod, note: i.note ?? "",
          reason: i.correctionReason ?? "", voidCode: i.voidReasonCode ?? "", corrCode: i.correctionReasonCode ?? "",
          advanceId: i.advanceInvoiceId ?? "", advanceAmount: i.advanceAmount ? String(Number(i.advanceAmount)) : "" });
        setLines(i.lines.map(toEdit));
      } else {
        setLines([]);
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

  function payload() {
    return {
      partnerId: Number(head.partnerId), docType: head.docType, issueDate: head.issueDate,
      supplyDate: head.docType === "AV" ? null : head.supplyDate || head.issueDate, dueDate: head.dueDate || null,
      paymentMethod: head.paymentMethod, note: head.note || null, version: inv?.version,
      correctionReason: head.reason || null, voidReasonCode: head.voidCode || null, correctionReasonCode: head.corrCode || null,
      advanceInvoiceId: canAdvance && head.advanceId ? head.advanceId : null,
      advanceAmount: canAdvance && head.advanceId ? Number(head.advanceAmount || 0) : null,
      lines: lines.map((l) => ({ itemId: l.itemId, description: l.description, unit: l.unit, qty: Number(l.qty),
        unitPrice: Number(l.unitPrice), discountPct: Number(l.discountPct || 0), vatRateId: l.vatRateId, priceSource: l.priceSource })),
    };
  }

  async function save(): Promise<number | null> {
    if (!head.partnerId) { setMsg({ kind: "err", text: "Изберете купувач." }); return null; }
    setBusy(true); setMsg(null);
    try {
      let invId = inv?.id;
      if (invId) await api.put(`/api/invoices/${invId}`, payload());
      else invId = (await api.post<{ id: number }>(`/api/clients/${client.id}/invoices`, payload())).id;
      const fresh = await api.get<Invoice>(`/api/invoices/${invId}`);
      setInv(fresh); setLines(fresh.lines.map(toEdit)); setDirty(false);
      if (!inv) nav(`../invoices/${invId}`, { relative: "path", replace: true });
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
      const r = await api.post<{ number: string }>(`/api/invoices/${invId}/issue`);
      setInv(await api.get<Invoice>(`/api/invoices/${invId}`));
      setMsg({ kind: "ok", text: `Издаден е документ ${r.number}. Агентот ќе го потпише и прати до УЈП.` });
    } catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); }
    finally { setBusy(false); setConfirmIssue(false); }
  }

  async function cancelDraft() {
    if (!inv) return nav("../invoices", { relative: "path" });
    setBusy(true);
    try { await api.post(`/api/invoices/${inv.id}/cancel`); nav("../../invoices", { relative: "path" }); }
    catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); setBusy(false); }
  }

  async function derive(docType: DocType) {
    if (!inv) return;
    setBusy(true);
    try {
      const r = await api.post<{ id: number }>(`/api/invoices/${inv.id}/derive`, { docType });
      nav(`../${r.id}`, { relative: "path" });
    } catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); }
    finally { setBusy(false); }
  }

  const partner = partners.find((p) => p.id === head.partnerId);
  const isDerived = DERIVED.includes(head.docType);
  const canDerive = inv && !editable && (inv.docType === "INV" || inv.docType === "KR") && ["issued", "json_exported", "sent_to_ujp"].includes(inv.status);
  const shown = editable ? totals : inv && { netTotal: inv.netTotal, vatTotal: inv.vatTotal, grossTotal: inv.grossTotal,
    payableAmount: inv.payableAmount ?? String(Math.round(Number(inv.grossTotal))), byRate: inv.byRate };

  return (
    <>
      <header className="page-head">
        <div>
          <Link to={inv ? "../../invoices" : "../invoices"} relative="path" className="back">← Фактури</Link>
          <h1>{inv?.number ?? (inv ? "Нацрт" : "Нова фактура")}{inv && inv.docType !== "INV" && <span className="doctype">{DOC[inv.docType]}</span>}</h1>
        </div>
        {inv && <div className="head-state"><span className={`chip st-${inv.status}`}>{STATUS[inv.status]}</span><UjpState r={inv} />
          <a className="btn" href={`/api/invoices/${inv.id}/pdf`} target="_blank" rel="noopener" onClick={(e) => { if (dirty) { e.preventDefault(); setMsg({ kind: "err", text: "Прво зачувајте ги промените, па отворете PDF." }); } }}>PDF</a></div>}
      </header>
      {msg && <p className={msg.kind === "ok" ? "notice" : "alert"} role={msg.kind === "err" ? "alert" : "status"}>{msg.text}</p>}
      {inv?.ujpError && <p className="alert">УЈП: {inv.ujpError}</p>}

      <section className="doc">
        <div className="doc-head">
          <label className="span2">Купувач
            {editable && !isDerived ? (
              <select value={head.partnerId} onChange={(e) => set("partnerId", e.target.value ? Number(e.target.value) : "")} required>
                <option value="">— изберете —</option>
                {partners.filter((p) => p.isActive || p.id === head.partnerId).map((p) => <option key={p.id} value={p.id}>{p.name}{p.edb ? ` (${p.edb})` : ""}</option>)}
              </select>
            ) : <output>{inv?.buyerName}</output>}
            {partner && <small className="muted">{[partner.address, partner.city].filter(Boolean).join(", ") || "без адреса"}{partner.vatNumber ? ` · ДДВ ${partner.vatNumber}` : ""}</small>}
          </label>
          <label>Вид
            {editable && !isDerived ? (
              <select value={head.docType} onChange={(e) => set("docType", e.target.value as Head["docType"])}>
                <option value="INV">Фактура</option><option value="AV">Авансна фактура</option>
              </select>
            ) : <output>{DOC[head.docType]}</output>}
          </label>
          <label>Датум на издавање
            {editable ? <input type="date" value={head.issueDate} onChange={(e) => set("issueDate", e.target.value)} required /> : <output>{date(inv!.issueDate)}</output>}
          </label>
          {head.docType !== "AV" && <label>Датум на промет
            {editable ? <input type="date" value={head.supplyDate} onChange={(e) => set("supplyDate", e.target.value)} /> : <output>{date(inv!.supplyDate)}</output>}
          </label>}
          <label>Рок за плаќање
            {editable ? <input type="date" value={head.dueDate} onChange={(e) => set("dueDate", e.target.value)} /> : <output>{date(inv!.dueDate)}</output>}
          </label>
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
                  </td>
                  <td className="c-unit">{linesEditable ? <input value={l.unit} onChange={(e) => setLine(l.key, { unit: e.target.value })} aria-label="Единица мерка" /> : l.unit}</td>
                  <td className="num c-qty">{linesEditable ? <input inputMode="decimal" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value.replace(",", ".") })} aria-label="Количина" /> : Number(l.qty)}</td>
                  <td className="num c-price">
                    {linesEditable ? <input inputMode="decimal" value={l.unitPrice} title={l.priceSource ?? undefined}
                      onChange={(e) => setLine(l.key, { unitPrice: e.target.value.replace(",", "."), priceSource: "Рачно внесена" })} aria-label="Цена без ДДВ" /> : money(l.unitPrice)}
                    {linesEditable && l.priceSource && <small className="src">{l.priceSource}</small>}
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
              <div className="payable"><dt>За плаќање</dt><dd>{money0(shown.payableAmount)} <span>ден.</span></dd></div>
            </dl>
          )}
        </div>
      </section>

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
