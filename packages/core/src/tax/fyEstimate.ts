/**
 * Combined "roughly how much tax do I owe this FY" estimate: dividend
 * income tax (`estimateFyDividendTax`) + realised CGT on actual sells
 * (per-parcel via `computeLots` + `estimateRealisedCgtForLedger`,
 * FIFO or min-CGT matching,
 * which also carries unused capital losses forward across FYs) — the two
 * components of a real tax bill this app's ledger can support. Not a full
 * return: no salary/other income, no non-portfolio deductions.
 */
import { summarizeDividendIncome, type AssessableDividendEvent } from "../income.js";
import { computeLots, type RecordedParcelTake } from "../lots.js";
import type { ParsedTransaction } from "../types.js";
import { estimateFyDividendTax, type FyTaxEstimateSummary } from "./incomeTax.js";
import { orderFnForMatching } from "./lotMatching.js";
import { estimateRealisedCgtForLedger, type RealisedCgtReport } from "./realisedCgt.js";
import type { CgtRegime, LotMatchingMethod, TaxProfile } from "./types.js";

export type FyTaxEstimateInput = {
  profile: TaxProfile;
  cgtRegime: CgtRegime;
  /**
   * How each historical sell is matched against open parcels.
   * Default `fifo`. `min_cgt` re-identifies lots at each sell to minimise
   * that disposal's estimated CGT (specific identification).
   * Sells with `recordedTakes` always use the recorded parcels instead.
   */
  lotMatching?: LotMatchingMethod;
  /** Confirmed specific-identification takes (win over lotMatching). */
  recordedTakes?: RecordedParcelTake[];
  /** Brokers whose imported sells stay FIFO. Default: Betashares Direct. */
  platformFifoBrokers?: string[];
  /** CPI indexation p.a. for post-2027 CGT (decimal); default in cgt.ts */
  cgtInflationRate?: number;
  /** Assumed franking % 0–100 for ASX dividend lines only (default 70). */
  asxFrankingPercent?: number;
  /** Foreign dividend withholding rate as decimal 0–1 (default 0.15). */
  usWithholdingRate?: number;
  ledgerIsNetOfWithholding?: boolean;
};

export type FyTaxTotal = {
  financialYear: string;
  assessableDividendIncome: number;
  dividendNetTax: number;
  /** Net of this FY's own realised gains and losses (see tax/realisedCgt.ts) — can be negative (a net loss). Unaffected by carry-forward — a performance metric, not a tax-treatment one. */
  netCapitalGain: number;
  /** How much of a prior FY's unused capital loss was applied to reduce this FY's CGT tax. */
  priorLossApplied: number;
  /** Unused capital loss carried forward into the next FY (0 if none, or if this FY's gain fully absorbed it). */
  lossCarriedForward: number;
  cgtTax: number;
  /** dividendNetTax + cgtTax — the headline "what do I owe" number. */
  totalTax: number;
};

export type FyTaxEstimateReport = {
  byFy: FyTaxTotal[];
  dividendTax: FyTaxEstimateSummary;
  /** Per-transaction dividend/DRP detail behind dividendTax — for a "why do I owe this" breakdown alongside cgt.lines. */
  dividendEvents: AssessableDividendEvent[];
  cgt: RealisedCgtReport & { fyTotals: RealisedCgtReport["fyTotals"] };
  notes: string[];
};

export function estimateFyTax(
  transactions: ParsedTransaction[],
  fxRates: Record<string, number | null | undefined>,
  opts: FyTaxEstimateInput,
): FyTaxEstimateReport {
  const income = summarizeDividendIncome(transactions, fxRates);
  const dividendTax = estimateFyDividendTax(income.byFy, {
    profile: opts.profile,
    asxFrankingPercent: opts.asxFrankingPercent,
    usWithholdingRate: opts.usWithholdingRate,
    ledgerIsNetOfWithholding: opts.ledgerIsNetOfWithholding,
  });

  const lotMatching = opts.lotMatching ?? "fifo";
  const { disposals } = computeLots(transactions, fxRates, {
    orderLotsForSale: orderFnForMatching(lotMatching, {
      regime: opts.cgtRegime,
      annualInflationRate: opts.cgtInflationRate,
    }),
    customMatching: lotMatching === "min_cgt" ? "min_cgt" : undefined,
    recordedTakes: opts.recordedTakes,
    platformFifoBrokers: opts.platformFifoBrokers,
  });
  const cgt = estimateRealisedCgtForLedger(disposals, {
    regime: opts.cgtRegime,
    profile: opts.profile,
    annualInflationRate: opts.cgtInflationRate,
  });

  const fySet = new Set<string>();
  for (const r of dividendTax.byFy) fySet.add(r.financialYear);
  for (const r of cgt.fyTotals) fySet.add(r.financialYear);

  const byFy: FyTaxTotal[] = [...fySet]
    .map((fy) => {
      const div = dividendTax.byFy.find((r) => r.financialYear === fy);
      const c = cgt.fyTotals.find((r) => r.financialYear === fy);
      const dividendNetTax = div?.netTax ?? 0;
      const cgtTax = c?.tax ?? 0;
      // Net gain/loss as a single signed figure for display — positive when
      // gains exceed losses, negative when this FY is a net capital loss.
      const netCapitalGain = (c?.netCapitalGain ?? 0) - (c?.netCapitalLoss ?? 0);
      return {
        financialYear: fy,
        assessableDividendIncome: round2(div?.assessableIncome ?? 0),
        dividendNetTax: round2(dividendNetTax),
        netCapitalGain: round2(netCapitalGain),
        priorLossApplied: round2(c?.priorLossApplied ?? 0),
        lossCarriedForward: round2(c?.lossCarriedOut ?? 0),
        cgtTax: round2(cgtTax),
        totalTax: round2(dividendNetTax + cgtTax),
      };
    })
    .sort((a, b) => b.financialYear.localeCompare(a.financialYear));

  return {
    byFy,
    dividendTax,
    dividendEvents: income.events,
    cgt,
    notes: [
      "Estimate only — not a tax return. Combines dividend income tax + " +
        "realised CGT on actual sells, with unused capital losses carried " +
        "forward across FYs; excludes salary/other income and non-portfolio " +
        "deductions.",
      lotMatching === "min_cgt"
        ? "Sells you can identify yourself are matched to minimise estimated CGT. Imported sells from brokers marked as issuing their own CGT report (default: Betashares Direct) stay FIFO. A sale confirmed on the ticker page uses the parcels you recorded."
        : "Sells matched FIFO (oldest parcel first), except sales you confirmed with a specific parcel mix.",
      ...dividendTax.notes,
    ],
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
