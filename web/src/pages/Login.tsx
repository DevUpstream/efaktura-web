import { useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { api, ApiError } from "../api";
import { useSession } from "../session";

const LOGIN_ERRORS: Record<string, string> = {
  no_access: "Вашата Microsoft сметка нема пристап. Побарајте од администраторот да ве додаде.",
  tenant: "Најавата е дозволена само со сметка од организацијата.",
  expired: "Најавата истече. Обидете се повторно.",
  microsoft: "Microsoft ја одби најавата. Обидете се повторно.",
  not_configured: "Најавата со Microsoft не е поставена на серверот.",
};

export function Login() {
  const { me, refresh, logout } = useSession();
  const [err, setErr] = useState<string | null>(() => {
    const e = new URLSearchParams(location.search).get("login_error");
    return e ? LOGIN_ERRORS[e] ?? "Најавата не успеа." : null;
  });
  useEffect(() => { if (location.search.includes("login_error")) history.replaceState(null, "", "/"); }, []);

  if (me?.pending === "totp") return <TotpVerify onDone={refresh} onCancel={logout} />;
  if (me?.pending === "totp_setup") return <TotpSetup onDone={refresh} onCancel={logout} />;
  return (
    <main className="login">
      <section className="login-card">
        <h1>е-Фактура</h1>
        <p className="muted">Издавање е-фактури кон УЈП за клиентите на бирото.</p>
        {err && <p className="alert" role="alert">{err}</p>}
        {me?.entra !== false && (
          <a className="btn btn-primary btn-block" href="/api/auth/entra/login">Најави се со Microsoft</a>
        )}
        <details className="local-login">
          <summary>Најава со сопствена сметка</summary>
          <LocalLogin onDone={refresh} onError={setErr} />
        </details>
      </section>
    </main>
  );
}

function LocalLogin({ onDone, onError }: { onDone: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try { await api.post("/api/auth/login", { email: f.get("email"), password: f.get("password") }); onDone(); }
    catch (x) { onError((x as ApiError).message); }
    finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="stack">
      <label>Е-пошта<input name="email" type="email" autoComplete="username" required /></label>
      <label>Лозинка<input name="password" type="password" autoComplete="current-password" required /></label>
      <button className="btn" disabled={busy}>{busy ? "Се најавува…" : "Најави се"}</button>
    </form>
  );
}

function CodeForm({ url, label, onDone }: { url: string; label: string; onDone: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try { await api.post(url, { code: new FormData(e.currentTarget).get("code") }); onDone(); }
    catch (x) { setErr((x as ApiError).message); }
  }
  return (
    <form onSubmit={submit} className="stack">
      {err && <p className="alert" role="alert">{err}</p>}
      <label>{label}<input name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" autoFocus required className="code" /></label>
      <button className="btn btn-primary">Потврди</button>
    </form>
  );
}

function TotpVerify({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  return (
    <main className="login"><section className="login-card">
      <h1>Потврда со код</h1>
      <p className="muted">Внесете го кодот од апликацијата за автентикација на телефонот.</p>
      <CodeForm url="/api/auth/totp/verify" label="Шестцифрен код" onDone={onDone} />
      <button className="link" onClick={onCancel}>Откажи</button>
    </section></main>
  );
}

function TotpSetup({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [s, setS] = useState<{ secret: string; qr: string } | null>(null);
  useEffect(() => {
    api.post<{ secret: string; uri: string }>("/api/auth/totp/setup")
      .then(async (r) => setS({ secret: r.secret, qr: await QRCode.toDataURL(r.uri, { margin: 1, width: 220 }) }));
  }, []);
  return (
    <main className="login"><section className="login-card">
      <h1>Двофакторска заштита</h1>
      <p className="muted">Скенирајте го кодот со Microsoft Authenticator или Google Authenticator, па внесете го шестцифрениот код.</p>
      {s && <>
        <img src={s.qr} alt="QR код за апликацијата за автентикација" width={220} height={220} className="qr" />
        <p className="muted small">Или внесете рачно: <code className="secret">{s.secret.match(/.{1,4}/g)!.join(" ")}</code></p>
        <CodeForm url="/api/auth/totp/confirm" label="Код од апликацијата" onDone={onDone} />
      </>}
      <button className="link" onClick={onCancel}>Откажи</button>
    </section></main>
  );
}
