import {
  convertCurrency,
  defaultCurrencyForExchange,
  holdingPriceKey,
  toAud,
} from "./market.js";
import {
  type SplitEvent,
  valuationQuantity,
} from "./splits.js";
import type { Holding, ParsedTransaction } from "./types.js";

/**
 * Market quotes are always in the exchange's quote currency (US→USD, ASX→AUD).
 * Cost base is now always accumulated in this same canonical currency too
 * (see computeHoldings) — a mismatched ledger `currency` (e.g. Sharesight's
 * paste sometimes storing an already-FX-converted AUD figure for a USD
 * trade) gets converted at accumulation time, not trusted at face value.
 */
function quoteCurrencyForHolding(exchange: string, ledgerCurrency: string): string {
  const fromEx = defaultCurrencyForExchange(exchange);
  // Trust exchange default when it is a major market; ledger currency only if exchange unknown
  if (fromEx) return fromEx;
  return (ledgerCurrency || "AUD").toUpperCase();
}

export type HoldingsPriceMaps = {
  /** Key: "EXCHANGE:TICKER" or yahoo symbol — last price in native currency */
  prices: Record<string, number | null | undefined>;
  /**
   * FX rates from Yahoo style pairs, e.g. AUDUSD=X = USD per 1 AUD.
   * Also accept currency code keys if pre-normalised.
   */
  fxRates?: Record<string, number | null | undefined>;
  /**
   * Valuation date (yyyy-mm-dd). When set with splitEvents, market value uses
   * rawQty × product of split ratios with date > valuationAsOf (Yahoo adj scale).
   * Cost / displayed quantity stay on ledger scale.
   */
  valuationAsOf?: string;
  /**
   * Split events from the full ledger (including splits after valuationAsOf).
   * Required for correct historical MTM against split-adjusted prices.
   */
  splitEvents?: SplitEvent[];
};

/** Settlement lands at most this many days after the trade that caused it. */
const TRANSFER_DUPLICATE_WINDOW_DAYS = 5;

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (new Date(toIso).getTime() - new Date(fromIso).getTime()) /
      (1000 * 60 * 60 * 24),
  );
}

/**
 * Issuer registry annual statements (Computershare, Link/MUFG) report every
 * CHESS settlement as a `transfer_in`/`transfer_out` row — the registry has
 * no way to know the same settlement was already recorded as a `buy`/`sell`
 * from the actual broker import (e.g. a Pocket CSV). When a transfer's
 * quantity is *exactly* explained by nearby buy/sell quantity for the same
 * instrument (settlement typically lands T+2, so within a few days of the
 * trade), it's that duplicate, not a genuine external transfer — drop it
 * before accumulating holdings/cost base.
 *
 * Only an exact quantity match is dropped; a partial/ambiguous match is left
 * alone rather than guessed at (docs §15.3 "warn > silent drop" — silently
 * discarding a real transfer would be far worse than leaving a rare
 * unresolved double-count visible).
 */
function dropDuplicateTransfers(
  transactions: ParsedTransaction[],
): ParsedTransaction[] {
  const byKey = new Map<string, ParsedTransaction[]>();
  for (const tx of transactions) {
    const key = holdingPriceKey(tx.exchange || "ASX", tx.ticker);
    const list = byKey.get(key);
    if (list) list.push(tx);
    else byKey.set(key, [tx]);
  }

  const drop = new Set<ParsedTransaction>();
  for (const list of byKey.values()) {
    for (const t of list) {
      if (t.type !== "transfer_in" && t.type !== "transfer_out") continue;
      const wantType = t.type === "transfer_in" ? "buy" : "sell";
      const nearbySum = list
        .filter(
          (o) =>
            o.type === wantType &&
            o.date <= t.date &&
            daysBetween(o.date, t.date) <= TRANSFER_DUPLICATE_WINDOW_DAYS,
        )
        .reduce((sum, o) => sum + o.quantity, 0);
      if (nearbySum > 0 && Math.abs(nearbySum - t.quantity) < 1e-9) {
        drop.add(t);
      }
    }
  }

  return drop.size ? transactions.filter((t) => !drop.has(t)) : transactions;
}

/**
 * Build current holdings from a chronological transaction ledger.
 * Cost base is always accumulated in the ticker's exchange-canonical
 * currency (see below); AUD fields use fxRates when available.
 */
export function computeHoldings(
  transactions: ParsedTransaction[],
  marketPrices: Record<string, number | null> | HoldingsPriceMaps = {},
): Holding[] {
  const maps: HoldingsPriceMaps =
    "prices" in marketPrices && marketPrices.prices
      ? (marketPrices as HoldingsPriceMaps)
      : { prices: marketPrices as Record<string, number | null> };
  const fx = maps.fxRates ?? {};

  const sorted = [...dropDuplicateTransfers(transactions)].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const map = new Map<
    string,
    {
      ticker: string;
      exchange: string;
      currency: string;
      quantity: number;
      costBase: number;
    }
  >();

  const keyOf = (t: ParsedTransaction) =>
    holdingPriceKey(t.exchange || "ASX", t.ticker);

  for (const tx of sorted) {
    const exchange = (tx.exchange || "ASX").toUpperCase();
    const txCurrency = (
      tx.currency || defaultCurrencyForExchange(exchange)
    ).toUpperCase();
    const key = keyOf({ ...tx, exchange });
    // A stock trades in one currency for its whole history, determined by
    // its exchange (US→USD, ASX→AUD, …) — not by which import source
    // happened to record a given trade. Sharesight's paste mechanism, for
    // one, sometimes stores an already-FX-converted AUD figure for a
    // USD-exchange trade. Treat the exchange-implied currency as canonical
    // and convert any mismatched transaction's dollar amount into it before
    // accumulating cost base, so mixed-source imports for the same ticker
    // never silently blend two currencies together.
    const canonicalCurrency = defaultCurrencyForExchange(exchange);
    const cur = map.get(key) ?? {
      ticker: tx.ticker.toUpperCase(),
      exchange,
      currency: canonicalCurrency,
      quantity: 0,
      costBase: 0,
    };

    switch (tx.type) {
      case "buy":
      case "transfer_in":
      case "drp": {
        const unitCost =
          tx.price ??
          (tx.amount != null && tx.quantity !== 0
            ? tx.amount / tx.quantity
            : 0);
        const costAddNative =
          tx.amount != null
            ? tx.amount + (tx.brokerage || 0)
            : unitCost * tx.quantity + (tx.brokerage || 0);
        const costAdd =
          txCurrency === cur.currency
            ? costAddNative
            : (convertCurrency(costAddNative, txCurrency, cur.currency, fx) ??
              costAddNative);
        cur.quantity += tx.quantity;
        cur.costBase += costAdd;
        break;
      }
      case "sell":
      case "transfer_out": {
        if (cur.quantity <= 0) break;
        const sellQty = Math.min(tx.quantity, cur.quantity);
        const avg = cur.costBase / cur.quantity;
        cur.costBase -= avg * sellQty;
        cur.quantity -= sellQty;
        break;
      }
      case "split": {
        cur.quantity += tx.quantity;
        break;
      }
      default:
        break;
    }

    if (cur.quantity < 1e-10) {
      cur.quantity = 0;
      cur.costBase = 0;
    }

    map.set(key, cur);
  }

  const holdings: Holding[] = [];

  for (const h of map.values()) {
    if (h.quantity <= 0) continue;
    const key = holdingPriceKey(h.exchange, h.ticker);
    const marketPrice =
      maps.prices[key] ??
      maps.prices[h.ticker] ??
      maps.prices[`${h.ticker}.AX`] ??
      null;
    const avgCost = h.quantity > 0 ? h.costBase / h.quantity : 0;
    // Displayed qty = ledger; pricing qty back-applies future splits for adj prices
    const priceQty = valuationQuantity(
      h.quantity,
      maps.valuationAsOf,
      key,
      maps.splitEvents,
    );
    const marketValue =
      marketPrice != null ? marketPrice * priceQty : null;

    const quoteCcy = quoteCurrencyForHolding(h.exchange, h.currency);
    const costCcy = (h.currency || quoteCcy).toUpperCase();

    let fxRate: number | null = null;
    if (quoteCcy !== "AUD") {
      const pair =
        quoteCcy === "USD"
          ? "AUDUSD=X"
          : quoteCcy === "GBP"
            ? "AUDGBP=X"
            : quoteCcy === "EUR"
              ? "AUDEUR=X"
              : `AUD${quoteCcy}=X`;
      fxRate = fx[pair] ?? fx[quoteCcy] ?? null;
    }

    // Cost and quote currency are now always the same canonical currency.
    const costBaseAud = toAud(h.costBase, costCcy, fx);
    const marketValueAud =
      marketValue != null ? toAud(marketValue, quoteCcy, fx) : null;

    holdings.push({
      ticker: h.ticker,
      exchange: h.exchange,
      currency: h.currency,
      quantity: roundQty(h.quantity),
      avgCost: roundMoney(avgCost),
      costBase: roundMoney(h.costBase),
      marketPrice: marketPrice != null ? roundMoney(marketPrice) : null,
      marketValue: marketValue != null ? roundMoney(marketValue) : null,
      fxRate,
      costBaseAud: costBaseAud != null ? roundMoney(costBaseAud) : null,
      marketValueAud:
        marketValueAud != null ? roundMoney(marketValueAud) : null,
    });
  }

  return holdings.sort((a, b) => {
    const e = a.exchange.localeCompare(b.exchange);
    if (e !== 0) return e;
    return a.ticker.localeCompare(b.ticker);
  });
}

function roundMoney(n: number) {
  return Math.round(n * 100) / 100;
}

function roundQty(n: number) {
  return Math.round(n * 1e6) / 1e6;
}
