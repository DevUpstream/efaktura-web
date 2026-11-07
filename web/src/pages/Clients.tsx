import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { useSession } from "../session";
import { date } from "../format";
import { ModulePicker, useModuleCatalog } from "../components/Modules";
import { CompanyCard, DiffTable, UjpPullStatus, useUjpPull } from "../components/UjpPull";

interface Row { id: number; name: string; edb: string; prefix: string; city: string; vatNumber: string | null; isActive: boolean;
  ujpRegistryAt: string | null; ujpRegistryNote: string | null; modules: string[] }

/** Klienti (firmi) na biroto. Podatocite se od registarot na UJP (preku agentot). Samo administrator. */
export function Clients() {
  const { me, refresh } = useSession();
  const nav = useNavigate();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState<Row | null>(null);
  const [mods, setMods] = useState<Row | null>(null);
  const catalog = useModuleCatalog();
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api.get<Row[]>("/api/clients").then(setRows);
  useEffect(() => { void load(); }, []);
  if (me?.user?.role !== "admin") return <p className="alert">Само за администратори.</p>;

  return (
    <>
      <header className="page-head"><h1>Фирми</h1>
        <button className="btn btn-primary" onClick={() => { setAdding(true); setChecking(null); }}>Нова фирма</button></header>
      {msg && <p className="notice" role="status">{msg}</p>}
      {adding && <NewClient onDone={async (c) => { setAdding(false); await load(); if (c) { await refresh(); setMsg(`Фирмата ${c.name} е додадена.`); nav(`/c/${c.id}/settings`); } }} />}
      {mods && <ClientModules c={mods} catalog={catalog} onDone={async (saved) => { setMods(null); if (saved) { await load(); await refresh(); setMsg(`Модулите за ${mods.name} се зачувани.`); } }} />}
      {checking && <CheckClient c={checking} onDone={async (changed) => { setChecking(null); await load(); if (changed !== null) setMsg(changed ? `Применети ${changed} промени од УЈП.` : "Се совпаѓа со регистарот."); }} />}
      {rows && (
        <div className="table-wrap"><table className="grid">
          <thead><tr><th>Назив</th><th>ЕДБ</th><th>Префикс</th><th>Град</th><th>Модули</th><th>Регистар на УЈП</th><th /></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.id} className={c.isActive ? "" : "row-inactive"} onClick={() => undefined}>
              <td><strong>{c.name}</strong></td><td>{c.edb}</td><td>{c.prefix}</td><td>{c.city}</td>
              <td><button className="link" onClick={() => { setMods(c); setChecking(null); setAdding(false); }}>
                {catalog.length ? c.modules.map((k) => catalog.find((m) => m.key === k)?.name ?? k).join(", ") : c.modules.join(", ")}</button></td>
              <td>{c.ujpRegistryAt ? <span className="chip ok" title={c.ujpRegistryNote ?? undefined}>УЈП ✓ {date(c.ujpRegistryAt.slice(0, 10))}</span> : <span className="chip wait">непроверено</span>}</td>
              <td><button className="link" onClick={() => { setChecking(c); setAdding(false); }}>Провери во УЈП</button></td>
            </tr>))}
          </tbody>
        </table></div>
      )}
      <p className="muted small">Назив, адреса, ДДВ број и ЕМБС секогаш доаѓаат од регистарот на УЈП. Барањето го извршува агентот на компјутерот со токенот, бидејќи УЈП не е достапен од серверот.</p>
    </>
  );
}

function NewClient({ onDone }: { onDone: (c?: { id: number; name: string }) => void }) {
  const pull = useUjpPull();
  const [edb, setEdb] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const done = pull.req?.status === "done" ? pull.req.result : null;
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try { onDone(await api.post<{ id: number; name: string }>("/api/clients", { edb, registryRequestId: pull.req!.id, invoicePrefix: f.prefix, email: f.email || null, phone: f.phone || null })); }
    catch (x) { setErr((x as ApiError).message); }
  }
  return (
    <section className="panel stack">
      <h2>Нова фирма</h2>
      <div className="row-actions">
        <label className="grow">ЕДБ (13 цифри)<input value={edb} onChange={(e) => { setEdb(e.target.value.replace(/\D/g, "").slice(0, 13)); pull.reset(); }} inputMode="numeric" autoFocus /></label>
        <button className="btn" disabled={edb.length !== 13 || pull.req?.status === "pending"} onClick={() => pull.start({ edb })}>Повлечи од УЈП</button>
      </div>
      <UjpPullStatus req={pull.req} err={pull.err} />
      {done && <form onSubmit={create} className="stack">
        <CompanyCard c={done} />
        {err && <p className="alert">{err}</p>}
        <div className="form-grid">
          <label>Префикс за фактури<input name="prefix" required maxLength={10} pattern="[A-Za-z0-9]{1,10}" placeholder="UP" title="До 10 латинични букви или цифри" /></label>
          <div className="span2"><label>Е-пошта<input name="email" type="email" /></label></div>
          <label>Телефон<input name="phone" /></label>
        </div>
        <div className="row-actions"><button className="btn btn-primary">Креирај фирма</button><button type="button" className="link" onClick={() => onDone()}>Откажи</button></div>
      </form>}
      {!done && <button className="link" onClick={() => onDone()}>Откажи</button>}
    </section>
  );
}

function CheckClient({ c, onDone }: { c: Row; onDone: (changed: number | null) => void }) {
  const pull = useUjpPull();
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void pull.start({ clientId: c.id }); }, [c.id]);
  async function apply() {
    try { onDone((await api.post<{ changed: number }>(`/api/ujp/registry-requests/${pull.req!.id}/apply`)).changed); }
    catch (x) { setErr((x as ApiError).message); }
  }
  return (
    <section className="panel stack">
      <h2>{c.name}: проверка во УЈП</h2>
      <UjpPullStatus req={pull.req} err={pull.err ?? err} />
      {pull.req?.status === "done" && pull.req.diff && <>
        <DiffTable diff={pull.req.diff} />
        <div className="row-actions">
          <button className="btn btn-primary" onClick={apply}>{pull.req.diff.length ? "Примени од УЈП" : "Означи „УЈП ✓“"}</button>
          <button className="link" onClick={() => onDone(null)}>Затвори</button>
        </div>
      </>}
      {pull.req?.status !== "done" && <button className="link" onClick={() => onDone(null)}>Затвори</button>}
    </section>
  );
}

function ClientModules({ c, catalog, onDone }: { c: Row; catalog: import("../components/Modules").ModuleDef[]; onDone: (saved: boolean) => void }) {
  const [v, setV] = useState<string[]>(c.modules);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    try { await api.put(`/api/clients/${c.id}/modules`, { modules: v }); onDone(true); } catch (x) { setErr((x as ApiError).message); }
  }
  return (
    <section className="panel stack">
      <h2>{c.name}: модули</h2>
      <p className="muted small">Вклучете ги модулите што ги користи оваа фирма. Сметководителите ги гледаат само вклучените, а во „Корисници и пристап“ може дополнително да се ограничат.</p>
      <ModulePicker catalog={catalog} value={v} onChange={setV} />
      {err && <p className="alert">{err}</p>}
      <div className="row-actions"><button className="btn btn-primary" onClick={save}>Зачувај модули</button><button className="link" onClick={() => onDone(false)}>Откажи</button></div>
    </section>
  );
}
