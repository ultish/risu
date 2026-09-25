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
 * - `auto_by_date` — as legislated (Treasury Laws Amendment (Tax Reform
 *   No. 1) Act 2026): disposal &lt; 2027-07-01 → discount_50; disposal
 *   ≥ 2027-07-01 → `act_2027` (see tax/act2027.ts).
 */
export type CgtRegime = "discount_50" | "indexation_min30" | "auto_by_date";

/**
 * The treatment one disposal actually gets. `act_2027` is a disposal on or
 * after 1 July 2027 under the Act: a parcel held across the cutover has its
 * gain split at its 30 June 2027 market value — the part before keeps the
 * old rules (50% discount if held 12 months by the sale), the part after is
 * indexed from 1 July 2027 with a 30% minimum tax.
 */
export type AppliedCgtRegime = "discount_50" | "indexation_min30" | "act_2027";

/**
 * "Market value just before 1 July 2027" (s 112-155(3)) — taken as the
 * close on 30 June 2027.
 */
export const CUTOVER_VALUATION_DATE = "2027-06-30";

/**
 * How a sell is matched against open parcels.
 *
 * - `fifo` — oldest lot first (default reconstruction).
 * - `min_cgt` — specific identification: consume lots with the lowest
 *   estimated taxable gain per unit first (losses, then smallest
 *   post-discount / post-indexation gains). Respects the 1 Jul 2027
 *   cutover via the same `CgtRegime` as the tax calculation.
 */
export type LotMatchingMethod = "fifo" | "min_cgt";

/** Cutover used by `auto_by_date` regime (inclusive new rules). */
export const CGT_REGIME_CUTOVER_ISO = "2027-07-01";

/** Combined statutory rate used for taxable income / short-term CGT. */
export function combinedMarginalRate(profile: TaxProfile): number {
  return profile.marginalRate + profile.medicareLevy;
}
