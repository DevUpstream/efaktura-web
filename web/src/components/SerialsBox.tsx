/** Seriski broevi (zabeleska 9): eden po red; izbor od zalihata pri izlez. Ist del za faktura, vlezna faktura i magacinski dokument. */
import { useState } from "react";
import { api } from "../api";

/** Broevi od poleto (po red, zapirka, tocka-zapirka), bez prazni i duplikati. */
export const serialList = (t: string | undefined | null) => [...new Set((t ?? "").split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean))];

export function SerialsBox({ clientId, itemId, warehouseId, need, value, onChange, pick, label }: {
  clientId: number; itemId: number | null; warehouseId?: number | null; need: number; value: string; onChange: (t: string) => void; pick: boolean; label: string;
}) {
  const [avail, setAvail] = useState<{ id: number; serialNo: string }[] | null>(null);
  const list = serialList(value);
  async function load() {
    const q = new URLSearchParams({ itemId: String(itemId), available: "1", ...(warehouseId ? { warehouseId: String(warehouseId) } : {}) });
    setAvail(await api.get<{ id: number; serialNo: string }[]>(`/api/clients/${clientId}/serials?${q}`).catch(() => []));
  }
  return (
    <div className="serials">
      <textarea rows={Math.min(6, Math.max(2, list.length + 1))} value={value} onChange={(e) => onChange(e.target.value)}
        placeholder="Сериски броеви – по еден во ред" aria-label={label} />
      <small className={list.length === need ? "muted" : "warn"}>Сериски броеви: {list.length} од {need}
        {pick && itemId && <> · <button type="button" className="link small" onClick={load}>Избери од залиха</button></>}</small>
      {avail && <div className="chips">{avail.length === 0 ? <span className="muted small">Нема на залиха.</span>
        : avail.filter((a) => !list.includes(a.serialNo)).slice(0, 100).map((a) => <button type="button" key={a.id} className="chip"
          onClick={() => onChange([...list, a.serialNo].join("\n"))}>+ {a.serialNo}</button>)}</div>}
    </div>
  );
}
