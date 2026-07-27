import type { CgtRegime, TaxProfile } from "../tax/types.js";

/**
 * Single sleeve / instrument assumptions inside a scenario allocation.
 * All rates are **effective annual** decimals (e.g. 0.07 = 7% p.a.).
 * The engine converts to monthly via (1+r)^(1/12)−1 so twelve steps recover r.
 */
export type AssetAssumption = {
  /** Optional label, e.g. "AU equity growth" */
  label?: string;
  /** Ticker / ETF code for display (e.g. BGBL, VHY) — not live-priced in planner */
  ticker?: string;
  /** Weight within allocation (0–1); weights should sum ≈ 1 */
  weight: number;
  /** Expected capital growth effective p.a. (before MER) */
  growthRate: number;
  /** Expected cash yield effective p.a. */
  yieldRate: number;
  /** MER / management fee effective p.a. as decimal drag on AUM */
  mer: number;
  /** Franking on yield portion (0–100); 0 for foreign / unfranked */
  frankingPercent?: number;
  /** If true, yield is reinvested (DRP); else cash out (still taxed) */
  reinvestDividends?: boolean;
};

/** Piecewise monthly contribution: from month index (0-based), amount AUD/month */
export type ContributionKeyframe = {
  /** Month index from scenario start (0 = first month) */
  monthIndex: number;
  /** Monthly contribution in AUD from this month until next keyframe */
  monthlyAud: number;
};

export type ExitStrategy =
  | { type: "liquidate" }
  | { type: "hold" }
  | {
      type: "drawdown";
      /** Fraction of portfolio withdrawn each year (e.g. 0.04 = 4%) */
      annualRate: number;
    };

/** Named portfolio style for comparison templates */
export type AllocationTemplateId = "growth" | "dividend" | "hybrid" | "custom";

export type ScenarioAllocation = {
  id: AllocationTemplateId | string;
  label: string;
  assets: AssetAssumption[];
  /**
   * Per-strategy exit (overrides scenario.exit when set).
   * e.g. growth → liquidate, dividend → hold (income path, no forced sale).
   */
  exit?: ExitStrategy;
};

/**
 * Planner scenario: horizon + tax + contributions + one or more allocations
 * to compare (typically growth / dividend / hybrid).
 */
export type Scenario = {
  name: string;
  /** Planning horizon in years */
  horizonYears: number;
  /** ISO start date (yyyy-mm-dd); defaults to today when running */
  startDate?: string;
  /** Opening portfolio value AUD */
  initialValueAud?: number;
  /** Opening cost base AUD (for CGT on exit); defaults to initialValue */
  initialCostBaseAud?: number;
  taxProfile: TaxProfile;
  cgtRegime: CgtRegime;
  /**
   * Assumed CPI / cost-base indexation rate p.a. (decimal) for post–Jul 2027.
   * Default 2.5%. Used to inflate cost base each month under `indexation_min30`.
   * Ignored for legacy `discount_50`.
   */
  inflationRateAnnual?: number;
  /**
   * Flat monthly contribution if no keyframes.
   * Keyframes override piecewise.
   */
  monthlyContributionAud?: number;
  contributionKeyframes?: ContributionKeyframe[];
  /** One-off lumps: monthIndex → AUD */
  lumpSums?: Array<{ monthIndex: number; amountAud: number }>;
  /** Brokerage per contribution event (AUD), optional */
  brokeragePerContribution?: number;
  /**
   * Default exit when an allocation does not set its own `exit`.
   * Prefer setting exit on each allocation for growth-vs-dividend comparisons.
   */
  exit: ExitStrategy;
  /** Allocations to run (1–3 typical) */
  allocations: ScenarioAllocation[];
};

export type ScenarioYearRow = {
  year: number;
  endValue: number;
  contributions: number;
  dividendsCash: number;
  dividendsReinvested: number;
  fees: number;
  incomeTax: number;
  cgtTax: number;
};

export type AllocationReport = {
  allocationId: string;
  label: string;
  /** Exit actually applied for this strategy */
  exit: ExitStrategy;
  finalValue: number;
  /** Monthly + lump contributions only (not initial balance) */
  totalContributions: number;
  /** initialValue + contributions — true capital you supplied */
  totalCapitalIn: number;
  totalDividendsCash: number;
  totalDividendsReinvested: number;
  /**
   * Portfolio capital + cash dividends taken out (before exit CGT / personal tax on cash).
   * Use this to compare “total economic outcome” when dividend strategies pay cash.
   */
  totalWealthBeforeExitCgt: number;
  totalFees: number;
  totalIncomeTax: number;
  totalCgtTax: number;
  /** Tax if liquidated (or drawdown CGT already included); 0 if hold */
  exitCgtTax: number;
  /** Net cash if sold all on last day (final − exit CGT); same as final if hold */
  netIfLiquidated: number;
  /**
   * Net after exit CGT + cash divs kept − capital you put in − income tax.
   * Rough “how much better off” including cash yield strategies.
   */
  netGainAfterTax: number;
  /**
   * Paper gain on capital only: finalValue − totalCapitalIn
   */
  gainBeforeExitCgt: number;
  /** Capital gain at exit for CGT: max(0, finalValue − cost base) */
  exitCapitalGain: number;
  /** (income tax + CGT) / max(totalCapitalIn, 1) */
  effectiveTaxDragPct: number;
  years: ScenarioYearRow[];
};

export type ScenarioReport = {
  scenarioName: string;
  horizonYears: number;
  startDate: string;
  endDate: string;
  taxProfile: TaxProfile;
  cgtRegime: CgtRegime;
  exit: ExitStrategy;
  allocations: AllocationReport[];
  disclaimer: string;
};

export const PLANNER_DISCLAIMER =
  "Estimates only — not financial, tax, or investment advice. Planner is for new buys under post–Jul 2027 CGT: cost base CPI-indexed (assumed inflation); no 50% discount; CGT rate = max(MTR+Medicare, 30%) on the indexed gain. Average cost; not ATO software.";
