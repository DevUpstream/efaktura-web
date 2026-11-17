/**
 * Pole so prebaruvanje namesto padacko meni (zabeleska 25): neколку букви -> lista; strelki, Enter, Esc.
 * Prebaruvanjeto e po site zborovi (redosledot ne e vazen), bez razlika na golemi/mali bukvi.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface SearchOption { id: number; label: string; sub?: string; search?: string }

export function SearchSelect({ value, options, onChange, placeholder, ariaLabel, emptyLabel, required, disabled, max = 50 }: {
  value: number | "" | null; options: SearchOption[]; onChange: (id: number | "") => void; placeholder?: string; ariaLabel: string;
  emptyLabel?: string; required?: boolean; disabled?: boolean; max?: number;
}) {
  const sel = options.find((o) => o.id === value) ?? null;
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const place = () => { const r = box.current?.getBoundingClientRect(); if (!r) return;
    const up = window.innerHeight - r.bottom < 260 && r.top > 300;
    setPos({ left: r.left, top: up ? r.top - 2 : r.bottom + 2, width: Math.max(r.width, 280), up }); };
  useEffect(() => {
    if (!open) return;
    place();
    const on = () => place();
    window.addEventListener("scroll", on, true); window.addEventListener("resize", on);
    return () => { window.removeEventListener("scroll", on, true); window.removeEventListener("resize", on); };
  }, [open]);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = useMemo(() => {
    const hay = (o: SearchOption) => `${o.label} ${o.sub ?? ""} ${o.search ?? ""}`.toLowerCase();
    return options.filter((o) => words.every((w) => hay(o).includes(w))).slice(0, max);
  }, [options, q]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setHi(0); }, [q]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) { setOpen(false); setQ(""); } };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const pick = (id: number | "") => { onChange(id); setOpen(false); setQ(""); };
  const extra = emptyLabel ? 1 : 0;   // prviot red "— без … —"
  function key(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, shown.length - 1 + extra)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") {
      if (!open) return;
      e.preventDefault();
      if (extra && hi === 0) pick("");
      else { const o = shown[hi - extra]; if (o) pick(o.id); }
    } else if (e.key === "Escape") { setOpen(false); setQ(""); }
  }
  return (
    <div className="ssel" ref={box}>
      <input role="combobox" aria-expanded={open} aria-controls={listId} aria-label={ariaLabel} disabled={disabled}
        value={open ? q : sel ? `${sel.label}${sel.sub ? ` · ${sel.sub}` : ""}` : ""}
        placeholder={sel ? `${sel.label}` : placeholder ?? "Пребарај…"} required={required && !sel}
        onFocus={() => { setOpen(true); setQ(""); }} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onKeyDown={key} />
      {open && !disabled && (
        <ul className="ssel-list" id={listId} role="listbox"
          style={pos ? { position: "fixed", left: pos.left, width: pos.width, ...(pos.up ? { bottom: window.innerHeight - pos.top, top: "auto" } : { top: pos.top }) } : undefined}>
          {emptyLabel && <li role="option" aria-selected={hi === 0} className={hi === 0 ? "hi" : ""} onMouseDown={(e) => { e.preventDefault(); pick(""); }}>{emptyLabel}</li>}
          {shown.map((o, i) => (
            <li key={o.id} role="option" aria-selected={hi === i + extra} className={`${hi === i + extra ? "hi" : ""}${o.id === value ? " cur" : ""}`}
              onMouseEnter={() => setHi(i + extra)} onMouseDown={(e) => { e.preventDefault(); pick(o.id); }}>
              <span>{o.label}</span>{o.sub && <span className="muted small"> {o.sub}</span>}
            </li>))}
          {shown.length === 0 && <li className="muted small none">Нема резултат за „{q}“.</li>}
          {shown.length === max && <li className="muted small none">Прикажани првите {max}. Внесете повеќе букви.</li>}
        </ul>
      )}
    </div>
  );
}
