import { describe, expect, it } from "vitest";
import type { RealisedDisposal } from "../lots.js";
import { estimateRealisedCgtForLedger } from "./realisedCgt.js";
import type { TaxProfile } from "./types.js";

const profile: TaxProfile = {
  label: "Test",
  marginalRate: 0.37,
  medicareLevy: 0.02,
}; // combined 0.39

function disposal(partial: Partial<RealisedDisposal> & Pick<RealisedDisposal, "disposedDate" | "proceedsAud" | "costBaseAud">): RealisedDisposal {
  return {
    ticker: "VAS",
    exchange: "ASX",
    acquiredDate: "2020-01-01",
    quantity: 1,
    ...partial,
  };
}

describe("estimateRealisedCgtForLedger", () => {
  it("applies each disposal's own lot acquisition date and rolls totals up by FY", () => {
    const disposals: RealisedDisposal[] = [
      disposal({
        acquiredDate: "2020-01-01",
        disposedDate: "2024-08-15", // FY2025, pre-cutover -> discount_50
        quantity: 4,
        proceedsAud: 800,
        costBaseAud: 400,
      }),
      disposal({
        acquiredDate: "2021-01-01",
        disposedDate: "2027-08-15", // FY2028, post-cutover -> indexation_min30
        quantity: 3,
        proceedsAud: 600,
        costBaseAud: 450,
      }),
    ];

    const report = estimateRealisedCgtForLedger(disposals, {
      regime: "auto_by_date",
      profile,
    });

    expect(report.lines).toHaveLength(2);
    expect(report.lines[0].appliedRegime).toBe("discount_50");
    expect(report.lines[0].longTerm).toBe(true);
    expect(report.lines[1].appliedRegime).toBe("indexation_min30");

    expect(report.fyTotals).toHaveLength(2);
    const fy2025 = report.fyTotals.find((t) => t.financialYear === "FY2025")!;
    const fy2028 = report.fyTotals.find((t) => t.financialYear === "FY2028")!;
    expect(fy2025.disposalCount).toBe(1);
    expect(fy2028.disposalCount).toBe(1);
    // discount_50 long-term, no losses to net: taxableGain = 50% of gain
    expect(fy2025.netCapitalGain).toBeCloseTo(400);
    expect(fy2025.taxableGain).toBeCloseTo(200);
    expect(fy2025.tax).toBeCloseTo(200 * 0.39);
  });

  it("sums multiple same-FY gains before applying indexed-regime tax", () => {
    const disposals: RealisedDisposal[] = [
      disposal({ acquiredDate: "2020-01-01", disposedDate: "2025-03-01", proceedsAud: 300, costBaseAud: 100 }),
      disposal({ ticker: "IOZ", acquiredDate: "2020-06-01", disposedDate: "2025-04-01", proceedsAud: 500, costBaseAud: 200 }),
    ];

    const report = estimateRealisedCgtForLedger(disposals, {
      regime: "indexation_min30",
      profile,
      annualInflationRate: 0,
    });

    expect(report.fyTotals).toHaveLength(1);
    expect(report.fyTotals[0].disposalCount).toBe(2);
    expect(report.fyTotals[0].netCapitalGain).toBeCloseTo(200 + 300);
    expect(report.fyTotals[0].taxableGain).toBeCloseTo(500); // no discount post-2027
  });

  it("nets a same-FY loss against a gain instead of taxing the gain in full", () => {
    // A $500 gain and a $500 loss in the same FY should net to $0 taxable —
    // not "full tax on the gain, $0 tax (but no credit) on the loss".
    const disposals: RealisedDisposal[] = [
      disposal({ disposedDate: "2025-03-01", proceedsAud: 1500, costBaseAud: 1000 }), // +500 gain
      disposal({ ticker: "IOZ", disposedDate: "2025-04-01", proceedsAud: 500, costBaseAud: 1000 }), // -500 loss
    ];

    const report = estimateRealisedCgtForLedger(disposals, {
      regime: "indexation_min30",
      profile,
      annualInflationRate: 0,
    });

    const fy = report.fyTotals[0]!;
    expect(fy.totalGains).toBeCloseTo(500);
    expect(fy.totalLosses).toBeCloseTo(500);
    expect(fy.netCapitalGain).toBeCloseTo(0);
    expect(fy.netCapitalLoss).toBeCloseTo(0);
    expect(fy.taxableGain).toBe(0);
    expect(fy.tax).toBe(0);
  });

  it("reports a net capital loss (not carried forward) when losses exceed gains in the FY", () => {
    const disposals: RealisedDisposal[] = [
      disposal({ disposedDate: "2025-03-01", proceedsAud: 1000, costBaseAud: 1200 }), // -200
      disposal({ ticker: "IOZ", disposedDate: "2025-04-01", proceedsAud: 500, costBaseAud: 1000 }), // -500
    ];

    const report = estimateRealisedCgtForLedger(disposals, {
      regime: "indexation_min30",
      profile,
      annualInflationRate: 0,
    });

    const fy = report.fyTotals[0]!;
    expect(fy.netCapitalGain).toBe(0);
    expect(fy.netCapitalLoss).toBeCloseTo(700);
    expect(fy.tax).toBe(0);
  });

  it("under discount_50, nets losses against short-term gains before long-term (most favourable order)", () => {
    // Long-term (held >365d) +1000 gain, eligible for 50% discount.
    // Short-term (held <365d) +400 gain, not eligible.
    // -400 loss should offset the short-term gain first (wasting none of
    // the discount), leaving the full 1000 long-term gain to be halved.
    const disposals: RealisedDisposal[] = [
      disposal({
        ticker: "LONG",
        acquiredDate: "2020-01-01",
        disposedDate: "2025-03-01", // held ~5y -> long-term
        proceedsAud: 2000,
        costBaseAud: 1000, // +1000
      }),
      disposal({
        ticker: "SHORT",
        acquiredDate: "2024-09-01",
        disposedDate: "2025-03-01", // held ~6mo -> short-term
        proceedsAud: 900,
        costBaseAud: 500, // +400
      }),
      disposal({
        ticker: "LOSS",
        acquiredDate: "2024-06-01",
        disposedDate: "2025-03-01",
        proceedsAud: 100,
        costBaseAud: 500, // -400
      }),
    ];

    const report = estimateRealisedCgtForLedger(disposals, {
      regime: "discount_50",
      profile,
    });

    const fy = report.fyTotals[0]!;
    expect(fy.totalGains).toBeCloseTo(1400);
    expect(fy.totalLosses).toBeCloseTo(400);
    expect(fy.netCapitalGain).toBeCloseTo(1000);
    // Loss fully absorbed by the short-term gain -> long-term 1000 untouched, halved.
    expect(fy.taxableGain).toBeCloseTo(500);
    expect(fy.tax).toBeCloseTo(500 * 0.39);
  });

  it("under discount_50, an excess loss beyond short-term gains spills over to reduce long-term gains (then halved)", () => {
    const disposals: RealisedDisposal[] = [
      disposal({
        ticker: "LONG",
        acquiredDate: "2020-01-01",
        disposedDate: "2025-03-01",
        proceedsAud: 2000,
        costBaseAud: 1000, // +1000 long-term
      }),
      disposal({
        ticker: "LOSS",
        acquiredDate: "2024-06-01",
        disposedDate: "2025-03-01",
        proceedsAud: 0,
        costBaseAud: 600, // -600, no short-term gain to absorb it
      }),
    ];

    const report = estimateRealisedCgtForLedger(disposals, {
      regime: "discount_50",
      profile,
    });

    const fy = report.fyTotals[0]!;
    expect(fy.netCapitalGain).toBeCloseTo(400); // 1000 - 600
    // Remaining long-term gain (1000 - 600 = 400) still gets the discount.
    expect(fy.taxableGain).toBeCloseTo(200);
    expect(fy.tax).toBeCloseTo(200 * 0.39);
  });

  describe("loss carry-forward across FYs", () => {
    it("carries a FY's net loss forward to reduce a later FY's net gain", () => {
      const disposals: RealisedDisposal[] = [
        // FY2025: pure loss, nothing to offset it against this year.
        disposal({ disposedDate: "2025-03-01", proceedsAud: 500, costBaseAud: 2500 }), // -2000
        // FY2027: a gain that should be reduced by the FY2025 carried loss.
        disposal({
          ticker: "IOZ",
          acquiredDate: "2026-01-01",
          disposedDate: "2027-03-01", // held < 365d -> short-term
          proceedsAud: 3000,
          costBaseAud: 1000, // +2000
        }),
      ];

      const report = estimateRealisedCgtForLedger(disposals, {
        regime: "discount_50",
        profile,
      });

      const fy2025 = report.fyTotals.find((t) => t.financialYear === "FY2025")!;
      expect(fy2025.netCapitalLoss).toBeCloseTo(2000);
      expect(fy2025.lossCarriedIn).toBe(0);
      expect(fy2025.lossCarriedOut).toBeCloseTo(2000);
      expect(fy2025.tax).toBe(0);

      const fy2027 = report.fyTotals.find((t) => t.financialYear === "FY2027")!;
      expect(fy2027.lossCarriedIn).toBeCloseTo(2000);
      expect(fy2027.priorLossApplied).toBeCloseTo(2000);
      expect(fy2027.netCapitalGain).toBeCloseTo(2000); // this FY's OWN performance, unaffected by carry-forward
      expect(fy2027.taxableGain).toBe(0); // fully absorbed by the carried loss
      expect(fy2027.tax).toBe(0);
      expect(fy2027.lossCarriedOut).toBe(0); // fully used, nothing left to carry further
    });

    it("carries forward only the unused remainder when a gain partially absorbs a prior loss", () => {
      const disposals: RealisedDisposal[] = [
        disposal({ disposedDate: "2025-03-01", proceedsAud: 0, costBaseAud: 3000 }), // -3000
        disposal({
          ticker: "IOZ",
          acquiredDate: "2026-01-01",
          disposedDate: "2027-03-01",
          proceedsAud: 2000,
          costBaseAud: 1000, // +1000
        }),
      ];

      const report = estimateRealisedCgtForLedger(disposals, {
        regime: "discount_50",
        profile,
      });

      const fy2027 = report.fyTotals.find((t) => t.financialYear === "FY2027")!;
      expect(fy2027.priorLossApplied).toBeCloseTo(1000); // only as much as this FY's gain allows
      expect(fy2027.taxableGain).toBe(0);
      expect(fy2027.lossCarriedOut).toBeCloseTo(2000); // 3000 - 1000, still available for a future FY
    });

    it("applies a carried-forward loss against short-term gains before long-term (discount preserved)", () => {
      const disposals: RealisedDisposal[] = [
        disposal({ disposedDate: "2025-03-01", proceedsAud: 0, costBaseAud: 500 }), // FY2025: -500 loss
        // FY2027: a short-term gain and a long-term gain in the same FY.
        disposal({
          ticker: "SHORT",
          acquiredDate: "2026-09-01",
          disposedDate: "2027-03-01",
          proceedsAud: 900,
          costBaseAud: 400, // +500 short-term
        }),
        disposal({
          ticker: "LONG",
          acquiredDate: "2020-01-01",
          disposedDate: "2027-03-01",
          proceedsAud: 2000,
          costBaseAud: 1000, // +1000 long-term
        }),
      ];

      const report = estimateRealisedCgtForLedger(disposals, {
        regime: "discount_50",
        profile,
      });

      const fy2027 = report.fyTotals.find((t) => t.financialYear === "FY2027")!;
      // Carried loss (500) fully absorbed by the short-term gain (500) ->
      // long-term 1000 untouched, still gets the 50% discount.
      expect(fy2027.priorLossApplied).toBeCloseTo(500);
      expect(fy2027.taxableGain).toBeCloseTo(500); // 1000 * 0.5
      expect(fy2027.tax).toBeCloseTo(500 * 0.39);
    });

    it("carries a loss forward across a regime change (discount_50 loss offsetting an indexation_min30 gain)", () => {
      const disposals: RealisedDisposal[] = [
        disposal({ disposedDate: "2025-03-01", proceedsAud: 0, costBaseAud: 1000 }), // FY2025 (pre-cutover): -1000
        disposal({
          ticker: "IOZ",
          acquiredDate: "2026-01-01",
          disposedDate: "2027-08-01", // FY2028 (post-cutover)
          proceedsAud: 2000,
          costBaseAud: 1000, // +1000
        }),
      ];

      const report = estimateRealisedCgtForLedger(disposals, {
        regime: "auto_by_date",
        profile,
        annualInflationRate: 0,
      });

      const fy2025 = report.fyTotals.find((t) => t.financialYear === "FY2025")!;
      expect(fy2025.appliedRegime).toBe("discount_50");
      expect(fy2025.lossCarriedOut).toBeCloseTo(1000);

      const fy2028 = report.fyTotals.find((t) => t.financialYear === "FY2028")!;
      expect(fy2028.appliedRegime).toBe("indexation_min30");
      expect(fy2028.priorLossApplied).toBeCloseTo(1000);
      expect(fy2028.taxableGain).toBe(0);
      expect(fy2028.tax).toBe(0);
    });
  });
});
