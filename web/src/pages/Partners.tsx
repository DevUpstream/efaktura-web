import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { GradeChip, type PartnerScore } from "../components/Score";
import { api, ApiError, type ClientRef, type Partner } from "../api";
import { date } from "../format";
import { CompanyCard, DiffTable, UjpPullStatus, useUjpPull } from "../components/UjpPull";

const LOCKED = ["name", "edb", "embs", "vatNumber", "address", "city", "postalCode"];

export function Partners() {
  const client = useOutletContext<ClientRef>();
  const [rows, setRows] = useState<Partner[] | null>(null);
  const [edit, setEdit] = useState<Partner | "new" | "ujp" | null>(null);
  const [check, setCheck] = useState<Partner | null>(null);
  const [q, setQ] = useState("");
  const nav = useNavigate();
  const load = () => api.get<Partner[]>(`/api/clients/${client.id}/partners`).then(setRows);
  useEffect(() => { setRows(null); setEdit(null); void load(); }, [client.id]);

  const needle = q.trim().toLowerCase();
  const [scores, setScores] = useState<Map<number, PartnerScore> | null>(null);
  useEffect(() => {
    if (!client.modules.includes("payments")) { setScores(null); return; }
    api.get<PartnerScore[]>(`/api/clients/${client.id}/partner-scores`).then((x) => setScores(new Map(x.map((s) => [s.partnerId, s]))), () => setScores(null));
  }, [client.id]);
  const shown = (rows ?? []).filter((p) => !needle || p.name.toLowerCase().includes(needle) || (p.edb ?? "").includes(needle));
  return (
    <>
      <header className="page-head"><h1>Купувачи</h1><div className="row-actions">
        <button className="btn btn-primary" onClick={() => { setEdit("ujp"); setCheck(null); }}>Нов купувач од УЈП</button>
        <button className="btn" onClick={() => { setEdit("new"); setCheck(null); }}>Рачно (странски / без ЕДБ)</button></div></header>
      {edit === "ujp" && <NewFromUjp client={client} onDone={() => { setEdit(null); void load(); }} />}
      {edit && edit !== "ujp" && <PartnerForm client={client} p={edit === "new" ? null : edit} onDone={() => { setEdit(null); void load(); }}
        onCheck={edit !== "new" && edit.edb ? () => { setCheck(edit); setEdit(null); } : undefined} />}
      {check && <CheckPartner client={client} p={check} onDone={() => { setCheck(null); void load(); }} />}
      <div className="toolbar"><input type="search" placeholder="Назив или ЕДБ" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Пребарај" /></div>
      {rows && shown.length === 0 && <div className="empty"><p>{rows.length ? "Нема купувач со тоа име или ЕДБ." : "Сè уште нема купувачи. Додадете го првиот."}</p></div>}
      {shown.length > 0 && (
        <div className="table-wrap"><table className="grid">
          <thead><tr><th>Назив</th><th>ЕДБ</th><th>ДДВ број</th><th>Град</th><th>Регистар</th>{scores && <th title="Платежна дисциплина">Плаќа</th>}</tr></thead>
          <tbody>{shown.map((p) => (
            <tr key={p.id} onClick={() => (client.modules.includes("crm") ? nav(`/c/${client.id}/partners/${p.id}`) : setEdit(p))} className={p.isActive ? "" : "row-inactive"}>
              <td>{client.modules.includes("crm") ? <Link className="docno" to={`/c/${client.id}/partners/${p.id}`} onClick={(e) => e.stopPropagation()}>{p.name}</Link>
                : <button className="link" onClick={() => setEdit(p)}>{p.name}</button>}{!p.isActive && <span className="doctype">неактивен</span>}</td>
              <td>{p.edb ?? "–"}</td><td>{p.vatNumber ?? "–"}</td><td>{p.city ?? "–"}</td>
              <td>{p.ujpRegistryAt ? <span className="chip ok" title={`Проверено ${date(p.ujpRegistryAt.slice(0, 10))}`}>УЈП ✓</span> : <span className="muted">–</span>}</td>
              {scores && <td><GradeChip s={scores.get(p.id)} /></td>}
            </tr>))}
          </tbody>
        </table></div>
      )}
    </>
  );
}

function NewFromUjp({ client, onDone }: { client: ClientRef; onDone: () => void }) {
  const pull = useUjpPull();
  const [edb, setEdb] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const done = pull.req?.status === "done" ? pull.req.result : null;
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try { await api.post(`/api/clients/${client.id}/partners/from-ujp`, { edb, registryRequestId: pull.req!.id, email: f.email || null, phone: f.phone || null }); onDone(); }
    catch (x) { setErr((x as ApiError).message); }
  }
  return (
    <section className="panel stack">
      <h2>Нов купувач од регистарот на УЈП</h2>
      <div className="row-actions">
        <label className="grow">ЕДБ на купувачот<input value={edb} onChange={(e) => { setEdb(e.target.value.replace(/\D/g, "").slice(0, 13)); pull.reset(); }} inputMode="numeric" autoFocus /></label>
        <button className="btn" disabled={edb.length !== 13 || pull.req?.status === "pending"} onClick={() => pull.start({ clientId: client.id, edb })}>Повлечи од УЈП</button>
      </div>
      <UjpPullStatus req={pull.req} err={pull.err} />
      {done ? <form onSubmit={create} className="stack">
        <CompanyCard c={done} />
        {err && <p className="alert">{err}</p>}
        <div className="form-grid"><div className="span2"><label>Е-пошта<input name="email" type="email" /></label></div><label>Телефон<input name="phone" /></label></div>
        <div className="row-actions"><button className="btn btn-primary">Додај купувач</button><button type="button" className="link" onClick={onDone}>Откажи</button></div>
      </form> : <button className="link" onClick={onDone}>Откажи</button>}
    </section>
  );
}

export function CheckPartner({ client, p, onDone }: { client: ClientRef; p: Partner; onDone: () => void }) {
  const pull = useUjpPull();
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void pull.start({ clientId: client.id, partnerId: p.id }); }, [p.id]);
  async function apply() {
    try { await api.post(`/api/ujp/registry-requests/${pull.req!.id}/apply`); onDone(); } catch (x) { setErr((x as ApiError).message); }
  }
  return (
    <section className="panel stack">
      <h2>{p.name}: проверка во УЈП</h2>
      <UjpPullStatus req={pull.req} err={pull.err ?? err} />
      {pull.req?.status === "done" && pull.req.diff && <>
        <DiffTable diff={pull.req.diff} />
        <div className="row-actions"><button className="btn btn-primary" onClick={apply}>{pull.req.diff.length ? "Примени од УЈП" : "Означи „УЈП ✓“"}</button>
          <button className="link" onClick={onDone}>Затвори</button></div>
      </>}
      {pull.req?.status !== "done" && <button className="link" onClick={onDone}>Затвори</button>}
    </section>
  );
}

export function PartnerForm({ client, p, onDone, onCheck }: { client: ClientRef; p: Partner | null; onDone: () => void; onCheck?: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const locked = !!p?.ujpRegistryAt;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const body: Record<string, unknown> = { ...f, isActive: f.isActive === "on" };
    if (locked) LOCKED.forEach((k) => delete body[k]);
    try {
      if (p) await api.patch(`/api/clients/${client.id}/partners/${p.id}`, body);
      else await api.post(`/api/clients/${client.id}/partners`, body);
      onDone();
    } catch (x) { setErr((x as ApiError).message); }
  }
  const field = (name: keyof Partner, label: string, extra: Record<string, unknown> = {}) => (
    <label>{label}<input name={name} defaultValue={(p?.[name] as string) ?? ""} disabled={locked && LOCKED.includes(name)} {...extra} /></label>
  );
  return (
    <form className="panel form-grid" onSubmit={submit}>
      <h2 className="span-all">{p ? p.name : "Нов купувач"}</h2>
      {locked && <p className="notice span-all">Податоците се проверени во регистарот на УЈП и се заклучени. Може да се менуваат само е-пошта, телефон и активност.</p>}
      {err && <p className="alert span-all">{err}</p>}
      <div className="span2">{field("name", "Назив", { required: true, minLength: 2 })}</div>
      {field("edb", "ЕДБ", { inputMode: "numeric", pattern: "\\d{13}", title: "13 цифри" })}
      {field("vatNumber", "ДДВ број")}
      <div className="span2">{field("address", "Адреса")}</div>
      {field("city", "Град")}
      {field("postalCode", "Поштенски број")}
      {field("embs", "ЕМБС")}
      {field("country", "Држава", { maxLength: 2, defaultValue: p?.country ?? "MK" })}
      {field("email", "Е-пошта", { type: "email" })}
      {field("phone", "Телефон")}
      {field("bankAccount", "Жиро-сметка (за извод)")}
      <label className="check"><input type="checkbox" name="isActive" defaultChecked={p?.isActive ?? true} /> Активен</label>
      <div className="span-all row-actions"><button className="btn btn-primary">Зачувај</button>
        {onCheck && <button type="button" className="btn" onClick={onCheck}>Провери во УЈП</button>}
        <button type="button" className="link" onClick={onDone}>Откажи</button></div>
    </form>
  );
}
