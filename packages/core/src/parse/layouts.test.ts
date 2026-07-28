import { describe, expect, it } from "vitest";
import { parseBrokerFile, parseImportFile, resolveForcedBroker } from "./index.js";

describe("Phase 0 foundations", () => {
  it("resolveForcedBroker treats auto/empty as detect", async () => {
    expect(resolveForcedBroker("auto")).toBeUndefined();
    expect(resolveForcedBroker("")).toBeUndefined();
    expect(resolveForcedBroker(null)).toBeUndefined();
    expect(resolveForcedBroker(undefined)).toBeUndefined();
    expect(resolveForcedBroker("stake")).toBe("stake");
  });

  it("PDF returns structured unsupported result (no throw)", async () => {
    const result = await parseBrokerFile({
      content: Buffer.from("%PDF-1.4 fake"),
      filename: "annual-2025.pdf",
      broker: "auto",
    });
    expect(result.transactions).toHaveLength(0);
    expect(result.broker).toBe("generic");
    expect(result.layoutId).toBe("unknown");
    expect(result.confidence).toBe("none");
    expect(
      result.warnings.some(
        (w) => w.severity === "error" && /PDF import is not implemented/i.test(w.message),
      ),
    ).toBe(true);
    expect(
      result.warnings.some((w) => /XLSX/i.test(w.message) && /Stake/i.test(w.message)),
    ).toBe(true);
  });

  it("parseImportFile is alias of parseBrokerFile", async () => {
    const a = await parseImportFile({
      content: Buffer.from("%PDF"),
      filename: "x.pdf",
    });
    const b = await parseBrokerFile({
      content: Buffer.from("%PDF"),
      filename: "x.pdf",
    });
    expect(a.layoutId).toBe(b.layoutId);
    expect(a.warnings[0]?.message).toBe(b.warnings[0]?.message);
  });

  it("broker auto still parses CSV via detect", async () => {
    const csv = `Date,Symbol,Side,Quantity,Price,Fees,Currency,Market,Unique Order Id
2022-01-15,AAPL,Buy,10,150.00,0,USD,NASDAQ,STK1
`;
    const result = await parseBrokerFile({
      content: csv,
      filename: "stake.csv",
      broker: "auto",
    });
    expect(result.transactions.length).toBeGreaterThanOrEqual(1);
    expect(result.broker).toBe("stake");
  });
});
