import { describe, expect, it } from "vitest";
import {
  daysBetweenIso,
  estimateRealisedCgt,
  resolveCgtRegime,
} from "./cgt.js";
import type { TaxProfile } from "./types.js";

const profile: TaxProfile = {
  label: "Test",
  marginalRate: 0.37,
  medicareLevy: 0.02,
};
// combined = 0.39

describe("resolveCgtRegime", () => {
  it("auto_by_date switches at 2027-07-01", () => {
    expect(resolveCgtRegime("auto_by_date", "2027-06-30")).toBe("discount_50");
    expect(resolveCgtRegime("auto_by_date", "2027-07-01")).toBe(
      "indexation_min30",
    );
  });
});

describe("daysBetweenIso", () => {
  it("counts calendar days", () => {
    expect(daysBetweenIso("2020-01-01", "2021-01-01")).toBe(366); // leap
    expect(daysBetweenIso("2021-01-01", "2022-01-01")).toBe(365);
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

  it("discount_50: tax is half the gain × combined MTR", () => {
    const r = estimateRealisedCgt({
      ...longTerm,
      regime: "discount_50",
    });
    expect(r.longTerm).toBe(true);
    expect(r.capitalGain).toBe(10_000);
    expect(r.taxableGain).toBe(5_000);
    // 5000 * 0.39 = 1950
    expect(r.tax).toBe(1950);
    expect(r.effectiveRateOnGain).toBeCloseTo(0.195, 5);
    expect(r.appliedRegime).toBe("discount_50");
  });

  it("indexation_min30: floors effective rate at 30% of full gain", () => {
    // half-path would be 0.39 * 0.5 = 0.195 < 0.30 → floor 30%
    const r = estimateRealisedCgt({
      ...longTerm,
      regime: "indexation_min30",
    });
    expect(r.longTerm).toBe(true);
    expect(r.capitalGain).toBe(10_000);
    expect(r.effectiveRateOnGain).toBe(0.3);
    expect(r.tax).toBe(3000); // 10000 * 0.30
    expect(r.appliedRegime).toBe("indexation_min30");
    // Min-30 tax is higher than classic 50% discount path for this MTR
    const disc = estimateRealisedCgt({
      ...longTerm,
      regime: "discount_50",
    });
    expect(r.tax).toBeGreaterThan(disc.tax);
  });

  it("short-term ignores discount and min-30 floor path", () => {
    const r = estimateRealisedCgt({
      proceedsAud: 20_000,
      costBaseAud: 10_000,
      acquiredDate: "2025-01-01",
      disposedDate: "2025-06-01", // < 365 days
      regime: "discount_50",
      profile,
    });
    expect(r.longTerm).toBe(false);
    expect(r.taxableGain).toBe(10_000);
    expect(r.tax).toBe(3900); // full gain * 0.39
  });

  it("capital loss yields zero tax", () => {
    const r = estimateRealisedCgt({
      proceedsAud: 5_000,
      costBaseAud: 10_000,
      acquiredDate: "2020-01-01",
      disposedDate: "2025-01-01",
      regime: "discount_50",
      profile,
    });
    expect(r.tax).toBe(0);
    expect(r.capitalGain).toBe(-5_000);
  });
});
