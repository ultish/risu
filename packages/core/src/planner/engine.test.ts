import { describe, expect, it } from "vitest";
import { runScenario } from "./engine.js";
import type { Scenario } from "./types.js";

const profile = {
  label: "Test",
  marginalRate: 0.37,
  medicareLevy: 0.02,
};

const simpleAssets = [
  {
    label: "EQ",
    weight: 1,
    growthRate: 0.06,
    yieldRate: 0.02,
    mer: 0,
    frankingPercent: 0,
    reinvestDividends: true,
  },
];

function baseScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    name: "test",
    horizonYears: 2,
    startDate: "2025-01-01",
    initialValueAud: 10_000,
    taxProfile: profile,
    cgtRegime: "discount_50",
    monthlyContributionAud: 0,
    exit: { type: "hold" },
    allocations: [
      {
        id: "one",
        label: "One",
        assets: simpleAssets,
        exit: { type: "hold" },
      },
    ],
    ...overrides,
  };
}

describe("planner engine contributions", () => {
  it("flat monthly contributions accumulate into totalContributions", () => {
    // 2 years × 12 months × $500 = $12_000
    const flat = runScenario(
      baseScenario({ monthlyContributionAud: 500 }),
    );
    expect(flat.allocations).toHaveLength(1);
    expect(flat.allocations[0]!.totalContributions).toBe(12_000);
  });

  it("keyframes change totalContributions vs flat", () => {
    // Flat $500/mo for 24 months = 12_000
    // Keyframes: $0 for first 12 months, then $1000/mo for last 12 = 12_000
    // Different schedule: $100 first year, $1000 second = 100*12 + 1000*12 = 13_200
    const flat = runScenario(
      baseScenario({ monthlyContributionAud: 500 }),
    );
    const keyed = runScenario(
      baseScenario({
        monthlyContributionAud: 0,
        contributionKeyframes: [
          { monthIndex: 0, monthlyAud: 100 },
          { monthIndex: 12, monthlyAud: 1000 },
        ],
      }),
    );

    expect(flat.allocations[0]!.totalContributions).toBe(12_000);
    expect(keyed.allocations[0]!.totalContributions).toBe(
      100 * 12 + 1000 * 12,
    );
    expect(keyed.allocations[0]!.totalContributions).not.toBe(
      flat.allocations[0]!.totalContributions,
    );
  });

  it("liquidate sets exitCgtTax > 0 when portfolio has gains", () => {
    const liquidate = runScenario(
      baseScenario({
        initialValueAud: 50_000,
        initialCostBaseAud: 40_000,
        monthlyContributionAud: 0,
        horizonYears: 3,
        cgtRegime: "discount_50",
        exit: { type: "liquidate" },
        allocations: [
          {
            id: "growth",
            label: "Growth",
            assets: [
              {
                label: "G",
                weight: 1,
                growthRate: 0.1,
                yieldRate: 0,
                mer: 0,
                reinvestDividends: true,
              },
            ],
            exit: { type: "liquidate" },
          },
        ],
      }),
    );

    const hold = runScenario(
      baseScenario({
        initialValueAud: 50_000,
        initialCostBaseAud: 40_000,
        monthlyContributionAud: 0,
        horizonYears: 3,
        cgtRegime: "discount_50",
        exit: { type: "hold" },
        allocations: [
          {
            id: "hold",
            label: "Hold",
            assets: [
              {
                label: "G",
                weight: 1,
                growthRate: 0.1,
                yieldRate: 0,
                mer: 0,
                reinvestDividends: true,
              },
            ],
            exit: { type: "hold" },
          },
        ],
      }),
    );

    const liq = liquidate.allocations[0]!;
    const h = hold.allocations[0]!;

    expect(liq.exit.type).toBe("liquidate");
    expect(liq.exitCgtTax).toBeGreaterThan(0);
    expect(liq.exitCapitalGain).toBeGreaterThan(0);
    expect(liq.netIfLiquidated).toBeLessThan(liq.finalValue);

    expect(h.exit.type).toBe("hold");
    expect(h.exitCgtTax).toBe(0);
    expect(h.netIfLiquidated).toBe(h.finalValue);
  });
});
