/**
 * Scenario planner engine — monthly simulation.
 *
 * Each month per allocation sleeve:
 * 1. Contribution (+ optional brokerage fee)
 * 2. Capital growth only (monthly compound of annual growthRate)
 * 3. Yield on capital (monthly of annual yieldRate):
 *    - cash: income outside capital (value/cost base unchanged by the yield)
 *    - reinvest: net-of-tax yield added to value and cost base
 * 4. MER drag on value (not cost base)
 *
 * Tax: income tax on yield (simplified); CGT on liquidate / drawdown (avg cost).
 *
 * growthRate + yieldRate are additive total-return components — do not strip
 * cash yield from capital (that zeroed CGT on high-yield strategies).
 */

import { resolveInstrumentFromSeed } from "../instruments/resolve.js";
import { estimateLiquidationCgt } from "../tax/cgt.js";
import { estimateDividendTax } from "../tax/incomeTax.js";
import type { CgtRegime, TaxProfile } from "../tax/types.js";
import {
  PLANNER_DISCLAIMER,
  type AllocationReport,
  type AssetAssumption,
  type ContributionKeyframe,
  type ExitStrategy,
  type Scenario,
  type ScenarioAllocation,
  type ScenarioReport,
  type ScenarioYearRow,
} from "./types.js";

const MONTHS = 12;

/**
 * Built-in comparison templates — ticker portfolios with illustrative assumptions.
 * Rates are NOT forecasts; user should tweak yield/growth/MER in the UI.
 */
export function defaultAllocationTemplates(): ScenarioAllocation[] {
  return [
    {
      id: "growth",
      label: "Growth",
      /** Sell at horizon to realise CGT under post‑2027 rules */
      exit: { type: "liquidate" },
      assets: [
        {
          ticker: "BGBL",
          label: "BGBL",
          weight: 0.7,
          growthRate: 0.08,
          yieldRate: 0.015,
          mer: 0.0016,
          frankingPercent: 0,
          reinvestDividends: true,
        },
        {
          ticker: "A200",
          label: "A200",
          weight: 0.3,
          growthRate: 0.07,
          yieldRate: 0.035,
          mer: 0.0004,
          frankingPercent: 70,
          reinvestDividends: true,
        },
      ],
    },
    {
      id: "dividend",
      label: "Dividend",
      /** Hold for income — no forced sale / exit CGT */
      exit: { type: "hold" },
      assets: [
        {
          ticker: "HYLD",
          label: "HYLD",
          weight: 0.5,
          growthRate: 0.03,
          yieldRate: 0.06,
          mer: 0.0025,
          frankingPercent: 50,
          reinvestDividends: false,
        },
        {
          ticker: "VHY",
          label: "VHY",
          weight: 0.5,
          growthRate: 0.035,
          yieldRate: 0.055,
          mer: 0.0025,
          frankingPercent: 80,
          reinvestDividends: false,
        },
      ],
    },
    {
      id: "hybrid",
      label: "Hybrid",
      exit: { type: "liquidate" },
      assets: [
        {
          ticker: "BGBL",
          label: "BGBL",
          weight: 0.5,
          growthRate: 0.08,
          yieldRate: 0.015,
          mer: 0.0016,
          frankingPercent: 0,
          reinvestDividends: true,
        },
        {
          ticker: "VHY",
          label: "VHY",
          weight: 0.5,
          growthRate: 0.035,
          yieldRate: 0.055,
          mer: 0.0025,
          frankingPercent: 80,
          reinvestDividends: false,
        },
      ],
    },
  ];
}

/** Sensible starter assumptions when user adds a new ticker row (seed-backed). */
export function defaultAssumptionsForTicker(ticker: string): AssetAssumption {
  const inst = resolveInstrumentFromSeed(ticker);
  const t = inst.ticker || "NEW";
  return {
    ticker: t,
    label: inst.name ?? t,
    weight: 0.1,
    growthRate: inst.growthRate,
    yieldRate: inst.yieldRate,
    mer: inst.mer,
    frankingPercent: inst.frankingPercent,
    reinvestDividends: true,
  };
}

export function runScenario(scenario: Scenario): ScenarioReport {
  const startDate = scenario.startDate ?? todayIso();
  const months = Math.max(1, Math.round(scenario.horizonYears * MONTHS));
  const endDate = addMonthsIso(startDate, months);

  const allocations = scenario.allocations.map((alloc) =>
    runAllocation(scenario, alloc, startDate, months),
  );

  return {
    scenarioName: scenario.name,
    horizonYears: scenario.horizonYears,
    startDate,
    endDate,
    taxProfile: scenario.taxProfile,
    cgtRegime: scenario.cgtRegime,
    exit: scenario.exit,
    allocations,
    disclaimer: PLANNER_DISCLAIMER,
  };
}

/**
 * Run body-only planner (no persistence) — same as runScenario.
 * Useful for POST /api/planner/run.
 */
export function runPlanner(scenario: Scenario): ScenarioReport {
  return runScenario(scenario);
}

function runAllocation(
  scenario: Scenario,
  alloc: ScenarioAllocation,
  startDate: string,
  months: number,
): AllocationReport {
  const assets = normaliseWeights(alloc.assets);
  const profile = scenario.taxProfile;
  const regime = scenario.cgtRegime;
  const brokerage = scenario.brokeragePerContribution ?? 0;
  /** Per-strategy exit (e.g. growth liquidate, dividend hold) */
  const exit = alloc.exit ?? scenario.exit;

  // Sleeve state: value + cost base (AUD), acquisition proxy for CGT
  const sleeves = assets.map((a) => {
    const w = a.weight;
    const init = (scenario.initialValueAud ?? 0) * w;
    const cost = (scenario.initialCostBaseAud ?? scenario.initialValueAud ?? 0) * w;
    return {
      assumption: a,
      value: init,
      costBase: cost,
      acquiredDate: startDate,
    };
  });

  let totalContributions = 0;
  let totalDividendsCash = 0;
  let totalDividendsReinvested = 0;
  let totalFees = 0;
  let totalIncomeTax = 0;
  let totalCgtTax = 0;

  // Year accumulators
  let yearContrib = 0;
  let yearDivCash = 0;
  let yearDivReinv = 0;
  let yearFees = 0;
  let yearIncomeTax = 0;
  let yearCgt = 0;
  const years: ScenarioYearRow[] = [];

  const keyframes = buildContributionSchedule(
    months,
    scenario.monthlyContributionAud ?? 0,
    scenario.contributionKeyframes,
  );
  const lumps = new Map<number, number>();
  for (const l of scenario.lumpSums ?? []) {
    lumps.set(l.monthIndex, (lumps.get(l.monthIndex) ?? 0) + l.amountAud);
  }

  for (let m = 0; m < months; m++) {
    const monthlyContrib = keyframes[m] ?? 0;
    const lump = lumps.get(m) ?? 0;
    const contribute = monthlyContrib + lump;

    if (contribute > 0) {
      totalContributions += contribute;
      yearContrib += contribute;
      // Split by weight; brokerage is fee not cost base of assets
      for (const s of sleeves) {
        const add = contribute * s.assumption.weight;
        s.value += add;
        s.costBase += add;
      }
      if (brokerage > 0) {
        totalFees += brokerage;
        yearFees += brokerage;
        // Drag fee from first sleeve / pro-rata
        for (const s of sleeves) {
          const fee = brokerage * s.assumption.weight;
          s.value = Math.max(0, s.value - fee);
        }
      }
    }

    // Growth, yield, MER per sleeve
    //
    // growthRate = capital (price) appreciation only.
    // yieldRate  = income on top of that capital — NOT double-counted as a
    //              capital reduction. (Old code did value-=div for cash yield,
    //              which wiped capital gains on high-yield sleeves.)
    for (const s of sleeves) {
      const a = s.assumption;
      const g = monthlyRate(a.growthRate);
      const y = monthlyRate(a.yieldRate);
      const mer = monthlyRate(a.mer);

      // Capital growth only
      s.value *= 1 + g;

      // Yield on post-growth capital
      const div = s.value * y;
      if (div > 0) {
        const franking = a.frankingPercent ?? 0;
        const tax = estimateDividendTax({
          cashAud: div,
          frankingPercent: franking,
          profile,
        });
        const taxDue = Math.max(0, tax.netTax);
        totalIncomeTax += taxDue;
        yearIncomeTax += taxDue;

        const reinvest = a.reinvestDividends === true;

        if (reinvest) {
          // DRP: net-of-tax yield buys more units → value + cost base
          const reinvestNet = Math.max(0, div - taxDue);
          s.value += reinvestNet;
          s.costBase += reinvestNet;
          totalDividendsReinvested += div;
          yearDivReinv += div;
        } else {
          // Cash yield: leaves as income (tracked separately). Capital stays;
          // cost base unchanged. Tax assumed paid from cash income / outside.
          totalDividendsCash += div;
          yearDivCash += div;
        }
      }

      // MER drag (reduces market value, not cost base)
      const fee = s.value * mer;
      s.value = Math.max(0, s.value - fee);
      totalFees += fee;
      yearFees += fee;
    }

    // Annual drawdown at year boundaries (end of each 12 months)
    if (exit.type === "drawdown" && (m + 1) % MONTHS === 0) {
      const rate = exit.annualRate;
      const portfolioValue = sleeves.reduce((sum, s) => sum + s.value, 0);
      const withdraw = portfolioValue * rate;
      if (withdraw > 0 && portfolioValue > 0) {
        const cgt = applyProRataWithdrawal(
          sleeves,
          withdraw,
          startDate,
          addMonthsIso(startDate, m + 1),
          regime,
          profile,
        );
        totalCgtTax += cgt;
        yearCgt += cgt;
      }
    }

    // Year-end snapshot
    if ((m + 1) % MONTHS === 0 || m === months - 1) {
      const yearNum = Math.ceil((m + 1) / MONTHS);
      const endValue = round2(sleeves.reduce((sum, s) => sum + s.value, 0));
      years.push({
        year: yearNum,
        endValue,
        contributions: round2(yearContrib),
        dividendsCash: round2(yearDivCash),
        dividendsReinvested: round2(yearDivReinv),
        fees: round2(yearFees),
        incomeTax: round2(yearIncomeTax),
        cgtTax: round2(yearCgt),
      });
      yearContrib = 0;
      yearDivCash = 0;
      yearDivReinv = 0;
      yearFees = 0;
      yearIncomeTax = 0;
      yearCgt = 0;
    }
  }

  const finalValue = sleeves.reduce((sum, s) => sum + s.value, 0);
  const finalCost = sleeves.reduce((sum, s) => sum + s.costBase, 0);
  let exitCgtTax = 0;
  let exitCapitalGain = 0;

  if (exit.type === "liquidate") {
    const cgt = estimateLiquidationCgt({
      marketValueAud: finalValue,
      costBaseAud: finalCost,
      acquiredDate: startDate,
      disposedDate: addMonthsIso(startDate, months),
      regime,
      profile,
    });
    exitCgtTax = cgt.tax;
    exitCapitalGain = Math.max(0, cgt.capitalGain);
    totalCgtTax += exitCgtTax;
  } else {
    // hold or drawdown-at-end: paper gain only; no final liquidation CGT
    exitCapitalGain = Math.max(0, finalValue - finalCost);
  }

  const initialIn = scenario.initialValueAud ?? 0;
  const totalCapitalIn = initialIn + totalContributions;
  // Portfolio capital + cash yield taken out (dividend strategies look "low" on final alone)
  const totalWealthBeforeExitCgt = finalValue + totalDividendsCash;

  const netIfLiquidated =
    exit.type === "hold" ? finalValue : finalValue - exitCgtTax;

  // Economic net: capital after exit CGT + cash divs kept − capital supplied − income tax
  // (income tax assumed paid from cash yield / outside; fees already reduced finalValue)
  const netGainAfterTax =
    netIfLiquidated + totalDividendsCash - totalCapitalIn - totalIncomeTax;

  const gainBeforeExitCgt = finalValue - totalCapitalIn;

  const totalTax = totalIncomeTax + totalCgtTax;
  const effectiveTaxDragPct =
    totalCapitalIn > 0
      ? (totalTax / totalCapitalIn) * 100
      : totalTax > 0
        ? 100
        : 0;

  return {
    allocationId: String(alloc.id),
    label: alloc.label,
    exit,
    finalValue: round2(finalValue),
    totalContributions: round2(totalContributions),
    totalCapitalIn: round2(totalCapitalIn),
    totalDividendsCash: round2(totalDividendsCash),
    totalDividendsReinvested: round2(totalDividendsReinvested),
    totalWealthBeforeExitCgt: round2(totalWealthBeforeExitCgt),
    totalFees: round2(totalFees),
    totalIncomeTax: round2(totalIncomeTax),
    totalCgtTax: round2(totalCgtTax),
    exitCgtTax: round2(exitCgtTax),
    netIfLiquidated: round2(netIfLiquidated),
    netGainAfterTax: round2(netGainAfterTax),
    gainBeforeExitCgt: round2(gainBeforeExitCgt),
    exitCapitalGain: round2(exitCapitalGain),
    effectiveTaxDragPct: round2(effectiveTaxDragPct),
    years,
  };
}

function applyProRataWithdrawal(
  sleeves: Array<{
    assumption: AssetAssumption;
    value: number;
    costBase: number;
    acquiredDate: string;
  }>,
  withdrawAud: number,
  _startDate: string,
  disposedDate: string,
  regime: CgtRegime,
  profile: TaxProfile,
): number {
  const total = sleeves.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return 0;
  let cgtTax = 0;
  for (const s of sleeves) {
    const portion = s.value / total;
    const take = withdrawAud * portion;
    if (take <= 0 || s.value <= 0) continue;
    const frac = Math.min(1, take / s.value);
    const costPortion = s.costBase * frac;
    const cgt = estimateLiquidationCgt({
      marketValueAud: take,
      costBaseAud: costPortion,
      acquiredDate: s.acquiredDate,
      disposedDate,
      regime,
      profile,
    });
    cgtTax += cgt.tax;
    s.value -= take;
    s.costBase -= costPortion;
  }
  return cgtTax;
}

function normaliseWeights(assets: AssetAssumption[]): AssetAssumption[] {
  const sum = assets.reduce((s, a) => s + a.weight, 0);
  if (sum <= 0) {
    const n = assets.length || 1;
    return assets.map((a) => ({ ...a, weight: 1 / n }));
  }
  if (Math.abs(sum - 1) < 0.001) return assets;
  return assets.map((a) => ({ ...a, weight: a.weight / sum }));
}

function buildContributionSchedule(
  months: number,
  flatMonthly: number,
  keyframes?: ContributionKeyframe[],
): number[] {
  const out = new Array<number>(months).fill(flatMonthly);
  if (!keyframes?.length) return out;
  const sorted = [...keyframes].sort((a, b) => a.monthIndex - b.monthIndex);
  let amount = flatMonthly;
  let ki = 0;
  for (let m = 0; m < months; m++) {
    while (ki < sorted.length && sorted[ki]!.monthIndex <= m) {
      amount = sorted[ki]!.monthlyAud;
      ki++;
    }
    out[m] = amount;
  }
  return out;
}

function monthlyRate(annual: number): number {
  return annual / MONTHS;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addMonthsIso(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Re-export types used by callers
export type { Scenario, ScenarioReport, ExitStrategy, TaxProfile };
