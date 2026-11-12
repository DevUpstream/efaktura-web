import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { api, type ClientRef } from "../api";
import { date, money } from "../format";
import { Tabs } from "./Payments";

type Side = "customer" | "supplier" | "both";
interface Row { date: string; type: string; typeName: string; number: string; doc: number; src: string; note: string | null; debit: string; credit: string; balance: string }
interface Card { opening: string; debit: string; credit: string; closing: string; rows: Row[] }
const SIDE: Record<Side, string> = { customer: "Купувач", supplier: "Добавувач", both: "Заедно" };
const yearStart = () => `${new Date().getFullYear()}-01-01`;
const todayIso = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Skopje" });

function Period({ side, setSide, from, setFrom, to, setTo, sides }: { side: Side; setSide: (s: Side) => void; from: string; setFrom: (s: string) => void; to: string; setTo: (s: string) => void; sides: Side[] }) {
  return (
    <div className="toolbar">
      <div className="seg" role="tablist">{sides.map((s) => <button key={s} role="tab" aria-selected={side === s} onClick={() => setSide(s)}>{SIDE[s]}</button>)}</div>
      <label>од <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
      <label>до <input type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
    </div>
  );
}

/** Картица на партнер (на страницата на партнерот), docs/14. */
export function PartnerLedger({ client, partnerId, isCustomer, isSupplier }: { client: ClientRef; partnerId: number; isCustomer: boolean; isSupplier: boolean }) {
  const sides: Side[] = isCustomer && isSupplier ? ["both", "customer", "supplier"] : isSupplier ? ["supplier"] : ["customer"];
  const [side, setSide] = useState<Side>(sides[0]!);
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(todayIso());
  const [c, setC] = useState<Card | null>(null);
  const base = `/api/clients/${client.id}/partners/${partnerId}/card?side=${side}&from=${from}&to=${to}`;
  useEffect(() => { setC(null); api.get<Card>(base).then(setC); }, [base]);
  const link = (r: Row) => r.src === "invoice" ? `/c/${client.id}/invoices/${r.doc}` : r.src === "purchase" ? `/c/${client.id}/purchases/${r.doc}` : null;
  return (
    <section className="panel stack">
      <div className="sec-head"><h2>Картица</h2><div className="row-actions">
        <a className="btn btn-small" href={`${base}&format=pdf`} target="_blank" rel="noreferrer">PDF</a>
        <a className="btn btn-small" href={`${base}&format=csv`}>Excel (CSV)</a></div></div>
      <Period side={side} setSide={setSide} from={from} setFrom={setFrom} to={to} setTo={setTo} sides={sides} />
      <p className="muted small">{side === "supplier" ? "Салдо > 0 = ние должиме." : "Салдо > 0 = партнерот ни должи."} Салдото „Заедно“ е исто со салдото во ИОС.</p>
      {!c ? <p className="muted">Се вчитува…</p> : (
        <div className="table-wrap"><table className="grid compact">
          <thead><tr><th>Датум</th><th>Вид</th><th>Документ</th><th className="num">Должи</th><th className="num">Побарува</th><th className="num">Салдо</th></tr></thead>
          <tbody>
            <tr><td>{date(from)}</td><td colSpan={4}><em>Почетно салдо</em></td><td className="num">{money(c.opening)}</td></tr>
            {c.rows.map((r) => { const l = link(r); return (
              <tr key={`${r.src}${r.doc}${r.type}`}><td>{date(r.date)}</td><td>{r.typeName}</td>
                <td>{l ? <Link className="docno" to={l}>{r.number}</Link> : r.number}{r.note && <span className="muted small"> · {r.note}</span>}</td>
                <td className="num">{Number(r.debit) ? money(r.debit) : ""}</td><td className="num">{Number(r.credit) ? money(r.credit) : ""}</td><td className="num">{money(r.balance)}</td></tr>); })}
          </tbody>
          <tfoot><tr><td colSpan={3}><strong>Промет и крајно салдо</strong></td><td className="num"><strong>{money(c.debit)}</strong></td>
            <td className="num"><strong>{money(c.credit)}</strong></td><td className="num"><strong>{money(c.closing)}</strong></td></tr></tfoot>
        </table></div>)}
    </section>
  );
}

interface SumRow { partnerId: number; name: string; edb: string | null; opening: string; debit: string; credit: string; closing: string }
/** Збирни картици по партнери (Плаќања и наплата → Картици). */
export function Ledgers() {
  const client = useOutletContext<ClientRef>();
  const [side, setSide] = useState<Side>("customer");
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(todayIso());
  const [q, setQ] = useState("");
  const [r, setR] = useState<{ rows: SumRow[]; totals: Omit<SumRow, "partnerId" | "name" | "edb"> } | null>(null);
  const base = `/api/clients/${client.id}/partner-cards?side=${side}&from=${from}&to=${to}`;
  useEffect(() => { setR(null); api.get<typeof r>(base).then(setR); }, [base]);
  const shown = (r?.rows ?? []).filter((x) => !q.trim() || x.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <header className="page-head"><h1>Плаќања и наплата</h1><div className="row-actions"><Tabs c={client.id} /></div></header>
      <p className="muted small">Картици по партнери: почетно салдо, промет и крајно салдо за периодот. Ова не е главна книга; служи за усогласување со сметководителот.</p>
      <Period side={side} setSide={setSide} from={from} setFrom={setFrom} to={to} setTo={setTo} sides={["customer", "supplier", "both"]} />
      <div className="toolbar"><input type="search" placeholder="Партнер" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Пребарај" />
        <a className="btn" href={`${base}&format=csv`}>Excel (CSV)</a></div>
      {!r ? <p className="muted">Се вчитува…</p> : shown.length === 0 ? <div className="empty"><p>Нема промет.</p></div> : (
        <div className="table-wrap"><table className="grid">
          <thead><tr><th>Партнер</th><th className="num">Почетно</th><th className="num">Должи</th><th className="num">Побарува</th><th className="num">Крајно</th></tr></thead>
          <tbody>{shown.map((x) => <tr key={x.partnerId}><td><Link to={`/c/${client.id}/partners/${x.partnerId}`}>{x.name}</Link></td>
            <td className="num">{money(x.opening)}</td><td className="num">{money(x.debit)}</td><td className="num">{money(x.credit)}</td><td className="num"><strong>{money(x.closing)}</strong></td></tr>)}</tbody>
          <tfoot><tr><td><strong>Вкупно ({r.rows.length})</strong></td><td className="num">{money(r.totals.opening)}</td><td className="num">{money(r.totals.debit)}</td>
            <td className="num">{money(r.totals.credit)}</td><td className="num"><strong>{money(r.totals.closing)}</strong></td></tr></tfoot>
        </table></div>)}
    </>
  );
}
