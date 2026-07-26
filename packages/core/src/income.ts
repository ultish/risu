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
  count: number;
  /** How many rows were cash dividends vs DRP-only (reinvest still taxable) */
  cashCount: number;
  drpCount: number;
};

export type IncomeSummary = {
  byFy: IncomeLine[];
  /** Totals rolled by FY (AUD when possible) */
  fyTotals: Array<{
    financialYear: string;
    amountAud: number | null;
    amountNativeMixed: number;
    count: number;
    cashCount: number;
    drpCount: number;
  }>;
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
 *   (same ticker + exchange, within ±7 days, amounts roughly equal).
 *
 * Rationale: AU tax — a dividend is assessable even when reinvested via DRP.
 * Cost base of DRP lots is separate; this rollup is income only.
 *
 * When both cash and DRP exist for the same event (common full-DRP exports),
 * only cash is counted. When only DRP is imported (Sharesight All Trades style),
 * the DRP amount is treated as assessable. Partial DRP (cash + reinvest, different
 * amounts) counts both.
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
    "DRP rows near an equal cash dividend for the same instrument are skipped to avoid double-count.",
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

  for (const t of cashRows) {
    const amount = dividendRowAmount(t);
    if (!amount) continue;
    events.push({
      date: t.date,
      ticker: (t.ticker || "").toUpperCase(),
      exchange: (t.exchange || "ASX").toUpperCase(),
      currency: (t.currency || "AUD").toUpperCase(),
      amount,
      source: "cash",
    });
  }

  for (const t of drpRows) {
    const amount = dividendRowAmount(t);
    if (!amount) continue;
    const ticker = (t.ticker || "").toUpperCase();
    const exchange = (t.exchange || "ASX").toUpperCase();
    if (hasMatchingCashDividend(cashRows, ticker, exchange, t.date, amount)) {
      continue;
    }
    events.push({
      date: t.date,
      ticker,
      exchange,
      currency: (t.currency || "AUD").toUpperCase(),
      amount,
      source: "drp",
    });
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
      count: 0,
      cashCount: 0,
      drpCount: 0,
    };
    cur.amount += e.amount;
    cur.count += 1;
    if (e.source === "cash") cur.cashCount += 1;
    else cur.drpCount += 1;

    const aud = toAud(e.amount, e.currency, fxRates);
    if (aud == null && e.currency !== "AUD") {
      missingFx.add(e.currency);
      cur.amountAud = cur.amountAud === 0 ? null : cur.amountAud;
    } else if (aud != null) {
      cur.amountAud = (cur.amountAud ?? 0) + aud;
    } else {
      cur.amountAud = (cur.amountAud ?? 0) + e.amount;
    }
    bucket.set(key, cur);
  }

  const byFy = [...bucket.values()]
    .map((line) => ({
      ...line,
      amount: round2(line.amount),
      amountAud: line.amountAud == null ? null : round2(line.amountAud),
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
      amountNativeMixed: number;
      count: number;
      cashCount: number;
      drpCount: number;
      hasMissing: boolean;
    }
  >();
  for (const line of byFy) {
    const cur = fyMap.get(line.financialYear) ?? {
      financialYear: line.financialYear,
      amountAud: 0,
      amountNativeMixed: 0,
      count: 0,
      cashCount: 0,
      drpCount: 0,
      hasMissing: false,
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

  return {
    byFy,
    fyTotals,
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
