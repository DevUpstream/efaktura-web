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
  KZ: "Книжно задолжување", ST: "Сторно", KR: "Корекција" };
export const STATUS: Record<Status, string> = { draft: "Нацрт", to_issue: "За издавање", issued: "Издадена",
  json_exported: "JSON извезен", sent_to_ujp: "Качена на УЈП", rejected: "Одбиена", voided: "Сторнирана",
  corrected: "Корегирана", cancelled_draft: "Откажан нацрт" };
export const PAYMENT: Record<string, string> = { bank: "Трансакциска сметка", cash: "Готовина", card: "Платежна картичка",
  compensation: "Компензација", other: "Друго" };
export const NOTE_KIND: Record<string, string> = { call: "Телефонски разговор", meeting: "Состанок", email: "Е-пошта", note: "Белешка" };
export const dateTime = (iso: string) => {
  const d = new Date(iso);
  return `${date(d.toLocaleDateString("sv-SE", { timeZone: "Europe/Skopje" }))} ${d.toLocaleTimeString("en-GB", { timeZone: "Europe/Skopje", hour: "2-digit", minute: "2-digit" })}`;
};
export const ITEM_TYPE: Record<string, string> = { service: "Услуга", goods: "Стока", material: "Материјал / дел", product: "Готов производ" };
export const STOCK_TYPES = ["goods", "material", "product"];
export const STOCK_KIND: Record<string, string> = { receipt: "Приемница", issue: "Испратница", writeoff: "Отпис", inventory: "Попис", transfer: "Пренос", consumption: "Издатница за производство", output: "Готов производ" };
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
