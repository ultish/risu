import { computeHoldings } from "./holdings.js";
import {
  computeLots,
  nativeToAud,
  type ComputeLotsOptions,
  type RealisedDisposal,
} from "./lots.js";
import { defaultCurrencyForExchange, holdingPriceKey } from "./market.js";
import {
  buildLastFxIndex,
  buildLastPriceIndex,
  fxAsOf,
  pricesAsOf,
  type FxInput,
  type PriceSeriesMap,
} from "./performance.js";
import { inferSplitEvents } from "./splits.js";
import type { ParsedTransaction } from "./types.js";

/** Parcels bought before this and still held later carry their value on this date for the hybrid CGT regime. */
export const CGT_REGIME_CUTOVER = "2027-07-01";

export type LotAsOf = {
  ticker: string;
  exchange: string;
  acquiredDate: string;
  quantity: number;
  costBaseAud: number;
  /** Null when there is no price on or before `asOf`. */
  marketValueAud: number | null;
  /** Value of this parcel's remaining units at the cutover; null if bought after it, or not yet reached. */
  valueAtCutoverAud: number | null;
};

export type LotsAsOf = {
  asOf: string;
  since: string | null;
  lots: LotAsOf[];
  /** Buys (not DRP) dated within [since, asOf], cost incl. brokerage. */
  buys: { ticker: string; exchange: string; date: string; costAud: number }[];
  /** Sells matched to parcels, disposed within [since, asOf]. */
  disposals: {
    ticker: string;
    exchange: string;
    acquiredDate: string;
    disposedDate: string;
    proceedsAud: number | null;
  }[];
};

export type LotsAsOfOptions = {
  asOf: string;
  since?: string;
  priceSeries?: PriceSeriesMap;
  fx?: FxInput;
  lotOptions?: ComputeLotsOptions;
};

/**
 * The ledger as it stood on `asOf`: every open parcel with its AUD cost
 * base, market value, and value at the 1 Jul 2027 cutover, plus the buys
 * and matched sells inside the `since` window. Built for callers that need
 * real parcels rather than pooled holdings (tanuki's plan tracker).
 *
 * Values reuse `computeHoldings` per instrument so split handling matches
 * the performance chart; a parcel's share is by quantity.
 */
export function lotsAsOf(
  transactions: ParsedTransaction[],
  opts: LotsAsOfOptions,
): LotsAsOf {
  const sorted = [...transactions].sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    if (d !== 0) return d;
    return (a.id ?? 0) - (b.id ?? 0);
  });
  const priceIndex = buildLastPriceIndex(opts.priceSeries ?? {});
  const fxIndex = buildLastFxIndex(opts.fx?.series ?? {});
  const flatFx = opts.fx?.rates ?? {};
  const splitEvents = inferSplitEvents(sorted);

  const ledgerAt = (date: string) => {
    const txs = sorted.filter((t) => t.date <= date);
    const fxRates = fxAsOf(date, flatFx, fxIndex);
    const { openLots, disposals } = computeLots(txs, fxRates, opts.lotOptions);
    const holdings = computeHoldings(txs, {
      prices: pricesAsOf(txs, date, priceIndex),
      fxRates,
      valuationAsOf: date,
      splitEvents,
    });
    const perUnitAud = new Map<string, number | null>();
    for (const h of holdings) {
      perUnitAud.set(
        holdingPriceKey(h.exchange, h.ticker),
        h.marketValueAud != null && h.quantity > 0
          ? h.marketValueAud / h.quantity
          : null,
      );
    }
    return { openLots, disposals, perUnitAud, fxRates };
  };

  const now = ledgerAt(opts.asOf);
  const atCutover =
    opts.asOf >= CGT_REGIME_CUTOVER ? ledgerAt(CGT_REGIME_CUTOVER) : null;
  const cutoverLotByTx = new Map(
    (atCutover?.openLots ?? [])
      .filter((l) => l.sourceTxId != null)
      .map((l) => [l.sourceTxId!, l]),
  );

  const lots: LotAsOf[] = now.openLots.map((lot) => {
    const key = holdingPriceKey(lot.exchange, lot.ticker);
    const unit = now.perUnitAud.get(key) ?? null;
    let valueAtCutoverAud: number | null = null;
    if (atCutover && lot.acquiredDate < CGT_REGIME_CUTOVER && lot.sourceTxId != null) {
      const then = cutoverLotByTx.get(lot.sourceTxId);
      const unitThen = atCutover.perUnitAud.get(key) ?? null;
      if (then && unitThen != null && lot.originalQuantity > 0) {
        // Splits since the cutover scale originalQuantity; undo that so the
        // remaining units are priced on the cutover's unit basis.
        const unitsThen = lot.quantity * (then.originalQuantity / lot.originalQuantity);
        valueAtCutoverAud = round2(unitThen * unitsThen);
      }
    }
    return {
      ticker: lot.ticker,
      exchange: lot.exchange,
      acquiredDate: lot.acquiredDate,
      quantity: lot.quantity,
      costBaseAud: lot.costBaseAud,
      marketValueAud: unit != null ? round2(unit * lot.quantity) : null,
      valueAtCutoverAud,
    };
  });

  const since = opts.since ?? null;
  const inWindow = (d: string) => (since == null || d >= since) && d <= opts.asOf;

  const buys: LotsAsOf["buys"] = [];
  for (const t of sorted) {
    if (t.type !== "buy" || t.quantity <= 0 || !inWindow(t.date)) continue;
    const exchange = (t.exchange || "ASX").toUpperCase();
    const canonical = defaultCurrencyForExchange(exchange);
    const unitCost =
      t.price ?? (t.amount != null && t.quantity !== 0 ? t.amount / t.quantity : 0);
    const costNative =
      t.amount != null
        ? t.amount + (t.brokerage || 0)
        : unitCost * t.quantity + (t.brokerage || 0);
    const costAud = nativeToAud(
      costNative,
      (t.currency || canonical).toUpperCase(),
      canonical,
      t.fxRateToAud,
      now.fxRates,
    );
    if (costAud == null) continue;
    buys.push({ ticker: t.ticker.toUpperCase(), exchange, date: t.date, costAud: round2(costAud) });
  }

  const disposals = now.disposals
    .filter((d: RealisedDisposal) => inWindow(d.disposedDate))
    .map((d) => ({
      ticker: d.ticker,
      exchange: d.exchange,
      acquiredDate: d.acquiredDate,
      disposedDate: d.disposedDate,
      proceedsAud: Number.isFinite(d.proceedsAud) ? d.proceedsAud : null,
    }));

  return { asOf: opts.asOf, since, lots, buys, disposals };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
