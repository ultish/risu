import { describe, expect, it } from "vitest";
import { summarizeDividendIncome } from "./income.js";
import type { ParsedTransaction } from "./types.js";

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

describe("summarizeDividendIncome", () => {
  it("includes DRP-only rows as assessable income", () => {
    const summary = summarizeDividendIncome([
      tx({
        date: "2021-06-01",
        ticker: "VAS",
        type: "drp",
        quantity: 1.85,
        price: 88.4,
        amount: 163.54,
      }),
    ]);
    expect(summary.grandTotalAud).toBe(163.54);
    expect(summary.byFy[0]!.drpCount).toBe(1);
    expect(summary.byFy[0]!.cashCount).toBe(0);
    expect(summary.fyTotals[0]!.financialYear).toBe("FY2021");
  });

  it("does not double-count DRP when matching cash dividend exists", () => {
    const summary = summarizeDividendIncome([
      tx({
        date: "2024-09-15",
        ticker: "VAS",
        type: "dividend_cash",
        amount: 100,
      }),
      tx({
        date: "2024-09-16",
        ticker: "VAS",
        type: "drp",
        quantity: 1,
        price: 100,
        amount: 100,
      }),
    ]);
    expect(summary.grandTotalAud).toBe(100);
    expect(summary.byFy[0]!.cashCount).toBe(1);
    expect(summary.byFy[0]!.drpCount).toBe(0);
  });

  it("counts both cash and DRP when amounts differ (partial reinvest)", () => {
    const summary = summarizeDividendIncome([
      tx({
        date: "2024-09-15",
        ticker: "VAS",
        type: "dividend_cash",
        amount: 30,
      }),
      tx({
        date: "2024-09-15",
        ticker: "VAS",
        type: "drp",
        quantity: 0.7,
        price: 100,
        amount: 70,
      }),
    ]);
    expect(summary.grandTotalAud).toBe(100);
    expect(summary.byFy[0]!.cashCount).toBe(1);
    expect(summary.byFy[0]!.drpCount).toBe(1);
  });

  it("still counts pure cash dividends", () => {
    const summary = summarizeDividendIncome([
      tx({
        date: "2024-08-01",
        ticker: "A200",
        type: "dividend_cash",
        amount: 50,
      }),
    ]);
    expect(summary.grandTotalAud).toBe(50);
    expect(summary.byFy[0]!.cashCount).toBe(1);
  });

  it("converts foreign DRP with FX map", () => {
    // AUDUSD=X = USD per 1 AUD → AUD = USD / rate
    const summary = summarizeDividendIncome(
      [
        tx({
          date: "2023-03-20",
          ticker: "AAPL",
          exchange: "US",
          currency: "USD",
          type: "drp",
          quantity: 0.5,
          price: 160,
          amount: 80,
        }),
      ],
      { "AUDUSD=X": 0.65 },
    );
    expect(summary.grandTotalAud).toBeCloseTo(80 / 0.65, 2);
    expect(summary.missingFx).toEqual([]);
  });
});
