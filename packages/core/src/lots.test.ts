import { describe, expect, it } from "vitest";
import { computeLots, isPlatformReportedFifoSell } from "./lots.js";
import { orderFnForMatching } from "./tax/lotMatching.js";
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

describe("computeLots FIFO matching", () => {
  it("consumes the oldest lot first on a partial sell", () => {
    const { openLots, disposals } = computeLots([
      tx({
        date: "2020-01-01",
        ticker: "VAS",
        type: "buy",
        quantity: 10,
        amount: 1000, // $100/unit
      }),
      tx({
        date: "2021-01-01",
        ticker: "VAS",
        type: "buy",
        quantity: 10,
        amount: 1500, // $150/unit
      }),
      tx({
        date: "2022-01-01",
        ticker: "VAS",
        type: "sell",
        quantity: 4,
        amount: 800, // $200/unit
      }),
    ]);

    expect(disposals).toHaveLength(1);
    expect(disposals[0]).toMatchObject({
      acquiredDate: "2020-01-01",
      disposedDate: "2022-01-01",
      quantity: 4,
      proceedsAud: 800,
      costBaseAud: 400, // 4 units @ $100
    });

    // First lot has 6 units left, second lot untouched
    expect(openLots).toHaveLength(2);
    expect(openLots[0]).toMatchObject({
      acquiredDate: "2020-01-01",
      quantity: 6,
      costBaseAud: 600,
    });
    expect(openLots[1]).toMatchObject({
      acquiredDate: "2021-01-01",
      quantity: 10,
      costBaseAud: 1500,
    });
  });

  it("splits a single sell across multiple lots when it exceeds the oldest lot's quantity", () => {
    const { openLots, disposals } = computeLots([
      tx({
        date: "2020-01-01",
        ticker: "VAS",
        type: "buy",
        quantity: 5,
        amount: 500, // $100/unit
      }),
      tx({
        date: "2021-01-01",
        ticker: "VAS",
        type: "buy",
        quantity: 10,
        amount: 1500, // $150/unit
      }),
      tx({
        date: "2022-01-01",
        ticker: "VAS",
        type: "sell",
        quantity: 8,
        amount: 1600, // $200/unit
      }),
    ]);

    expect(disposals).toHaveLength(2);
    expect(disposals[0]).toMatchObject({
      acquiredDate: "2020-01-01",
      quantity: 5,
      proceedsAud: 1000,
      costBaseAud: 500,
    });
    expect(disposals[1]).toMatchObject({
      acquiredDate: "2021-01-01",
      quantity: 3,
      proceedsAud: 600,
      costBaseAud: 450, // 3 units @ $150
    });

    expect(openLots).toHaveLength(1);
    expect(openLots[0]).toMatchObject({
      acquiredDate: "2021-01-01",
      quantity: 7,
      costBaseAud: 1050,
    });
  });

  it("scales open lots proportionally on a split without changing total cost base", () => {
    const { openLots } = computeLots([
      tx({
        date: "2020-01-01",
        ticker: "ABC",
        type: "buy",
        quantity: 10,
        amount: 1000,
      }),
      tx({
        date: "2021-01-01",
        ticker: "ABC",
        type: "buy",
        quantity: 5,
        amount: 750,
      }),
      // 3-for-1 split: total qty 15 -> 45, delta +30
      tx({
        date: "2022-01-01",
        ticker: "ABC",
        type: "split",
        quantity: 30,
      }),
    ]);

    expect(openLots).toHaveLength(2);
    expect(openLots[0].quantity).toBeCloseTo(30); // 10 * 3
    expect(openLots[0].costBaseAud).toBeCloseTo(1000); // unchanged
    expect(openLots[1].quantity).toBeCloseTo(15); // 5 * 3
    expect(openLots[1].costBaseAud).toBeCloseTo(750); // unchanged
  });

  it("excludes transfer_in/transfer_out from lots entirely", () => {
    const { openLots, disposals } = computeLots([
      tx({
        date: "2020-01-01",
        ticker: "XYZ",
        type: "transfer_in",
        quantity: 10,
      }),
      tx({
        date: "2021-01-01",
        ticker: "XYZ",
        type: "buy",
        quantity: 5,
        amount: 500,
      }),
      tx({
        date: "2022-01-01",
        ticker: "XYZ",
        type: "transfer_out",
        quantity: 3,
      }),
    ]);

    expect(disposals).toHaveLength(0);
    expect(openLots).toHaveLength(1);
    expect(openLots[0]).toMatchObject({ quantity: 5, costBaseAud: 500 });
  });

  it("converts a foreign-currency lot's cost/proceeds to AUD via the transaction's own historical rate", () => {
    const { disposals } = computeLots([
      tx({
        date: "2020-01-01",
        ticker: "TSLA",
        exchange: "US",
        type: "buy",
        quantity: 2,
        amount: 200, // USD
        currency: "USD",
        fxRateToAud: 0.5, // 0.5 USD per 1 AUD -> 200 USD = 400 AUD
      }),
      tx({
        date: "2022-01-01",
        ticker: "TSLA",
        exchange: "US",
        type: "sell",
        quantity: 2,
        amount: 300, // USD
        currency: "USD",
        fxRateToAud: 0.6, // 300 USD = 500 AUD
      }),
    ]);

    expect(disposals).toHaveLength(1);
    expect(disposals[0].costBaseAud).toBeCloseTo(400);
    expect(disposals[0].proceedsAud).toBeCloseTo(500);
  });
});

describe("computeLots recorded specific identification", () => {
  it("copies sourceTxId from the buy onto the lot and disposal", () => {
    const { openLots, disposals } = computeLots([
      tx({
        id: 1,
        date: "2020-01-01",
        ticker: "VAS",
        type: "buy",
        quantity: 10,
        amount: 1000,
      }),
      tx({
        id: 2,
        date: "2021-01-01",
        ticker: "VAS",
        type: "buy",
        quantity: 10,
        amount: 1800,
      }),
      tx({
        id: 3,
        date: "2024-01-01",
        ticker: "VAS",
        type: "sell",
        quantity: 5,
        amount: 1000,
      }),
    ]);

    expect(disposals[0].acquireTxId).toBe(1); // FIFO: oldest buy
    expect(disposals[0].sellTxId).toBe(3);
    expect(openLots.find((l) => l.sourceTxId === 1)?.quantity).toBeCloseTo(5);
    expect(openLots.find((l) => l.sourceTxId === 2)?.quantity).toBeCloseTo(10);
  });

  it("consumes the recorded parcel instead of FIFO when takes are stored", () => {
    const { openLots, disposals } = computeLots(
      [
        tx({
          id: 1,
          date: "2020-01-01",
          ticker: "VAS",
          type: "buy",
          quantity: 10,
          amount: 1000,
        }),
        tx({
          id: 2,
          date: "2021-01-01",
          ticker: "VAS",
          type: "buy",
          quantity: 10,
          amount: 1800,
        }),
        tx({
          id: 3,
          date: "2024-01-01",
          ticker: "VAS",
          type: "sell",
          quantity: 5,
          amount: 1000,
        }),
      ],
      {},
      {
        recordedTakes: [
          { sellTxId: 3, acquireTxId: 2, quantity: 5 },
        ],
      },
    );

    expect(disposals).toHaveLength(1);
    expect(disposals[0].acquireTxId).toBe(2);
    expect(disposals[0].costBaseAud).toBeCloseTo(900);
    expect(openLots.find((l) => l.sourceTxId === 1)?.quantity).toBeCloseTo(10);
    expect(openLots.find((l) => l.sourceTxId === 2)?.quantity).toBeCloseTo(5);
  });

  it("can split a recorded sell across two parcels", () => {
    const { disposals } = computeLots(
      [
        tx({
          id: 1,
          date: "2020-01-01",
          ticker: "VAS",
          type: "buy",
          quantity: 10,
          amount: 1000,
        }),
        tx({
          id: 2,
          date: "2021-01-01",
          ticker: "VAS",
          type: "buy",
          quantity: 10,
          amount: 1800,
        }),
        tx({
          id: 3,
          date: "2024-01-01",
          ticker: "VAS",
          type: "sell",
          quantity: 12,
          amount: 2400,
        }),
      ],
      {},
      {
        recordedTakes: [
          { sellTxId: 3, acquireTxId: 2, quantity: 10 },
          { sellTxId: 3, acquireTxId: 1, quantity: 2 },
        ],
      },
    );

    expect(disposals).toHaveLength(2);
    expect(disposals[0].acquireTxId).toBe(2);
    expect(disposals[0].quantity).toBeCloseTo(10);
    expect(disposals[1].acquireTxId).toBe(1);
    expect(disposals[1].quantity).toBeCloseTo(2);
  });
});

describe("Betashares Direct statement sells stay FIFO", () => {
  it("detects platform-reported FIFO sells", () => {
    expect(
      isPlatformReportedFifoSell({
        type: "sell",
        broker: "betashares_direct",
        source: "file:betashares_direct.platform_annual",
      }),
    ).toBe(true);
    expect(
      isPlatformReportedFifoSell({
        type: "sell",
        broker: "betashares_direct",
        source: "confirm-sale",
      }),
    ).toBe(false);
    expect(
      isPlatformReportedFifoSell({
        type: "sell",
        broker: "stake",
        source: "file:stake.activity",
      }),
    ).toBe(false);
    expect(
      isPlatformReportedFifoSell(
        {
          type: "sell",
          broker: "stake",
          source: "file:stake.activity",
        },
        ["stake"],
      ),
    ).toBe(true);
    expect(
      isPlatformReportedFifoSell(
        {
          type: "sell",
          broker: "betashares_direct",
          source: "file:betashares_direct.platform_annual",
        },
        [],
      ),
    ).toBe(false);
  });

  it("consumes the oldest lot for a Betashares statement sell even when min_cgt is requested", () => {
    const { disposals } = computeLots(
      [
        tx({
          id: 1,
          date: "2020-01-01",
          ticker: "BGBL",
          type: "buy",
          quantity: 10,
          amount: 1000,
        }),
        tx({
          id: 2,
          date: "2021-01-01",
          ticker: "BGBL",
          type: "buy",
          quantity: 10,
          amount: 1800,
        }),
        tx({
          id: 3,
          date: "2024-01-01",
          ticker: "BGBL",
          type: "sell",
          quantity: 5,
          amount: 1000,
          broker: "betashares_direct",
          source: "file:betashares_direct.platform_annual",
        }),
      ],
      {},
      {
        orderLotsForSale: orderFnForMatching("min_cgt", { regime: "auto_by_date" }),
        customMatching: "min_cgt",
      },
    );
    expect(disposals[0].acquireTxId).toBe(1);
    expect(disposals[0].parcelMatch).toBe("fifo");
  });

  it("still applies min_cgt to a Betashares sell you recorded yourself", () => {
    const { disposals } = computeLots(
      [
        tx({
          id: 1,
          date: "2020-01-01",
          ticker: "BGBL",
          type: "buy",
          quantity: 10,
          amount: 1000,
        }),
        tx({
          id: 2,
          date: "2021-01-01",
          ticker: "BGBL",
          type: "buy",
          quantity: 10,
          amount: 1800,
        }),
        tx({
          id: 3,
          date: "2024-01-01",
          ticker: "BGBL",
          type: "sell",
          quantity: 5,
          amount: 1000,
          broker: "betashares_direct",
          source: "confirm-sale",
        }),
      ],
      {},
      {
        orderLotsForSale: orderFnForMatching("min_cgt", { regime: "auto_by_date" }),
        customMatching: "min_cgt",
      },
    );
    expect(disposals[0].acquireTxId).toBe(2);
    expect(disposals[0].parcelMatch).toBe("min_cgt");
  });
});
