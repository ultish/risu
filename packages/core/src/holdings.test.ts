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

describe("computeHoldings excludes transfer_in/transfer_out", () => {
  // transfer_in/transfer_out are shown in the transaction log but never
  // counted toward holdings, full stop — regardless of whether a matching
  // buy/sell exists elsewhere. Real bug this replaced: issuer registry PDFs
  // (Computershare, Link/MUFG) and SelfWealth HIN-conversion rows alike
  // report transfer_in with no idea whether the same event was already
  // recorded elsewhere (a broker CSV import, or a pre-existing manual entry)
  // — since transfer_in never carries a real price/cost either way, blanket
  // exclusion is simpler and safer than trying to detect duplicates.
  it("excludes a transfer_in even when nothing else records the same units", () => {
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
    expect(holdings.find((h) => h.ticker === "VAS")).toBeUndefined();
  });

  it("excludes transfer_in even when a matching buy also exists (no double count)", () => {
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

  it("excludes transfer_out from reducing quantity (only a real sell reduces it)", () => {
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
    // transfer_out is a no-op for holdings — only the real sell's 5 units come off
    expect(bhp.quantity).toBeCloseTo(15, 6);
  });
});

describe("computeHoldings AUD cost base uses per-transaction historical FX", () => {
  it("sums each buy's own historical rate instead of converting the blended total at today's rate", () => {
    // Real bug report: TSLA bought in 2018 (AUDUSD ~0.746) and 2025
    // (AUDUSD ~0.653) — converting the summed USD total at only today's
    // rate misrepresents years of AUDUSD movement as if every buy happened
    // today. Each buy should convert at its own date's rate instead.
    const holdings = computeHoldings(
      [
        tx({
          date: "2018-05-09",
          ticker: "TSLA",
          type: "buy",
          quantity: 2,
          amount: 600,
          currency: "USD",
          fxRateToAud: 0.746, // 600 / 0.746 = 804.29 AUD
        }),
        tx({
          date: "2025-06-10",
          ticker: "TSLA",
          type: "buy",
          quantity: 1,
          amount: 300,
          currency: "USD",
          fxRateToAud: 0.653, // 300 / 0.653 = 459.42 AUD
        }),
      ],
      { prices: {}, fxRates: { "AUDUSD=X": 0.6979 } }, // today's rate — must NOT be used here
    );
    const tsla = holdings.find((h) => h.ticker === "TSLA")!;
    expect(tsla.costBaseAud).toBeCloseTo(600 / 0.746 + 300 / 0.653, 2);
    // Sanity: NOT the same as converting the 900 USD total at today's rate
    expect(tsla.costBaseAud).not.toBeCloseTo(900 / 0.6979, 2);
  });

  it("falls back to today's fxRates for a buy that has no historical rate recorded", () => {
    const holdings = computeHoldings(
      [
        tx({
          date: "2024-01-01",
          ticker: "AAPL",
          type: "buy",
          quantity: 1,
          amount: 200,
          currency: "USD",
          // fxRateToAud omitted — e.g. imported before this feature existed
        }),
      ],
      { prices: {}, fxRates: { "AUDUSD=X": 0.65 } },
    );
    const aapl = holdings.find((h) => h.ticker === "AAPL")!;
    expect(aapl.costBaseAud).toBeCloseTo(200 / 0.65, 2);
  });

  it("reduces the AUD cost base proportionally on a sell, same as the native cost base", () => {
    const holdings = computeHoldings([
      tx({
        date: "2020-01-01",
        ticker: "MSFT",
        type: "buy",
        quantity: 10,
        amount: 2000,
        currency: "USD",
        fxRateToAud: 0.7, // 2000 / 0.7 = 2857.14 AUD for 10 units
      }),
      tx({
        date: "2024-01-01",
        ticker: "MSFT",
        type: "sell",
        quantity: 4,
        amount: 1000,
        currency: "USD",
        fxRateToAud: 0.65, // sell-side rate irrelevant to remaining cost base (avg-cost method)
      }),
    ]);
    const msft = holdings.find((h) => h.ticker === "MSFT")!;
    // avg AUD cost/unit = 285.714; 6 units remain
    expect(msft.costBaseAud).toBeCloseTo((2000 / 0.7 / 10) * 6, 2);
  });

  it("is unaffected for AUD-native holdings regardless of fxRateToAud", () => {
    const holdings = computeHoldings([
      tx({
        date: "2024-01-01",
        ticker: "VAS",
        exchange: "ASX",
        type: "buy",
        quantity: 5,
        amount: 500,
        currency: "AUD",
        fxRateToAud: 0.7, // should be ignored — already AUD
      }),
    ]);
    const vas = holdings.find((h) => h.ticker === "VAS")!;
    expect(vas.costBaseAud).toBeCloseTo(500, 2);
    expect(vas.costBaseAud).toBeCloseTo(vas.costBase, 6);
  });
});
