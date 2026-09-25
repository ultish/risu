import { describe, expect, it } from "vitest";
import { lotsAsOf } from "./lotsAsOf.js";
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

const ledger = [
  tx({ date: "2027-01-10", ticker: "VAS", type: "buy", quantity: 10, price: 100 }),
  tx({ date: "2028-03-05", ticker: "VAS", type: "buy", quantity: 5, price: 110 }),
  tx({ date: "2028-03-20", ticker: "VAS", type: "sell", quantity: 4, price: 120 }),
];
const priceSeries = {
  "VAS.AX": [
    { date: "2027-06-30", close: 105 },
    { date: "2028-03-31", close: 130 },
  ],
};

describe("lotsAsOf", () => {
  it("values open parcels, their cutover value, and the window's buys and sells", () => {
    const r = lotsAsOf(ledger, {
      asOf: "2028-03-31",
      since: "2028-03-01",
      priceSeries,
    });
    expect(r.lots).toEqual([
      {
        ticker: "VAS",
        exchange: "ASX",
        acquiredDate: "2027-01-10",
        quantity: 6,
        costBaseAud: 600,
        marketValueAud: 780,
        valueAtCutoverAud: 630,
      },
      {
        ticker: "VAS",
        exchange: "ASX",
        acquiredDate: "2028-03-05",
        quantity: 5,
        costBaseAud: 550,
        marketValueAud: 650,
        valueAtCutoverAud: null,
      },
    ]);
    expect(r.buys).toEqual([
      { ticker: "VAS", exchange: "ASX", date: "2028-03-05", costAud: 550 },
    ]);
    expect(r.disposals).toEqual([
      {
        ticker: "VAS",
        exchange: "ASX",
        acquiredDate: "2027-01-10",
        disposedDate: "2028-03-20",
        proceedsAud: 480,
      },
    ]);
  });

  it("before the cutover, no parcel has a cutover value yet", () => {
    const r = lotsAsOf(ledger, {
      asOf: "2027-03-31",
      priceSeries: { "VAS.AX": [{ date: "2027-02-01", close: 102 }] },
    });
    expect(r.lots).toHaveLength(1);
    expect(r.lots[0]!.marketValueAud).toBe(1_020);
    expect(r.lots[0]!.valueAtCutoverAud).toBeNull();
    expect(r.buys).toHaveLength(1);
  });

  it("reports no market value when there is no price, rather than inventing one", () => {
    const r = lotsAsOf(ledger, { asOf: "2027-03-31" });
    expect(r.lots[0]!.marketValueAud).toBeNull();
  });
});
