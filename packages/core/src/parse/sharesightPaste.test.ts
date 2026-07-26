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
  it("parses buys, sell, split with AUD cost base", () => {
    const result = parseSharesightPaste(tslaPaste, {
      ticker: "TSLA",
      exchange: "US",
    });
    expect(result.transactions.length).toBe(5);

    const buy = result.transactions.find(
      (t) => t.date === "2025-06-10" && t.type === "buy",
    )!;
    expect(buy.currency).toBe("AUD");
    expect(buy.amount).toBeCloseTo(487.85, 2);
    expect(buy.quantity).toBeCloseTo(1.00889087, 6);

    const sell = result.transactions.find((t) => t.type === "sell")!;
    expect(sell.quantity).toBeCloseTo(10.9805, 4);
    expect(sell.amount).toBeCloseTo(9352.01, 2);

    const split = result.transactions.find((t) => t.type === "split")!;
    expect(split.quantity).toBe(70);

    const holdings = computeHoldings(result.transactions);
    const tsla = holdings.find((h) => h.ticker === "TSLA");
    expect(tsla).toBeTruthy();
    // 1 + 1.00889 + 0.65818 + 70 - 10.9805 ≈ 61.686
    expect(tsla!.quantity).toBeGreaterThan(60);
    expect(tsla!.currency).toBe("AUD");
  });
});
