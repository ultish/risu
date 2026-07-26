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
 * - `discount_50` — classic 50% CGT discount when held ≥ 365 days
 * - `indexation_min30` — post–1 Jul 2027 simplified model: effective tax on
 *   long-term gains floored at 30% of the gain (see cgt.ts docs)
 * - `auto_by_date` — use discount_50 for disposal date &lt; 2027-07-01,
 *   indexation_min30 on/after that date
 */
export type CgtRegime = "discount_50" | "indexation_min30" | "auto_by_date";

/** Cutover used by `auto_by_date` regime (inclusive new rules). */
export const CGT_REGIME_CUTOVER_ISO = "2027-07-01";

/** Combined statutory rate used for taxable income / short-term CGT. */
export function combinedMarginalRate(profile: TaxProfile): number {
  return profile.marginalRate + profile.medicareLevy;
}
