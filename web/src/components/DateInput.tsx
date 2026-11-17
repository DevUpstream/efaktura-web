/**
 * Datum vo oblik dd.мм.гггг (zabeleska 12), nezavisno od jazikot na prelistuvacot.
 * Vnes: 17.11.2026, 17/11/2026, 17-11-26, 17.11 (tekovna godina), 2026-11-17. Kopce: kalendar (od prelistuvacot).
 * Kon programata vrednosta e sekogas ISO (гггг-мм-дд), kako kaj <input type="date">.
 */
import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue" | "onChange"> & {
  value?: string; defaultValue?: string; onChange?: (e: { target: { value: string } }) => void;
};

const dmy = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "");

/** Tekst -> ISO; "" za prazno; null za neispravno. */
export function parseDmy(t: string): string | null {
  const s = t.trim();
  if (!s) return "";
  let d: number, m: number, y: number;
  let x = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (x) { y = +x[1]!; m = +x[2]!; d = +x[3]!; }
  else {
    x = /^(\d{1,2})[.\/\-\s](\d{1,2})(?:[.\/\-\s](\d{2}|\d{4}))?\.?$/.exec(s) ?? /^(\d{2})(\d{2})(\d{2}|\d{4})$/.exec(s);
    if (!x) return null;
    d = +x[1]!; m = +x[2]!; y = x[3] ? +x[3] : new Date().getFullYear();
    if (y < 100) y += 2000;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 1900 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function DateInput({ value, defaultValue, onChange, name, min, max, required, disabled, className, ...rest }: Props) {
  const controlled = value !== undefined;
  const [iso, setIso] = useState(controlled ? value! : defaultValue ?? "");
  const [text, setText] = useState(dmy(controlled ? value! : defaultValue ?? ""));
  const [editing, setEditing] = useState(false);
  const txt = useRef<HTMLInputElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  useEffect(() => { if (controlled && !editing) { setIso(value!); setText(dmy(value!)); } }, [value, controlled, editing]);

  function check(t: string) {
    const p = parseDmy(t);
    let msg = "";
    if (p === null) msg = "Датум во облик дд.мм.гггг (на пр. 17.11.2026).";
    else if (p && min && p < String(min)) msg = `Најрано ${dmy(String(min))}.`;
    else if (p && max && p > String(max)) msg = `Најдоцна ${dmy(String(max))}.`;
    txt.current?.setCustomValidity(msg);
    return msg ? null : p;
  }
  function emit(p: string) { setIso(p); onChange?.({ target: { value: p } }); }
  return (
    <span className={`date-in${className ? ` ${className}` : ""}`}>
      <input {...rest} ref={txt} type="text" inputMode="numeric" autoComplete="off" placeholder="дд.мм.гггг" value={text} required={required} disabled={disabled}
        onFocus={() => setEditing(true)}
        onChange={(e) => { setText(e.target.value); const p = check(e.target.value); if (p !== null && p !== iso) emit(p); }}
        onBlur={() => { setEditing(false); const p = check(text); if (p !== null) setText(dmy(p)); }} />
      <button type="button" className="date-btn" tabIndex={-1} disabled={disabled} aria-label="Календар"
        onClick={() => { const el = pick.current; if (!el) return; try { el.showPicker(); } catch { el.focus(); } }}>▦</button>
      <input ref={pick} type="date" className="date-native" tabIndex={-1} aria-hidden="true" value={iso} min={min} max={max}
        onChange={(e) => { const p = e.target.value; setText(dmy(p)); txt.current?.setCustomValidity(""); emit(p); }} />
      {name && <input type="hidden" name={name} value={iso} />}
    </span>
  );
}
