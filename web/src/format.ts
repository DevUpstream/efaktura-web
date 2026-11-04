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
