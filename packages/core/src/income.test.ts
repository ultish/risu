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

  it("explains a pooled multi-period DRP via that instrument's own earlier cash dividends", () => {
    // Computershare-style: three periods' distributions (each its own
    // dividend_cash row) accumulate as DRP residual until the third period
    // also buys a whole unit — the drp amount (21.00) is fully covered by
    // the pool built from the three cash rows (35.73+21.50+21.00=78.23), so
    // it should contribute nothing extra to income.
    const summary = summarizeDividendIncome([
      tx({ date: "2023-07-18", ticker: "VGS", type: "dividend_cash", amount: 35.73 }),
      tx({ date: "2023-10-17", ticker: "VGS", type: "dividend_cash", amount: 21.5 }),
      tx({ date: "2024-01-17", ticker: "VGS", type: "dividend_cash", amount: 21.0 }),
      tx({
        date: "2024-01-17",
        ticker: "VGS",
        type: "drp",
        quantity: 1,
        price: 21.0,
        amount: 21.0,
      }),
    ]);
    expect(summary.grandTotalAud).toBe(78.23);
    const fy2024 = summary.byFy.find((l) => l.financialYear === "FY2024")!;
    expect(fy2024.cashCount).toBe(3);
    expect(fy2024.drpCount).toBe(0);
  });

  it("counts only the shortfall when a pooled DRP exceeds the instrument's recorded cash-dividend history", () => {
    // Same shape, but the DRP (113.19) draws on more than the two recorded
    // cash rows (35.73+21.50=57.23) can explain — e.g. residual carried in
    // from an earlier, un-imported statement year. Only the unexplained
    // remainder (55.96) should count as extra DRP income.
    const summary = summarizeDividendIncome([
      tx({ date: "2023-07-18", ticker: "VGS", type: "dividend_cash", amount: 35.73 }),
      tx({ date: "2023-10-17", ticker: "VGS", type: "dividend_cash", amount: 21.5 }),
      tx({
        date: "2024-01-17",
        ticker: "VGS",
        type: "drp",
        quantity: 1,
        price: 113.19,
        amount: 113.19,
      }),
    ]);
    expect(summary.grandTotalAud).toBeCloseTo(35.73 + 21.5 + 55.96, 2);
    const fy2024 = summary.byFy.find((l) => l.financialYear === "FY2024")!;
    expect(fy2024.drpCount).toBe(1);
  });

  it("does not let a later cash dividend fund an earlier pooled DRP", () => {
    // The DRP happens before the third cash dividend is even paid — that
    // later distribution can't retroactively explain an earlier purchase.
    const summary = summarizeDividendIncome([
      tx({ date: "2023-07-18", ticker: "VGS", type: "dividend_cash", amount: 20 }),
      tx({ date: "2023-10-17", ticker: "VGS", type: "dividend_cash", amount: 20 }),
      tx({
        date: "2023-11-01",
        ticker: "VGS",
        type: "drp",
        quantity: 1,
        price: 50,
        amount: 50,
      }),
      tx({ date: "2024-04-17", ticker: "VGS", type: "dividend_cash", amount: 20 }),
    ]);
    // Pool available as of 2023-11-01 is only 40 (the third cash dividend,
    // paid 2024-04-17, is not yet available) — shortfall = 50-40 = 10.
    expect(summary.grandTotalAud).toBeCloseTo(20 + 20 + 10 + 20, 2);
  });

  it("still counts both in full for a single cash/DRP pair with unrelated amounts (no pooling evidence)", () => {
    // Only one dividend_cash row exists for this instrument — below the 2+
    // threshold for pooling, so this falls through to the same "count both"
    // behaviour as the existing partial-reinvest test, just on a different
    // ticker to isolate it from the pooling tests above.
    const summary = summarizeDividendIncome([
      tx({ date: "2024-02-01", ticker: "IOZ", type: "dividend_cash", amount: 10 }),
      tx({
        date: "2024-02-01",
        ticker: "IOZ",
        type: "drp",
        quantity: 1,
        price: 90,
        amount: 90,
      }),
    ]);
    expect(summary.grandTotalAud).toBe(100);
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
