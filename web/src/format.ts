import type { DocType, Status } from "./api";

const n2 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
/** 1.234,56 - ist format kako na PDF-ot od Power Apps. */
export const money = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "–" : n2.format(Number(v)));
export const money0 = (v: string | number | null | undefined) => (v === null || v === undefined ? "–" : n0.format(Number(v)));
export const date = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "–");
export const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => new Date(new Date(d + "T12:00:00Z").getTime() + n * 864e5).toISOString().slice(0, 10);

export const DOC: Record<DocType, string> = { INV: "Фактура", AV: "Авансна фактура", OD: "Книжно одобрение",
  KZ: "Книжно задолжување", ST: "Сторно", KR: "Корекција", PF: "Понуда / профактура" };
export const STATUS: Record<Status, string> = { draft: "Нацрт", to_issue: "За издавање", issued: "Издадена",
  json_exported: "JSON извезен", sent_to_ujp: "Качена на УЈП", rejected: "Одбиена", voided: "Сторнирана",
  corrected: "Корегирана", cancelled_draft: "Откажан нацрт" };
/** Статус за приказ: понудата не се „сторнира“, туку се откажува. */
export const statusOf = (docType: DocType, status: Status) => (docType === "PF" && status === "voided" ? "Откажана" : STATUS[status]);
export const PAYMENT: Record<string, string> = { bank: "Трансакциска сметка", cash: "Готовина", card: "Платежна картичка",
  compensation: "Компензација", other: "Друго" };
export const NOTE_KIND: Record<string, string> = { call: "Телефонски разговор", meeting: "Состанок", email: "Е-пошта", note: "Белешка" };
export const dateTime = (iso: string) => {
  const d = new Date(iso);
  return `${date(d.toLocaleDateString("sv-SE", { timeZone: "Europe/Skopje" }))} ${d.toLocaleTimeString("en-GB", { timeZone: "Europe/Skopje", hour: "2-digit", minute: "2-digit" })}`;
};
/** Partner (zabeleska 24): kratok naziv za listi i izbor; pravnoto ime (od registarot) ostanuva na fakturata i kon UJP. */
export const partnerShort = (p: { name: string; shortName?: string | null }) => p.shortName?.trim() || p.name;
export const partnerOption = (p: { name: string; shortName?: string | null; edb?: string | null }) =>
  `${p.shortName?.trim() ? `${p.shortName.trim()} — ${p.name}` : p.name}${p.edb ? ` (${p.edb})` : ""}`;
export const partnerMatches = (p: { name: string; shortName?: string | null; edb?: string | null }, needle: string) =>
  !needle || p.name.toLowerCase().includes(needle) || (p.shortName ?? "").toLowerCase().includes(needle) || (p.edb ?? "").includes(needle);
/** Edinici merka (zabeleska 14, 15): listata na firmata ili standardnata; prvata e pocetna. */
export const DEFAULT_UNITS = ["парче", "кг", "г", "литар", "м", "м²", "м³", "час", "ден", "месец", "пакет", "кутија", "пар", "сет", "услуга"];
export const unitsOf = (c: { units?: string[] }) => (c.units?.length ? c.units : DEFAULT_UNITS);
/** Opcii za pole so prebaruvanje (zabeleska 25). */
export const partnerOpt = (p: { id: number; name: string; shortName?: string | null; edb?: string | null; city?: string | null }) => ({
  id: p.id, label: p.shortName?.trim() || p.name, sub: [p.shortName?.trim() ? p.name : null, p.edb, p.city].filter(Boolean).join(" · "), search: p.edb ?? "" });
export const itemOpt = (it: { id: number; code: string; name: string; unit?: string }, stockQty?: number | null) => ({
  id: it.id, label: `${it.code} · ${it.name}`,
  sub: stockQty === undefined || stockQty === null ? undefined : `залиха ${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3 }).format(stockQty)} ${it.unit ?? ""}`.trim() });
export const ITEM_TYPE: Record<string, string> = { service: "Услуга", goods: "Трговски производ", material: "Материјал / дел", product: "Сопствен производ" };
export const STOCK_TYPES = ["goods", "material", "product"];
export const STOCK_KIND: Record<string, string> = { receipt: "Приемница", issue: "Испратница", writeoff: "Отпис", inventory: "Попис", transfer: "Пренос", consumption: "Издатница за производство", output: "Прием од производство" };
export const qtyFmt = (v: string | number | null | undefined) => (v === null || v === undefined ? "–" : new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3 }).format(Number(v)));
/** Broj od vnes: "1,5" / "1.234,56" / "1234.56" / "1 234" -> broj (NaN ako ne e broj). */
export function parseNum(v: string | number | null | undefined): number {
  if (typeof v === "number") return v;
  let t = String(v ?? "").trim().replace(/\s|\u00a0/g, "");
  if (!t) return 0;
  if (t.includes(",") && t.includes(".")) t = t.lastIndexOf(",") > t.lastIndexOf(".") ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else if (t.includes(",")) t = t.replace(",", ".");
  return /^[-+]?\d*\.?\d+$/.test(t) ? Number(t) : NaN;
}
