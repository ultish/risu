import { describe, expect, it } from "vitest";
import { combineValuations, valuationAsOf, valuationReportToCsv } from "./valuation.js";
import type { ParsedTransaction } from "./types.js";

let nextId = 1;
function tx(
  partial: Partial<ParsedTransaction> &
    Pick<ParsedTransaction, "date" | "ticker" | "type">,
): ParsedTransaction {
  return {
    id: nextId++,
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

const vas = {
  "VAS.AX": [
    { date: "2027-06-28", close: 100 },
    { date: "2027-06-30", close: 105 },
    { date: "2027-07-02", close: 110 },
  ],
};

describe("valuationAsOf", () => {
  it("values each broker's holding from its own parcels, at the last close on or before the date", () => {
    const r = valuationAsOf(
      [
        tx({ date: "2026-01-10", ticker: "VAS", type: "buy", quantity: 10, price: 80, broker: "commsec" }),
        tx({ date: "2026-05-10", ticker: "VAS", type: "buy", quantity: 5, price: 90, broker: "stake" }),
        // A sell at CommSec must not eat Stake's parcel.
        tx({ date: "2027-03-01", ticker: "VAS", type: "sell", quantity: 4, price: 95, broker: "commsec" }),
      ],
      { asOf: "2027-06-30", priceSeries: vas },
    );
    expect(r.brokers.map((b) => b.broker)).toEqual(["commsec", "stake"]);
    const commsec = r.brokers[0]!.lines[0]!;
    expect(commsec.quantity).toBe(6);
    expect(commsec.costBaseAud).toBe(480);
    expect(commsec.marketValueAud).toBe(630);
    expect(commsec.priceDate).toBe("2027-06-30");
    expect(commsec.flags).toEqual([]);
    expect(commsec.parcels).toEqual([
      { acquiredDate: "2026-01-10", quantity: 6, costBaseAud: 480, marketValueAud: 630 },
    ]);
    expect(r.brokers[1]!.lines[0]!.marketValueAud).toBe(525);
    expect(r.marketValueAud).toBe(1_155);
    expect(r.costBaseAud).toBe(930);
  });

  it("applies a split with no broker to every broker holding the stock, pro rata", () => {
    const r = valuationAsOf(
      [
        tx({ date: "2026-01-10", ticker: "VAS", type: "buy", quantity: 30, price: 80, broker: "commsec" }),
        tx({ date: "2026-02-10", ticker: "VAS", type: "buy", quantity: 10, price: 80, broker: "stake" }),
        // A 1-for-4 consolidation entered by hand: 40 units become 10.
        tx({ date: "2026-06-01", ticker: "VAS", type: "split", quantity: -30 }),
      ],
      { asOf: "2027-06-30", priceSeries: vas },
    );
    expect(r.brokers.map((b) => [b.broker, b.lines[0]!.quantity])).toEqual([
      ["commsec", 7.5],
      ["stake", 2.5],
    ]);
    // Cost base doesn't change on a split.
    expect(r.brokers[0]!.lines[0]!.costBaseAud).toBe(2_400);
  });

  it("drops a holding a brokerless split takes to zero", () => {
    const r = valuationAsOf(
      [
        tx({ date: "2026-01-10", ticker: "AUZ", type: "buy", quantity: 100, price: 1, broker: "commsec" }),
        tx({ date: "2026-02-01", ticker: "AUZ", type: "split", quantity: -100 }),
      ],
      { asOf: "2027-06-30", priceSeries: {} },
    );
    expect(r.brokers).toEqual([]);
  });

  it("ignores trades after the date and prices after it", () => {
    const r = valuationAsOf(
      [
        tx({ date: "2026-01-10", ticker: "VAS", type: "buy", quantity: 10, price: 80, broker: "commsec" }),
        tx({ date: "2027-07-01", ticker: "VAS", type: "sell", quantity: 10, price: 108, broker: "commsec" }),
      ],
      { asOf: "2027-06-29", priceSeries: vas },
    );
    const line = r.brokers[0]!.lines[0]!;
    expect(line.quantity).toBe(10);
    expect(line.priceDate).toBe("2027-06-28");
    expect(line.marketValueAud).toBe(1_000);
  });

  it("flags a stale close and a missing close", () => {
    const r = valuationAsOf(
      [
        tx({ date: "2026-01-10", ticker: "VAS", type: "buy", quantity: 10, price: 80, broker: "stake" }),
        tx({ date: "2026-01-10", ticker: "NOPE", type: "buy", quantity: 3, price: 10, broker: "stake" }),
      ],
      { asOf: "2027-07-20", priceSeries: vas },
    );
    const [nope, v] = r.brokers[0]!.lines;
    expect(nope!.ticker).toBe("NOPE");
    expect(nope!.marketValueAud).toBeNull();
    expect(nope!.flags).toContain("no_price");
    expect(v!.flags).toEqual(["stale_price"]);
    expect(v!.priceDate).toBe("2027-07-02");
    expect(r.unvalued).toBe(1);
  });

  it("flags units whose buy had no workable AUD cost", () => {
    const r = valuationAsOf(
      [
        // A USD buy with no FX rate on the trade and none cached: no parcel.
        tx({ date: "2026-01-10", ticker: "TSLA", exchange: "US", type: "buy", quantity: 2, price: 300, currency: "USD", broker: "stake" }),
      ],
      { asOf: "2027-06-30", priceSeries: { TSLA: [{ date: "2027-06-30", close: 330 }] } },
    );
    const line = r.brokers[0]!.lines[0]!;
    expect(line.untrackedQuantity).toBe(2);
    expect(line.parcels).toEqual([]);
    expect(line.flags).toEqual(expect.arrayContaining(["untracked_units", "no_fx"]));
  });

  it("converts US holdings with the FX rate from the date, and says when only today's rate exists", () => {
    const tsla = tx({
      date: "2026-01-10",
      ticker: "TSLA",
      exchange: "US",
      type: "buy",
      quantity: 2,
      price: 300,
      currency: "USD",
      fxRateToAud: 0.6,
      broker: "stake",
    });
    const prices = { TSLA: [{ date: "2027-06-30", close: 330 }] };
    const dated = valuationAsOf([tsla], {
      asOf: "2027-06-30",
      priceSeries: prices,
      fx: { series: { "AUDUSD=X": [{ date: "2027-06-30", rate: 0.66 }] } },
    }).brokers[0]!.lines[0]!;
    expect(dated.fxRate).toBe(0.66);
    expect(dated.fxDate).toBe("2027-06-30");
    expect(dated.marketValueAud).toBe(1_000);
    expect(dated.costBaseAud).toBe(1_000);

    const latestOnly = valuationAsOf([tsla], {
      asOf: "2027-06-30",
      priceSeries: prices,
      fx: { rates: { "AUDUSD=X": 0.66 } },
    }).brokers[0]!.lines[0]!;
    expect(latestOnly.flags).toContain("fx_not_historical");
  });
});

describe("valuationReportToCsv", () => {
  it("writes one row per parcel with the line's price repeated", () => {
    const v = valuationAsOf(
      [
        tx({ date: "2026-01-10", ticker: "VAS", type: "buy", quantity: 10, price: 80, broker: "commsec" }),
        tx({ date: "2026-03-10", ticker: "VAS", type: "buy", quantity: 2, price: 90, broker: "commsec" }),
      ],
      { asOf: "2027-06-30", priceSeries: vas },
    );
    const csv = valuationReportToCsv(
      combineValuations("2027-06-30", "2027-07-01T00:00:00Z", [{ id: 1, name: "Me, Myself", valuation: v }]),
    );
    expect(csv.trim().split("\n")).toEqual([
      "as_of,portfolio,broker,ticker,exchange,currency,units_held,price_date,unit_value_native,fx_rate_foreign_per_aud,fx_date,holding_value_aud,parcel_acquired,parcel_units,parcel_cost_aud,parcel_value_aud,flags",
      '2027-06-30,"Me, Myself",commsec,VAS,ASX,AUD,12,2027-06-30,105,,,1260,2026-01-10,10,800,1050,',
      '2027-06-30,"Me, Myself",commsec,VAS,ASX,AUD,12,2027-06-30,105,,,1260,2026-03-10,2,180,210,',
    ]);
  });
});
