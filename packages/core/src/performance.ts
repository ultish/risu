import { computeHoldings } from "./holdings.js";
import { holdingPriceKey } from "./market.js";
import { inferSplitEvents } from "./splits.js";
import type { ParsedTransaction } from "./types.js";
import { toYahooSymbol } from "./yahoo.js";

/** One month-end (or as-of) portfolio snapshot in AUD. */
export type PerformancePoint = {
  /** ISO date yyyy-mm-dd (typically month end) */
  date: string;
  /** Total cost base of holdings still open, converted to AUD where possible */
  costBaseAud: number | null;
  /** Mark-to-market value using last known prices, in AUD where possible */
  marketValueAud: number | null;
};

/** Daily close bars keyed by Yahoo symbol (e.g. VAS.AX, AAPL) or EXCHANGE:TICKER */
export type PriceSeriesMap = Record<
  string,
  Array<{ date: string; close: number }>
>;

/**
 * FX rates: Yahoo-style pairs (AUDUSD=X = foreign units per 1 AUD).
 * Flat map = constant/latest rate for all dates.
 * Optional series = last known rate on/before each valuation date.
 */
export type FxInput = {
  rates?: Record<string, number | null | undefined>;
  series?: Record<string, Array<{ date: string; rate: number }>>;
};

export type BuildPerformanceOptions = {
  priceSeries?: PriceSeriesMap;
  fx?: FxInput;
  /** Inclusive end date (yyyy-mm-dd). Default: today UTC. */
  asOf?: string;
  /**
   * If true (default), emit one point per calendar month end from first trade
   * through asOf. If false, only emit a single asOf point.
   */
  monthly?: boolean;
};

/**
 * Build portfolio value points over time (AUD).
 *
 * Simple approach: for each month end, compute holdings from transactions up
 * to that date, value with last known price on/before the date, convert to AUD
 * with last known FX.
 */
export function buildPerformanceSeries(
  transactions: ParsedTransaction[],
  options: BuildPerformanceOptions = {},
): PerformancePoint[] {
  if (!transactions.length) return [];

  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  const firstDate = sorted[0]!.date;
  const asOf = options.asOf ?? todayIso();
  const monthly = options.monthly !== false;

  const dates = monthly
    ? monthEndsBetween(firstDate, asOf)
    : [asOf >= firstDate ? asOf : firstDate];

  // Ensure asOf itself is included when it is not a month end
  if (monthly && dates.length && dates[dates.length - 1]! < asOf) {
    dates.push(asOf);
  }

  const priceIndex = buildLastPriceIndex(options.priceSeries ?? {});
  const fxSeriesIndex = buildLastFxIndex(options.fx?.series ?? {});
  const flatFx = options.fx?.rates ?? {};
  // Full-ledger splits so early month-ends can back-apply ratios vs Yahoo adj prices
  const splitEvents = inferSplitEvents(sorted);

  const points: PerformancePoint[] = [];

  for (const date of dates) {
    const txsToDate = sorted.filter((t) => t.date <= date);
    if (!txsToDate.length) continue;

    const prices = pricesAsOf(txsToDate, date, priceIndex);
    const fxRates = fxAsOf(date, flatFx, fxSeriesIndex);

    const holdings = computeHoldings(txsToDate, {
      prices,
      fxRates,
      valuationAsOf: date,
      splitEvents,
    });

    let costSum = 0;
    let costAny = false;
    let valueSum = 0;
    let valueAny = false;

    for (const h of holdings) {
      if (h.costBaseAud != null) {
        costSum += h.costBaseAud;
        costAny = true;
      } else if (h.currency === "AUD") {
        costSum += h.costBase;
        costAny = true;
      }
      if (h.marketValueAud != null) {
        valueSum += h.marketValueAud;
        valueAny = true;
      }
    }

    points.push({
      date,
      costBaseAud: costAny ? round2(costSum) : null,
      marketValueAud: valueAny ? round2(valueSum) : null,
    });
  }

  return points;
}

/** Last close on or before `date` for each open instrument. */
function pricesAsOf(
  txs: ParsedTransaction[],
  date: string,
  priceIndex: Map<string, Array<{ date: string; close: number }>>,
): Record<string, number | null> {
  const instruments = new Map<string, { ticker: string; exchange: string }>();
  for (const t of txs) {
    const exchange = (t.exchange || "ASX").toUpperCase();
    const ticker = t.ticker.toUpperCase();
    instruments.set(holdingPriceKey(exchange, ticker), { ticker, exchange });
  }

  const prices: Record<string, number | null> = {};
  for (const [key, { ticker, exchange }] of instruments) {
    const yahoo = toYahooSymbol(ticker, exchange);
    const close =
      lastCloseOnOrBefore(priceIndex, yahoo, date) ??
      lastCloseOnOrBefore(priceIndex, key, date) ??
      lastCloseOnOrBefore(priceIndex, ticker, date) ??
      (exchange === "ASX"
        ? lastCloseOnOrBefore(priceIndex, `${ticker}.AX`, date)
        : null);

    prices[key] = close;
    prices[yahoo] = close;
    prices[ticker] = close;
    if (exchange === "ASX") prices[`${ticker}.AX`] = close;
  }
  return prices;
}

function fxAsOf(
  date: string,
  flat: Record<string, number | null | undefined>,
  seriesIndex: Map<string, Array<{ date: string; rate: number }>>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [pair, rate] of Object.entries(flat)) {
    out[pair] = rate ?? null;
  }
  for (const [pair, series] of seriesIndex) {
    const rate = lastRateOnOrBefore(series, date);
    if (rate != null) out[pair] = rate;
  }
  return out;
}

function buildLastPriceIndex(
  series: PriceSeriesMap,
): Map<string, Array<{ date: string; close: number }>> {
  const map = new Map<string, Array<{ date: string; close: number }>>();
  for (const [key, bars] of Object.entries(series)) {
    const sorted = [...bars]
      .filter((b) => b.close != null && !Number.isNaN(b.close))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (sorted.length) map.set(key, sorted);
  }
  return map;
}

function buildLastFxIndex(
  series: Record<string, Array<{ date: string; rate: number }>>,
): Map<string, Array<{ date: string; rate: number }>> {
  const map = new Map<string, Array<{ date: string; rate: number }>>();
  for (const [pair, rows] of Object.entries(series)) {
    const sorted = [...rows]
      .filter((r) => r.rate != null && !Number.isNaN(r.rate))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (sorted.length) map.set(pair, sorted);
  }
  return map;
}

function lastCloseOnOrBefore(
  index: Map<string, Array<{ date: string; close: number }>>,
  key: string,
  date: string,
): number | null {
  const series = index.get(key);
  if (!series?.length) return null;
  // binary search last date <= date
  let lo = 0;
  let hi = series.length - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = series[mid]!.date;
    if (d <= date) {
      best = series[mid]!.close;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function lastRateOnOrBefore(
  series: Array<{ date: string; rate: number }>,
  date: string,
): number | null {
  let lo = 0;
  let hi = series.length - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = series[mid]!.date;
    if (d <= date) {
      best = series[mid]!.rate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Calendar month-end dates from start month through end month (inclusive). */
export function monthEndsBetween(startIso: string, endIso: string): string[] {
  const start = parseIso(startIso);
  const end = parseIso(endIso);
  if (!start || !end || start > end) return [];

  const out: string[] = [];
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth(); // 0-based

  while (true) {
    const monthEnd = lastDayOfMonthUtc(y, m);
    const iso = toIso(monthEnd);
    if (iso >= startIso && iso <= endIso) out.push(iso);
    if (y > end.getUTCFullYear() || (y === end.getUTCFullYear() && m >= end.getUTCMonth())) {
      break;
    }
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return out;
}

function lastDayOfMonthUtc(year: number, month0: number): Date {
  // day 0 of next month = last day of this month
  return new Date(Date.UTC(year, month0 + 1, 0));
}

function parseIso(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function toIso(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayIso(): string {
  return toIso(new Date());
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
