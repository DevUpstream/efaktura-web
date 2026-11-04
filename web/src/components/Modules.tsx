import { useEffect, useState } from "react";
import { api } from "../api";

export interface ModuleDef { key: string; name: string; core: boolean; ready: boolean; requires: string[] }
let cache: Promise<ModuleDef[]> | null = null;
/** Katalog na modulite (se vcituva ednas). */
export function useModuleCatalog() {
  const [list, setList] = useState<ModuleDef[]>([]);
  useEffect(() => { (cache ??= api.get<ModuleDef[]>("/api/modules")).then(setList, () => { cache = null; }); }, []);
  return list;
}

/** Stiklirawe moduli. `allowed` gi ogranicuva izborite (za korisnik: samo modulite na firmata). */
export function ModulePicker({ catalog, value, allowed, onChange, disabled }: {
  catalog: ModuleDef[]; value: string[]; allowed?: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const list = catalog.filter((m) => !allowed || allowed.includes(m.key));
  function toggle(k: string, on: boolean) {
    let next = on ? [...value, k] : value.filter((x) => x !== k);
    if (on) catalog.find((m) => m.key === k)!.requires.forEach((r) => { if (!next.includes(r)) next.push(r); });
    else next = next.filter((x) => !catalog.find((m) => m.key === x)!.requires.includes(k));
    onChange(catalog.map((m) => m.key).filter((x) => next.includes(x)));
  }
  return (
    <div className="modules">{list.map((m) => (
      <label key={m.key} className="check">
        <input type="checkbox" checked={m.core || value.includes(m.key)} disabled={disabled || m.core} onChange={(e) => toggle(m.key, e.target.checked)} />
        <span>{m.name}{m.core && <span className="muted small"> (секогаш)</span>}{!m.ready && <span className="chip">во изработка</span>}
          {m.requires.length > 0 && <span className="muted small"> бара {m.requires.map((r) => catalog.find((x) => x.key === r)?.name).join(", ")}</span>}</span>
      </label>))}</div>
  );
}
