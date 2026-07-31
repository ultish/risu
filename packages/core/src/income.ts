import { toAud } from "./market.js";
import type { ParsedTransaction } from "./types.js";

/** Australian financial year label, e.g. "FY2025" for 1 Jul 2024 – 30 Jun 2025. */
export function auFinancialYear(isoDate: string): string {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  if (!y || !m) return "FY????";
  // Jul–Dec → FY is next calendar year; Jan–Jun → current calendar year
  const endYear = m >= 7 ? y + 1 : y;
  return `FY${endYear}`;
}

export type IncomeLine = {
  financialYear: string;
  exchange: string;
  currency: string;
  /** Sum of assessable dividend amounts in trade currency */
  amount: number;
  /** AUD converted when FX available; else null for non-AUD */
  amountAud: number | null;
  /** Cash-only / DRP-only slice of amountAud (same null-when-missing-FX rule) */
  amountCashAud: number | null;
  amountDrpAud: number | null;
  count: number;
  /** How many rows were cash dividends vs DRP-only (reinvest still taxable) */
  cashCount: number;
  drpCount: number;
};

/** One assessable dividend/DRP event (post dedup/pooling) — line-level detail for display. */
export type AssessableDividendEvent = {
  financialYear: string;
  date: string;
  ticker: string;
  exchange: string;
  currency: string;
  amount: number;
  amountAud: number | null;
  source: "cash" | "drp";
};

export type IncomeSummary = {
  byFy: IncomeLine[];
  /** Totals rolled by FY (AUD when possible) */
  fyTotals: Array<{
    financialYear: string;
    amountAud: number | null;
    amountCashAud: number | null;
    amountDrpAud: number | null;
    amountNativeMixed: number;
    count: number;
    cashCount: number;
    drpCount: number;
  }>;
  /** Per-transaction detail behind byFy/fyTotals (post dedup/pooling) — for a "why is this my dividend tax" breakdown. */
  events: AssessableDividendEvent[];
  grandTotalAud: number | null;
  missingFx: string[];
  notes: string[];
};

type TxPick = Pick<
  ParsedTransaction,
  | "date"
  | "type"
  | "amount"
  | "currency"
  | "exchange"
  | "quantity"
  | "price"
  | "ticker"
>;

/**
 * Native amount for a dividend / DRP row (prefer amount; else price × qty).
 */
export function dividendRowAmount(t: {
  amount: number | null;
  price: number | null;
  quantity: number;
}): number {
  if (t.amount != null && Number.isFinite(t.amount) && t.amount !== 0) {
    return Math.abs(t.amount);
  }
  if (t.price != null && t.quantity) {
    return Math.abs(t.price * t.quantity);
  }
  return 0;
}

/**
 * Summarise assessable dividend income by AU financial year and exchange/currency.
 *
 * Includes:
 * - all `dividend_cash` rows
 * - `drp` rows that are **not** duplicates of a nearby cash dividend
 *   (same ticker + exchange, within ±7 days, amounts roughly equal), and
 *   **not** already explained by that instrument's own earlier cash
 *   dividends (see "Pooled DRP" below) — only the unexplained remainder,
 *   if any, is counted.
 *
 * Rationale: AU tax — a dividend is assessable even when reinvested via DRP.
 * Cost base of DRP lots is separate; this rollup is income only.
 *
 * When both cash and DRP exist for the same event (common full-DRP exports),
 * only cash is counted. When only DRP is imported (Sharesight All Trades style),
 * the DRP amount is treated as assessable. Partial DRP (cash + reinvest, different
 * amounts) counts both.
 *
 * **Pooled DRP** (docs/import-layouts-plan.md §19): some issuer DRP plans
 * (e.g. Computershare-administered ETFs) only buy whole units, carrying any
 * leftover as a residual cash balance that rolls into the *next* period(s)
 * until enough accumulates. The resulting `drp` row's amount is the
 * reinvested unit's cost — often the sum of *several* periods' own
 * distributions, each of which already has its own `dividend_cash` row
 * (assessable income was recorded for every period, not just the ones that
 * happened to buy a whole unit). Counting the `drp` amount on top would
 * double-count that pooled income. When an instrument has genuine
 * multi-period evidence (2+ `dividend_cash` rows — a single nearby row that
 * already failed the exact-match check above is a *different*, unexplained
 * distribution, not a pool), a `drp` row draws down a running per-instrument
 * pool built from that instrument's own `dividend_cash` history dated on or
 * before it (chronological — a distribution can't fund a purchase made
 * before it was paid); only the shortfall beyond what the pool can explain
 * is counted as additional income. A single nearby cash/DRP pair (fewer than
 * 2 cash rows for that instrument) still falls through to "count both in
 * full" as before, since there's no multi-period evidence to pool from.
 *
 * Pass Yahoo-style FX map (e.g. `{ "AUDUSD=X": 0.65 }`) to convert foreign cash to AUD.
 */
export function summarizeDividendIncome(
  transactions: TxPick[],
  fxRates: Record<string, number | null | undefined> = {},
): IncomeSummary {
  const cashRows = transactions.filter((t) => t.type === "dividend_cash");
  const drpRows = transactions.filter((t) => t.type === "drp");

  const notes: string[] = [
    "Includes cash dividends and DRP/reinvest amounts (assessable even when reinvested).",
    "DRP rows matching a nearby cash dividend, or explained by that instrument's own earlier cash dividends (pooled DRP residual), are skipped or reduced to avoid double-count.",
  ];

  type Event = {
    date: string;
    ticker: string;
    exchange: string;
    currency: string;
    amount: number;
    source: "cash" | "drp";
  };

  const events: Event[] = [];

  // Per-instrument cash-dividend history (date-sorted), used below to pool
  // multi-period DRP residuals.
  type CashEntry = { date: string; amount: number };
  const cashByInstrument = new Map<string, CashEntry[]>();

  for (const t of cashRows) {
    const amount = dividendRowAmount(t);
    if (!amount) continue;
    const ticker = (t.ticker || "").toUpperCase();
    const exchange = (t.exchange || "ASX").toUpperCase();
    events.push({
      date: t.date,
      ticker,
      exchange,
      currency: (t.currency || "AUD").toUpperCase(),
      amount,
      source: "cash",
    });
    const key = `${ticker}|${exchange}`;
    const list = cashByInstrument.get(key) ?? [];
    list.push({ date: t.date, amount });
    cashByInstrument.set(key, list);
  }
  for (const list of cashByInstrument.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
  }

  // Cumulative $ already drawn from each instrument's pool by an earlier
  // (chronologically prior) DRP row, so a later DRP can't redraw the same
  // pooled dividends.
  const poolConsumed = new Map<string, number>();
  const sortedDrpRows = [...drpRows].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  for (const t of sortedDrpRows) {
    const amount = dividendRowAmount(t);
    if (!amount) continue;
    const ticker = (t.ticker || "").toUpperCase();
    const exchange = (t.exchange || "ASX").toUpperCase();
    const currency = (t.currency || "AUD").toUpperCase();

    // Primary: an obviously-matching same-event cash dividend nearby (full
    // or partial reinvest of ONE distribution) — unchanged from before.
    if (hasMatchingCashDividend(cashRows, ticker, exchange, t.date, amount)) {
      continue;
    }

    const key = `${ticker}|${exchange}`;
    const cashHistory = cashByInstrument.get(key) ?? [];

    if (cashHistory.length >= 2) {
      const availableAsOfDate = cashHistory
        .filter((c) => c.date <= t.date)
        .reduce((sum, c) => sum + c.amount, 0);
      const alreadyConsumed = poolConsumed.get(key) ?? 0;
      const pool = Math.max(0, availableAsOfDate - alreadyConsumed);
      const draw = Math.min(pool, amount);
      poolConsumed.set(key, alreadyConsumed + draw);

      const shortfall = amount - draw;
      if (shortfall <= 0) continue; // fully explained by prior distributions
      events.push({
        date: t.date,
        ticker,
        exchange,
        currency,
        amount: shortfall,
        source: "drp",
      });
      continue;
    }

    // Fallback: no pooling evidence — count in full (matches prior
    // behaviour for DRP-only imports with no cash-dividend data at all).
    events.push({ date: t.date, ticker, exchange, currency, amount, source: "drp" });
  }

  const bucket = new Map<string, IncomeLine>();
  const missingFx = new Set<string>();

  for (const e of events) {
    const fy = auFinancialYear(e.date);
    const key = `${fy}|${e.exchange}|${e.currency}`;
    const cur = bucket.get(key) ?? {
      financialYear: fy,
      exchange: e.exchange,
      currency: e.currency,
      amount: 0,
      amountAud: 0,
      amountCashAud: 0,
      amountDrpAud: 0,
      count: 0,
      cashCount: 0,
      drpCount: 0,
    };
    cur.amount += e.amount;
    cur.count += 1;
    if (e.source === "cash") cur.cashCount += 1;
    else cur.drpCount += 1;

    const aud = toAud(e.amount, e.currency, fxRates);
    const missing = aud == null && e.currency !== "AUD";
    const audOrNative = aud ?? e.amount;
    if (missing) {
      missingFx.add(e.currency);
      cur.amountAud = cur.amountAud === 0 ? null : cur.amountAud;
      if (e.source === "cash") {
        cur.amountCashAud = cur.amountCashAud === 0 ? null : cur.amountCashAud;
      } else {
        cur.amountDrpAud = cur.amountDrpAud === 0 ? null : cur.amountDrpAud;
      }
    } else {
      cur.amountAud = (cur.amountAud ?? 0) + audOrNative;
      if (e.source === "cash") {
        cur.amountCashAud = (cur.amountCashAud ?? 0) + audOrNative;
      } else {
        cur.amountDrpAud = (cur.amountDrpAud ?? 0) + audOrNative;
      }
    }
    bucket.set(key, cur);
  }

  const byFy = [...bucket.values()]
    .map((line) => ({
      ...line,
      amount: round2(line.amount),
      amountAud: line.amountAud == null ? null : round2(line.amountAud),
      amountCashAud:
        line.amountCashAud == null ? null : round2(line.amountCashAud),
      amountDrpAud:
        line.amountDrpAud == null ? null : round2(line.amountDrpAud),
    }))
    .sort((a, b) => {
      const fy = b.financialYear.localeCompare(a.financialYear);
      if (fy !== 0) return fy;
      const ex = a.exchange.localeCompare(b.exchange);
      if (ex !== 0) return ex;
      return a.currency.localeCompare(b.currency);
    });

  const fyMap = new Map<
    string,
    {
      financialYear: string;
      amountAud: number | null;
      amountCashAud: number | null;
      amountDrpAud: number | null;
      amountNativeMixed: number;
      count: number;
      cashCount: number;
      drpCount: number;
      hasMissing: boolean;
      hasMissingCash: boolean;
      hasMissingDrp: boolean;
    }
  >();
  for (const line of byFy) {
    const cur = fyMap.get(line.financialYear) ?? {
      financialYear: line.financialYear,
      amountAud: 0,
      amountCashAud: 0,
      amountDrpAud: 0,
      amountNativeMixed: 0,
      count: 0,
      cashCount: 0,
      drpCount: 0,
      hasMissing: false,
      hasMissingCash: false,
      hasMissingDrp: false,
    };
    cur.amountNativeMixed += line.amount;
    cur.count += line.count;
    cur.cashCount += line.cashCount;
    cur.drpCount += line.drpCount;
    if (line.amountAud == null) {
      cur.hasMissing = true;
    } else {
      cur.amountAud = (cur.amountAud ?? 0) + line.amountAud;
    }
    if (line.amountCashAud == null) {
      cur.hasMissingCash = true;
    } else {
      cur.amountCashAud = (cur.amountCashAud ?? 0) + line.amountCashAud;
    }
    if (line.amountDrpAud == null) {
      cur.hasMissingDrp = true;
    } else {
      cur.amountDrpAud = (cur.amountDrpAud ?? 0) + line.amountDrpAud;
    }
    fyMap.set(line.financialYear, cur);
  }

  const fyTotals = [...fyMap.values()]
    .map((t) => ({
      financialYear: t.financialYear,
      amountAud:
        t.hasMissing && t.amountAud === 0
          ? null
          : t.amountAud == null
            ? null
            : round2(t.amountAud),
      amountCashAud:
        t.hasMissingCash && t.amountCashAud === 0
          ? null
          : t.amountCashAud == null
            ? null
            : round2(t.amountCashAud),
      amountDrpAud:
        t.hasMissingDrp && t.amountDrpAud === 0
          ? null
          : t.amountDrpAud == null
            ? null
            : round2(t.amountDrpAud),
      amountNativeMixed: round2(t.amountNativeMixed),
      count: t.count,
      cashCount: t.cashCount,
      drpCount: t.drpCount,
    }))
    .sort((a, b) => b.financialYear.localeCompare(a.financialYear));

  let grandTotalAud: number | null = 0;
  let anyAud = false;
  let anyMissing = false;
  for (const line of byFy) {
    if (line.amountAud == null) {
      anyMissing = true;
      continue;
    }
    anyAud = true;
    grandTotalAud = (grandTotalAud ?? 0) + line.amountAud;
  }
  if (!anyAud) grandTotalAud = null;
  else if (anyMissing) {
    grandTotalAud = round2(grandTotalAud ?? 0);
  } else {
    grandTotalAud = round2(grandTotalAud ?? 0);
  }

  const dividendEvents: AssessableDividendEvent[] = events
    .map((e) => ({
      financialYear: auFinancialYear(e.date),
      date: e.date,
      ticker: e.ticker,
      exchange: e.exchange,
      currency: e.currency,
      amount: round2(e.amount),
      amountAud: (() => {
        const aud = toAud(e.amount, e.currency, fxRates);
        return aud == null ? (e.currency === "AUD" ? round2(e.amount) : null) : round2(aud);
      })(),
      source: e.source,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    byFy,
    fyTotals,
    events: dividendEvents,
    grandTotalAud,
    missingFx: [...missingFx].sort(),
    notes,
  };
}

/**
 * True when a cash dividend for the same instrument is nearby with a similar
 * amount — treat DRP as the reinvest lot for that cash, not a second income event.
 */
function hasMatchingCashDividend(
  cashRows: TxPick[],
  ticker: string,
  exchange: string,
  date: string,
  drpAmount: number,
): boolean {
  const tU = ticker.toUpperCase();
  const eU = exchange.toUpperCase();
  for (const c of cashRows) {
    if ((c.ticker || "").toUpperCase() !== tU) continue;
    if ((c.exchange || "ASX").toUpperCase() !== eU) continue;
    if (!withinDays(c.date, date, 7)) continue;
    const cashAmt = dividendRowAmount(c);
    if (cashAmt <= 0) continue;
    if (amountsRoughlyEqual(cashAmt, drpAmount)) return true;
  }
  return false;
}

function amountsRoughlyEqual(a: number, b: number): boolean {
  const max = Math.max(Math.abs(a), Math.abs(b));
  if (max < 1e-9) return true;
  // $1 absolute or 5% relative — covers rounding / brokerage-free DRP lots
  return Math.abs(a - b) <= Math.max(1, max * 0.05);
}

function withinDays(a: string, b: string, days: number): boolean {
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(db)) return a === b;
  return Math.abs(da - db) <= days * 86_400_000;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
