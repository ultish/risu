import { describe, expect, it } from "vitest";
import {
  daysBetweenIso,
  estimateRealisedCgt,
  indexCostBaseAud,
  post2027CgtRateOnGain,
  resolveCgtRegime,
} from "./cgt.js";
import type { TaxProfile } from "./types.js";

const profile: TaxProfile = {
  label: "Test",
  marginalRate: 0.37,
  medicareLevy: 0.02,
};
// combined = 0.39

const profileZero: TaxProfile = {
  label: "Zero",
  marginalRate: 0,
  medicareLevy: 0,
};

describe("resolveCgtRegime", () => {
  it("auto_by_date switches to the Act's rules at 2027-07-01", () => {
    expect(resolveCgtRegime("auto_by_date", "2027-06-30")).toBe("discount_50");
    expect(resolveCgtRegime("auto_by_date", "2027-07-01")).toBe("act_2027");
  });
});

describe("daysBetweenIso", () => {
  it("counts calendar days", () => {
    expect(daysBetweenIso("2020-01-01", "2021-01-01")).toBe(366); // leap
    expect(daysBetweenIso("2021-01-01", "2022-01-01")).toBe(365);
  });
});

describe("indexCostBaseAud / post2027CgtRateOnGain", () => {
  it("compounds cost at constant inflation", () => {
    // days/365.25 years at 10% (leap years make it slightly over 2.0 calendar years)
    const indexed = indexCostBaseAud(100, "2020-01-01", "2022-01-01", 0.1);
    const years = daysBetweenIso("2020-01-01", "2022-01-01") / 365.25;
    expect(indexed).toBeCloseTo(100 * Math.pow(1.1, years), 8);
  });

  it("rate is max(MTR, 30%)", () => {
    expect(post2027CgtRateOnGain(profile)).toBeCloseTo(0.39, 5);
    expect(post2027CgtRateOnGain(profileZero)).toBe(0.3);
  });
});

describe("estimateRealisedCgt regimes", () => {
  const longTerm = {
    proceedsAud: 20_000,
    costBaseAud: 10_000,
    acquiredDate: "2020-01-01",
    disposedDate: "2025-01-01", // > 365 days
    profile,
  };

  it("discount_50: tax is half the gain × combined MTR (nominal cost)", () => {
    const r = estimateRealisedCgt({
      ...longTerm,
      regime: "discount_50",
    });
    expect(r.longTerm).toBe(true);
    expect(r.capitalGain).toBe(10_000);
    expect(r.taxableGain).toBe(5_000);
    expect(r.tax).toBe(1950);
    expect(r.effectiveRateOnGain).toBeCloseTo(0.195, 5);
  });

  it("post-2027: indexes cost and taxes at max(MTR, 30%)", () => {
    // 5 years at 0% inflation for a clear rate check
    const r = estimateRealisedCgt({
      ...longTerm,
      regime: "indexation_min30",
      annualInflationRate: 0,
    });
    expect(r.capitalGain).toBe(10_000);
    expect(r.effectiveRateOnGain).toBeCloseTo(0.39, 5);
    expect(r.tax).toBe(3900);
  });

  it("post-2027: 30% floor when MTR is 0", () => {
    const r = estimateRealisedCgt({
      proceedsAud: 20_000,
      costBaseAud: 10_000,
      acquiredDate: "2020-01-01",
      disposedDate: "2025-01-01",
      regime: "indexation_min30",
      annualInflationRate: 0,
      profile: profileZero,
    });
    expect(r.capitalGain).toBe(10_000);
    expect(r.effectiveRateOnGain).toBe(0.3);
    expect(r.tax).toBe(3000);
  });

  it("post-2027: indexation reduces the taxable gain", () => {
    const r = estimateRealisedCgt({
      proceedsAud: 20_000,
      costBaseAud: 10_000,
      acquiredDate: "2020-01-01",
      disposedDate: "2022-01-01",
      regime: "indexation_min30",
      annualInflationRate: 0.1,
      profile,
    });
    const years = daysBetweenIso("2020-01-01", "2022-01-01") / 365.25;
    const expectedCost = 10_000 * Math.pow(1.1, years);
    const expectedGain = 20_000 - expectedCost;
    expect(r.costBaseUsedAud).toBeCloseTo(expectedCost, 1);
    expect(r.capitalGain).toBeCloseTo(expectedGain, 1);
    expect(r.tax).toBeCloseTo(expectedGain * 0.39, 0);
    // Indexed cost > nominal → smaller gain than unindexed $10k
    expect(r.capitalGain).toBeLessThan(10_000);
  });

  it("post-2027: does not double-index when costBaseAlreadyIndexed", () => {
    const r = estimateRealisedCgt({
      proceedsAud: 20_000,
      costBaseAud: 12_100,
      acquiredDate: "2020-01-01",
      disposedDate: "2022-01-01",
      regime: "indexation_min30",
      annualInflationRate: 0.1,
      costBaseAlreadyIndexed: true,
      profile,
    });
    expect(r.costBaseUsedAud).toBe(12_100);
    expect(r.capitalGain).toBeCloseTo(7_900, 0);
  });

  it("legacy discount_50 short-term is full MTR", () => {
    const r = estimateRealisedCgt({
      proceedsAud: 20_000,
      costBaseAud: 10_000,
      acquiredDate: "2025-01-01",
      disposedDate: "2025-06-01",
      regime: "discount_50",
      profile,
    });
    expect(r.longTerm).toBe(false);
    expect(r.tax).toBe(3900);
  });

  it("capital loss yields zero tax", () => {
    const r = estimateRealisedCgt({
      proceedsAud: 5_000,
      costBaseAud: 10_000,
      acquiredDate: "2020-01-01",
      disposedDate: "2025-01-01",
      regime: "indexation_min30",
      annualInflationRate: 0,
      profile,
    });
    expect(r.tax).toBe(0);
    expect(r.capitalGain).toBe(-5_000);
  });
});
