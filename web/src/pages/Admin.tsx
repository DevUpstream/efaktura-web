import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { useSession } from "../session";
import { date } from "../format";

interface U { id: number; email: string; displayName: string; provider: "entra" | "local"; role: "admin" | "accountant";
  isActive: boolean; totpEnabled: boolean; entraLinked: boolean; hasPassword: boolean; lastLoginAt: string | null;
  lockedUntil: string | null; clientIds: number[] }

export function Admin() {
  const { me } = useSession();
  const clients = me?.clients ?? [];
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
      <header className="page-head"><h1>Корисници и пристап</h1><button className="btn btn-primary" onClick={() => setAdding(true)}>Нов корисник</button></header>
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
                        title={u.role === "admin" ? "Администраторот ги гледа сите клиенти" : c.name}
                        onChange={(e) => access(u, c.id, e.target.checked)} aria-label={`${u.email} – пристап до ${c.name}`} />
                    </td>))}
                  <td className="center"><input type="checkbox" checked={u.isActive} disabled={self} onChange={(e) => patch(u, { isActive: e.target.checked })} aria-label={`${u.email} активен`} /></td>
                  <td>{u.provider === "local" && <button className="link" onClick={() => sendInvite(u)}>{u.hasPassword ? "Нова лозинка" : "Линк за покана"}</button>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
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
      onDone(f.provider === "local" ? "Корисникот е додаден. Направете му линк за покана." : "Корисникот е додаден. Може да се најави со Microsoft; доделете му клиенти.");
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
