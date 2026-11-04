import { useEffect, useState, type FormEvent } from "react";
import { useOutletContext } from "react-router-dom";
import { api, ApiError, type ClientRef } from "../api";
import { useSession } from "../session";

interface Bank { account: string; bank: string }
interface Pdf { shortName?: string; tagline?: string; subtitle?: string; contactLine?: string; addressLines?: string[];
  bankAccounts?: Bank[]; invoiceTitle?: string; signatory?: string; paymentNote?: string; clausesTitle?: string;
  receiverDeclaration?: string; showReceivedBy?: boolean }
interface Client { id: number; name: string; edb: string; embs: string | null; vatNumber: string | null; address: string; city: string;
  postalCode: string | null; invoiceClauses: string | null; pdfSettings: Pdf | null; ujpRegistryAt: string | null }

/** Izgled na PDF fakturata za klientot (format: UPSTREAM Фактура-Испратница). Samo administrator menuva. */
export function ClientSettings() {
  const ref = useOutletContext<ClientRef>();
  const { me } = useSession();
  const admin = me?.user?.role === "admin";
  const [c, setC] = useState<Client | null>(null);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  useEffect(() => {
    api.get<Client>(`/api/clients/${ref.id}`).then((x) => { setC(x); setBanks(x.pdfSettings?.bankAccounts ?? []); });
  }, [ref.id]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const pdfSettings: Pdf = {
      shortName: f.shortName, tagline: f.tagline, subtitle: f.subtitle, contactLine: f.contactLine,
      addressLines: (f.addressLines ?? "").split("\n").map((x) => x.trim()).filter(Boolean),
      bankAccounts: banks.filter((b) => b.account.trim()), invoiceTitle: f.invoiceTitle, signatory: f.signatory,
      paymentNote: f.paymentNote, clausesTitle: f.clausesTitle, receiverDeclaration: f.receiverDeclaration,
      showReceivedBy: f.showReceivedBy === "on",
    };
    try {
      setC(await api.patch<Client>(`/api/clients/${ref.id}`, { pdfSettings, invoiceClauses: f.invoiceClauses || null }));
      setMsg({ kind: "ok", text: "Поставките се зачувани. Важат за секој нов PDF." });
    } catch (x) { setMsg({ kind: "err", text: (x as ApiError).message }); }
  }
  if (!c) return <p className="muted">Се вчитува…</p>;
  const p = c.pdfSettings ?? {};
  const dis = !admin;
  return (
    <>
      <header className="page-head"><h1>Поставки на клиентот</h1></header>
      <p className="muted">Ова е изгледот на PDF фактурата. Назив, ЕДБ, адреса и ДДВ број доаѓаат од регистарот на УЈП и не се менуваат тука.</p>
      <dl className="facts">
        <div><dt>Назив (УЈП)</dt><dd>{c.name}</dd></div><div><dt>ЕДБ / ДДВ</dt><dd>{c.edb} · {c.vatNumber ?? "–"}</dd></div>
        <div><dt>ЕМБС</dt><dd>{c.embs ?? "–"}</dd></div><div><dt>Адреса</dt><dd>{c.address}, {c.postalCode} {c.city}</dd></div>
      </dl>
      {msg && <p className={msg.kind === "ok" ? "notice" : "alert"} role="status">{msg.text}</p>}
      <form className="panel form-grid" onSubmit={submit}>
        <h2 className="span-all">Заглавје (лево)</h2>
        <div className="span2"><label>Дејност (над називот)<input name="tagline" defaultValue={p.tagline} disabled={dis} placeholder="Друштво за производство, трговија и услуги" /></label></div>
        <div className="span2"><label>Краток назив (голем)<input name="shortName" defaultValue={p.shortName} disabled={dis} placeholder="УПСТРЕАМ ДООЕЛ" maxLength={60} /></label></div>
        <div className="span2"><label>Под називот<input name="subtitle" defaultValue={p.subtitle} disabled={dis} placeholder="увоз-извоз Крива Паланка" /></label></div>
        <div className="span2"><label>Контакт (веб | е-пошта | телефон)<input name="contactLine" defaultValue={p.contactLine} disabled={dis} /></label></div>
        <div className="span-all"><label>Адреси (секоја во нов ред; **текст** = задебелено)
          <textarea name="addressLines" rows={3} defaultValue={(p.addressLines ?? []).join("\n")} disabled={dis} /></label></div>
        <div className="span-all banks">
          <span className="lbl">Жиро-сметки</span>
          {banks.map((b, i) => (
            <div key={i} className="bank-row">
              <input value={b.account} onChange={(e) => setBanks(banks.map((x, k) => k === i ? { ...x, account: e.target.value } : x))} placeholder="210076965310159" aria-label="Жиро-сметка" disabled={dis} />
              <input value={b.bank} onChange={(e) => setBanks(banks.map((x, k) => k === i ? { ...x, bank: e.target.value } : x))} placeholder="НЛБ Банка АД Скопје" aria-label="Банка" disabled={dis} />
              {admin && <button type="button" className="icon" onClick={() => setBanks(banks.filter((_, k) => k !== i))} aria-label="Отстрани сметка">×</button>}
            </div>))}
          {admin && banks.length < 5 && <button type="button" className="btn" onClick={() => setBanks([...banks, { account: "", bank: "" }])}>Додај сметка</button>}
        </div>

        <h2 className="span-all">Наслов и потпис</h2>
        <label>Наслов на фактура<input name="invoiceTitle" defaultValue={p.invoiceTitle} disabled={dis} placeholder="Фактура-Испратница" /></label>
        <div className="span2"><label>Лице овластено за потпишување<input name="signatory" defaultValue={p.signatory} disabled={dis} /></label></div>
        <label className="check"><input type="checkbox" name="showReceivedBy" defaultChecked={p.showReceivedBy ?? true} disabled={dis} /> „Примил (Име и Презиме, Потпис)“</label>

        <h2 className="span-all">Подножје</h2>
        <div className="span-all"><label>Напомена за плаќање (задебелено)<input name="paymentNote" defaultValue={p.paymentNote} disabled={dis} /></label></div>
        <div className="span-all"><label>Наслов на клаузулите (задебелено)<input name="clausesTitle" defaultValue={p.clausesTitle} disabled={dis} /></label></div>
        <div className="span-all"><label>Клаузули (секоја во нов ред)<textarea name="invoiceClauses" rows={7} defaultValue={c.invoiceClauses ?? ""} disabled={dis} /></label></div>
        <div className="span-all"><label>Изјава под „Примил“<textarea name="receiverDeclaration" rows={2} defaultValue={p.receiverDeclaration} disabled={dis} /></label></div>
        {admin ? <div className="span-all row-actions"><button className="btn btn-primary">Зачувај</button></div>
          : <p className="muted span-all">Само администратор може да ги менува поставките.</p>}
      </form>
    </>
  );
}
