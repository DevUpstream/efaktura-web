/** Stranicenje (zabeleska 17): 25 / 50 / 100 / site. Izborot se pamti po lista vo prelistuvacot (ako moze). */
import { useEffect, useState } from "react";

const SIZES = [25, 50, 100, 0] as const;   // 0 = site
const read = (key: string) => {
  try { const raw = localStorage.getItem(`pager:${key}`); const v = raw === null ? NaN : Number(raw); return (SIZES as readonly number[]).includes(v) ? v : 50; }
  catch { return 50; }
};

export function usePaged<T>(rows: T[], key: string, resetOn: unknown[] = []) {
  const [size, setSize] = useState<number>(() => read(key));
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [rows.length, size, ...resetOn]);   // eslint-disable-line react-hooks/exhaustive-deps
  const pages = size ? Math.max(1, Math.ceil(rows.length / size)) : 1;
  const p = Math.min(page, pages - 1);
  const slice = size ? rows.slice(p * size, p * size + size) : rows;
  const change = (n: number) => { setSize(n); try { localStorage.setItem(`pager:${key}`, String(n)); } catch { /* bez pamtenje */ } };
  const bar = rows.length > 25 ? (
    <div className="pager">
      <label className="small">По страна <select value={size} onChange={(e) => change(Number(e.target.value))} aria-label="Редови по страна">
        {SIZES.map((n) => <option key={n} value={n}>{n || "сите"}</option>)}</select></label>
      {size > 0 && pages > 1 && <>
        <button className="btn btn-small" disabled={p === 0} onClick={() => setPage(p - 1)} aria-label="Претходна страна">‹</button>
        <span className="small">{p * size + 1}–{Math.min(rows.length, p * size + size)} од {rows.length}</span>
        <button className="btn btn-small" disabled={p >= pages - 1} onClick={() => setPage(p + 1)} aria-label="Следна страна">›</button>
      </>}
    </div>
  ) : null;
  return { rows: slice, bar };
}
