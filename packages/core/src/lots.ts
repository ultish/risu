/**
 * Per-parcel (FIFO) cost-base lot tracking — a per-lot alternative to the
 * pooled average cost `computeHoldings` uses. Needed to compute *realised*
 * CGT against the actual ledger (each parcel's own acquisition date decides
 * discount eligibility / indexation period), not just the planner's
 * hypothetical single-lot liquidation.
 *
 * Same exclusions as `computeHoldings`/`inferSplitEvents`: transfer_in/out
 * carry no reliable cost and are never turned into lots or consumed by
 * sells; a split scales open lots' quantity proportionally without
 * changing their cost base (a split doesn't create or destroy value).
 */
import {
  convertCurrency,
  defaultCurrencyForExchange,
  holdingPriceKey,
  toAud,
} from "./market.js";
import type { ParsedTransaction } from "./types.js";

export type Lot = {
  ticker: string;
  exchange: string;
  currency: string;
  /** Acquisition date of this specific parcel (buy or DRP allotment). */
  acquiredDate: string;
  /** Quantity originally acquired (scaled by any later splits). */
  originalQuantity: number;
  /** Quantity remaining after FIFO consumption by sells. */
  quantity: number;
  /** Remaining AUD cost base for `quantity` units of this lot. */
  costBaseAud: number;
};

export type RealisedDisposal = {
  ticker: string;
  exchange: string;
  /** Acquisition date of the specific lot this portion of the sale came from. */
  acquiredDate: string;
  disposedDate: string;
  quantity: number;
  proceedsAud: number;
  costBaseAud: number;
};

export type LotsResult = {
  /** Still-held parcels, oldest first. */
  openLots: Lot[];
  /** FIFO-matched disposals, one row per (sell × lot) portion consumed. */
  disposals: RealisedDisposal[];
};

/**
 * Walk the ledger chronologically, building FIFO cost-base lots per
 * ticker+exchange and recording a realised disposal for each portion of a
 * sell matched against a lot.
 */
export function computeLots(
  transactions: ParsedTransaction[],
  fxRates: Record<string, number | null | undefined> = {},
): LotsResult {
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  const lotsByKey = new Map<string, Lot[]>();
  const disposals: RealisedDisposal[] = [];

  for (const tx of sorted) {
    const exchange = (tx.exchange || "ASX").toUpperCase();
    const ticker = tx.ticker.toUpperCase();
    const key = holdingPriceKey(exchange, ticker);
    const canonicalCurrency = defaultCurrencyForExchange(exchange);
    const txCurrency = (tx.currency || canonicalCurrency).toUpperCase();
    const lots = lotsByKey.get(key) ?? [];
    if (!lotsByKey.has(key)) lotsByKey.set(key, lots);

    switch (tx.type) {
      case "buy":
      case "drp": {
        if (tx.quantity <= 0) break;
        const unitCost =
          tx.price ??
          (tx.amount != null && tx.quantity !== 0
            ? tx.amount / tx.quantity
            : 0);
        const costNative =
          tx.amount != null
            ? tx.amount + (tx.brokerage || 0)
            : unitCost * tx.quantity + (tx.brokerage || 0);
        const costAud = nativeToAud(
          costNative,
          txCurrency,
          canonicalCurrency,
          tx.fxRateToAud,
          fxRates,
        );
        if (costAud == null) break; // can't establish a cost base — skip rather than fabricate
        lots.push({
          ticker,
          exchange,
          currency: canonicalCurrency,
          acquiredDate: tx.date,
          originalQuantity: tx.quantity,
          quantity: tx.quantity,
          costBaseAud: costAud,
        });
        break;
      }
      case "sell": {
        if (tx.quantity <= 0) break;
        const proceedsNative =
          tx.amount != null
            ? tx.amount - (tx.brokerage || 0)
            : (tx.price ?? 0) * tx.quantity - (tx.brokerage || 0);
        const proceedsAud = nativeToAud(
          proceedsNative,
          txCurrency,
          canonicalCurrency,
          tx.fxRateToAud,
          fxRates,
        );
        const perUnitProceedsAud =
          proceedsAud != null && tx.quantity > 0
            ? proceedsAud / tx.quantity
            : null;

        let remaining = tx.quantity;
        for (const lot of lots) {
          if (remaining <= 1e-9) break;
          if (lot.quantity <= 1e-9) continue;
          const take = Math.min(lot.quantity, remaining);
          const lotUnitCostAud = lot.costBaseAud / lot.quantity;
          const costTaken = lotUnitCostAud * take;
          disposals.push({
            ticker,
            exchange,
            acquiredDate: lot.acquiredDate,
            disposedDate: tx.date,
            quantity: take,
            proceedsAud: perUnitProceedsAud != null ? perUnitProceedsAud * take : 0,
            costBaseAud: costTaken,
          });
          lot.quantity -= take;
          lot.costBaseAud -= costTaken;
          remaining -= take;
        }
        // A sell exceeding all known lots (e.g. history predates the ledger)
        // has no lot to draw cost from — the excess quantity is silently
        // dropped rather than fabricating a cost base for it.
        break;
      }
      case "split": {
        const totalQty = lots.reduce((s, l) => s + l.quantity, 0);
        if (totalQty > 1e-9 && tx.quantity !== 0) {
          const after = totalQty + tx.quantity;
          if (after > 1e-9) {
            const ratio = after / totalQty;
            for (const lot of lots) {
              lot.quantity *= ratio;
              lot.originalQuantity *= ratio;
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }

  const openLots: Lot[] = [];
  for (const lots of lotsByKey.values()) {
    for (const lot of lots) {
      if (lot.quantity > 1e-9) {
        openLots.push({
          ...lot,
          quantity: roundQty(lot.quantity),
          costBaseAud: roundMoney(lot.costBaseAud),
        });
      }
    }
  }
  openLots.sort((a, b) => {
    const e = a.exchange.localeCompare(b.exchange);
    if (e !== 0) return e;
    const t = a.ticker.localeCompare(b.ticker);
    if (t !== 0) return t;
    return a.acquiredDate.localeCompare(b.acquiredDate);
  });

  return {
    openLots,
    disposals: disposals.map((d) => ({
      ...d,
      quantity: roundQty(d.quantity),
      proceedsAud: roundMoney(d.proceedsAud),
      costBaseAud: roundMoney(d.costBaseAud),
    })),
  };
}

/**
 * Convert a native-currency amount to AUD using this transaction's own
 * historical rate when known (accurate), else today's cached rate (best
 * effort) — same precedence `computeHoldings` uses, never a blended
 * today's-rate conversion of the whole ledger.
 */
function nativeToAud(
  amountNative: number,
  txCurrency: string,
  canonicalCurrency: string,
  fxRateToAud: number | null | undefined,
  fxRates: Record<string, number | null | undefined>,
): number | null {
  if (canonicalCurrency === "AUD" && txCurrency === "AUD") return amountNative;
  if (fxRateToAud != null) return amountNative / fxRateToAud;
  if (txCurrency === canonicalCurrency) {
    return toAud(amountNative, txCurrency, fxRates);
  }
  const canonical = convertCurrency(
    amountNative,
    txCurrency,
    canonicalCurrency,
    fxRates,
  );
  if (canonical == null) return null;
  return toAud(canonical, canonicalCurrency, fxRates);
}

function roundMoney(n: number) {
  return Math.round(n * 100) / 100;
}

function roundQty(n: number) {
  return Math.round(n * 1e6) / 1e6;
}
