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
  /** Buy/DRP ledger row that created this parcel, when known. */
  sourceTxId?: number;
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
  /** Buy/DRP ledger row this portion was taken from, when known. */
  acquireTxId?: number;
  /** Sell ledger row, when this disposal came from a recorded sell. */
  sellTxId?: number;
  /**
   * How this sell was matched to parcels:
   * `recorded` = confirmed specific ID, `fifo` = oldest first (including
   * platform-reported FIFO such as Betashares Direct statement sells),
   * `min_cgt` = minimize-CGT order.
   */
  parcelMatch?: "fifo" | "min_cgt" | "recorded";
};

/**
 * A previously confirmed specific-identification take: this sell consumed
 * `quantity` units of the parcel created by `acquireTxId`. When present,
 * `computeLots` consumes those lots instead of FIFO / min-CGT guessing.
 */
export type RecordedParcelTake = {
  sellTxId: number;
  acquireTxId: number;
  quantity: number;
};

export type LotsResult = {
  /** Still-held parcels, oldest first. */
  openLots: Lot[];
  /** Matched disposals, one row per (sell × lot) portion consumed. */
  disposals: RealisedDisposal[];
};

/** Inputs the lot-order callback sees for a single sell. */
export type LotSaleContext = {
  disposedDate: string;
  /** AUD proceeds per unit of this sell; null when FX conversion failed. */
  proceedsPerUnitAud: number | null;
};

/**
 * Reorder (or subset) the still-open lots for a sell. Must return the
 * **same lot object references** so quantity/cost mutations stick.
 * Default (omitted) is FIFO — the array is already oldest-first.
 */
export type OrderLotsForSale = (lots: Lot[], ctx: LotSaleContext) => Lot[];

export type ComputeLotsOptions = {
  orderLotsForSale?: OrderLotsForSale;
  /**
   * Confirmed parcel takes, keyed by sell. A sell listed here is matched
   * exactly as recorded; other sells still use FIFO / `orderLotsForSale`.
   */
  recordedTakes?: RecordedParcelTake[];
  /** Tag for disposals that used `orderLotsForSale` (default min_cgt). */
  customMatching?: "min_cgt";
  /**
   * Broker/custody ids whose imported statement sells stay FIFO
   * (platform tax report). Default: Betashares Direct. Empty = none.
   */
  platformFifoBrokers?: string[];
};

/** Brokers that issue their own CGT report (FIFO lock) unless configured otherwise. */
export const DEFAULT_PLATFORM_FIFO_BROKERS = ["betashares_direct"];

/**
 * Parse the `platform_fifo_brokers` setting. Missing/invalid → default
 * (Betashares Direct). A JSON `[]` means none — every imported sell can
 * use the Tax tab matching method.
 */
export function parsePlatformFifoBrokers(
  raw: string | null | undefined,
): string[] {
  if (raw == null || raw.trim() === "") {
    return [...DEFAULT_PLATFORM_FIFO_BROKERS];
  }
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [...DEFAULT_PLATFORM_FIFO_BROKERS];
    return v
      .map((x) => String(x).trim().toLowerCase())
      .filter((s) => s.length > 0);
  } catch {
    return raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  }
}

/**
 * Platforms that issue their own CGT report using FIFO. Those imported
 * statement sells stay FIFO even when the Tax tab is on minimize-CGT.
 * A sale you recorded here (`confirm-sale` / Add trade) is never locked.
 */
export function isPlatformReportedFifoSell(
  tx: {
    type?: string;
    broker?: string | null;
    custody?: string | null;
    source?: string | null;
  },
  brokers: string[] = DEFAULT_PLATFORM_FIFO_BROKERS,
): boolean {
  if (tx.type != null && tx.type !== "sell") return false;
  const source = (tx.source ?? "").toLowerCase();
  if (source === "confirm-sale" || source.startsWith("manual")) return false;
  if (brokers.length === 0) return false;
  const hay = `${tx.broker ?? ""} ${tx.custody ?? ""} ${source}`.toLowerCase();
  return brokers.some((id) => {
    const needle = id.toLowerCase();
    if (!needle) return false;
    return hay.includes(needle) || hay.includes(needle.replace(/_/g, " "));
  });
}

/**
 * Walk the ledger chronologically, building cost-base lots per
 * ticker+exchange and recording a realised disposal for each portion of a
 * sell matched against a lot. Default matching is FIFO (oldest first);
 * pass `orderLotsForSale` for specific identification (e.g. min-CGT).
 */
export function computeLots(
  transactions: ParsedTransaction[],
  fxRates: Record<string, number | null | undefined> = {},
  opts: ComputeLotsOptions = {},
): LotsResult {
  const sorted = [...transactions].sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    if (d !== 0) return d;
    return (a.id ?? 0) - (b.id ?? 0);
  });
  const lotsByKey = new Map<string, Lot[]>();
  const disposals: RealisedDisposal[] = [];
  const recordedBySell = indexRecordedTakes(opts.recordedTakes);

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
          sourceTxId: tx.id,
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

        const recorded = tx.id != null ? recordedBySell.get(tx.id) : undefined;
        if (recorded && recorded.length > 0) {
          disposals.push(
            ...consumeRecordedTakes(
              lots,
              recorded,
              tx.date,
              perUnitProceedsAud,
              tx.id,
            ).map((d) => ({ ...d, parcelMatch: "recorded" as const })),
          );
        } else {
          const lockFifo = isPlatformReportedFifoSell(
            tx,
            opts.platformFifoBrokers,
          );
          const useCustom = Boolean(opts.orderLotsForSale) && !lockFifo;
          const parcelMatch: RealisedDisposal["parcelMatch"] = useCustom
            ? (opts.customMatching ?? "min_cgt")
            : "fifo";
          disposals.push(
            ...consumeLots(
              lots,
              tx.quantity,
              tx.date,
              perUnitProceedsAud,
              useCustom ? opts.orderLotsForSale : undefined,
            ).map((d) => ({
              ...d,
              sellTxId: tx.id,
              parcelMatch,
            })),
          );
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
 * Consume `quantity` units from `lots` (mutating remaining qty/cost),
 * returning one disposal per lot portion taken. `lots` is the per-key
 * array from `computeLots` (may include already-empty lots).
 */
export function consumeLots(
  lots: Lot[],
  quantity: number,
  disposedDate: string,
  proceedsPerUnitAud: number | null,
  orderLotsForSale?: OrderLotsForSale,
): RealisedDisposal[] {
  const remainingLots = lots.filter((l) => l.quantity > 1e-9);
  const ordered = orderLotsForSale
    ? orderLotsForSale(remainingLots, {
        disposedDate,
        proceedsPerUnitAud,
      })
    : remainingLots;

  const out: RealisedDisposal[] = [];
  let remaining = quantity;
  for (const lot of ordered) {
    if (remaining <= 1e-9) break;
    if (lot.quantity <= 1e-9) continue;
    const take = Math.min(lot.quantity, remaining);
    const lotUnitCostAud = lot.costBaseAud / lot.quantity;
    const costTaken = lotUnitCostAud * take;
    out.push({
      ticker: lot.ticker,
      exchange: lot.exchange,
      acquiredDate: lot.acquiredDate,
      disposedDate,
      quantity: take,
      proceedsAud:
        proceedsPerUnitAud != null ? proceedsPerUnitAud * take : 0,
      costBaseAud: costTaken,
      acquireTxId: lot.sourceTxId,
    });
    lot.quantity -= take;
    lot.costBaseAud -= costTaken;
    remaining -= take;
  }
  return out;
}

export function indexRecordedTakes(
  takes: RecordedParcelTake[] | undefined,
): Map<number, RecordedParcelTake[]> {
  const map = new Map<number, RecordedParcelTake[]>();
  if (!takes) return map;
  for (const t of takes) {
    const list = map.get(t.sellTxId) ?? [];
    if (!map.has(t.sellTxId)) map.set(t.sellTxId, list);
    list.push(t);
  }
  return map;
}

/**
 * Consume specific parcels by buy/DRP row id (confirmed specific
 * identification). Lots without a matching sourceTxId are skipped —
 * never fabricate a cost base.
 */
export function consumeRecordedTakes(
  lots: Lot[],
  takes: RecordedParcelTake[],
  disposedDate: string,
  proceedsPerUnitAud: number | null,
  sellTxId?: number,
): RealisedDisposal[] {
  const out: RealisedDisposal[] = [];
  for (const take of takes) {
    if (take.quantity <= 1e-9) continue;
    const lot = lots.find(
      (l) => l.sourceTxId === take.acquireTxId && l.quantity > 1e-9,
    );
    if (!lot) continue;
    const qty = Math.min(lot.quantity, take.quantity);
    const lotUnitCostAud = lot.costBaseAud / lot.quantity;
    const costTaken = lotUnitCostAud * qty;
    out.push({
      ticker: lot.ticker,
      exchange: lot.exchange,
      acquiredDate: lot.acquiredDate,
      disposedDate,
      quantity: qty,
      proceedsAud:
        proceedsPerUnitAud != null ? proceedsPerUnitAud * qty : 0,
      costBaseAud: costTaken,
      acquireTxId: lot.sourceTxId,
      sellTxId,
    });
    lot.quantity -= qty;
    lot.costBaseAud -= costTaken;
  }
  return out;
}

/**
 * Hypothetical sale against a snapshot of open lots (does not mutate
 * the input). Unmatched quantity is returned when `quantity` exceeds
 * what's held — never fabricates a cost base for the shortfall.
 */
export function takeLotsForSale(
  openLots: Lot[],
  quantity: number,
  disposedDate: string,
  proceedsPerUnitAud: number,
  orderLotsForSale?: OrderLotsForSale,
): { disposals: RealisedDisposal[]; unmatchedQuantity: number } {
  const copies = openLots
    .filter((l) => l.quantity > 1e-9)
    .map((l) => ({ ...l }));
  const disposals = consumeLots(
    copies,
    quantity,
    disposedDate,
    proceedsPerUnitAud,
    orderLotsForSale,
  );
  const sold = disposals.reduce((s, d) => s + d.quantity, 0);
  const unmatched = Math.max(0, quantity - sold);
  return {
    disposals: disposals.map((d) => ({
      ...d,
      quantity: roundQty(d.quantity),
      proceedsAud: roundMoney(d.proceedsAud),
      costBaseAud: roundMoney(d.costBaseAud),
    })),
    unmatchedQuantity: unmatched > 1e-9 ? roundQty(unmatched) : 0,
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
