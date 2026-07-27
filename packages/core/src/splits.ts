/**
 * Stock-split helpers for mark-to-market against split-adjusted prices (Yahoo).
 *
 * Ledger qty is as-traded until a Sharesight `split` delta row applies.
 * Yahoo historical closes are fully split-adjusted. For valuation on date D,
 * use effectiveQty = rawQty(D) × product of split ratios with split.date > D.
 * Cost base is never multiplied.
 */
import { holdingPriceKey } from "./market.js";
import type { ParsedTransaction } from "./types.js";

export type SplitEvent = {
  /** EXCHANGE:TICKER */
  key: string;
  ticker: string;
  exchange: string;
  date: string;
  /** qty_after / qty_before, e.g. 5 for a 5-for-1 */
  ratio: number;
};

/**
 * Walk the ledger and infer split ratios from `type === "split"` deltas.
 * ratio = (qty_before + split.quantity) / qty_before when qty_before > 0.
 */
export function inferSplitEvents(
  transactions: ParsedTransaction[],
): SplitEvent[] {
  const sorted = [...transactions].sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    if (d !== 0) return d;
    // Stable-ish: splits after same-day trades that affect qty
    if (a.type === "split" && b.type !== "split") return 1;
    if (b.type === "split" && a.type !== "split") return -1;
    return 0;
  });

  const qty = new Map<string, number>();
  const events: SplitEvent[] = [];

  for (const tx of sorted) {
    const exchange = (tx.exchange || "ASX").toUpperCase();
    const ticker = tx.ticker.toUpperCase();
    const key = holdingPriceKey(exchange, ticker);
    let q = qty.get(key) ?? 0;

    switch (tx.type) {
      case "buy":
      case "transfer_in":
      case "drp":
        q += tx.quantity;
        break;
      case "sell":
      case "transfer_out":
        q = Math.max(0, q - tx.quantity);
        break;
      case "split": {
        const before = q;
        if (before > 1e-12 && tx.quantity !== 0) {
          const after = before + tx.quantity;
          if (after > 1e-12) {
            const ratio = after / before;
            // Ignore no-ops / noise; real splits are usually >= 1.5 or <= 0.75
            if (Number.isFinite(ratio) && Math.abs(ratio - 1) > 1e-6) {
              events.push({
                key,
                ticker,
                exchange,
                date: tx.date,
                ratio,
              });
            }
          }
        }
        q += tx.quantity;
        break;
      }
      default:
        break;
    }
    if (q < 1e-12) q = 0;
    qty.set(key, q);
  }

  return events;
}

/**
 * Product of split ratios for this instrument with split.date > asOf.
 * Yahoo adj prices already include these future splits relative to asOf qty.
 */
export function splitFactorAfter(
  asOf: string,
  key: string,
  events: SplitEvent[],
): number {
  let factor = 1;
  for (const e of events) {
    if (e.key !== key) continue;
    if (e.date > asOf) {
      factor *= e.ratio;
    }
  }
  return factor;
}

/** effectiveQty for pricing with split-adjusted market prices. */
export function valuationQuantity(
  rawQty: number,
  asOf: string | undefined,
  key: string,
  events: SplitEvent[] | undefined,
): number {
  if (!asOf || !events?.length || rawQty <= 0) return rawQty;
  const f = splitFactorAfter(asOf, key, events);
  return rawQty * f;
}
