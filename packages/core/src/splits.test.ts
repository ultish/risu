import { describe, expect, it } from "vitest";
import { computeHoldings } from "./holdings.js";
import {
  inferSplitEvents,
  splitFactorAfter,
  valuationQuantity,
} from "./splits.js";
import type { ParsedTransaction } from "./types.js";

function tx(
  partial: Partial<ParsedTransaction> &
    Pick<ParsedTransaction, "date" | "type" | "ticker" | "quantity">,
): ParsedTransaction {
  return {
    exchange: "US",
    currency: "AUD",
    price: null,
    amount: null,
    brokerage: 0,
    notes: null,
    externalId: null,
    ...partial,
  };
}

/** Mirrors real Sharesight TSLA book (qtys/split deltas from DB). */
const tslaBook: ParsedTransaction[] = [
  tx({ date: "2018-05-09", type: "buy", ticker: "TSLA", quantity: 0.4739, amount: 190.89 }),
  tx({ date: "2018-05-09", type: "buy", ticker: "TSLA", quantity: 2.0, amount: 805.61 }),
  tx({ date: "2018-05-18", type: "buy", ticker: "TSLA", quantity: 0.621, amount: 233.41 }),
  tx({ date: "2018-05-18", type: "buy", ticker: "TSLA", quantity: 2.0, amount: 751.71 }),
  tx({ date: "2018-06-28", type: "buy", ticker: "TSLA", quantity: 0.1103, amount: 52.34 }),
  tx({ date: "2018-06-28", type: "buy", ticker: "TSLA", quantity: 2.0, amount: 949.03 }),
  tx({ date: "2018-08-08", type: "buy", ticker: "TSLA", quantity: 0.9909, amount: 492.13 }),
  tx({ date: "2018-08-08", type: "buy", ticker: "TSLA", quantity: 1.0, amount: 496.65 }),
  // 9.1961 before 5-for-1
  tx({ date: "2020-08-30", type: "split", ticker: "TSLA", quantity: 36.7844 }),
  tx({
    date: "2020-12-17",
    type: "sell",
    ticker: "TSLA",
    quantity: 10.9805,
    amount: 9352.01,
  }),
  // 35 before 3-for-1
  tx({ date: "2022-08-25", type: "split", ticker: "TSLA", quantity: 70 }),
];

describe("inferSplitEvents / splitFactorAfter", () => {
  it("infers 5-for-1 then 3-for-1 from Sharesight deltas", () => {
    const events = inferSplitEvents(tslaBook);
    expect(events).toHaveLength(2);
    expect(events[0]!.date).toBe("2020-08-30");
    expect(events[0]!.ratio).toBeCloseTo(5, 5);
    expect(events[1]!.date).toBe("2022-08-25");
    expect(events[1]!.ratio).toBeCloseTo(3, 5);
  });

  it("future factor is 15 before first split, 3 between, 1 after", () => {
    const events = inferSplitEvents(tslaBook);
    const key = "US:TSLA";
    expect(splitFactorAfter("2018-05-31", key, events)).toBeCloseTo(15, 5);
    // on split date: ledger already has that split; only later ratios count
    expect(splitFactorAfter("2020-08-30", key, events)).toBeCloseTo(3, 5);
    expect(splitFactorAfter("2021-06-30", key, events)).toBeCloseTo(3, 5);
    expect(splitFactorAfter("2022-08-25", key, events)).toBeCloseTo(1, 5);
    expect(splitFactorAfter("2026-07-27", key, events)).toBe(1);
  });

  it("valuationQuantity scales pre-split qty for adj prices", () => {
    const events = inferSplitEvents(tslaBook);
    const raw = 5.0949; // qty after May 2018 buys only
    expect(
      valuationQuantity(raw, "2018-05-31", "US:TSLA", events),
    ).toBeCloseTo(raw * 15, 4);
  });
});

describe("computeHoldings split-adjusted MTM", () => {
  it("values pre-split book with adj close near cost, not 1/15th", () => {
    const buys = tslaBook.filter((t) => t.date <= "2018-05-31");
    const events = inferSplitEvents(tslaBook);
    const adjClose = 18.982;
    const fx = 0.759;

    const wrong = computeHoldings(buys, {
      prices: { "US:TSLA": adjClose },
      fxRates: { "AUDUSD=X": fx },
    });
    expect(wrong[0]!.marketValue).toBeLessThan(200);

    const right = computeHoldings(buys, {
      prices: { "US:TSLA": adjClose },
      fxRates: { "AUDUSD=X": fx },
      valuationAsOf: "2018-05-31",
      splitEvents: events,
    });
    expect(right[0]!.quantity).toBeCloseTo(5.0949, 4);
    expect(right[0]!.costBaseAud).toBeCloseTo(1981.62, 0);
    expect(right[0]!.marketValue).toBeGreaterThan(1400);
    expect(right[0]!.marketValueAud).toBeGreaterThan(1800);
    expect(right[0]!.marketValueAud).toBeLessThan(3000);
  });
});
