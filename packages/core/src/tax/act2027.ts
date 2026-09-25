/**
 * CGT on a disposal on or after 1 July 2027, as legislated by the Treasury
 * Laws Amendment (Tax Reform No. 1) Act 2026.
 *
 * ## Splitting a disposal (Subdivision 112-E)
 * A parcel held at the end of 30 June 2027 is treated as sold just before
 * 1 July 2027 for its market value then, and bought back for the same
 * amount. Nothing is taxed in 2027: that deemed gain (or loss) is deferred
 * to the year of the real sale (s 112-160).
 * - **Pre-2027 part** = value at 30 June 2027 − cost. It's a discount
 *   capital gain if the parcel was held 12 months by the *real* sale
 *   (s 112-160(3)(c) tests the deemed sale as if it happened that day).
 * - **Post-2027 part** = proceeds − the 30 June 2027 value, indexed from
 *   1 July 2027 once the parcel has been held 12 months (s 114-10(9) counts
 *   from the original purchase). No discount.
 * A parcel bought on or after 1 July 2027 has only a post part, its cost
 * indexed from purchase once held 12 months.
 *
 * ## Netting a year (s 102-5(1) method statement)
 * This year's losses, then carried-forward losses, reduce gains in order:
 * deferred (pre-2027) gains first, then the post-2027 ones. Within the
 * deferred category the Act lets you choose (Note 3), so non-discount gains
 * go before discount ones. Then the 50% discount applies to what's left of
 * the discount gains. The post-2027 gains remaining are the "minimum tax
 * capital gain" (Division 119): taxed at no less than 30%, modelled here as
 * max(MTR + Medicare, 30%) on that part.
 *
 * Estimates only. Shares only — the Act's residential categories aren't
 * modelled.
 */
import { holdingPriceKey } from "../market.js";
import type { SplitEvent } from "../splits.js";
import {
  DEFAULT_CGT_INFLATION_RATE,
  daysBetweenIso,
  indexCostBaseAud,
  post2027CgtRateOnGain,
} from "./cgt.js";
import {
  CGT_REGIME_CUTOVER_ISO,
  CUTOVER_VALUATION_DATE,
  combinedMarginalRate,
  type TaxProfile,
} from "./types.js";

/**
 * Where a parcel's 30 June 2027 value came from: a saved valuation, cached
 * prices, or — for a sale priced before that date has happened, or with no
 * price for it — an estimate by time between cost and proceeds.
 */
export type CutoverSource = "saved" | "prices" | "estimated";

export type CutoverUnitValue = {
  /** AUD per unit on 30 June 2027, on that day's unit basis. */
  unitValueAud: number;
  source: "saved" | "prices";
};

export type CutoverValues = {
  /** By instrument, "EXCHANGE:TICKER". */
  unitValues: Record<string, CutoverUnitValue>;
  /** Splits from the whole ledger, to carry units across a split after the cutover. */
  splits: SplitEvent[];
};

/** Value just before 1 July 2027 of `quantity` units sold on `disposedDate`, if known. */
export function cutoverValueFor(
  cutover: CutoverValues | undefined,
  exchange: string,
  ticker: string,
  quantity: number,
  disposedDate: string,
): { valueAud: number; source: "saved" | "prices" } | null {
  if (!cutover) return null;
  const key = holdingPriceKey(exchange || "ASX", ticker);
  const unit = cutover.unitValues[key];
  if (!unit) return null;
  // Units sold after a later split are more (or fewer) than were held then.
  let factor = 1;
  for (const s of cutover.splits) {
    if (s.key === key && s.date > CUTOVER_VALUATION_DATE && s.date <= disposedDate) {
      factor *= s.ratio;
    }
  }
  return { valueAud: (unit.unitValueAud * quantity) / factor, source: unit.source };
}

/** Straight-line-in-time guess at the 30 June 2027 value, for when there's no real one. */
export function estimateCutoverValue(
  costBaseAud: number,
  proceedsAud: number,
  acquiredDate: string,
  disposedDate: string,
): number {
  const total = daysBetweenIso(acquiredDate, disposedDate);
  if (total <= 0) return costBaseAud;
  const before = Math.min(total, Math.max(0, daysBetweenIso(acquiredDate, CGT_REGIME_CUTOVER_ISO)));
  return costBaseAud + (proceedsAud - costBaseAud) * (before / total);
}

export type Act2027Parts = {
  /** The deferred gain up to 30 June 2027; negative for a loss. 0 when bought after. */
  preGain: number;
  /** The gain from 1 July 2027 (after indexation); negative for a loss. */
  postGain: number;
  /** Held 12 months by the sale: the pre part gets the discount, the post part is indexed. */
  heldTwelveMonths: boolean;
  /** Value of the units just before 1 July 2027; null when bought after it. */
  cutoverValueAud: number | null;
  cutoverSource: CutoverSource | null;
  /** What the post part is measured from: the (indexed) cutover value, or (indexed) cost. */
  postCostBaseAud: number;
};

export function splitAct2027(input: {
  proceedsAud: number;
  costBaseAud: number;
  acquiredDate: string;
  disposedDate: string;
  annualInflationRate?: number;
  cutover?: { valueAud: number; source: "saved" | "prices" } | null;
}): Act2027Parts {
  const held = daysBetweenIso(input.acquiredDate, input.disposedDate) >= 365;
  const infl = input.annualInflationRate ?? DEFAULT_CGT_INFLATION_RATE;
  if (input.acquiredDate >= CGT_REGIME_CUTOVER_ISO) {
    const base = held
      ? indexCostBaseAud(input.costBaseAud, input.acquiredDate, input.disposedDate, infl)
      : input.costBaseAud;
    return {
      preGain: 0,
      postGain: round2(input.proceedsAud - base),
      heldTwelveMonths: held,
      cutoverValueAud: null,
      cutoverSource: null,
      postCostBaseAud: round2(base),
    };
  }
  const value =
    input.cutover?.valueAud ??
    estimateCutoverValue(input.costBaseAud, input.proceedsAud, input.acquiredDate, input.disposedDate);
  const base = held
    ? indexCostBaseAud(value, CGT_REGIME_CUTOVER_ISO, input.disposedDate, infl)
    : value;
  return {
    preGain: round2(value - input.costBaseAud),
    postGain: round2(input.proceedsAud - base),
    heldTwelveMonths: held,
    cutoverValueAud: round2(value),
    cutoverSource: input.cutover?.source ?? "estimated",
    postCostBaseAud: round2(base),
  };
}

export type Act2027Net = {
  totalGains: number;
  totalLosses: number;
  /** This year's losses not used against this year's gains. */
  netCapitalLoss: number;
  priorLossApplied: number;
  lossCarriedOut: number;
  /** Remaining after losses, before the discount. */
  deferredNonDiscount: number;
  deferredDiscount: number;
  /** Post-2027 gains remaining after losses — the minimum tax capital gain. */
  minimumTaxGain: number;
  taxableGain: number;
  tax: number;
};

/** One year's disposals under the Act, netted in the s 102-5(1) order. */
export function netAct2027(
  parts: Act2027Parts[],
  carryIn: number,
  profile: TaxProfile,
): Act2027Net {
  // [pre-2027 non-discount, pre-2027 discount, post-2027] — the loss order.
  const buckets = [0, 0, 0];
  let losses = 0;
  for (const p of parts) {
    if (p.preGain > 0) buckets[p.heldTwelveMonths ? 1 : 0]! += p.preGain;
    else losses -= p.preGain;
    if (p.postGain > 0) buckets[2]! += p.postGain;
    else losses -= p.postGain;
  }
  const totalGains = buckets[0]! + buckets[1]! + buckets[2]!;
  const apply = (amount: number): number => {
    let left = amount;
    for (let i = 0; i < buckets.length && left > 0; i++) {
      const used = Math.min(left, buckets[i]!);
      buckets[i]! -= used;
      left -= used;
    }
    return amount - left;
  };
  const netCapitalLoss = losses - apply(losses);
  const priorLossApplied = apply(Math.max(0, carryIn));
  const [nonDiscount, discount, post] = buckets as [number, number, number];
  const taxableGain = nonDiscount + discount * 0.5 + post;
  const tax =
    (nonDiscount + discount * 0.5) * combinedMarginalRate(profile) +
    post * post2027CgtRateOnGain(profile);
  return {
    totalGains: round2(totalGains),
    totalLosses: round2(losses),
    netCapitalLoss: round2(netCapitalLoss),
    priorLossApplied: round2(priorLossApplied),
    lossCarriedOut: round2(netCapitalLoss + Math.max(0, carryIn) - priorLossApplied),
    deferredNonDiscount: round2(nonDiscount),
    deferredDiscount: round2(discount),
    minimumTaxGain: round2(post),
    taxableGain: round2(taxableGain),
    tax: round2(tax),
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
