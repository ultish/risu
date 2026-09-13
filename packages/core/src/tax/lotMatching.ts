/**
 * Parcel matching for CGT: FIFO (oldest first) vs minimise CGT
 * (specific identification — consume the lots with the lowest estimated
 * taxable gain per unit first).
 *
 * Scoring uses the same 1 Jul 2027 cutover as `estimateRealisedCgt`:
 * pre-cutover long-term gains are halved; post-cutover gains use
 * CPI-indexed cost and no discount. Losses score as their full (negative)
 * raw gain, so they are always preferred when the goal is to minimise tax.
 *
 * Isolation-per-unit greedy is used because lots can be sold fractionally
 * and the per-unit score is constant within a lot. Same-FY netting of the
 * resulting parcels is still applied later by `estimateRealisedCgtForLedger`.
 */
import {
  takeLotsForSale,
  type Lot,
  type LotSaleContext,
  type OrderLotsForSale,
  type RealisedDisposal,
} from "../lots.js";
import {
  daysBetweenIso,
  estimateRealisedCgt,
  indexCostBaseAud,
  resolveCgtRegime,
} from "./cgt.js";
import { estimateRealisedCgtForLedger } from "./realisedCgt.js";
import type { CgtRegime, LotMatchingMethod, TaxProfile } from "./types.js";

export type MinCgtOrderOpts = {
  regime: CgtRegime;
  annualInflationRate?: number;
};

/**
 * Taxable-gain-per-unit if this lot were sold in isolation at `proceedsPerUnitAud`.
 * Lower (more negative) = preferred when minimising CGT.
 */
export function taxableGainPerUnit(
  lot: Lot,
  proceedsPerUnitAud: number,
  disposedDate: string,
  opts: MinCgtOrderOpts,
): number {
  if (!(lot.quantity > 0)) return 0;
  const applied = resolveCgtRegime(opts.regime, disposedDate);
  let costPerUnit = lot.costBaseAud / lot.quantity;
  if (applied === "indexation_min30") {
    const indexed = indexCostBaseAud(
      lot.costBaseAud,
      lot.acquiredDate,
      disposedDate,
      opts.annualInflationRate ?? 0.025,
    );
    costPerUnit = indexed / lot.quantity;
  }
  const gain = proceedsPerUnitAud - costPerUnit;
  if (gain <= 0) return gain;
  const longTerm = daysBetweenIso(lot.acquiredDate, disposedDate) >= 365;
  if (applied === "discount_50" && longTerm) return gain * 0.5;
  return gain;
}

/** Oldest first. No-op identity so callers can always pass an order fn. */
export function orderLotsFifo(lots: Lot[]): Lot[] {
  return lots;
}

/**
 * Lowest taxable-gain-per-unit first; FIFO among ties. Falls back to FIFO
 * when proceeds are unknown (can't score without a sale price).
 */
export function orderLotsMinCgt(
  lots: Lot[],
  ctx: LotSaleContext,
  opts: MinCgtOrderOpts,
): Lot[] {
  if (ctx.proceedsPerUnitAud == null) return lots;
  const proceeds = ctx.proceedsPerUnitAud;
  return [...lots].sort((a, b) => {
    const sa = taxableGainPerUnit(a, proceeds, ctx.disposedDate, opts);
    const sb = taxableGainPerUnit(b, proceeds, ctx.disposedDate, opts);
    if (sa !== sb) return sa - sb;
    return a.acquiredDate.localeCompare(b.acquiredDate);
  });
}

export function orderFnForMatching(
  matching: LotMatchingMethod,
  opts: MinCgtOrderOpts,
): OrderLotsForSale | undefined {
  if (matching !== "min_cgt") return undefined;
  return (lots, ctx) => orderLotsMinCgt(lots, ctx, opts);
}

export type HypotheticalSaleParcel = RealisedDisposal & {
  capitalGain: number;
  longTerm: boolean;
  appliedRegime: Exclude<CgtRegime, "auto_by_date">;
};

export type HypotheticalSaleSummary = {
  matching: LotMatchingMethod;
  quantitySold: number;
  proceedsAud: number;
  costBaseAud: number;
  capitalGain: number;
  taxableGain: number;
  tax: number;
  appliedRegime: Exclude<CgtRegime, "auto_by_date"> | null;
};

export type HypotheticalSaleEstimate = HypotheticalSaleSummary & {
  quantityRequested: number;
  unmatchedQuantity: number;
  proceedsPerUnitAud: number;
  disposedDate: string;
  parcels: HypotheticalSaleParcel[];
  comparison: {
    fifo: HypotheticalSaleSummary;
    min_cgt: HypotheticalSaleSummary;
  };
  notes: string[];
};

export function estimateHypotheticalSale(input: {
  openLots: Lot[];
  quantity: number;
  proceedsPerUnitAud: number;
  disposedDate: string;
  matching: LotMatchingMethod;
  regime: CgtRegime;
  profile: TaxProfile;
  annualInflationRate?: number;
}): HypotheticalSaleEstimate {
  const fifo = runSale({ ...input, matching: "fifo" });
  const minCgt = runSale({ ...input, matching: "min_cgt" });
  const selected = input.matching === "min_cgt" ? minCgt : fifo;

  const notes = [
    "Estimate only — not ATO calculation. Assumes today's (or the given) price as proceeds.",
    input.matching === "min_cgt"
      ? "Parcels picked to minimise estimated CGT (specific identification): losses and smallest post-discount/indexation gains first."
      : "Parcels picked FIFO (oldest lot sold first).",
    "1 Jul 2027 cutover: disposals before that date use the 50% CGT discount when held ≥ 365 days; from that date, cost is CPI-indexed and there is no discount (rate floored at 30%).",
  ];
  if (selected.unmatchedQuantity > 0) {
    notes.push(
      `Only ${selected.quantitySold} of ${input.quantity} units could be matched to known lots — the rest has no cost base in the ledger.`,
    );
  }

  return {
    ...selected,
    matching: input.matching,
    comparison: {
      fifo: toSummary(fifo),
      min_cgt: toSummary(minCgt),
    },
    notes,
  };
}

function runSale(input: {
  openLots: Lot[];
  quantity: number;
  proceedsPerUnitAud: number;
  disposedDate: string;
  matching: LotMatchingMethod;
  regime: CgtRegime;
  profile: TaxProfile;
  annualInflationRate?: number;
}): Omit<HypotheticalSaleEstimate, "comparison" | "notes" | "matching"> & {
  matching: LotMatchingMethod;
} {
  const order = orderFnForMatching(input.matching, {
    regime: input.regime,
    annualInflationRate: input.annualInflationRate,
  });
  const { disposals, unmatchedQuantity } = takeLotsForSale(
    input.openLots,
    input.quantity,
    input.disposedDate,
    input.proceedsPerUnitAud,
    order,
  );

  const parcels: HypotheticalSaleParcel[] = disposals.map((d) => {
    const result = estimateRealisedCgt({
      proceedsAud: d.proceedsAud,
      costBaseAud: d.costBaseAud,
      acquiredDate: d.acquiredDate,
      disposedDate: d.disposedDate,
      regime: input.regime,
      profile: input.profile,
      annualInflationRate: input.annualInflationRate,
    });
    return {
      ...d,
      capitalGain: result.capitalGain,
      longTerm: result.longTerm,
      appliedRegime: result.appliedRegime,
    };
  });

  const report = estimateRealisedCgtForLedger(disposals, {
    regime: input.regime,
    profile: input.profile,
    annualInflationRate: input.annualInflationRate,
  });
  const fy = report.fyTotals[0];
  const quantitySold = roundQty(disposals.reduce((s, d) => s + d.quantity, 0));
  const proceedsAud = round2(disposals.reduce((s, d) => s + d.proceedsAud, 0));
  const costBaseAud = round2(disposals.reduce((s, d) => s + d.costBaseAud, 0));
  const capitalGain = fy
    ? round2(fy.netCapitalGain - fy.netCapitalLoss)
    : 0;

  return {
    matching: input.matching,
    quantityRequested: input.quantity,
    quantitySold,
    unmatchedQuantity,
    proceedsPerUnitAud: input.proceedsPerUnitAud,
    proceedsAud,
    costBaseAud,
    capitalGain,
    taxableGain: fy?.taxableGain ?? 0,
    tax: fy?.tax ?? 0,
    appliedRegime: fy?.appliedRegime ?? parcels[0]?.appliedRegime ?? null,
    disposedDate: input.disposedDate,
    parcels,
  };
}

function toSummary(
  s: Omit<HypotheticalSaleEstimate, "comparison" | "notes">,
): HypotheticalSaleSummary {
  return {
    matching: s.matching,
    quantitySold: s.quantitySold,
    proceedsAud: s.proceedsAud,
    costBaseAud: s.costBaseAud,
    capitalGain: s.capitalGain,
    taxableGain: s.taxableGain,
    tax: s.tax,
    appliedRegime: s.appliedRegime,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function roundQty(n: number) {
  return Math.round(n * 1e6) / 1e6;
}
