import { describe, expect, it } from "vitest";
import { computeLots } from "../lots.js";
import type { ParsedTransaction } from "../types.js";
import { estimateFyTax } from "./fyEstimate.js";
import {
  estimateHypotheticalSale,
  orderFnForMatching,
  taxableGainPerUnit,
} from "./lotMatching.js";
import type { TaxProfile } from "./types.js";

const profile: TaxProfile = {
  label: "Test",
  marginalRate: 0.37,
  medicareLevy: 0.02,
}; // combined 0.39

function tx(
  partial: Partial<ParsedTransaction> &
    Pick<ParsedTransaction, "date" | "ticker" | "type">,
): ParsedTransaction {
  return {
    exchange: "ASX",
    quantity: 0,
    price: null,
    amount: null,
    brokerage: 0,
    currency: "AUD",
    externalId: null,
    notes: null,
    ...partial,
  };
}

describe("taxableGainPerUnit", () => {
  const lot = {
    ticker: "VAS",
    exchange: "ASX",
    currency: "AUD",
    acquiredDate: "2020-01-01",
    originalQuantity: 10,
    quantity: 10,
    costBaseAud: 1000, // $100/unit
  };

  it("halves a pre-2027 long-term gain", () => {
    // sell @ $200 on 2024 → gain $100/unit, 50% discount → $50 taxable/unit
    expect(
      taxableGainPerUnit(lot, 200, "2024-01-01", { regime: "auto_by_date" }),
    ).toBeCloseTo(50);
  });

  it("does not discount a short-term gain", () => {
    const recent = { ...lot, acquiredDate: "2024-01-01" };
    expect(
      taxableGainPerUnit(recent, 200, "2024-06-01", { regime: "auto_by_date" }),
    ).toBeCloseTo(100);
  });

  it("indexes cost post-2027 so older lots can have a smaller gain", () => {
    const infl = 0.1;
    const oldScore = taxableGainPerUnit(lot, 200, "2027-07-01", {
      regime: "auto_by_date",
      annualInflationRate: infl,
    });
    const newer = { ...lot, acquiredDate: "2026-07-01", costBaseAud: 1800 };
    const newScore = taxableGainPerUnit(newer, 200, "2027-07-01", {
      regime: "auto_by_date",
      annualInflationRate: infl,
    });
    // Old lot: $100 indexed ~7.5y at 10% ≈ $204 → slight loss at $200 proceeds
    // New lot: $180 indexed 1y at 10% ≈ $198 → small gain
    expect(oldScore).toBeLessThan(newScore);
  });
});

describe("min_cgt vs FIFO matching on a historical sell", () => {
  const ledger: ParsedTransaction[] = [
    tx({
      date: "2020-01-01",
      ticker: "VAS",
      type: "buy",
      quantity: 10,
      amount: 1000, // $100/unit — large unrealised gain
    }),
    tx({
      date: "2021-01-01",
      ticker: "VAS",
      type: "buy",
      quantity: 10,
      amount: 1800, // $180/unit — smaller gain
    }),
    tx({
      date: "2024-01-01",
      ticker: "VAS",
      type: "sell",
      quantity: 5,
      amount: 1000, // $200/unit
    }),
  ];

  it("FIFO consumes the oldest (cheapest) lot", () => {
    const { disposals } = computeLots(ledger, {});
    expect(disposals).toHaveLength(1);
    expect(disposals[0].acquiredDate).toBe("2020-01-01");
    expect(disposals[0].costBaseAud).toBeCloseTo(500);
  });

  it("min_cgt consumes the higher-cost lot (smaller taxable gain)", () => {
    const { disposals } = computeLots(ledger, {}, {
      orderLotsForSale: orderFnForMatching("min_cgt", {
        regime: "auto_by_date",
      }),
    });
    expect(disposals).toHaveLength(1);
    expect(disposals[0].acquiredDate).toBe("2021-01-01");
    expect(disposals[0].costBaseAud).toBeCloseTo(900); // 5 × $180
  });

  it("fy estimate CGT tax is lower under min_cgt than FIFO", () => {
    const fifo = estimateFyTax(ledger, {}, {
      profile,
      cgtRegime: "auto_by_date",
      lotMatching: "fifo",
    });
    const min = estimateFyTax(ledger, {}, {
      profile,
      cgtRegime: "auto_by_date",
      lotMatching: "min_cgt",
    });
    const fifoFy = fifo.byFy.find((r) => r.financialYear === "FY2024")!;
    const minFy = min.byFy.find((r) => r.financialYear === "FY2024")!;
    // FIFO: gain 5*(200-100)=500, 50% disc → taxable 250, tax 97.5
    // min_cgt: gain 5*(200-180)=100, 50% disc → taxable 50, tax 19.5
    expect(fifoFy.cgtTax).toBeCloseTo(97.5);
    expect(minFy.cgtTax).toBeCloseTo(19.5);
    expect(minFy.cgtTax).toBeLessThan(fifoFy.cgtTax);
  });
});

describe("estimateHypotheticalSale", () => {
  const openLots = [
    {
      ticker: "VAS",
      exchange: "ASX",
      currency: "AUD",
      acquiredDate: "2020-01-01",
      originalQuantity: 10,
      quantity: 10,
      costBaseAud: 1000,
    },
    {
      ticker: "VAS",
      exchange: "ASX",
      currency: "AUD",
      acquiredDate: "2021-01-01",
      originalQuantity: 10,
      quantity: 10,
      costBaseAud: 1800,
    },
  ];

  it("FIFO sells the 2020 lot; min_cgt sells the 2021 lot", () => {
    const fifo = estimateHypotheticalSale({
      openLots,
      quantity: 5,
      proceedsPerUnitAud: 200,
      disposedDate: "2024-06-01",
      matching: "fifo",
      regime: "auto_by_date",
      profile,
    });
    const min = estimateHypotheticalSale({
      openLots,
      quantity: 5,
      proceedsPerUnitAud: 200,
      disposedDate: "2024-06-01",
      matching: "min_cgt",
      regime: "auto_by_date",
      profile,
    });

    expect(fifo.parcels[0].acquiredDate).toBe("2020-01-01");
    expect(min.parcels[0].acquiredDate).toBe("2021-01-01");
    expect(min.tax).toBeLessThan(fifo.tax);
    expect(fifo.comparison.min_cgt.tax).toBeCloseTo(min.tax);
    expect(min.comparison.fifo.tax).toBeCloseTo(fifo.tax);
  });

  it("prefers a loss-making parcel over a discounted gain", () => {
    const lots = [
      {
        ticker: "VAS",
        exchange: "ASX",
        currency: "AUD",
        acquiredDate: "2020-01-01",
        originalQuantity: 10,
        quantity: 10,
        costBaseAud: 500, // big gain at $150
      },
      {
        ticker: "VAS",
        exchange: "ASX",
        currency: "AUD",
        acquiredDate: "2021-01-01",
        originalQuantity: 10,
        quantity: 10,
        costBaseAud: 2000, // loss at $150
      },
    ];
    const r = estimateHypotheticalSale({
      openLots: lots,
      quantity: 5,
      proceedsPerUnitAud: 150,
      disposedDate: "2024-06-01",
      matching: "min_cgt",
      regime: "auto_by_date",
      profile,
    });
    expect(r.parcels[0].acquiredDate).toBe("2021-01-01");
    expect(r.tax).toBe(0);
    expect(r.capitalGain).toBeLessThan(0);
  });

  it("post-2027 min_cgt can pick a newer lot when indexation shrinks the older lot's gain less than the newer lot's higher cost", () => {
    // Cheap old lot vs expensive recent lot, sold after the cutover.
    // At 0% inflation the old lot has a much larger gain, so min_cgt
    // still prefers the new lot — same as pre-2027, just without discount.
    const r = estimateHypotheticalSale({
      openLots,
      quantity: 5,
      proceedsPerUnitAud: 200,
      disposedDate: "2027-07-01",
      matching: "min_cgt",
      regime: "auto_by_date",
      profile,
      annualInflationRate: 0,
    });
    expect(r.appliedRegime).toBe("indexation_min30");
    expect(r.parcels[0].acquiredDate).toBe("2021-01-01");
    // gain 5*(200-180)=100, no discount, rate 39% → 39
    expect(r.tax).toBeCloseTo(39);
    expect(r.comparison.fifo.tax).toBeGreaterThan(r.tax);
  });

  it("reports unmatched quantity when asking to sell more than is held", () => {
    const r = estimateHypotheticalSale({
      openLots,
      quantity: 25,
      proceedsPerUnitAud: 200,
      disposedDate: "2024-06-01",
      matching: "fifo",
      regime: "auto_by_date",
      profile,
    });
    expect(r.quantitySold).toBeCloseTo(20);
    expect(r.unmatchedQuantity).toBeCloseTo(5);
  });

  it("does not mutate the caller's open lots", () => {
    const before = openLots.map((l) => l.quantity);
    estimateHypotheticalSale({
      openLots,
      quantity: 5,
      proceedsPerUnitAud: 200,
      disposedDate: "2024-06-01",
      matching: "fifo",
      regime: "auto_by_date",
      profile,
    });
    expect(openLots.map((l) => l.quantity)).toEqual(before);
  });
});
