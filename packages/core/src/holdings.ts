import {
  defaultCurrencyForExchange,
  holdingPriceKey,
  toAud,
} from "./market.js";
import type { Holding, ParsedTransaction } from "./types.js";

export type HoldingsPriceMaps = {
  /** Key: "EXCHANGE:TICKER" or yahoo symbol — last price in native currency */
  prices: Record<string, number | null | undefined>;
  /**
   * FX rates from Yahoo style pairs, e.g. AUDUSD=X = USD per 1 AUD.
   * Also accept currency code keys if pre-normalised.
   */
  fxRates?: Record<string, number | null | undefined>;
};

/**
 * Build current holdings from a chronological transaction ledger.
 * Cost base stays in trade currency; AUD fields use fxRates when available.
 */
export function computeHoldings(
  transactions: ParsedTransaction[],
  marketPrices: Record<string, number | null> | HoldingsPriceMaps = {},
): Holding[] {
  const maps: HoldingsPriceMaps =
    "prices" in marketPrices && marketPrices.prices
      ? (marketPrices as HoldingsPriceMaps)
      : { prices: marketPrices as Record<string, number | null> };

  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
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
    const currency = (
      tx.currency || defaultCurrencyForExchange(exchange)
    ).toUpperCase();
    const key = keyOf({ ...tx, exchange });
    const cur = map.get(key) ?? {
      ticker: tx.ticker.toUpperCase(),
      exchange,
      currency,
      quantity: 0,
      costBase: 0,
    };
    // Prefer first non-empty currency on the book
    if (!cur.currency) cur.currency = currency;

    switch (tx.type) {
      case "buy":
      case "transfer_in":
      case "drp": {
        const unitCost =
          tx.price ??
          (tx.amount != null && tx.quantity !== 0
            ? tx.amount / tx.quantity
            : 0);
        const costAdd =
          tx.amount != null
            ? tx.amount + (tx.brokerage || 0)
            : unitCost * tx.quantity + (tx.brokerage || 0);
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

  const fx = maps.fxRates ?? {};
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
    const marketValue =
      marketPrice != null ? marketPrice * h.quantity : null;

    let fxRate: number | null = null;
    if (h.currency !== "AUD") {
      const pair =
        h.currency === "USD"
          ? "AUDUSD=X"
          : h.currency === "GBP"
            ? "AUDGBP=X"
            : h.currency === "EUR"
              ? "AUDEUR=X"
              : `AUD${h.currency}=X`;
      fxRate = fx[pair] ?? fx[h.currency] ?? null;
    }

    const costBaseAud = toAud(h.costBase, h.currency, fx);
    const marketValueAud =
      marketValue != null ? toAud(marketValue, h.currency, fx) : null;

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
