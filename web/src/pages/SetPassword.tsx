import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";

export function SetPassword() {
  const token = location.hash.slice(1);
  const [state, setState] = useState<"form" | "done">("form");
  const [err, setErr] = useState<string | null>(token ? null : "Линкот е нецелосен. Отворете го линкот од поканата повторно.");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get("p1") !== f.get("p2")) return setErr("Лозинките не се исти.");
    try { await api.post("/api/auth/set-password", { token, password: f.get("p1") }); setState("done"); history.replaceState(null, "", "/set-password"); }
    catch (x) { setErr((x as ApiError).message); }
  }
  return (
    <main className="login"><section className="login-card">
      <h1>Поставете лозинка</h1>
      {state === "done" ? <>
        <p>Лозинката е поставена. При првата најава ќе поставите и двофакторска заштита.</p>
        <a className="btn btn-primary btn-block" href="/">Кон најава</a>
      </> : <form onSubmit={submit} className="stack">
        <p className="muted">Најмалку 12 знаци. Најдобро е реченица што лесно ја паметите.</p>
        {err && <p className="alert" role="alert">{err}</p>}
        <label>Нова лозинка<input name="p1" type="password" autoComplete="new-password" minLength={12} required /></label>
        <label>Повторете ја<input name="p2" type="password" autoComplete="new-password" minLength={12} required /></label>
        <button className="btn btn-primary" disabled={!token}>Зачувај</button>
      </form>}
    </section></main>
  );
}
