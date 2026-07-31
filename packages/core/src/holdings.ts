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

  const sorted = [...transactions].sort((a, b) =>
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
      /**
       * AUD cost base accumulated per-transaction using each buy's own
       * historical FX rate (tx.fxRateToAud) when known, falling back to
       * today's rate only for the transactions that lack one — unlike
       * `costBase` above, which stays in native currency and only gets
       * converted to AUD once at the very end (see costBaseAud below).
       */
      costBaseAudHist: number;
      /** False until at least one buy successfully contributes a known AUD amount. */
      costBaseAudKnown: boolean;
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
      costBaseAudHist: 0,
      costBaseAudKnown: false,
    };

    switch (tx.type) {
      // transfer_in/transfer_out are intentionally excluded from holdings —
      // shown in the transaction log, never counted here. They never carry a
      // real price/cost (issuer PDFs and broker HIN-conversion rows alike
      // report bare unit counts), so a "missing offsetting buy" would produce
      // an inaccurate cost base regardless of whether the quantity is
      // counted; the user has confirmed this tradeoff is acceptable.
      case "buy":
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

        // AUD side: this transaction's own historical rate when known
        // (accurate), else today's rate for just this contribution (best
        // effort) — never the blended "convert the whole total at today's
        // rate" approach, which misrepresents years of AUDUSD movement as
        // if every buy happened today.
        const costAddAud =
          cur.currency === "AUD"
            ? costAdd
            : tx.fxRateToAud != null
              ? costAddNative / tx.fxRateToAud
              : toAud(costAddNative, txCurrency, fx);
        if (costAddAud != null) {
          cur.costBaseAudHist += costAddAud;
          cur.costBaseAudKnown = true;
        }
        break;
      }
      case "sell": {
        if (cur.quantity <= 0) break;
        const sellQty = Math.min(tx.quantity, cur.quantity);
        const avg = cur.costBase / cur.quantity;
        const avgAud = cur.costBaseAudHist / cur.quantity;
        cur.costBase -= avg * sellQty;
        cur.costBaseAudHist -= avgAud * sellQty;
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
      cur.costBaseAudHist = 0;
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
    // AUD cost base uses the per-transaction historical-rate accumulator
    // (see the buy/drp case above) rather than re-converting
    // the native-currency total at today's rate — years of AUDUSD movement
    // otherwise get misrepresented as if every purchase happened today.
    const costBaseAud =
      costCcy === "AUD"
        ? h.costBase
        : h.costBaseAudKnown
          ? h.costBaseAudHist
          : null;
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
