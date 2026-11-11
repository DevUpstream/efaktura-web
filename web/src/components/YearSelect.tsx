import { useEffect, useState } from "react";
import { api } from "../api";

/**
 * Godini od podatocite (+ tekovnata). Pocetno: tekovnata ako ima podatoci, inaku najnovata so podatoci
 * (na pr. preneseni fakturi od 2025). 0 = site godini (samo kaj allowAll).
 */
export function useYears(url: string) {
  const cur = new Date().getFullYear();
  const [years, setYears] = useState<number[]>([cur]);
  const [year, setYear] = useState<number | null>(null);
  useEffect(() => {
    setYear(null);
    api.get<number[]>(url).then((ys) => {
      setYears([...new Set([cur, ...ys])].sort((a, b) => b - a));
      setYear(ys.includes(cur) || !ys.length ? cur : ys[0]!);
    }).catch(() => { setYears([cur]); setYear(cur); });
  }, [url]);
  return { years, year, setYear };
}

export function YearSelect({ years, year, onChange, allowAll }: { years: number[]; year: number | null; onChange: (y: number) => void; allowAll?: boolean }) {
  return (
    <select value={year ?? ""} onChange={(e) => onChange(Number(e.target.value))} aria-label="Година">
      {allowAll && <option value={0}>Сите години</option>}
      {years.map((y) => <option key={y} value={y}>{y}</option>)}
    </select>
  );
}
