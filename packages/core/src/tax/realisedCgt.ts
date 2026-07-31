/**
 * Realised CGT against the actual ledger — FIFO per-parcel disposals (see
 * ../lots.ts), rolled up by AU financial year. Unlike the planner's
 * `estimateLiquidationCgt` (a single hypothetical average-cost lot), each
 * line here uses its own parcel's real acquisition date, so discount
 * eligibility / indexation period reflect what you actually bought and sold.
 *
 * ## Netting gains and losses (per FY, then across FYs)
 *
 * Tax is a FY-level concept, not a per-disposal one: a capital loss on one
 * parcel offsets a capital gain on another parcel sold the same year (ATO
 * "net capital gain" concept). A $500 gain + a $500 loss in the same FY
 * nets to $0 taxable, not "full tax on the gain, $0 (wasted) on the loss."
 *
 * A FY with an overall net loss doesn't just vanish either: it **carries
 * forward** to reduce a later FY's net gain (real ATO rule — capital losses
 * can only ever offset capital gains, current-year or carried forward, never
 * ordinary/dividend income). FYs are processed **oldest first**, threading a
 * running unused-loss balance forward; a later FY applies as much of that
 * balance as its own net gain allows, and whatever's left over keeps
 * carrying forward again. The carry-forward balance is regime-agnostic — a
 * loss realised under `discount_50` carries forward exactly the same way
 * into an `indexation_min30` FY.
 *
 * `auto_by_date` (and a fixed regime override) always resolves to the same
 * regime for every disposal within a single FY — the cutover date is itself
 * a FY boundary (1 Jul) — so netting within one FY never has to reconcile
 * two regimes at once.
 *
 * - `indexation_min30`: no discount concept. Net gain (after current-year AND
 *   carried-forward losses) × max(MTR+Medicare, 30%).
 * - `discount_50`: losses (current-year, then carried-forward) are applied
 *   against **short-term (non-discount-eligible) gains first** — the
 *   ATO-permitted order most favourable to the taxpayer, since a loss
 *   "wastes" half its offsetting power applied against a gain that would
 *   only be 50%-taxed anyway. Only the discount-eligible remainder is halved.
 * - A FY with an overall net loss (after applying any carry-in) produces $0
 *   tax (not a negative/refund); the unused amount is `lossCarriedOut` to
 *   the next FY.
 */
import { auFinancialYear } from "../income.js";
import type { RealisedDisposal } from "../lots.js";
import { estimateRealisedCgt, post2027CgtRateOnGain } from "./cgt.js";
import { combinedMarginalRate, type CgtRegime, type TaxProfile } from "./types.js";

export type RealisedCgtLine = RealisedDisposal & {
  financialYear: string;
  /** Raw gain/loss for this disposal (indexed already, if the regime applies indexation). Negative = loss. */
  capitalGain: number;
  longTerm: boolean;
  appliedRegime: Exclude<CgtRegime, "auto_by_date">;
};

export type RealisedCgtFyTotal = {
  financialYear: string;
  appliedRegime: Exclude<CgtRegime, "auto_by_date">;
  /** Sum of this FY's disposals with a positive raw gain. */
  totalGains: number;
  /** Sum of this FY's disposals with a raw loss (positive number). */
  totalLosses: number;
  /** This FY's own max(0, totalGains − totalLosses) — before carry-forward or discount. Performance metric, not a tax-treatment one. */
  netCapitalGain: number;
  /** This FY's own max(0, totalLosses − totalGains) — before any carry-forward is applied. */
  netCapitalLoss: number;
  /** Unused capital loss balance carried in from earlier FYs, before this FY's own result is applied. */
  lossCarriedIn: number;
  /** How much of lossCarriedIn was actually used to reduce this FY's tax. */
  priorLossApplied: number;
  /** Unused loss balance remaining after this FY — carries into the next FY. */
  lossCarriedOut: number;
  /** Amount actually subject to tax (after current-year AND carried-forward losses, then the 50% discount where applicable). */
  taxableGain: number;
  tax: number;
  disposalCount: number;
};

export type RealisedCgtReport = {
  lines: RealisedCgtLine[];
  fyTotals: RealisedCgtFyTotal[];
};

export function estimateRealisedCgtForLedger(
  disposals: RealisedDisposal[],
  opts: {
    regime: CgtRegime;
    profile: TaxProfile;
    annualInflationRate?: number;
  },
): RealisedCgtReport {
  const lines: RealisedCgtLine[] = disposals.map((d) => {
    const result = estimateRealisedCgt({
      proceedsAud: d.proceedsAud,
      costBaseAud: d.costBaseAud,
      acquiredDate: d.acquiredDate,
      disposedDate: d.disposedDate,
      regime: opts.regime,
      profile: opts.profile,
      annualInflationRate: opts.annualInflationRate,
    });
    return {
      ...d,
      financialYear: auFinancialYear(d.disposedDate),
      capitalGain: result.capitalGain,
      longTerm: result.longTerm,
      appliedRegime: result.appliedRegime,
    };
  });

  const byFy = new Map<string, RealisedCgtLine[]>();
  for (const line of lines) {
    const list = byFy.get(line.financialYear) ?? [];
    if (!byFy.has(line.financialYear)) byFy.set(line.financialYear, list);
    list.push(line);
  }

  // Oldest first — a loss can only carry forward into a later FY, never
  // backward, so the running balance must be threaded chronologically.
  const orderedFys = [...byFy.keys()].sort((a, b) => a.localeCompare(b));

  let carryBalance = 0;
  const fyTotals: RealisedCgtFyTotal[] = [];
  for (const fy of orderedFys) {
    const result = netFyGains(fy, byFy.get(fy)!, opts.profile, carryBalance);
    fyTotals.push(result);
    carryBalance = result.lossCarriedOut;
  }

  // Display order: newest FY first, matching the rest of the app's FY tables.
  fyTotals.sort((a, b) => b.financialYear.localeCompare(a.financialYear));

  return { lines, fyTotals };
}

function netFyGains(
  financialYear: string,
  fyLines: RealisedCgtLine[],
  profile: TaxProfile,
  carryIn: number,
): RealisedCgtFyTotal {
  // Uniform per FY — see module doc comment.
  const appliedRegime = fyLines[0]!.appliedRegime;

  const gains = fyLines.filter((l) => l.capitalGain > 0);
  const losses = fyLines.filter((l) => l.capitalGain < 0);
  const totalGains = sum(gains.map((l) => l.capitalGain));
  const totalLosses = sum(losses.map((l) => -l.capitalGain));
  const netCapitalGain = Math.max(0, totalGains - totalLosses);
  const netCapitalLoss = Math.max(0, totalLosses - totalGains);

  // Split this FY's own (post current-year-loss-netting) gain into a
  // discount-eligible (long-term) and non-eligible (short-term) remainder.
  // indexation_min30 has no discount concept at all — treat the whole net
  // gain as "non-eligible" so the shared carry-forward/discount code below
  // still applies (it's taxed in full either way; only the rate differs).
  let shortTermRemaining: number;
  let longTermRemaining: number;
  if (appliedRegime === "indexation_min30") {
    shortTermRemaining = netCapitalGain;
    longTermRemaining = 0;
  } else {
    const shortTermGains = sum(gains.filter((l) => !l.longTerm).map((l) => l.capitalGain));
    const longTermGains = sum(gains.filter((l) => l.longTerm).map((l) => l.capitalGain));
    shortTermRemaining = Math.max(0, shortTermGains - totalLosses);
    const lossAfterShortTerm = Math.max(0, totalLosses - shortTermGains);
    longTermRemaining = Math.max(0, longTermGains - lossAfterShortTerm);
  }

  // Apply the carried-forward balance the same way — short-term first.
  const priorLossApplied = Math.min(carryIn, shortTermRemaining + longTermRemaining);
  const shortTermAfterCarry = Math.max(0, shortTermRemaining - priorLossApplied);
  const carryLossAfterShortTerm = Math.max(0, priorLossApplied - shortTermRemaining);
  const longTermAfterCarry = Math.max(0, longTermRemaining - carryLossAfterShortTerm);

  const taxableGain = shortTermAfterCarry + longTermAfterCarry * 0.5;
  const rate =
    appliedRegime === "indexation_min30"
      ? post2027CgtRateOnGain(profile)
      : combinedMarginalRate(profile);
  const tax = taxableGain * rate;

  const lossCarriedOut = netCapitalLoss + Math.max(0, carryIn - priorLossApplied);

  return {
    financialYear,
    appliedRegime,
    totalGains: round2(totalGains),
    totalLosses: round2(totalLosses),
    netCapitalGain: round2(netCapitalGain),
    netCapitalLoss: round2(netCapitalLoss),
    lossCarriedIn: round2(carryIn),
    priorLossApplied: round2(priorLossApplied),
    lossCarriedOut: round2(lossCarriedOut),
    taxableGain: round2(taxableGain),
    tax: round2(tax),
    disposalCount: fyLines.length,
  };
}

function sum(ns: number[]): number {
  return ns.reduce((s, n) => s + n, 0);
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
