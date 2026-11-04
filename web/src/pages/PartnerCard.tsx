import { useEffect, useState, type FormEvent } from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { api, ApiError, type ClientRef, type Contact, type Note, type NoteKind, type PartnerCardData } from "../api";
import { addDays, date, dateTime, DOC, money0, NOTE_KIND, STATUS, today } from "../format";
import { CheckPartner, PartnerForm } from "./Partners";

/** Kartica na kupuvac: podatoci, kontakt lica, istorija na komunikacija so potsetnici, fakturi. */
export function PartnerCard() {
  const client = useOutletContext<ClientRef>();
  const { id } = useParams();
  const [d, setD] = useState<PartnerCardData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"edit" | "check" | null>(null);
  const [contact, setContact] = useState<Contact | "new" | null>(null);
  const load = () => api.get<PartnerCardData>(`/api/clients/${client.id}/partners/${id}`).then(setD, (x) => setErr((x as ApiError).message));
  useEffect(() => { setD(null); setMode(null); setContact(null); void load(); }, [client.id, id]);

  if (err) return <div className="empty"><p>{err}</p><Link to={`/c/${client.id}/partners`}>Назад кон купувачите</Link></div>;
  if (!d) return <p className="muted">Се вчитува…</p>;
  const p = d.partner;
  const open = d.notes.filter((n) => n.followUpAt && !n.followUpDoneAt).sort((a, b) => a.followUpAt!.localeCompare(b.followUpAt!));

  return (
    <>
      <Link className="back" to={`/c/${client.id}/partners`}>← Купувачи</Link>
      <header className="page-head">
        <div><h1>{p.name}</h1>
          <p className="muted small">{[p.edb && `ЕДБ ${p.edb}`, p.vatNumber && `ДДВ ${p.vatNumber}`, [p.address, p.city].filter(Boolean).join(", ")].filter(Boolean).join("   ")}
            {p.ujpRegistryAt && <span className="chip ok" style={{ marginLeft: 10 }}>УЈП ✓</span>}</p></div>
        <div className="row-actions">
          <Link className="btn" to={`/c/${client.id}/invoices/new?partner=${p.id}`}>Нова фактура</Link>
          <button className="btn" onClick={() => setMode("edit")}>Уреди податоци</button></div>
      </header>
      {mode === "edit" && <PartnerForm client={client} p={p} onDone={() => { setMode(null); void load(); }} onCheck={p.edb ? () => setMode("check") : undefined} />}
      {mode === "check" && <CheckPartner client={client} p={p} onDone={() => { setMode(null); void load(); }} />}

      {open.length > 0 && (
        <section className="followups-strip">
          {open.map((n) => <FollowUpLine key={n.id} n={n} contacts={d.contacts} onDone={async () => {
            await api.post(`/api/clients/${client.id}/partners/${p.id}/notes/${n.id}/done`); void load(); }} />)}
        </section>
      )}

      <div className="card-cols">
        <section className="panel stack">
          <div className="sec-head"><h2>Историја</h2></div>
          <NoteForm client={client} partnerId={p.id} contacts={d.contacts.filter((c) => c.isActive)} onSaved={load} />
          {d.notes.length === 0 ? <p className="muted">Сè уште нема записи. Запишете го првиот разговор или договор.</p> : (
            <ol className="timeline">{d.notes.map((n) => {
              const who = d.contacts.find((c) => c.id === n.contactId);
              return (
                <li key={n.id}>
                  <div className="tl-meta"><strong>{NOTE_KIND[n.kind]}</strong>{who && <> со {who.name}</>}
                    <span className="muted"> · {dateTime(n.createdAt)}{n.author && `, ${n.author}`}</span></div>
                  <p className="tl-text">{n.text}</p>
                  {n.followUpAt && <p className="small">{n.followUpDoneAt
                    ? <span className="muted">Потсетник за {date(n.followUpAt)}, завршен {date(n.followUpDoneAt.slice(0, 10))}</span>
                    : <span className={n.followUpAt < today() ? "chip err" : "chip wait"}>Потсетник: {date(n.followUpAt)}</span>}</p>}
                </li>);
            })}</ol>
          )}
        </section>

        <div className="stack">
          <section className="panel stack">
            <div className="sec-head"><h2>Контакт лица</h2>{contact !== "new" && <button className="link" onClick={() => setContact("new")}>Додај</button>}</div>
            {contact && <ContactForm client={client} partnerId={p.id} c={contact === "new" ? null : contact} onDone={() => { setContact(null); void load(); }} />}
            {d.contacts.length === 0 && !contact && <p className="muted">Нема контакт лица.{p.phone || p.email ? " Општ контакт е подолу." : ""}</p>}
            <ul className="contacts">{d.contacts.map((c) => (
              <li key={c.id} className={c.isActive ? "" : "inactive"}>
                <div className="c-name"><strong>{c.name}</strong>{c.isPrimary && <span className="chip ok">главен</span>}{!c.isActive && <span className="chip">не е активен</span>}
                  <button className="link small" onClick={() => setContact(c)}>Уреди</button></div>
                {c.role && <div className="muted small">{c.role}</div>}
                <div className="c-reach">
                  {c.mobile && <a href={`tel:${c.mobile.replace(/\s/g, "")}`}>моб. {c.mobile}</a>}
                  {c.phone && <a href={`tel:${c.phone.replace(/\s/g, "")}`}>тел. {c.phone}</a>}
                  {c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}</div>
              </li>))}</ul>
            {(p.phone || p.email) && <p className="small muted">Фирма: {[p.phone, p.email].filter(Boolean).join(", ")}</p>}
          </section>

          {client.modules.includes("payments") && <Balance client={client} partnerId={p.id} />}
          <section className="panel stack">
            <div className="sec-head"><h2>Фактури</h2></div>
            {d.invoices.length === 0 ? <p className="muted">Нема фактури за овој купувач.</p> : (
              <table className="grid compact"><tbody>{d.invoices.slice(0, 15).map((i) => (
                <tr key={i.id}><td><Link className="docno" to={`/c/${client.id}/invoices/${i.id}`}>{i.number ?? "Нацрт"}</Link>
                  {i.docType !== "INV" && <span className="doctype">{DOC[i.docType]}</span>}<br /><span className="muted small">{date(i.issueDate)} · {STATUS[i.status]}</span></td>
                  <td className="num">{money0(i.payableAmount ?? i.grossTotal)}</td></tr>))}</tbody></table>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function FollowUpLine({ n, contacts, onDone }: { n: Note; contacts: Contact[]; onDone: () => void }) {
  const late = n.followUpAt! < today();
  const who = contacts.find((c) => c.id === n.contactId);
  return (
    <div className={`fu ${late ? "late" : n.followUpAt === today() ? "now" : ""}`}>
      <span className="fu-date">{late ? "Задоцнето · " : n.followUpAt === today() ? "Денес · " : ""}{date(n.followUpAt)}</span>
      <span className="fu-text">{n.text}{who && <span className="muted"> ({who.name}{who.mobile ? `, ${who.mobile}` : who.phone ? `, ${who.phone}` : ""})</span>}</span>
      <button className="btn" onClick={onDone}>Завршено</button>
    </div>
  );
}

function NoteForm({ client, partnerId, contacts, onSaved }: { client: ClientRef; partnerId: number; contacts: Contact[]; onSaved: () => void }) {
  const [kind, setKind] = useState<NoteKind>("call");
  const [fu, setFu] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setBusy(true); setErr(null);
    try {
      await api.post(`/api/clients/${client.id}/partners/${partnerId}/notes`, { kind, text: f.text, contactId: f.contactId ? Number(f.contactId) : null, followUpAt: fu || null });
      form.reset(); setFu(""); onSaved();
    } catch (x) { setErr((x as ApiError).message); } finally { setBusy(false); }
  }
  const quick: [string, number][] = [["Утре", 1], ["За 3 дена", 3], ["За недела", 7], ["За месец", 30]];
  return (
    <form className="note-form stack" onSubmit={submit}>
      <div className="seg" role="tablist" aria-label="Вид на запис">{(Object.keys(NOTE_KIND) as NoteKind[]).map((k) => (
        <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>{NOTE_KIND[k]}</button>))}</div>
      <label>Што беше договорено<textarea name="text" rows={3} required maxLength={4000} placeholder="На пр. Бара попуст за 2027, ќе се јави по Нова година." /></label>
      <div className="row-actions">
        {contacts.length > 0 && <label className="grow">Со кого<select name="contactId" defaultValue=""><option value="">–</option>
          {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
        <label>Потсети ме на<input type="date" value={fu} min={today()} onChange={(e) => setFu(e.target.value)} /></label>
        <div className="quick">{quick.map(([l, n]) => <button key={n} type="button" className="link small" onClick={() => setFu(addDays(today(), n))}>{l}</button>)}</div>
      </div>
      {err && <p className="alert">{err}</p>}
      <div className="row-actions"><button className="btn btn-primary" disabled={busy}>Запиши</button>
        <span className="muted small">Записите не се менуваат и не се бришат. Ако нешто се смени, додадете нов запис.</span></div>
    </form>
  );
}

function ContactForm({ client, partnerId, c, onDone }: { client: ClientRef; partnerId: number; c: Contact | null; onDone: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const body = { name: f.name, role: f.role, phone: f.phone, mobile: f.mobile, email: f.email, isPrimary: f.isPrimary === "on", isActive: f.isActive === "on" };
    try {
      if (c) await api.patch(`/api/clients/${client.id}/partners/${partnerId}/contacts/${c.id}`, body);
      else await api.post(`/api/clients/${client.id}/partners/${partnerId}/contacts`, body);
      onDone();
    } catch (x) { setErr((x as ApiError).message); }
  }
  return (
    <form className="contact-form form-grid" onSubmit={submit}>
      <div className="span2"><label>Име и презиме<input name="name" defaultValue={c?.name ?? ""} required minLength={2} autoFocus /></label></div>
      <div className="span2"><label>Функција<input name="role" defaultValue={c?.role ?? ""} placeholder="Сметководство, набавки…" /></label></div>
      <label>Мобилен<input name="mobile" type="tel" defaultValue={c?.mobile ?? ""} /></label>
      <label>Телефон<input name="phone" type="tel" defaultValue={c?.phone ?? ""} /></label>
      <div className="span2"><label>Е-пошта<input name="email" type="email" defaultValue={c?.email ?? ""} /></label></div>
      <label className="check"><input type="checkbox" name="isPrimary" defaultChecked={c?.isPrimary ?? false} /> Главен контакт</label>
      <label className="check"><input type="checkbox" name="isActive" defaultChecked={c?.isActive ?? true} /> Активен</label>
      {err && <p className="alert span-all">{err}</p>}
      <div className="span-all row-actions"><button className="btn btn-primary">{c ? "Зачувај" : "Додај контакт"}</button>
        <button type="button" className="link" onClick={onDone}>Откажи</button></div>
    </form>
  );
}

/** Salдо (modul Plakjanja): dolzi nam / mu dolzime, zadocneto. */
function Balance({ client, partnerId }: { client: ClientRef; partnerId: number }) {
  type R = { aging: { total: string; current: string }; byPartner: { unallocated: string }[] };
  const [d, setD] = useState<{ in: R; out: R } | null>(null);
  useEffect(() => {
    Promise.all([api.get<R>(`/api/clients/${client.id}/open-items?direction=in&partnerId=${partnerId}`), api.get<R>(`/api/clients/${client.id}/open-items?direction=out&partnerId=${partnerId}`)])
      .then(([a, b]) => setD({ in: a, out: b }), () => setD(null));
  }, [client.id, partnerId]);
  if (!d) return null;
  const late = (r: R) => Number(r.aging.total) - Number(r.aging.current);
  const free = (r: R) => Number(r.byPartner[0]?.unallocated ?? 0);
  return (
    <section className="panel stack">
      <div className="sec-head"><h2>Салдо</h2><Link className="link" to={`/c/${client.id}/payments`}>Наплата</Link></div>
      <dl className="totals small-totals">
        <div><dt>Ни должи</dt><dd>{money0(d.in.aging.total)}</dd></div>
        {late(d.in) > 0 && <div className="late-amt"><dt>од тоа задоцнето</dt><dd>{money0(late(d.in))}</dd></div>}
        {free(d.in) > 0 && <div><dt>Нераспоредена уплата</dt><dd>{money0(free(d.in))}</dd></div>}
        {Number(d.out.aging.total) > 0 && <div><dt>Ние му должиме</dt><dd>{money0(d.out.aging.total)}</dd></div>}
      </dl>
    </section>
  );
}
