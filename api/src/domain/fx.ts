/**
 * Девизни фактури (docs/16): курс на НБРМ и пресметка во валута + денари.
 *
 * Курс = среден курс на НБРМ (поле Sreden / Nomin) од курсната листа важна на датумот (последната листа <= датумот,
 * најмногу 10 дена наназад – викенд и празници). Веб-сервис: https://www.nbrm.mk/KLServiceNOV (GetExchangeRate, format=json).
 * [НЕТЕСТИРАНО] Точниот изглед на JSON одговорот (имиња на полиња и формат на датумот) не е проверен на вистински одговор:
 * читачот прифаќа повеќе облици и одбива со јасна порака ако не го препознае. Резерва: рачен внес на курсот.
 */
import { Decimal } from "decimal.js";
import { and, eq } from "drizzle-orm";
import { exchangeRates } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DomainError } from "./errors.js";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** Валути во изборот (сите ги има на курсната листа на НБРМ). */
export const CURRENCIES = ["MKD", "EUR", "USD", "CHF", "GBP", "SEK", "NOK", "DKK", "JPY", "CAD", "AUD"] as const;
export const NBRM_URL = "https://www.nbrm.mk/KLServiceNOV/GetExchangeRate";
const MAX_BACK_DAYS = 10;

export interface NbrmRate { listDate: string; currency: string; rate: string }

/** Датум од NBRM во yyyy-MM-dd: „2026-11-09T00:00:00“, „/Date(1794182400000)/“, „09.11.2026“. */
export function nbrmDate(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  m = /Date\((-?\d+)/.exec(s);
  if (m) return new Date(Number(m[1])).toLocaleDateString("sv-SE", { timeZone: "Europe/Skopje" });
  return null;
}

const num = (v: unknown) => {
  if (typeof v === "number") return Number.isFinite(v) ? new D(v) : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim().replace(/\s/g, "");
  const n = s.includes(",") && !s.includes(".") ? s.replace(",", ".") : s.replace(/,/g, "");
  return /^-?\d+(\.\d+)?$/.test(n) ? new D(n) : null;
};

/** Чита одговор од NBRM (низа, или објект со низа во d / ExchangeRates / …). Без препознаени редови -> грешка. */
export function parseNbrm(body: unknown): NbrmRate[] {
  let arr: unknown = body;
  if (arr && !Array.isArray(arr) && typeof arr === "object") arr = Object.values(arr as object).find(Array.isArray) ?? [];
  if (!Array.isArray(arr)) throw new DomainError("fx_format", "Непознат одговор од НБРМ.", 502);
  const out: NbrmRate[] = [];
  for (const r of arr as Record<string, unknown>[]) {
    const g = (k: string) => r[k] ?? r[k.toLowerCase()] ?? r[k.toUpperCase()];
    const code = String(g("Oznaka") ?? "").trim().toUpperCase();
    const date = nbrmDate(g("Datum"));
    const mid = num(g("Sreden")), nom = num(g("Nomin")) ?? new D(1);
    if (!/^[A-Z]{3}$/.test(code) || !date || !mid || mid.lte(0) || nom.lte(0)) continue;
    out.push({ listDate: date, currency: code, rate: mid.div(nom).toDecimalPlaces(6, D.ROUND_HALF_UP).toFixed(6) });
  }
  if (!out.length && arr.length) throw new DomainError("fx_format", "Одговорот од НБРМ не е препознаен (полиња Oznaka, Datum, Sreden).", 502);
  return out;
}

const shift = (d: string, days: number) => new Date(Date.parse(`${d}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const dmy = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
export const skopjeToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Skopje" });

export type FxFetch = (url: string) => Promise<unknown>;
export const httpFetch: FxFetch = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

/**
 * Среден курс на НБРМ за валута на датум. Се чува во exchange_rates (минат датум или листа од истиот ден не се бара повторно).
 */
export async function getNbrmRate(db: Db, currency: string, date: string, fetcher: FxFetch = httpFetch, today = skopjeToday()) {
  const cur = currency.toUpperCase();
  if (cur === "MKD") return { currency: cur, date, rate: "1.000000", listDate: date, cached: true };
  if (!/^[A-Z]{3}$/.test(cur)) throw new DomainError("validation", "Непозната валута.", 422);
  if (date > today) throw new DomainError("validation", "Курс за иден датум не постои. Внесете го рачно или сменете го датумот.", 422);
  const [hit] = await db.select().from(exchangeRates).where(and(eq(exchangeRates.rateDate, date), eq(exchangeRates.currency, cur)));
  if (hit) return { currency: cur, date, rate: hit.rate, listDate: hit.listDate, cached: true };

  const url = `${NBRM_URL}?StartDate=${dmy(shift(date, -MAX_BACK_DAYS))}&EndDate=${dmy(date)}&format=json`;
  let rows: NbrmRate[];
  try { rows = parseNbrm(await fetcher(url)); }
  catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError("fx_unavailable", "НБРМ не одговара. Внесете го курсот рачно (среден курс на НБРМ).", 502);
  }
  const best = rows.filter((r) => r.currency === cur && r.listDate <= date).sort((a, b) => b.listDate.localeCompare(a.listDate))[0];
  if (!best) throw new DomainError("fx_missing", `НБРМ нема курс за ${cur} до ${dmy(date)}. Внесете го рачно.`, 422);
  // кеш: минат датум е конечен; денешниот само ако листата е од денес
  if (date < today || best.listDate === date) {
    await db.insert(exchangeRates).values({ rateDate: date, currency: cur, rate: best.rate, listDate: best.listDate }).onConflictDoNothing();
  }
  return { currency: cur, date, rate: best.rate, listDate: best.listDate, cached: false };
}

export { calcFxTotals, toMkd } from "./calc.js";

/** Курсот мора да е од листа <= датумот на промет (или издавање), најмногу 10 дена наназад. */
export function rateDateProblem(rateDate: string | null, docDate: string): string | null {
  if (!rateDate) return "Девизна фактура: нема датум на курсот. Земете го курсот од НБРМ или внесете датум.";
  if (rateDate > docDate) return `Курсот е за ${dmy(rateDate)}, по датумот на промет ${dmy(docDate)}.`;
  if (rateDate < shift(docDate, -MAX_BACK_DAYS)) return `Курсот е за ${dmy(rateDate)}, премногу пред датумот на промет ${dmy(docDate)}. Освежете го курсот.`;
  return null;
}
