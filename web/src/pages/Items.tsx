import { useEffect, useState, type FormEvent } from "react";
import { useOutletContext } from "react-router-dom";
import { api, ApiError, type ClientRef, type Item, type VatRate } from "../api";
import { money } from "../format";

export function Items() {
  const client = useOutletContext<ClientRef>();
  const [rows, setRows] = useState<Item[] | null>(null);
  const [rates, setRates] = useState<VatRate[]>([]);
  const [edit, setEdit] = useState<Item | "new" | null>(null);
  const load = () => api.get<Item[]>(`/api/clients/${client.id}/items`).then(setRows);
  useEffect(() => { setRows(null); setEdit(null); void load(); api.get<VatRate[]>("/api/vat-rates").then(setRates); }, [client.id]);
  const rate = (id: number) => rates.find((r) => r.id === id);

  return (
    <>
      <header className="page-head"><h1>Артикли и услуги</h1><button className="btn btn-primary" onClick={() => setEdit("new")}>Нов артикл</button></header>
      {edit && <ItemForm client={client} it={edit === "new" ? null : edit} rates={rates} onDone={() => { setEdit(null); void load(); }} />}
      {rows && rows.length === 0 && <div className="empty"><p>Сè уште нема артикли. Додадете го првиот.</p></div>}
      {rows && rows.length > 0 && (
        <div className="table-wrap"><table className="grid">
          <thead><tr><th>Шифра</th><th>Назив</th><th>Тип</th><th>Ед.</th><th className="num">Цена без ДДВ</th><th>ДДВ</th></tr></thead>
          <tbody>{rows.map((it) => (
            <tr key={it.id} onClick={() => setEdit(it)} className={it.isActive ? "" : "row-inactive"}>
              <td><button className="link" onClick={() => setEdit(it)}>{it.code}</button></td>
              <td>{it.name}{!it.isActive && <span className="doctype">неактивен</span>}</td>
              <td>{it.type === "service" ? "Услуга" : "Стока"}</td><td>{it.unit}</td>
              <td className="num">{money(it.unitPrice)}</td><td>{rate(it.vatRateId) ? `${Number(rate(it.vatRateId)!.ratePct)}%` : "–"}</td>
            </tr>))}
          </tbody>
        </table></div>
      )}
    </>
  );
}

function ItemForm({ client, it, rates, onDone }: { client: ClientRef; it: Item | null; rates: VatRate[]; onDone: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const body = { ...f, unitPrice: Number(String(f.unitPrice).replace(",", ".")), vatRateId: Number(f.vatRateId), isActive: f.isActive === "on" };
    try {
      if (it) await api.patch(`/api/clients/${client.id}/items/${it.id}`, body);
      else await api.post(`/api/clients/${client.id}/items`, body);
      onDone();
    } catch (x) { setErr((x as ApiError).message); }
  }
  return (
    <form className="panel form-grid" onSubmit={submit}>
      <h2 className="span-all">{it ? `${it.code} · ${it.name}` : "Нов артикл"}</h2>
      {err && <p className="alert span-all">{err}</p>}
      <label>Шифра<input name="code" defaultValue={it?.code} required maxLength={30} /></label>
      <div className="span2"><label>Назив<input name="name" defaultValue={it?.name} required minLength={2} /></label></div>
      <label>Тип<select name="type" defaultValue={it?.type ?? "service"}><option value="service">Услуга</option><option value="goods">Стока</option></select></label>
      <label>Единица мерка<input name="unit" defaultValue={it?.unit ?? "ком"} required maxLength={10} /></label>
      <label>Цена без ДДВ<input name="unitPrice" inputMode="decimal" defaultValue={it ? Number(it.unitPrice) : ""} required /></label>
      <label>ДДВ стапка<select name="vatRateId" defaultValue={it?.vatRateId ?? rates.find((r) => r.code === "S18")?.id}>
        {rates.filter((r) => r.isActive).map((r) => <option key={r.id} value={r.id}>{Number(r.ratePct)}% · {r.name}</option>)}
      </select></label>
      <label className="check"><input type="checkbox" name="isActive" defaultChecked={it?.isActive ?? true} /> Активен</label>
      <div className="span-all row-actions"><button className="btn btn-primary">Зачувај</button><button type="button" className="link" onClick={onDone}>Откажи</button></div>
    </form>
  );
}
