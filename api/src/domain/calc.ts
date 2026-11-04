/**
 * Presmetki na faktura - ISTITE pravila kako Power Apps (app/scrInvoice.py) i agentot (UjpAgent.psm1):
 *  - zaokruzuvanje "away from zero" (Power Fx Round, [MidpointRounding]::AwayFromZero);
 *  - popust i DDV po edinica na 4 decimali, iznosi po stavka na 4 decimali;
 *  - zaglavje = zbir na nezaokruzenite stavki, zaokruzen na 2 decimali;
 *  - "Za plakjanje" = round(vkupno, 0) - avans.
 * Se koristi decimal.js (ne float) za da nema greski od tipot 0.1 + 0.2.
 */
import { Decimal } from "decimal.js";

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP }); // HALF_UP = away from zero

export type Num = string | number | Decimal;
export const round = (v: Num, dp: number) => new D(v).toDecimalPlaces(dp, D.ROUND_HALF_UP);

export interface LineInput { qty: Num; unitPrice: Num; discountPct?: Num; vatRatePct: Num }
export interface LineResult { unitNet: string; netAmount: string; vatAmount: string }

/** sign = -1 za knizno odobrenie i storno (iznosite se negativni), inaku 1. */
export function calcLine(l: LineInput, sign: 1 | -1 = 1): LineResult {
  const price = new D(l.unitPrice);
  const disc = new D(l.discountPct ?? 0);
  const unitNet = price.minus(round(price.times(disc).div(100), 4));
  const unitVat = round(unitNet.times(l.vatRatePct).div(100), 4);
  const q = new D(l.qty).times(sign);
  return {
    unitNet: unitNet.toFixed(4),
    netAmount: round(q.times(unitNet), 4).toFixed(4),
    vatAmount: round(q.times(unitVat), 4).toFixed(4),
  };
}

export interface Totals {
  netTotal: string; vatTotal: string; grossTotal: string; payableAmount: string;
  byRate: { vatRatePct: string; net: string; vat: string }[];
}

export function calcTotals(lines: (LineResult & { vatRatePct: Num })[], advanceAmount: Num = 0): Totals {
  let n = new D(0), v = new D(0);
  const groups = new Map<string, { net: Decimal; vat: Decimal }>();
  for (const l of lines) {
    n = n.plus(l.netAmount); v = v.plus(l.vatAmount);
    const k = new D(l.vatRatePct).toFixed(2);
    const g = groups.get(k) ?? { net: new D(0), vat: new D(0) };
    g.net = g.net.plus(l.netAmount); g.vat = g.vat.plus(l.vatAmount);
    groups.set(k, g);
  }
  const net2 = round(n, 2), vat2 = round(v, 2), gross = net2.plus(vat2);
  return {
    netTotal: net2.toFixed(2),
    vatTotal: vat2.toFixed(2),
    grossTotal: gross.toFixed(2),
    payableAmount: round(gross, 0).minus(round(advanceAmount, 2)).toFixed(2),
    byRate: [...groups.entries()].sort(([a], [b]) => Number(b) - Number(a))
      .map(([k, g]) => ({ vatRatePct: k, net: round(g.net, 2).toFixed(2), vat: round(g.vat, 2).toFixed(2) })),
  };
}
