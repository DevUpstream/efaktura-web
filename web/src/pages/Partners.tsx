import { useEffect, useState, type FormEvent } from "react";
import { useOutletContext } from "react-router-dom";
import { api, ApiError, type ClientRef, type Partner } from "../api";
import { date } from "../format";

const LOCKED = ["name", "edb", "embs", "vatNumber", "address", "city", "postalCode"];

export function Partners() {
  const client = useOutletContext<ClientRef>();
  const [rows, setRows] = useState<Partner[] | null>(null);
  const [edit, setEdit] = useState<Partner | "new" | null>(null);
  const [q, setQ] = useState("");
  const load = () => api.get<Partner[]>(`/api/clients/${client.id}/partners`).then(setRows);
  useEffect(() => { setRows(null); setEdit(null); void load(); }, [client.id]);

  const needle = q.trim().toLowerCase();
  const shown = (rows ?? []).filter((p) => !needle || p.name.toLowerCase().includes(needle) || (p.edb ?? "").includes(needle));
  return (
    <>
      <header className="page-head"><h1>Купувачи</h1><button className="btn btn-primary" onClick={() => setEdit("new")}>Нов купувач</button></header>
      {edit && <PartnerForm client={client} p={edit === "new" ? null : edit} onDone={() => { setEdit(null); void load(); }} />}
      <div className="toolbar"><input type="search" placeholder="Назив или ЕДБ" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Пребарај" /></div>
      {rows && shown.length === 0 && <div className="empty"><p>{rows.length ? "Нема купувач со тоа име или ЕДБ." : "Сè уште нема купувачи. Додадете го првиот."}</p></div>}
      {shown.length > 0 && (
        <div className="table-wrap"><table className="grid">
          <thead><tr><th>Назив</th><th>ЕДБ</th><th>ДДВ број</th><th>Град</th><th>Регистар</th></tr></thead>
          <tbody>{shown.map((p) => (
            <tr key={p.id} onClick={() => setEdit(p)} className={p.isActive ? "" : "row-inactive"}>
              <td><button className="link" onClick={() => setEdit(p)}>{p.name}</button>{!p.isActive && <span className="doctype">неактивен</span>}</td>
              <td>{p.edb ?? "–"}</td><td>{p.vatNumber ?? "–"}</td><td>{p.city ?? "–"}</td>
              <td>{p.ujpRegistryAt ? <span className="chip ok" title={`Проверено ${date(p.ujpRegistryAt.slice(0, 10))}`}>УЈП ✓</span> : <span className="muted">–</span>}</td>
            </tr>))}
          </tbody>
        </table></div>
      )}
    </>
  );
}

function PartnerForm({ client, p, onDone }: { client: ClientRef; p: Partner | null; onDone: () => void }) {
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
      <label className="check"><input type="checkbox" name="isActive" defaultChecked={p?.isActive ?? true} /> Активен</label>
      <div className="span-all row-actions"><button className="btn btn-primary">Зачувај</button><button type="button" className="link" onClick={onDone}>Откажи</button></div>
    </form>
  );
}
