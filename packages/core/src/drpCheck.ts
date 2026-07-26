import type { DividendEvent, ParsedTransaction } from "./types.js";

export type HoldingDrpFlag = {
  ticker: string;
  exchange: string;
  drpEnabled: boolean;
  /** Inclusive ISO date from which DRP/DRIP is on; null = all history if enabled */
  drpFromDate: string | null;
};

export type DrpSuggestion = {
  date: string;
  ticker: string;
  exchange: string;
  /** Estimated cash dividend = unitsHeld × amountPerShare (native currency) */
  cashDiv: number;
  /**
   * Yahoo does not provide DRP issue prices, so expected share allotment is
   * usually null. Caller may fill if they have a known issue price.
   */
  expectedShares: number | null;
  /** Units held on (or just before) the ex/payment date used for cashDiv */
  unitsHeld: number;
  /** Dividend per share from market data */
  amountPerShare: number;
  note: string;
};

export type ImportedDrpRow = {
  date: string;
  quantity: number;
  amount: number | null;
  price: number | null;
};

export type DrpCheckResult = {
  ticker: string;
  exchange: string;
  drpEnabled: boolean;
  drpFromDate: string | null;
  /** Suggestions only when DRP flag is on — never auto-written to ledger */
  suggestions: DrpSuggestion[];
  /** Existing ledger `drp` rows for this instrument */
  importedDrp: ImportedDrpRow[];
  /**
   * Dividend events on/after flag date that have no nearby imported DRP
   * (within ±7 days). User can confirm and add manually.
   */
  unmatchedSuggestions: DrpSuggestion[];
  notes: string[];
};

/**
 * Units held just before/on `asOfDate` from chronological ledger events
 * that affect quantity (buy/sell/drp/transfer/split).
 */
export function unitsHeldAsOf(
  transactions: Array<
    Pick<ParsedTransaction, "date" | "type" | "quantity" | "ticker" | "exchange">
  >,
  ticker: string,
  exchange: string,
  asOfDate: string,
): number {
  const tU = ticker.toUpperCase();
  const eU = exchange.toUpperCase();
  const sorted = [...transactions]
    .filter(
      (t) =>
        t.ticker.toUpperCase() === tU &&
        (t.exchange || "ASX").toUpperCase() === eU &&
        t.date <= asOfDate,
    )
    .sort((a, b) => a.date.localeCompare(b.date));

  let qty = 0;
  for (const tx of sorted) {
    switch (tx.type) {
      case "buy":
      case "transfer_in":
      case "drp":
        qty += tx.quantity;
        break;
      case "sell":
      case "transfer_out":
        qty -= tx.quantity;
        break;
      case "split":
        qty += tx.quantity;
        break;
      default:
        break;
    }
    if (qty < 0) qty = 0;
  }
  return qty;
}

/**
 * Build expected DRP/DRIP check suggestions from Yahoo-style dividend events
 * and a per-holding DRP flag. Does **not** write transactions.
 *
 * When DRP is disabled, returns empty suggestions (flag off = cash only assumed).
 * `expectedShares` is left null — issue price is unknown from Yahoo.
 */
export function buildDrpCheck(input: {
  ticker: string;
  exchange?: string;
  flag: HoldingDrpFlag | null | undefined;
  dividends: DividendEvent[];
  transactions: Array<
    Pick<
      ParsedTransaction,
      | "date"
      | "type"
      | "quantity"
      | "ticker"
      | "exchange"
      | "amount"
      | "price"
    >
  >;
  /** Optional: if provided and > 0, estimate expectedShares = cashDiv / issuePrice */
  issuePriceByDate?: Record<string, number | null | undefined>;
}): DrpCheckResult {
  const ticker = input.ticker.toUpperCase();
  const exchange = (input.exchange || "ASX").toUpperCase();
  const notes: string[] = [];

  const flag = input.flag;
  const drpEnabled = Boolean(flag?.drpEnabled);
  const drpFromDate = flag?.drpFromDate ?? null;

  const importedDrp: ImportedDrpRow[] = input.transactions
    .filter(
      (t) =>
        t.type === "drp" &&
        t.ticker.toUpperCase() === ticker &&
        (t.exchange || "ASX").toUpperCase() === exchange,
    )
    .map((t) => ({
      date: t.date,
      quantity: t.quantity,
      amount: t.amount,
      price: t.price,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!drpEnabled) {
    notes.push(
      "DRP/DRIP flag is off — no expected reinvest suggestions. Toggle flag if this holding reinvests.",
    );
    return {
      ticker,
      exchange,
      drpEnabled: false,
      drpFromDate,
      suggestions: [],
      importedDrp,
      unmatchedSuggestions: [],
      notes,
    };
  }

  notes.push(
    "Suggestions are for confirmation only — they are never written to the ledger automatically.",
  );
  notes.push(
    "Yahoo cash dividends have no franking and no DRP issue price; expectedShares is usually null.",
  );

  const suggestions: DrpSuggestion[] = [];

  for (const div of input.dividends) {
    if (drpFromDate && div.date < drpFromDate) continue;
    if (div.amount <= 0) continue;

    const unitsHeld = unitsHeldAsOf(
      input.transactions,
      ticker,
      exchange,
      div.date,
    );
    if (unitsHeld <= 0) {
      continue;
    }

    const cashDiv = round2(unitsHeld * div.amount);
    const issue = input.issuePriceByDate?.[div.date];
    let expectedShares: number | null = null;
    let note =
      "Cash dividend estimate from units × Yahoo DPS. Confirm against broker DRP allotment.";
    if (issue != null && issue > 0) {
      expectedShares = roundQty(cashDiv / issue);
      note = `Estimated shares ≈ cashDiv / issue price ${issue}. Confirm with broker.`;
    } else {
      note += " Issue price unknown → expectedShares left null.";
    }

    suggestions.push({
      date: div.date,
      ticker,
      exchange,
      cashDiv,
      expectedShares,
      unitsHeld: roundQty(unitsHeld),
      amountPerShare: div.amount,
      note,
    });
  }

  suggestions.sort((a, b) => b.date.localeCompare(a.date));

  const unmatchedSuggestions = suggestions.filter((s) => {
    return !importedDrp.some((row) => withinDays(row.date, s.date, 7));
  });

  if (suggestions.length === 0) {
    notes.push(
      "No dividend events with positive units held while DRP was on. Check Yahoo history or flag from-date.",
    );
  } else if (unmatchedSuggestions.length) {
    notes.push(
      `${unmatchedSuggestions.length} dividend event(s) have no imported DRP within ±7 days — review and add manually if missing.`,
    );
  }

  return {
    ticker,
    exchange,
    drpEnabled: true,
    drpFromDate,
    suggestions,
    importedDrp,
    unmatchedSuggestions,
    notes,
  };
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

function roundQty(n: number) {
  return Math.round(n * 1e6) / 1e6;
}
