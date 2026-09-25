import { describe, expect, it } from "vitest";
import type { RealisedDisposal } from "../lots.js";
import { cutoverValueFor, netAct2027, splitAct2027, type CutoverValues } from "./act2027.js";
import { estimateRealisedCgtForLedger } from "./realisedCgt.js";
import type { TaxProfile } from "./types.js";

const top: TaxProfile = { label: "Top", marginalRate: 0.45, medicareLevy: 0.02 }; // 47%
const low: TaxProfile = { label: "Low", marginalRate: 0.19, medicareLevy: 0.02 }; // 21%

const vas = (unitValueAud: number, source: "saved" | "prices" = "saved"): CutoverValues => ({
  unitValues: { "ASX:VAS": { unitValueAud, source } },
  splits: [],
});

function sale(p: Partial<RealisedDisposal> & Pick<RealisedDisposal, "acquiredDate" | "disposedDate" | "proceedsAud" | "costBaseAud">): RealisedDisposal {
  return { ticker: "VAS", exchange: "ASX", quantity: 100, ...p };
}

describe("the Act's split for a sale after 1 July 2027", () => {
  it("worked example: $10k bought 2020, $20k at 30 June 2027, sold for $25k in 2030", () => {
    const r = estimateRealisedCgtForLedger(
      [sale({ acquiredDate: "2020-01-01", disposedDate: "2030-07-01", proceedsAud: 25_000, costBaseAud: 10_000 })],
      { regime: "auto_by_date", profile: top, annualInflationRate: 0.025, cutover: vas(200) },
    );
    const indexed = 20_000 * Math.pow(1.025, 1096 / 365.25);
    const line = r.lines[0]!;
    expect(line.act?.preGain).toBe(10_000);
    expect(line.act?.postGain).toBeCloseTo(25_000 - indexed, 1);
    expect(r.fyTotals[0]!.tax).toBeCloseTo(10_000 * 0.5 * 0.47 + (25_000 - indexed) * 0.47, 1);
  });

  it("bought under a year before the cutover and held a year by the sale: pre-2027 gain discounted", () => {
    const p = splitAct2027({
      proceedsAud: 1_500, costBaseAud: 1_000, acquiredDate: "2027-03-01", disposedDate: "2028-06-01",
      annualInflationRate: 0, cutover: { valueAud: 1_200, source: "prices" },
    });
    expect(p).toMatchObject({ preGain: 200, postGain: 300, heldTwelveMonths: true });
  });

  it("held under 12 months in total: no discount and no indexation", () => {
    const p = splitAct2027({
      proceedsAud: 1_150, costBaseAud: 1_000, acquiredDate: "2027-03-01", disposedDate: "2027-12-01",
      annualInflationRate: 0.1, cutover: { valueAud: 1_100, source: "prices" },
    });
    expect(p).toMatchObject({ preGain: 100, postGain: 50, heldTwelveMonths: false, postCostBaseAud: 1_100 });
    expect(netAct2027([p], 0, top).tax).toBeCloseTo(150 * 0.47);
  });

  it("bought after the cutover: cost indexed from purchase only once held 12 months", () => {
    const short = splitAct2027({ proceedsAud: 1_200, costBaseAud: 1_000, acquiredDate: "2028-01-01", disposedDate: "2028-06-01", annualInflationRate: 0.1 });
    expect(short).toMatchObject({ preGain: 0, postGain: 200, cutoverValueAud: null });
    const long = splitAct2027({ proceedsAud: 1_200, costBaseAud: 1_000, acquiredDate: "2028-01-01", disposedDate: "2029-01-01", annualInflationRate: 0.1 });
    expect(long.postCostBaseAud).toBeCloseTo(1_000 * Math.pow(1.1, 366 / 365.25), 1);
  });
});

describe("netting a year in the Act's order (s 102-5(1))", () => {
  // A: $100 pre-2027, not discountable. B: $200 pre-2027, discountable.
  // C: $300 post-2027. Plus a $250 loss.
  const parts = [
    { preGain: 100, postGain: 0, heldTwelveMonths: false, cutoverValueAud: 0, cutoverSource: "prices" as const, postCostBaseAud: 0 },
    { preGain: 200, postGain: 0, heldTwelveMonths: true, cutoverValueAud: 0, cutoverSource: "prices" as const, postCostBaseAud: 0 },
    { preGain: 0, postGain: 300, heldTwelveMonths: true, cutoverValueAud: 0, cutoverSource: "prices" as const, postCostBaseAud: 0 },
    { preGain: 0, postGain: -250, heldTwelveMonths: true, cutoverValueAud: 0, cutoverSource: "prices" as const, postCostBaseAud: 0 },
  ];

  it("losses go against pre-2027 gains first — non-discount, then discount — then post-2027", () => {
    const n = netAct2027(parts, 0, top);
    // $250 loss: all of A ($100), then $150 of B. C untouched.
    expect(n).toMatchObject({ deferredNonDiscount: 0, deferredDiscount: 50, minimumTaxGain: 300, taxableGain: 325 });
    expect(n.tax).toBeCloseTo(325 * 0.47);
  });

  it("the post-2027 part pays at least 30% even on a low tax rate", () => {
    const n = netAct2027(parts, 0, low);
    expect(n.tax).toBeCloseTo(25 * 0.21 + 300 * 0.3);
  });

  it("carried-forward losses follow the same order", () => {
    const gainsOnly = parts.slice(0, 3);
    const n = netAct2027(gainsOnly, 250, top);
    expect(n).toMatchObject({ priorLossApplied: 250, deferredDiscount: 50, minimumTaxGain: 300, lossCarriedOut: 0 });
  });
});

describe("cutover value of the units sold", () => {
  it("allows for a split after 30 June 2027", () => {
    const cv: CutoverValues = {
      unitValues: { "ASX:VAS": { unitValueAud: 100, source: "prices" } },
      splits: [{ key: "ASX:VAS", ticker: "VAS", exchange: "ASX", date: "2028-01-01", ratio: 2 }],
    };
    // 10 units sold in 2029 were 5 units on 30 June 2027.
    expect(cutoverValueFor(cv, "ASX", "VAS", 10, "2029-01-01")).toEqual({ valueAud: 500, source: "prices" });
    expect(cutoverValueFor(cv, "ASX", "VAS", 10, "2027-12-01")?.valueAud).toBe(1_000);
  });
});
