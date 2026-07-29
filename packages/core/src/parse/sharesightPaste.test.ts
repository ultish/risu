import { describe, expect, it } from "vitest";
import { computeHoldings } from "../holdings.js";
import { parseSharesightPaste } from "./sharesightPaste.js";

const tslaPaste = `
All trades & adjustments
Add trade or adjustment

10 Jun 2025
Buy
1.00889087
US$312.68
US$3.00
0.65278054 AUD/USD
AU$487.85
Confirmed
Edit
18 Mar 2025
Buy
0.658181
US$237.17
US$3.00
0.63613967 AUD/USD
AU$250.10
Confirmed
Edit
25 Aug 2022
Split
70
—
—
—
—
Confirmed
Edit
17 Dec 2020
Sell
-10.9805
US$648.78
US$0.00
0.76175397 AUD/USD
-AU$9,352.01
Confirmed
Edit
8 Aug 2018
Buy
1
US$368.84
US$0.00
0.742655 AUD/USD
AU$496.65
Confirmed
Edit
`;

describe("Sharesight paste (per-holding trades)", () => {
  it("prefers native (USD) trade currency over Sharesight's AU$ conversion, matching Stake/CommSec", () => {
    const result = parseSharesightPaste(tslaPaste, {
      ticker: "TSLA",
      exchange: "US",
    });
    expect(result.transactions.length).toBe(5);

    const buy = result.transactions.find(
      (t) => t.date === "2025-06-10" && t.type === "buy",
    )!;
    expect(buy.currency).toBe("USD");
    expect(buy.price).toBeCloseTo(312.68, 2);
    // native price*qty + brokerage, not Sharesight's AU$487.85 total
    expect(buy.amount).toBeCloseTo(312.68 * 1.00889087 + 3.0, 2);
    expect(buy.quantity).toBeCloseTo(1.00889087, 6);

    const sell = result.transactions.find((t) => t.type === "sell")!;
    expect(sell.currency).toBe("USD");
    expect(sell.quantity).toBeCloseTo(10.9805, 4);
    expect(sell.price).toBeCloseTo(648.78, 2);
    // matches the real Stake per-fill breakdown for this trade: 3+7+0.9805
    // units at $648.78 (636.13+4541.46+1946.34 = 7123.93), not Sharesight's
    // AU$9,352.01 blended-FX total
    expect(sell.amount).toBeCloseTo(648.78 * 10.9805, 2);

    const split = result.transactions.find((t) => t.type === "split")!;
    expect(split.quantity).toBe(70);

    const holdings = computeHoldings(result.transactions);
    const tsla = holdings.find((h) => h.ticker === "TSLA");
    expect(tsla).toBeTruthy();
    // 1 + 1.00889 + 0.65818 + 70 - 10.9805 ≈ 61.686
    expect(tsla!.quantity).toBeGreaterThan(60);
    expect(tsla!.currency).toBe("USD");
  });

  it("falls back to the AU$ value when no native price line is present", () => {
    const result = parseSharesightPaste(
      `10 Jun 2025\nBuy\n1.00889087\n—\n—\n—\nAU$487.85\nConfirmed\nEdit\n`,
      { ticker: "TSLA", exchange: "US" },
    );
    const buy = result.transactions[0]!;
    expect(buy.currency).toBe("AUD");
    expect(buy.amount).toBeCloseTo(487.85, 2);
  });
});
