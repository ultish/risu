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
  /** Sum of cash dividends in trade currency */
  amount: number;
  /** AUD converted when FX available; else null for non-AUD */
  amountAud: number | null;
  count: number;
};

export type IncomeSummary = {
  byFy: IncomeLine[];
  /** Totals rolled by FY (AUD when possible) */
  fyTotals: Array<{
    financialYear: string;
    amountAud: number | null;
    amountNativeMixed: number;
    count: number;
  }>;
  grandTotalAud: number | null;
  missingFx: string[];
};

/**
 * Summarise `dividend_cash` ledger rows by AU financial year and exchange/currency.
 * Pass Yahoo-style FX map (e.g. `{ "AUDUSD=X": 0.65 }`) to convert foreign cash to AUD.
 */
export function summarizeDividendIncome(
  transactions: Array<
    Pick<
      ParsedTransaction,
      "date" | "type" | "amount" | "currency" | "exchange" | "quantity" | "price"
    >
  >,
  fxRates: Record<string, number | null | undefined> = {},
): IncomeSummary {
  const cash = transactions.filter((t) => t.type === "dividend_cash");
  const bucket = new Map<string, IncomeLine>();
  const missingFx = new Set<string>();

  for (const t of cash) {
    const fy = auFinancialYear(t.date);
    const exchange = (t.exchange || "ASX").toUpperCase();
    const currency = (t.currency || "AUD").toUpperCase();
    // Prefer amount; fall back to price × qty for incomplete rows
    const amount =
      t.amount != null
        ? t.amount
        : t.price != null && t.quantity
          ? t.price * t.quantity
          : 0;
    if (!amount) continue;

    const key = `${fy}|${exchange}|${currency}`;
    const cur = bucket.get(key) ?? {
      financialYear: fy,
      exchange,
      currency,
      amount: 0,
      amountAud: 0,
      count: 0,
    };
    cur.amount += amount;
    const aud = toAud(amount, currency, fxRates);
    if (aud == null && currency !== "AUD") {
      missingFx.add(currency);
      cur.amountAud = cur.amountAud === 0 ? null : cur.amountAud;
    } else if (aud != null) {
      cur.amountAud = (cur.amountAud ?? 0) + aud;
    } else {
      cur.amountAud = (cur.amountAud ?? 0) + amount;
    }
    cur.count += 1;
    bucket.set(key, cur);
  }

  const byFy = [...bucket.values()]
    .map((line) => ({
      ...line,
      amount: round2(line.amount),
      amountAud:
        line.amountAud == null ? null : round2(line.amountAud),
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
    { financialYear: string; amountAud: number | null; amountNativeMixed: number; count: number; hasMissing: boolean }
  >();
  for (const line of byFy) {
    const cur = fyMap.get(line.financialYear) ?? {
      financialYear: line.financialYear,
      amountAud: 0,
      amountNativeMixed: 0,
      count: 0,
      hasMissing: false,
    };
    cur.amountNativeMixed += line.amount;
    cur.count += line.count;
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
      amountAud: t.hasMissing && t.amountAud === 0 ? null : t.amountAud == null ? null : round2(t.amountAud),
      amountNativeMixed: round2(t.amountNativeMixed),
      count: t.count,
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
    // Partial AUD total is still useful; keep it
    grandTotalAud = round2(grandTotalAud ?? 0);
  } else {
    grandTotalAud = round2(grandTotalAud ?? 0);
  }

  return {
    byFy,
    fyTotals,
    grandTotalAud,
    missingFx: [...missingFx].sort(),
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
