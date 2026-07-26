/**
 * Simplified realised CGT for Australian tax residents.
 *
 * ## Cost method: **average cost**
 * Realised gain on a sell uses average cost base (same approach as
 * `computeHoldings` in holdings.ts). Modelling choice, not FIFO / parcels.
 *
 * ## Regimes (model, not ATO law)
 *
 * ### `indexation_min30` — post–Jul 2027 (planner default)
 * - **No 50% CGT discount**
 * - Cost base is **CPI-indexed** (constant annual inflation assumption) from
 *   acquisition to disposal, unless `costBaseAlreadyIndexed` is set
 * - Capital gain = proceeds − **indexed** cost base
 * - Tax rate on that gain = **max(MTR + Medicare, 30%)**
 *   (30% floor when the combined rate is low / zero; high MTR still pays full MTR)
 *
 * ### `discount_50` — legacy only (optional compare)
 * - Nominal cost base (no indexation)
 * - Long-term: 50% of gain × (MTR + Medicare)
 * - Short-term: full gain × (MTR + Medicare)
 *
 * ### `auto_by_date`
 * - disposal &lt; 2027-07-01 → discount_50
 * - disposal ≥ 2027-07-01 → indexation_min30
 *
 * Capital losses: tax = 0 (no carry-forward in this sketch).
 */

import {
  CGT_REGIME_CUTOVER_ISO,
  combinedMarginalRate,
  type CgtRegime,
  type TaxProfile,
} from "./types.js";

/** Minimum CGT rate on the (indexed) gain under post–Jul 2027 model. */
export const POST_2027_CGT_MIN_RATE = 0.3;

/** Default assumed CPI / indexation rate p.a. when not specified. */
export const DEFAULT_CGT_INFLATION_RATE = 0.025;

export type RealisedCgtInput = {
  /** Proceeds in AUD (net of sell brokerage if already deducted) */
  proceedsAud: number;
  /**
   * Cost base in AUD. Nominal unless `costBaseAlreadyIndexed` (e.g. planner
   * has already inflated cost each month).
   */
  costBaseAud: number;
  /** ISO yyyy-mm-dd of acquisition (or average acquisition proxy) */
  acquiredDate: string;
  /** ISO yyyy-mm-dd of disposal */
  disposedDate: string;
  regime: CgtRegime;
  profile: TaxProfile;
  /**
   * Annual inflation for cost-base indexation under post–2027 (decimal).
   * Ignored when `costBaseAlreadyIndexed` or regime is discount_50.
   * Default: {@link DEFAULT_CGT_INFLATION_RATE}.
   */
  annualInflationRate?: number;
  /**
   * When true, `costBaseAud` is already in disposal-year dollars (planner
   * monthly indexation). Do not inflate again.
   */
  costBaseAlreadyIndexed?: boolean;
};

export type RealisedCgtResult = {
  capitalGain: number;
  /** Cost base used for the gain (indexed when post-2027) */
  costBaseUsedAud: number;
  /** Days held (calendar, from ISO dates) */
  daysHeld: number;
  longTerm: boolean;
  /** Resolved regime after auto_by_date */
  appliedRegime: Exclude<CgtRegime, "auto_by_date">;
  /** Amount of gain included in taxable income */
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
 * Index a nominal cost base from acquisition to disposal at a constant
 * annual inflation rate (compound).
 */
export function indexCostBaseAud(
  costBaseAud: number,
  acquiredDate: string,
  disposedDate: string,
  annualInflationRate: number,
): number {
  if (!(costBaseAud > 0) || !(annualInflationRate > 0)) {
    return costBaseAud;
  }
  const days = daysBetweenIso(acquiredDate, disposedDate);
  if (days <= 0) return costBaseAud;
  const years = days / 365.25;
  return costBaseAud * Math.pow(1 + annualInflationRate, years);
}

/**
 * Post–2027 CGT rate on the (indexed) capital gain:
 * max(combined MTR, 30%). No 50% discount.
 */
export function post2027CgtRateOnGain(profile: TaxProfile): number {
  return Math.max(combinedMarginalRate(profile), POST_2027_CGT_MIN_RATE);
}

/**
 * Estimate CGT on a single realised disposal using average cost.
 */
export function estimateRealisedCgt(input: RealisedCgtInput): RealisedCgtResult {
  const daysHeld = daysBetweenIso(input.acquiredDate, input.disposedDate);
  const longTerm = daysHeld >= 365;
  const appliedRegime = resolveCgtRegime(input.regime, input.disposedDate);
  const mtr = combinedMarginalRate(input.profile);
  const notes: string[] = [
    "Average cost method (not FIFO / parcel matching).",
    "Model estimate only — not ATO calculation.",
  ];

  let costBaseUsed = input.costBaseAud;

  if (appliedRegime === "indexation_min30") {
    if (input.costBaseAlreadyIndexed) {
      notes.push("Cost base already indexed (e.g. planner monthly CPI).");
    } else {
      const infl =
        input.annualInflationRate ?? DEFAULT_CGT_INFLATION_RATE;
      const nominal = input.costBaseAud;
      costBaseUsed = indexCostBaseAud(
        nominal,
        input.acquiredDate,
        input.disposedDate,
        infl,
      );
      if (infl > 0 && costBaseUsed !== nominal) {
        notes.push(
          `Cost base indexed at ${(infl * 100).toFixed(1)}% p.a.: ${round2(nominal)} → ${round2(costBaseUsed)}.`,
        );
      } else if (infl <= 0) {
        notes.push("Inflation 0% — nominal cost base (no indexation).");
      }
    }
  }

  const capitalGain = round2(input.proceedsAud - costBaseUsed);
  costBaseUsed = round2(costBaseUsed);

  if (capitalGain <= 0) {
    return {
      capitalGain,
      costBaseUsedAud: costBaseUsed,
      daysHeld,
      longTerm,
      appliedRegime,
      taxableGain: 0,
      effectiveRateOnGain: 0,
      tax: 0,
      notes: [...notes, "Capital loss / break-even — no tax in this sketch."],
    };
  }

  // Post–Jul 2027: indexed gain × max(MTR, 30%) — no 50% discount
  if (appliedRegime === "indexation_min30") {
    const effectiveRateOnGain = post2027CgtRateOnGain(input.profile);
    const tax = round2(capitalGain * effectiveRateOnGain);
    notes.push(
      `Post–Jul 2027: no 50% discount; rate = max(MTR+Medicare, 30%) = ${(
        effectiveRateOnGain * 100
      ).toFixed(1)}% of indexed gain.`,
    );
    return {
      capitalGain,
      costBaseUsedAud: costBaseUsed,
      daysHeld,
      longTerm,
      appliedRegime,
      taxableGain: capitalGain,
      effectiveRateOnGain,
      tax,
      notes,
    };
  }

  // Legacy discount_50 — nominal cost only
  if (!longTerm) {
    const tax = round2(capitalGain * mtr);
    notes.push("Held < 365 days — full gain at combined MTR + Medicare.");
    return {
      capitalGain,
      costBaseUsedAud: costBaseUsed,
      daysHeld,
      longTerm,
      appliedRegime,
      taxableGain: capitalGain,
      effectiveRateOnGain: mtr,
      tax,
      notes,
    };
  }

  const taxableGain = round2(capitalGain * 0.5);
  const tax = round2(taxableGain * mtr);
  notes.push(
    "Legacy 50% CGT discount (pre–Jul 2027 compare only); tax = 50% × gain × (MTR + Medicare).",
  );
  return {
    capitalGain,
    costBaseUsedAud: costBaseUsed,
    daysHeld,
    longTerm,
    appliedRegime,
    taxableGain,
    effectiveRateOnGain: mtr * 0.5,
    tax,
    notes,
  };
}

/**
 * Convenience: CGT if liquidating a holding bought as a single average lot.
 */
export function estimateLiquidationCgt(opts: {
  marketValueAud: number;
  costBaseAud: number;
  acquiredDate: string;
  disposedDate: string;
  regime: CgtRegime;
  profile: TaxProfile;
  annualInflationRate?: number;
  costBaseAlreadyIndexed?: boolean;
}): RealisedCgtResult {
  return estimateRealisedCgt({
    proceedsAud: opts.marketValueAud,
    costBaseAud: opts.costBaseAud,
    acquiredDate: opts.acquiredDate,
    disposedDate: opts.disposedDate,
    regime: opts.regime,
    profile: opts.profile,
    annualInflationRate: opts.annualInflationRate,
    costBaseAlreadyIndexed: opts.costBaseAlreadyIndexed,
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
