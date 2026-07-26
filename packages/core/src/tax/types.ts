/**
 * Simplified AU tax modelling types.
 * Not ATO software — estimates only for personal planning.
 */

/** User or spouse tax profile for income + CGT estimates */
export type TaxProfile = {
  /** Display label, e.g. "Me", "Partner" */
  label: string;
  /** Marginal income tax rate as decimal, e.g. 0.37 for 37% */
  marginalRate: number;
  /** Medicare levy as decimal, e.g. 0.02 for 2% (0 if exempt) */
  medicareLevy: number;
};

/**
 * CGT modelling regime (AU resident, worldwide assets in AUD).
 *
 * - `indexation_min30` — **post–1 Jul 2027 / planner default**:
 *   CPI-index cost base; no 50% discount; tax rate on indexed gain =
 *   max(MTR+Medicare, 30%).
 * - `discount_50` — **legacy only** (optional compare): nominal cost;
 *   50% CGT discount when held ≥ 365 days
 * - `auto_by_date` — disposal &lt; 2027-07-01 → discount_50;
 *   disposal ≥ 2027-07-01 → indexation_min30
 */
export type CgtRegime = "discount_50" | "indexation_min30" | "auto_by_date";

/** Cutover used by `auto_by_date` regime (inclusive new rules). */
export const CGT_REGIME_CUTOVER_ISO = "2027-07-01";

/** Combined statutory rate used for taxable income / short-term CGT. */
export function combinedMarginalRate(profile: TaxProfile): number {
  return profile.marginalRate + profile.medicareLevy;
}
