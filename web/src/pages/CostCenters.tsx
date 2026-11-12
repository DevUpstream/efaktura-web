import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { api, ApiError, type ClientRef, type CostCenter, type Partner } from "../api";
import { date, money } from "../format";
import { useSession } from "../session";

const MODE = { off: "Исклучено", optional: "Опционално", required: "Задолжително" } as const;
const monthRange = () => { const d = new Date(); return [`${d.getFullYear()}-01-01`, d.toLocaleDateString("sv-SE", { timeZone: "Europe/Skopje" })] as const; };
interface RepRow { id: number | null; code: string; name: string; isActive: boolean; revenue: string; costs: string; result: string; revenueDocs: number; costDocs: number }
interface Docs { invoices: { id: number; number: string; date: string; partner: string; net: string }[]; purchases: { id: number; number: string; supplierNumber: string; date: string; partner: string; net: string }[] }

/** Трошковни места: поставка, шифрарник, извештај, масовно доделување (docs/14). */
export function CostCenters() {
  const client = useOutletContext<ClientRef>();
  const { me } = useSession();
  const admin = me?.user?.role === "admin";
  const mode = client.costCenterMode ?? "off";
  const [rows, setRows] = useState<CostCenter[]>([]);
  const [edit, setEdit] = useState<CostCenter | "new" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => api.get<CostCenter[]>(`/api/clients/${client.id}/cost-centers`).then(setRows);
  useEffect(() => { void load(); }, [client.id]);
  async function setMode(m: keyof typeof MODE) {
    try { await api.patch(`/api/clients/${client.id}`, { costCenterMode: m }); window.location.reload(); } catch (e) { setMsg({ ok: false, text: (e as ApiError).message }); }
  }
  return (
    <>
      <header className="page-head"><h1>Трошковни места</h1>{mode !== "off" && <button className="btn btn-primary" onClick={() => setEdit("new")}>Ново трошковно место</button>}</header>
      <section className="panel stack">
        <fieldset className="radio-set" disabled={!admin}>
          <legend>Трошковно место на фактурите и влезните фактури {admin ? "" : "(само администратор менува)"}</legend>
          {(Object.keys(MODE) as (keyof typeof MODE)[]).map((k) => <label key={k} className="check"><input type="radio" name="ccmode" checked={mode === k} onChange={() => setMode(k)} /> {MODE[k]}
            <span className="muted small"> {k === "off" ? "– полето не се гледа" : k === "optional" ? "– може да остане празно" : "– без ТМ фактурата не се издава, а влезната не се книжи"}</span></label>)}
        </fieldset>
        <p className="muted small">ТМ не се печати на фактурата и не оди кон УЈП. Може да се смени и по издавање (се запишува во ревизијата). Ставка без свое ТМ го зема ТМ од фактурата.</p>
      </section>
      {msg && <p className={msg.ok ? "notice" : "alert"}>{msg.text}</p>}
      {mode !== "off" && <>
        {edit && <CcForm client={client} cc={edit === "new" ? null : edit} onDone={() => { setEdit(null); void load(); }} />}
        {rows.length > 0 && <div className="table-wrap"><table className="grid compact">
          <thead><tr><th>Шифра</th><th>Назив</th><th>Статус</th></tr></thead>
          <tbody>{rows.map((c) => <tr key={c.id} className="clickable" onClick={() => setEdit(c)}><td className="docno">{c.code}</td><td>{c.name}</td>
            <td>{c.isActive ? <span className="chip ok">активно</span> : <span className="chip">исклучено</span>}</td></tr>)}</tbody></table></div>}
        <Report client={client} />
        <Assign client={client} ccs={rows.filter((c) => c.isActive)} />
      </>}
    </>
  );
}

function CcForm({ client, cc, onDone }: { client: ClientRef; cc: CostCenter | null; onDone: () => void }) {
  const [f, setF] = useState({ code: cc?.code ?? "", name: cc?.name ?? "", isActive: cc?.isActive ?? true });
  const [err, setErr] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    try { if (cc) await api.patch(`/api/clients/${client.id}/cost-centers/${cc.id}`, f); else await api.post(`/api/clients/${client.id}/cost-centers`, f); onDone(); }
    catch (x) { setErr((x as ApiError).message); }
  }
  return (
    <form className="panel form-grid" onSubmit={save}>
      <h2 className="span-all">{cc ? `${cc.code} · ${cc.name}` : "Ново трошковно место"}</h2>
      <label>Шифра<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} maxLength={20} required /></label>
      <label className="span2">Назив<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} required /></label>
      <label className="check"><input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Активно</label>
      {err && <p className="alert span-all">{err}</p>}
      <div className="row-actions span-all"><button className="btn btn-primary">Зачувај</button><button type="button" className="btn" onClick={onDone}>Откажи</button></div>
    </form>
  );
}

function Report({ client }: { client: ClientRef }) {
  const [[from, to], setR] = useState<readonly [string, string]>(monthRange());
  const [d, setD] = useState<{ rows: RepRow[]; totals: { revenue: string; costs: string; result: string } } | null>(null);
  const [open, setOpen] = useState<RepRow | null>(null);
  const [docs, setDocs] = useState<Docs | null>(null);
  useEffect(() => { setD(null); setOpen(null); api.get<typeof d>(`/api/clients/${client.id}/reports/cost-centers?from=${from}&to=${to}`).then(setD); }, [client.id, from, to]);
  useEffect(() => { setDocs(null); if (open) api.get<Docs>(`/api/clients/${client.id}/reports/cost-centers/${open.id ?? 0}?from=${from}&to=${to}`).then(setDocs); }, [open, from, to, client.id]);
  return (
    <section className="panel stack">
      <div className="sec-head"><h2>Извештај по трошковни места</h2>
        <a className="btn btn-small" href={`/api/clients/${client.id}/reports/cost-centers?from=${from}&to=${to}&format=csv`}>Excel (CSV)</a></div>
      <div className="toolbar"><label>од <input type="date" value={from} onChange={(e) => e.target.value && setR([e.target.value, to])} /></label>
        <label>до <input type="date" value={to} onChange={(e) => e.target.value && setR([from, e.target.value])} /></label></div>
      <p className="muted small">Приходи = КИФ, трошоци = КУФ, нето (без ДДВ). Сторно и одобрение се со минус; кај корекција – разликата. Трошоците од изводи засега не се вклучени.</p>
      {d && <div className="table-wrap"><table className="grid compact">
        <thead><tr><th>Трошковно место</th><th className="num">Приходи</th><th className="num">Трошоци</th><th className="num">Разлика</th></tr></thead>
        <tbody>{d.rows.map((r) => <tr key={r.id ?? 0} className="clickable" onClick={() => setOpen(r)}><td>{r.code ? `${r.code} · ` : ""}{r.name}</td>
          <td className="num">{money(r.revenue)}</td><td className="num">{money(r.costs)}</td><td className="num"><strong>{money(r.result)}</strong></td></tr>)}</tbody>
        <tfoot><tr><td><strong>Вкупно</strong></td><td className="num">{money(d.totals.revenue)}</td><td className="num">{money(d.totals.costs)}</td><td className="num"><strong>{money(d.totals.result)}</strong></td></tr></tfoot>
      </table></div>}
      {open && <div className="stack"><h3>{open.code ? `${open.code} · ` : ""}{open.name}</h3>
        {!docs ? <p className="muted">Се вчитува…</p> : <div className="card-cols">
          <table className="grid compact"><thead><tr><th>Излезни</th><th>Датум</th><th className="num">Нето</th></tr></thead>
            <tbody>{docs.invoices.map((x) => <tr key={x.id}><td><Link className="docno" to={`/c/${client.id}/invoices/${x.id}`}>{x.number}</Link><div className="muted small">{x.partner}</div></td>
              <td>{date(x.date)}</td><td className="num">{money(x.net)}</td></tr>)}</tbody></table>
          <table className="grid compact"><thead><tr><th>Влезни</th><th>Датум</th><th className="num">Нето</th></tr></thead>
            <tbody>{docs.purchases.map((x) => <tr key={x.id}><td><Link className="docno" to={`/c/${client.id}/purchases/${x.id}`}>{x.number}</Link><div className="muted small">{x.partner} · {x.supplierNumber}</div></td>
              <td>{date(x.date)}</td><td className="num">{money(x.net)}</td></tr>)}</tbody></table></div>}</div>}
    </section>
  );
}

function Assign({ client, ccs }: { client: ClientRef; ccs: CostCenter[] }) {
  const [f, setF] = useState({ kind: "invoice" as "invoice" | "purchase", from: `${new Date().getFullYear() - 1}-01-01`, to: monthRange()[1], partnerId: "" as number | "", onlyEmpty: true, costCenterId: "" as number | "" });
  const [partners, setPartners] = useState<Partner[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { api.get<Partner[]>(`/api/clients/${client.id}/partners`).then(setPartners); }, [client.id]);
  useEffect(() => { setCount(null); }, [f]);
  const body = (dryRun: boolean) => ({ ...f, partnerId: f.partnerId || null, costCenterId: f.costCenterId, dryRun });
  async function run(dryRun: boolean) {
    setMsg(null);
    try {
      const r = await api.post<{ count: number; applied: boolean }>(`/api/clients/${client.id}/cost-centers/assign`, body(dryRun));
      if (dryRun) setCount(r.count); else { setMsg({ ok: true, text: `Доделено на ${r.count} документи.` }); setCount(null); }
    } catch (e) { setMsg({ ok: false, text: (e as ApiError).message }); }
  }
  return (
    <section className="panel stack">
      <h2>Масовно доделување</h2>
      <p className="muted small">На пример: сите пренесени фактури од ERPNext без ТМ. Се менува ТМ на документот; ставките со свое ТМ остануваат. Секое доделување се запишува во ревизијата.</p>
      <div className="form-grid">
        <label>Документи<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as "invoice" | "purchase" })}>
          <option value="invoice">Излезни фактури</option>{client.modules.includes("incoming") && <option value="purchase">Влезни фактури</option>}</select></label>
        <label>од<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label>до<input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <label className="span2">Партнер (по избор)<select value={f.partnerId} onChange={(e) => setF({ ...f, partnerId: e.target.value ? Number(e.target.value) : "" })}>
          <option value="">— сите —</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>Трошковно место<select value={f.costCenterId} onChange={(e) => setF({ ...f, costCenterId: e.target.value ? Number(e.target.value) : "" })}>
          <option value="">— изберете —</option>{ccs.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select></label>
        <label className="check span-all"><input type="checkbox" checked={f.onlyEmpty} onChange={(e) => setF({ ...f, onlyEmpty: e.target.checked })} /> Само документи без ТМ</label>
      </div>
      <div className="row-actions">
        <button className="btn" disabled={!f.costCenterId} onClick={() => run(true)}>Провери колку</button>
        {count !== null && <button className="btn btn-primary" disabled={!count} onClick={() => run(false)}>Додели на {count} документи</button>}
      </div>
      {msg && <p className={msg.ok ? "notice" : "alert"}>{msg.text}</p>}
    </section>
  );
}
