/**
 * Simplified realised CGT for Australian tax residents.
 *
 * ## Cost method: **average cost**
 * Realised gain on a sell uses average cost base (same approach as
 * `computeHoldings` in holdings.ts): cost of units sold =
 * `(total cost base / quantity before sell) * quantity sold`.
 * This is a modelling choice, not FIFO or parcel-specific ATO accounting.
 *
 * ## Holding period
 * Days held = disposalDate − acquisitionDate (ISO dates). Eligible for
 * long-term treatment when days ≥ 365.
 *
 * ## Regimes (model, not ATO law)
 * - **discount_50** (long-term): taxable gain = 50% of capital gain;
 *   tax = taxable × (MTR + Medicare).
 * - **indexation_min30** (long-term, simplified post–2027 style):
 *   effective rate on the full gain =
 *   `max((MTR + Medicare) × 0.5, 0.30)`.
 *   i.e. keep the “half-rate” idea but floor at 30% of the gain.
 * - **auto_by_date**: disposal &lt; 2027-07-01 → discount_50;
 *   disposal ≥ 2027-07-01 → indexation_min30.
 * - Short-term (&lt; 365 days): full gain × (MTR + Medicare) in all regimes.
 * - Capital losses: tax = 0 (no carry-forward in this sketch).
 */

import {
  CGT_REGIME_CUTOVER_ISO,
  combinedMarginalRate,
  type CgtRegime,
  type TaxProfile,
} from "./types.js";

export type RealisedCgtInput = {
  /** Proceeds in AUD (net of sell brokerage if already deducted) */
  proceedsAud: number;
  /** Average-cost portion of cost base for units sold, AUD */
  costBaseAud: number;
  /** ISO yyyy-mm-dd of acquisition (or average acquisition proxy) */
  acquiredDate: string;
  /** ISO yyyy-mm-dd of disposal */
  disposedDate: string;
  regime: CgtRegime;
  profile: TaxProfile;
};

export type RealisedCgtResult = {
  capitalGain: number;
  /** Days held (calendar, from ISO dates) */
  daysHeld: number;
  longTerm: boolean;
  /** Resolved regime after auto_by_date */
  appliedRegime: Exclude<CgtRegime, "auto_by_date">;
  /** Amount of gain included in taxable income (discount path) */
  taxableGain: number;
  /** Effective tax rate applied to capitalGain (0–1) */
  effectiveRateOnGain: number;
  /** Estimated tax payable on this disposal */
  tax: number;
  notes: string[];
};

export function resolveCgtRegime(
  regime: CgtRegime,
  disposedDate: string,
): Exclude<CgtRegime, "auto_by_date"> {
  if (regime === "auto_by_date") {
    return disposedDate >= CGT_REGIME_CUTOVER_ISO
      ? "indexation_min30"
      : "discount_50";
  }
  return regime;
}

/** Inclusive day count between two ISO dates (yyyy-mm-dd). */
export function daysBetweenIso(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

/**
 * Estimate CGT on a single realised disposal using average cost.
 */
export function estimateRealisedCgt(input: RealisedCgtInput): RealisedCgtResult {
  const capitalGain = round2(input.proceedsAud - input.costBaseAud);
  const daysHeld = daysBetweenIso(input.acquiredDate, input.disposedDate);
  const longTerm = daysHeld >= 365;
  const appliedRegime = resolveCgtRegime(input.regime, input.disposedDate);
  const mtr = combinedMarginalRate(input.profile);
  const notes: string[] = [
    "Average cost method (not FIFO / parcel matching).",
    "Model estimate only — not ATO calculation.",
  ];

  if (capitalGain <= 0) {
    return {
      capitalGain,
      daysHeld,
      longTerm,
      appliedRegime,
      taxableGain: 0,
      effectiveRateOnGain: 0,
      tax: 0,
      notes: [...notes, "Capital loss / break-even — no tax in this sketch."],
    };
  }

  if (!longTerm) {
    const tax = round2(capitalGain * mtr);
    notes.push("Held < 365 days — full gain at combined MTR + Medicare.");
    return {
      capitalGain,
      daysHeld,
      longTerm,
      appliedRegime,
      taxableGain: capitalGain,
      effectiveRateOnGain: mtr,
      tax,
      notes,
    };
  }

  if (appliedRegime === "discount_50") {
    const taxableGain = round2(capitalGain * 0.5);
    const tax = round2(taxableGain * mtr);
    notes.push(
      "50% CGT discount applied; tax = 50% × gain × (MTR + Medicare).",
    );
    return {
      capitalGain,
      daysHeld,
      longTerm,
      appliedRegime,
      taxableGain,
      effectiveRateOnGain: mtr * 0.5,
      tax,
      notes,
    };
  }

  // indexation_min30 — simplified post-2027 floor model
  const discountPathRate = mtr * 0.5;
  const effectiveRateOnGain = Math.max(discountPathRate, 0.3);
  const tax = round2(capitalGain * effectiveRateOnGain);
  notes.push(
    `Long-term min-30% model: rate = max((MTR+Medicare)×0.5, 0.30) = ${(
      effectiveRateOnGain * 100
    ).toFixed(2)}% of full gain.`,
  );
  return {
    capitalGain,
    daysHeld,
    longTerm,
    appliedRegime,
    taxableGain: capitalGain, // full gain included for reporting
    effectiveRateOnGain,
    tax,
    notes,
  };
}

/**
 * Convenience: CGT if liquidating a holding bought as a single average lot.
 * Uses average cost (costBaseAud) and a single acquiredDate proxy.
 */
export function estimateLiquidationCgt(opts: {
  marketValueAud: number;
  costBaseAud: number;
  acquiredDate: string;
  disposedDate: string;
  regime: CgtRegime;
  profile: TaxProfile;
}): RealisedCgtResult {
  return estimateRealisedCgt({
    proceedsAud: opts.marketValueAud,
    costBaseAud: opts.costBaseAud,
    acquiredDate: opts.acquiredDate,
    disposedDate: opts.disposedDate,
    regime: opts.regime,
    profile: opts.profile,
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
