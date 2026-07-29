import { describe, expect, it } from "vitest";
import { computeHoldings } from "./holdings.js";
import type { ParsedTransaction } from "./types.js";

function tx(
  partial: Partial<ParsedTransaction> &
    Pick<ParsedTransaction, "date" | "ticker" | "type">,
): ParsedTransaction {
  return {
    exchange: "US",
    quantity: 0,
    price: null,
    amount: null,
    brokerage: 0,
    currency: "USD",
    externalId: null,
    notes: null,
    ...partial,
  };
}

describe("computeHoldings currency handling", () => {
  it("normalises a mismatched-currency buy to the exchange's canonical currency instead of blending raw dollars", () => {
    // Same scenario as the real bug report: a US-exchange ticker with one
    // buy recorded in AUD (e.g. Sharesight's paste storing an already-FX-
    // converted figure) and one in native USD (e.g. Stake). Without
    // conversion, summing 805.61 AUD + 312.68 USD as if both were the same
    // unit produces a meaningless "avg cost".
    const fxRates = { "AUDUSD=X": 0.65 }; // USD per 1 AUD
    const holdings = computeHoldings(
      [
        tx({
          date: "2018-05-09",
          ticker: "TSLA",
          type: "buy",
          quantity: 2,
          amount: 100,
          currency: "AUD",
        }),
        tx({
          date: "2025-06-10",
          ticker: "TSLA",
          type: "buy",
          quantity: 1,
          amount: 300,
          currency: "USD",
        }),
      ],
      { prices: {}, fxRates },
    );

    const tsla = holdings.find((h) => h.ticker === "TSLA")!;
    expect(tsla.currency).toBe("USD");
    // 100 AUD -> 65 USD (at 0.65 USD per AUD) + 300 USD = 365 USD cost base,
    // NOT 100 + 300 = 400 treated as one currency.
    expect(tsla.costBase).toBeCloseTo(65 + 300, 2);
    expect(tsla.quantity).toBeCloseTo(3, 6);
    expect(tsla.avgCost).toBeCloseTo((65 + 300) / 3, 2);
  });

  it("always reports the exchange-canonical currency, not whichever transaction came first", () => {
    // Same bug, but with the mismatched (AUD-labelled) row dated *after* the
    // native-currency one — the old "prefer first non-empty currency" logic
    // would have locked onto USD here anyway; this just confirms currency is
    // now derived from exchange, not transaction order, either way.
    const holdings = computeHoldings(
      [
        tx({
          date: "2025-06-10",
          ticker: "TSLA",
          type: "buy",
          quantity: 1,
          amount: 300,
          currency: "USD",
        }),
        tx({
          date: "2018-05-09",
          ticker: "TSLA",
          type: "buy",
          quantity: 2,
          amount: 100,
          currency: "AUD",
        }),
      ],
      { prices: {}, fxRates: { "AUDUSD=X": 0.65 } },
    );
    expect(holdings.find((h) => h.ticker === "TSLA")!.currency).toBe("USD");
  });

  it("still computes a plain single-currency holding correctly (no regression)", () => {
    const holdings = computeHoldings([
      tx({
        date: "2024-01-01",
        ticker: "AAPL",
        type: "buy",
        quantity: 10,
        amount: 1500,
        currency: "USD",
      }),
      tx({
        date: "2024-06-01",
        ticker: "AAPL",
        type: "sell",
        quantity: 4,
        amount: 700,
        currency: "USD",
      }),
    ]);
    const aapl = holdings.find((h) => h.ticker === "AAPL")!;
    expect(aapl.currency).toBe("USD");
    expect(aapl.quantity).toBeCloseTo(6, 6);
    // avg cost 150/unit * remaining 6 units
    expect(aapl.costBase).toBeCloseTo(900, 2);
  });

  it("falls back to the unconverted amount when no FX rate is available, rather than dropping the cost", () => {
    const holdings = computeHoldings(
      [
        tx({
          date: "2018-05-09",
          ticker: "TSLA",
          type: "buy",
          quantity: 2,
          amount: 100,
          currency: "AUD",
        }),
      ],
      { prices: {} }, // no fxRates at all
    );
    const tsla = holdings.find((h) => h.ticker === "TSLA")!;
    // Can't convert without a rate — falls back to the raw (unconverted)
    // amount rather than silently zeroing it out.
    expect(tsla.costBase).toBeCloseTo(100, 2);
  });
});

describe("computeHoldings transfer_in/out duplicate detection", () => {
  // Real bug: issuer registry annual statements (Computershare, Link/MUFG)
  // report every CHESS settlement as transfer_in/out with no idea the same
  // settlement was already imported as a buy/sell from the broker CSV —
  // doubling the holding. Settlement lands ~T+2 after the trade.
  it("drops a transfer_in that exactly matches a single nearby buy", () => {
    const holdings = computeHoldings([
      tx({
        date: "2023-12-12",
        ticker: "NDQ",
        exchange: "ASX",
        type: "buy",
        quantity: 5,
        amount: 189.38,
        currency: "AUD",
      }),
      tx({
        date: "2023-12-14",
        ticker: "NDQ",
        exchange: "ASX",
        type: "transfer_in",
        quantity: 5,
        currency: "AUD",
      }),
    ]);
    const ndq = holdings.find((h) => h.ticker === "NDQ")!;
    expect(ndq.quantity).toBeCloseTo(5, 6);
    expect(ndq.costBase).toBeCloseTo(189.38, 2);
  });

  it("drops a transfer_in that exactly matches the SUM of nearby buys (split across broker orders)", () => {
    const holdings = computeHoldings([
      tx({
        date: "2023-12-11",
        ticker: "IOZ",
        exchange: "ASX",
        type: "buy",
        quantity: 6,
        amount: 176.75,
        currency: "AUD",
      }),
      tx({
        date: "2023-12-11",
        ticker: "IOZ",
        exchange: "ASX",
        type: "buy",
        quantity: 2,
        amount: 60.2,
        currency: "AUD",
      }),
      tx({
        date: "2023-12-13",
        ticker: "IOZ",
        exchange: "ASX",
        type: "transfer_in",
        quantity: 8,
        currency: "AUD",
      }),
    ]);
    const ioz = holdings.find((h) => h.ticker === "IOZ")!;
    expect(ioz.quantity).toBeCloseTo(8, 6);
    expect(ioz.costBase).toBeCloseTo(176.75 + 60.2, 2);
  });

  it("keeps a transfer_in with no matching nearby buy (genuine external transfer / opening balance)", () => {
    const holdings = computeHoldings([
      tx({
        date: "2020-01-01",
        ticker: "VAS",
        exchange: "ASX",
        type: "transfer_in",
        quantity: 50,
        currency: "AUD",
      }),
    ]);
    const vas = holdings.find((h) => h.ticker === "VAS")!;
    expect(vas.quantity).toBeCloseTo(50, 6);
  });

  it("keeps a transfer_in outside the settlement window even if quantity matches", () => {
    const holdings = computeHoldings([
      tx({
        date: "2023-01-01",
        ticker: "VGS",
        exchange: "ASX",
        type: "buy",
        quantity: 10,
        amount: 500,
        currency: "AUD",
      }),
      tx({
        date: "2023-06-01", // months later, not a settlement of the January buy
        ticker: "VGS",
        exchange: "ASX",
        type: "transfer_in",
        quantity: 10,
        currency: "AUD",
      }),
    ]);
    const vgs = holdings.find((h) => h.ticker === "VGS")!;
    // Both counted: 10 (buy) + 10 (unexplained transfer) = 20
    expect(vgs.quantity).toBeCloseTo(20, 6);
  });

  it("drops a transfer_out that exactly matches a nearby sell (symmetric case)", () => {
    const holdings = computeHoldings([
      tx({
        date: "2024-01-01",
        ticker: "BHP",
        exchange: "ASX",
        type: "buy",
        quantity: 20,
        amount: 800,
        currency: "AUD",
      }),
      tx({
        date: "2024-06-01",
        ticker: "BHP",
        exchange: "ASX",
        type: "sell",
        quantity: 5,
        amount: 250,
        currency: "AUD",
      }),
      tx({
        date: "2024-06-03",
        ticker: "BHP",
        exchange: "ASX",
        type: "transfer_out",
        quantity: 5,
        currency: "AUD",
      }),
    ]);
    const bhp = holdings.find((h) => h.ticker === "BHP")!;
    // Only the real sell's 5 units come off — the duplicate transfer_out is dropped
    expect(bhp.quantity).toBeCloseTo(15, 6);
  });
});
