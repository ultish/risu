import { describe, expect, it } from "vitest";
import type { ParsedTransaction } from "../types.js";
import { estimateFyTax } from "./fyEstimate.js";
import type { TaxProfile } from "./types.js";

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

const profile: TaxProfile = {
  label: "Test",
  marginalRate: 0.37,
  medicareLevy: 0.02,
}; // combined 0.39

describe("estimateFyTax", () => {
  it("combines dividend tax and realised CGT into one FY total", () => {
    const transactions: ParsedTransaction[] = [
      tx({
        date: "2020-01-01",
        ticker: "VAS",
        type: "buy",
        quantity: 10,
        amount: 1000, // $100/unit
      }),
      tx({
        date: "2024-08-01",
        ticker: "VAS",
        type: "dividend_cash",
        quantity: 0,
        amount: 1000,
      }),
      tx({
        date: "2024-09-01", // FY2025, pre-cutover -> discount_50, held > 365 days
        ticker: "VAS",
        type: "sell",
        quantity: 4,
        amount: 800, // $200/unit; cost $100/unit -> gain 400, taxable 200 (50% discount)
      }),
    ];

    const report = estimateFyTax(transactions, {}, {
      profile,
      cgtRegime: "auto_by_date",
    });

    const fy2025 = report.byFy.find((r) => r.financialYear === "FY2025");
    expect(fy2025).toBeDefined();
    // Dividend: cash 1000, 70% franked -> credits 300, assessable 1300,
    // gross tax 1300*0.39=507, net tax 507-300=207
    expect(fy2025?.dividendNetTax).toBeCloseTo(207);
    // CGT: gain 400, 50% discount -> taxable 200, tax 200*0.39=78
    expect(fy2025?.cgtTax).toBeCloseTo(78);
    expect(fy2025?.netCapitalGain).toBeCloseTo(400);
    expect(fy2025?.totalTax).toBeCloseTo(207 + 78);

    // dividendEvents gives the line-level detail behind dividendNetTax.
    expect(report.dividendEvents).toHaveLength(1);
    expect(report.dividendEvents[0]).toMatchObject({
      financialYear: "FY2025",
      ticker: "VAS",
      amount: 1000,
      source: "cash",
    });
  });

  it("nets a same-FY capital loss against a gain rather than taxing the gain in full", () => {
    // Two tickers sold in the same FY: one for a gain, one for a loss of
    // equal size. Total tax should reflect the net position ($0 CGT), not
    // full tax on the gain plus a no-op $0 on the loss.
    const transactions: ParsedTransaction[] = [
      tx({ date: "2020-01-01", ticker: "WIN", type: "buy", quantity: 10, amount: 1000 }),
      tx({ date: "2020-01-01", ticker: "LOSE", type: "buy", quantity: 10, amount: 1000 }),
      tx({
        date: "2024-09-01", // FY2025
        ticker: "WIN",
        type: "sell",
        quantity: 10,
        amount: 1500, // +500 gain
      }),
      tx({
        date: "2024-10-01", // FY2025
        ticker: "LOSE",
        type: "sell",
        quantity: 10,
        amount: 500, // -500 loss
      }),
    ];

    const report = estimateFyTax(transactions, {}, {
      profile,
      cgtRegime: "auto_by_date",
    });

    const fy2025 = report.byFy.find((r) => r.financialYear === "FY2025");
    expect(fy2025?.netCapitalGain).toBeCloseTo(0);
    expect(fy2025?.cgtTax).toBe(0);
    expect(fy2025?.totalTax).toBe(0);
  });

  it("carries a capital loss forward to reduce a later FY's CGT tax", () => {
    const transactions: ParsedTransaction[] = [
      tx({ date: "2020-01-01", ticker: "LOSS", type: "buy", quantity: 10, amount: 3000 }),
      tx({ date: "2020-01-01", ticker: "GAIN", type: "buy", quantity: 10, amount: 1000 }),
      tx({
        date: "2025-03-01", // FY2025 -- pure loss, nothing to offset it
        ticker: "LOSS",
        type: "sell",
        quantity: 10,
        amount: 1000, // proceeds 1000, cost 3000 -> -2000
      }),
      tx({
        date: "2026-09-01", // FY2027 -- gain that should absorb the FY2025 loss
        ticker: "GAIN",
        type: "sell",
        quantity: 10,
        amount: 3000, // proceeds 3000, cost 1000 -> +2000
      }),
    ];

    const report = estimateFyTax(transactions, {}, { profile, cgtRegime: "auto_by_date" });

    const fy2025 = report.byFy.find((r) => r.financialYear === "FY2025")!;
    expect(fy2025.cgtTax).toBe(0);
    expect(fy2025.lossCarriedForward).toBeCloseTo(2000);

    const fy2027 = report.byFy.find((r) => r.financialYear === "FY2027")!;
    expect(fy2027.priorLossApplied).toBeCloseTo(2000);
    expect(fy2027.cgtTax).toBe(0); // fully absorbed by the FY2025 loss
    expect(fy2027.lossCarriedForward).toBe(0);
  });

  it("returns an empty report for a ledger with no dividends or sells", () => {
    const report = estimateFyTax(
      [
        tx({
          date: "2020-01-01",
          ticker: "VAS",
          type: "buy",
          quantity: 10,
          amount: 1000,
        }),
      ],
      {},
      { profile, cgtRegime: "auto_by_date" },
    );
    expect(report.byFy).toHaveLength(0);
  });
});
