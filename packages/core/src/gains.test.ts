import { describe, expect, it } from "vitest";
import {
  combineGainsByFy,
  summarizeFyEndSnapshots,
  summarizeRealisedGains,
} from "./gains.js";
import type { PerformancePoint } from "./performance.js";
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

describe("summarizeRealisedGains", () => {
  it("sums nominal (proceeds - cost) per FY with no tax/regime dependency", () => {
    const totals = summarizeRealisedGains([
      tx({ date: "2020-01-01", ticker: "VAS", type: "buy", quantity: 10, amount: 1000 }),
      tx({
        date: "2024-09-01", // FY2025
        ticker: "VAS",
        type: "sell",
        quantity: 4,
        amount: 800, // cost 400 -> gain 400
      }),
      tx({
        date: "2025-01-01", // FY2025 too
        ticker: "VAS",
        type: "sell",
        quantity: 2,
        amount: 300, // cost 200 -> gain 100
      }),
    ]);
    expect(totals).toHaveLength(1);
    expect(totals[0]).toMatchObject({
      financialYear: "FY2025",
      capitalGain: 500,
      disposalCount: 2,
    });
  });
});

describe("summarizeFyEndSnapshots", () => {
  it("takes the latest point within each FY as that FY's snapshot", () => {
    const points: PerformancePoint[] = [
      { date: "2023-12-31", costBaseAud: 1000, marketValueAud: 1100 },
      { date: "2024-06-30", costBaseAud: 1000, marketValueAud: 1200 }, // FY2024 end
      { date: "2024-09-30", costBaseAud: 1500, marketValueAud: 1450 }, // FY2025, in progress
    ];
    const snapshots = summarizeFyEndSnapshots(points);
    expect(snapshots).toHaveLength(2);
    const fy2024 = snapshots.find((s) => s.financialYear === "FY2024")!;
    const fy2025 = snapshots.find((s) => s.financialYear === "FY2025")!;
    expect(fy2024.asOfDate).toBe("2024-06-30");
    expect(fy2024.unrealisedGainAud).toBeCloseTo(200);
    expect(fy2025.asOfDate).toBe("2024-09-30");
    expect(fy2025.unrealisedGainAud).toBeCloseTo(-50);
  });

  it("returns null unrealisedGainAud when cost or value is unknown", () => {
    const snapshots = summarizeFyEndSnapshots([
      { date: "2024-01-01", costBaseAud: 1000, marketValueAud: null },
    ]);
    expect(snapshots[0]!.unrealisedGainAud).toBeNull();
  });
});

describe("combineGainsByFy", () => {
  it("zips realised and unrealised rows by FY, defaulting missing sides", () => {
    const combined = combineGainsByFy(
      [{ financialYear: "FY2024", capitalGain: 500, disposalCount: 1 }],
      [
        {
          financialYear: "FY2025",
          asOfDate: "2024-09-30",
          costBaseAud: 1000,
          marketValueAud: 1200,
          unrealisedGainAud: 200,
        },
      ],
    );
    expect(combined).toEqual([
      { financialYear: "FY2024", realisedGainAud: 500, unrealisedGainAud: null },
      { financialYear: "FY2025", realisedGainAud: 0, unrealisedGainAud: 200 },
    ]);
  });
});
