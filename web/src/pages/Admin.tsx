import { useEffect, useState, type FormEvent } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { api, ApiError, type ClientRef } from "../api";
import { useSession } from "../session";
import { date } from "../format";
import { ModulePicker, useModuleCatalog } from "../components/Modules";

interface U { id: number; email: string; displayName: string; provider: "entra" | "local"; role: "admin" | "accountant";
  isActive: boolean; totpEnabled: boolean; entraLinked: boolean; hasPassword: boolean; lastLoginAt: string | null;
  lockedUntil: string | null; clientIds: number[]; clientModules: Record<number, string[] | null> }

export function Admin() {
  const { me } = useSession();
  const clients = me?.clients ?? [];
  const current = useOutletContext<ClientRef>();
  const catalog = useModuleCatalog();
  const [modUser, setModUser] = useState<number | null>(null);
  const [users, setUsers] = useState<U[] | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [invite, setInvite] = useState<{ email: string; link: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const load = () => api.get<U[]>("/api/users").then(setUsers).catch((e) => setMsg({ kind: "err", text: e.message }));
  useEffect(() => { void load(); }, []);

  async function run(f: () => Promise<unknown>, ok?: string) {
    setMsg(null);
    try { await f(); await load(); if (ok) setMsg({ kind: "ok", text: ok }); }
    catch (e) { setMsg({ kind: "err", text: (e as ApiError).message }); }
  }
  const access = (u: U, clientId: number, isActive: boolean) =>
    run(() => api.put(`/api/clients/${clientId}/access/${u.id}`, { isActive }));
  const patch = (u: U, body: Partial<U>) => run(() => api.patch(`/api/users/${u.id}`, body));
  const sendInvite = (u: U) => run(async () => {
    const r = await api.post<{ link: string }>(`/api/users/${u.id}/invite`);
    setInvite({ email: u.email, link: r.link });
  });

  if (me?.user?.role !== "admin") return <p className="alert">Само за администратори.</p>;
  return (
    <>
      <header className="page-head"><h1>Корисници и пристап</h1><div className="row-actions">
        <Link className="btn" to={`/c/${current.id}/clients`}>Нова фирма</Link>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>Нов корисник</button></div></header>
      <p className="muted small">Колоните {clients.map((c) => c.prefix).join(", ")} се фирмите што ги водите. Нова фирма (на пр. MRFP) прво се додава со „Нова фирма“, па тука се појавува како колона за доделување.</p>
      {msg && <p className={msg.kind === "ok" ? "notice" : "alert"} role="status">{msg.text}</p>}
      {invite && (
        <div className="panel">
          <h2>Линк за {invite.email}</h2>
          <p className="muted">Испратете му го линкот лично (е-пошта или порака). Важи 72 часа и може да се искористи еднаш.</p>
          <div className="row-actions"><input readOnly value={invite.link} onFocus={(e) => e.currentTarget.select()} aria-label="Линк за поставување лозинка" />
            <button className="btn" onClick={() => navigator.clipboard.writeText(invite.link).then(() => setMsg({ kind: "ok", text: "Линкот е копиран." }))}>Копирај</button>
            <button className="link" onClick={() => setInvite(null)}>Затвори</button></div>
        </div>
      )}
      {adding && <NewUser onDone={(created) => { setAdding(false); void load(); if (created) setMsg({ kind: "ok", text: created }); }} />}
      {users && (
        <div className="table-wrap">
          <table className="grid users">
            <thead><tr><th>Корисник</th><th>Најава</th><th>Улога</th>{clients.map((c) => <th key={c.id} title={c.name}>{c.prefix}</th>)}<th>Активен</th><th /></tr></thead>
            <tbody>{users.map((u) => {
              const self = u.id === me.user!.id;
              return (
                <tr key={u.id} className={u.isActive ? "" : "row-inactive"}>
                  <td><strong>{u.displayName}</strong><br /><span className="muted small">{u.email}</span></td>
                  <td className="small">
                    {u.provider === "entra" ? "Microsoft" : "Сопствена"}
                    <br /><span className="muted">{u.provider === "entra" ? (u.entraLinked ? `последно ${u.lastLoginAt ? date(u.lastLoginAt.slice(0, 10)) : "–"}` : "уште не е најавен")
                      : !u.hasPassword ? "чека покана" : u.totpEnabled ? "лозинка + код" : "без код (2FA)"}</span>
                    {u.lockedUntil && new Date(u.lockedUntil) > new Date() && <><br /><span className="chip err">заклучен</span></>}
                  </td>
                  <td><select value={u.role} disabled={self} onChange={(e) => patch(u, { role: e.target.value as U["role"] })} aria-label={`Улога за ${u.email}`}>
                    <option value="accountant">Сметководител</option><option value="admin">Администратор</option></select></td>
                  {clients.map((c) => (
                    <td key={c.id} className="center">
                      <input type="checkbox" checked={u.role === "admin" || u.clientIds.includes(c.id)} disabled={u.role === "admin"}
                        title={u.role === "admin" ? "Администраторот ги гледа сите фирми" : c.name}
                        onChange={(e) => access(u, c.id, e.target.checked)} aria-label={`${u.email} – пристап до ${c.name}`} />
                      {u.role !== "admin" && u.clientIds.includes(c.id) && <button className="link small mods-link" onClick={() => setModUser(modUser === u.id ? null : u.id)}>
                        {u.clientModules[c.id] ? `${u.clientModules[c.id]!.filter((k) => c.modules.includes(k)).length + 1}/${c.modules.length} мод.` : "сите мод."}</button>}
                    </td>))}
                  <td className="center"><input type="checkbox" checked={u.isActive} disabled={self} onChange={(e) => patch(u, { isActive: e.target.checked })} aria-label={`${u.email} активен`} /></td>
                  <td>{u.provider === "local" && <button className="link" onClick={() => sendInvite(u)}>{u.hasPassword ? "Нова лозинка" : "Линк за покана"}</button>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      {modUser !== null && users?.find((x) => x.id === modUser) && <UserModules u={users.find((x) => x.id === modUser)!} clients={clients} catalog={catalog}
        onDone={() => { setModUser(null); void load(); }} />}
      <AgentKeys />
      <p className="muted small">Microsoft корисниците се најавуваат со својата сметка од организацијата (MFA е кај Microsoft). Сопствените сметки добиваат линк за лозинка и при првата најава поставуваат апликација за кодови.</p>
    </>
  );
}

function NewUser({ onDone }: { onDone: (msg?: string) => void }) {
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api.post("/api/users", f);
      onDone(f.provider === "local" ? "Корисникот е додаден. Направете му линк за покана." : "Корисникот е додаден. Може да се најави со Microsoft; доделете му фирми.");
    } catch (x) { setErr((x as ApiError).message); }
  }
  return (
    <form className="panel form-grid" onSubmit={submit}>
      <h2 className="span-all">Нов корисник</h2>
      {err && <p className="alert span-all">{err}</p>}
      <div className="span2"><label>Име и презиме<input name="displayName" required minLength={2} /></label></div>
      <div className="span2"><label>Е-пошта<input name="email" type="email" required /></label></div>
      <label>Најава<select name="provider" defaultValue="entra"><option value="entra">Microsoft сметка</option><option value="local">Сопствена (лозинка + код)</option></select></label>
      <label>Улога<select name="role" defaultValue="accountant"><option value="accountant">Сметководител</option><option value="admin">Администратор</option></select></label>
      <div className="span-all row-actions"><button className="btn btn-primary">Додај</button><button type="button" className="link" onClick={() => onDone()}>Откажи</button></div>
    </form>
  );
}

interface Key { id: number; name: string; isActive: boolean; lastUsedAt: string | null; createdAt: string }

/** Kluchevi za lokalniot agent (kompjuterot so tokenot). Klucot se gleda samo pri kreiranje. */
function AgentKeys() {
  const [keys, setKeys] = useState<Key[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api.get<Key[]>("/api/agent-keys").then(setKeys);
  useEffect(() => { void load(); }, []);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get("name"));
    try { setFresh((await api.post<{ key: string }>("/api/agent-keys", { name })).key); form.reset(); await load(); }
    catch (x) { setErr((x as ApiError).message); }
  }
  return (
    <section className="panel stack">
      <h2>Агент (компјутер со токенот)</h2>
      <p className="muted">Агентот ги извршува барањата кон УЈП (регистар, подоцна праќање фактури) бидејќи УЈП не е достапен од серверот. Секој компјутер со агент добива свој клуч.</p>
      {err && <p className="alert">{err}</p>}
      {fresh && <div className="notice stack">
        <strong>Клучот се прикажува само сега. Копирајте го во agent.config.psd1 (ServerAgentKey) на компјутерот со токенот.</strong>
        <div className="row-actions"><input readOnly value={fresh} className="key-box" onFocus={(e) => e.currentTarget.select()} aria-label="Клуч за агентот" />
          <button className="btn" onClick={() => navigator.clipboard.writeText(fresh)}>Копирај</button>
          <button className="link" onClick={() => setFresh(null)}>Готово</button></div>
      </div>}
      {keys.length > 0 && <div className="table-wrap"><table className="grid">
        <thead><tr><th>Име</th><th>Последно се јавил</th><th>Активен</th></tr></thead>
        <tbody>{keys.map((k) => <tr key={k.id} className={k.isActive ? "" : "row-inactive"}>
          <td>{k.name}</td><td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString("mk-MK") : "никогаш"}</td>
          <td><input type="checkbox" checked={k.isActive} onChange={(e) => api.patch(`/api/agent-keys/${k.id}`, { isActive: e.target.checked }).then(load)} aria-label={`${k.name} активен`} /></td>
        </tr>)}</tbody></table></div>}
      <form onSubmit={create} className="row-actions">
        <label className="grow">Име на компјутерот<input name="name" required minLength={2} placeholder="Сметководство – компјутер со токен" /></label>
        <button className="btn">Нов клуч</button>
      </form>
    </section>
  );
}

function UserModules({ u, clients, catalog, onDone }: { u: U; clients: ClientRef[]; catalog: import("../components/Modules").ModuleDef[]; onDone: () => void }) {
  const mine = clients.filter((c) => u.clientIds.includes(c.id));
  const [sel, setSel] = useState<Record<number, string[] | null>>(() => Object.fromEntries(mine.map((c) => [c.id, u.clientModules[c.id] ?? null])));
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    try {
      for (const c of mine) await api.put(`/api/clients/${c.id}/access/${u.id}`, { modules: sel[c.id] ?? null });
      onDone();
    } catch (x) { setErr((x as ApiError).message); }
  }
  return (
    <section className="panel stack">
      <h2>{u.displayName}: модули по фирма</h2>
      <p className="muted small">„Сите модули“ значи сè што е вклучено за фирмата, вклучително и модулите што ќе ги вклучите подоцна. Излезните фактури се секогаш достапни.</p>
      <div className="user-mods">{mine.map((c) => (
        <div key={c.id} className="stack">
          <strong>{c.prefix} <span className="muted small">{c.name}</span></strong>
          <label className="check"><input type="checkbox" checked={sel[c.id] === null} onChange={(e) => setSel({ ...sel, [c.id]: e.target.checked ? null : c.modules.filter((k) => k !== "invoices") })} /> Сите модули на фирмата</label>
          {sel[c.id] !== null && <ModulePicker catalog={catalog} allowed={c.modules} value={sel[c.id]!} onChange={(v) => setSel({ ...sel, [c.id]: v.filter((k) => k !== "invoices") })} />}
        </div>))}</div>
      {err && <p className="alert">{err}</p>}
      <div className="row-actions"><button className="btn btn-primary" onClick={save}>Зачувај</button><button className="link" onClick={onDone}>Откажи</button></div>
    </section>
  );
}
