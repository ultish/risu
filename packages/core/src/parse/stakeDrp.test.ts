import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { analyzeStakeDrp } from "./stakeDrp.js";

function buildActivityWorkbook(
  statementDate: string,
  ausRows: Record<string, unknown>[] = [],
): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Report Type: Investment Activity"],
      ["Name: TEST"],
      [`Statement Date: ${statementDate}`],
    ]),
    "Summary",
  );
  const headers = [
    "Trade Date",
    "Settlement Date",
    "Symbol",
    "Name",
    "Side",
    "Trade Identifier",
    "Units",
    "Avg. Price",
    "Value",
    "Fees",
    "GST",
    "Total Value",
    "Currency",
  ];
  const rows = ausRows.map((r) => headers.map((h) => r[h] ?? ""));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...rows]), "Aus Equities");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers]), "Wall St Equities");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function buildIncomeWorkbook(
  statementDate: string,
  ausRows: Record<string, unknown>[] = [],
): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Report Type: Investment Income"],
      ["Name: TEST"],
      [`Statement Date: ${statementDate}`],
    ]),
    "Summary",
  );
  const headers = [
    "Ex-Dividend Date",
    "Payment Date",
    "Symbol",
    "Name",
    "Type",
    "Units",
    "Dividend/Share",
    "Total Amount",
    "Unfranked",
    "Franked",
    "Franking Credit",
  ];
  const rows = ausRows.map((r) => headers.map((h) => r[h] ?? ""));
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([headers, ...rows]),
    "Aus Dividends (Estimated)",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([[
      "Payment Date", "Symbol", "Name", "Type", "Total Amount",
      "Withholding Rate", "Tax Withheld", "Net Amount", "Currency", "AUD/USD rate",
    ]]),
    "Wall St Dividends",
  );
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function buildValuationWorkbook(
  asAtDate: string,
  ausRows: Record<string, unknown>[] = [],
): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      [`Report Type: Portfolio Valuation as at ${asAtDate}`],
      ["Name: TEST"],
      [`Statement Date: ${asAtDate}`],
    ]),
    "Summary",
  );
  const headers = ["Symbol", "Name", "Weighting", "Units", "Mkt. Price", "Mkt. Value"];
  const rows = ausRows.map((r) => headers.map((h) => r[h] ?? ""));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...rows]), "Aus Equities");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers]), "Wall St Equities");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("analyzeStakeDrp", () => {
  it("proposes a drp when units-held rises between two dividend checkpoints with no trade in between", () => {
    const income = buildIncomeWorkbook("2023-07-01 - 2024-06-30", [
      { "Ex-Dividend Date": "2023-07-01", "Payment Date": "2023-07-16", Symbol: "VAS", Type: "Final Dividend", Units: "100" },
      { "Ex-Dividend Date": "2023-10-01", "Payment Date": "2023-10-16", Symbol: "VAS", Type: "Interim Dividend", Units: "101" },
    ]);
    const result = analyzeStakeDrp([{ filename: "dividends-2024.xlsx", content: income }]);

    expect(result.warnings).toHaveLength(0);
    expect(result.proposed).toHaveLength(1);
    expect(result.proposed[0]).toMatchObject({
      date: "2023-07-16", // funding dividend's Payment Date, not the ex-div date it was confirmed at
      ticker: "VAS",
      exchange: "ASX",
      type: "drp",
      quantity: 1,
      price: null,
      amount: null,
    });
  });

  it("nets out a real Activity buy before attributing the remainder to DRP", () => {
    const income = buildIncomeWorkbook("2024-07-01 - 2025-06-30", [
      { "Ex-Dividend Date": "2024-10-01", "Payment Date": "2024-10-16", Symbol: "VAS", Type: "Interim Dividend", Units: "132" },
      { "Ex-Dividend Date": "2025-01-02", "Payment Date": "2025-01-17", Symbol: "VAS", Type: "Interim Dividend", Units: "135" },
    ]);
    const activity = buildActivityWorkbook("2024-07-01 - 2025-06-30", [
      { "Trade Date": "2024-10-09", "Settlement Date": "2024-10-11", Symbol: "VAS", Side: "Buy", Units: 2, Currency: "AUD" },
    ]);
    const result = analyzeStakeDrp([
      { filename: "dividends-2025.xlsx", content: income },
      { filename: "annual-2025.xlsx", content: activity },
    ]);

    expect(result.warnings).toHaveLength(0);
    // 132 + 2 (buy) + 1 (drp) = 135
    expect(result.proposed).toHaveLength(1);
    expect(result.proposed[0]).toMatchObject({ ticker: "VAS", quantity: 1 });
  });

  it("nets out an Activity buy even when its Symbol carries a .ASX suffix the Income/Valuation sheets omit", () => {
    // Real-world Stake quirk: the Investment Activity export lists Symbol as
    // "VGS.ASX" while Investment Income/Portfolio Valuation list the same
    // holding as bare "VGS" — without normalising both to the same ticker key,
    // the Activity buy lands in an orphaned bucket and the real VGS bucket
    // sees no offsetting trade, so a real buy gets misattributed as a DRP.
    const income = buildIncomeWorkbook("2023-07-01 - 2024-06-30", [
      { "Ex-Dividend Date": "2024-01-02", "Payment Date": "2024-01-17", Symbol: "VGS", Type: "Interim Dividend", Units: "41" },
      { "Ex-Dividend Date": "2024-04-02", "Payment Date": "2024-04-17", Symbol: "VGS", Type: "Interim Dividend", Units: "43" },
    ]);
    const activity = buildActivityWorkbook("2023-07-01 - 2024-06-30", [
      { "Trade Date": "2024-01-02", Symbol: "VGS.ASX", Side: "Buy", Units: 1, Currency: "AUD" },
      { "Trade Date": "2024-01-02", Symbol: "VGS.ASX", Side: "Buy", Units: 1, Currency: "AUD" },
    ]);
    const result = analyzeStakeDrp([
      { filename: "dividends-2024.xlsx", content: income },
      { filename: "annual-2024.xlsx", content: activity },
    ]);

    expect(result.warnings).toHaveLength(0);
    // 41 + 2 (buys) = 43, matches the April checkpoint exactly — no DRP.
    expect(result.proposed).toHaveLength(0);
  });

  it("warns instead of guessing when a units-held gap has no dividend record covering it (NXT/SPP-style)", () => {
    const valuation2023 = buildValuationWorkbook("2023-06-30", [
      { Symbol: "NXT", Units: 78 },
    ]);
    const valuation2024 = buildValuationWorkbook("2024-06-30", [
      { Symbol: "NXT", Units: 91 },
    ]);
    const result = analyzeStakeDrp([
      { filename: "valuation-2023.xlsx", content: valuation2023 },
      { filename: "valuation-2024.xlsx", content: valuation2024 },
    ]);

    expect(result.proposed).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.ticker).toBe("NXT");
    expect(result.warnings[0]!.message).toMatch(/\+13/);
    expect(result.warnings[0]!.message).toMatch(/no dividend record/);
  });

  it("warns rather than proposing a negative DRP when units-held drops with no dividend in the gap (ORGN/liquidation-style)", () => {
    const valuation2025 = buildValuationWorkbook("2025-06-30", [{ Symbol: "ORGN", Units: 6 }]);
    const valuation2026 = buildValuationWorkbook("2026-06-30", [{ Symbol: "ORGN", Units: 0.2 }]);
    const result = analyzeStakeDrp([
      { filename: "valuation-2025.xlsx", content: valuation2025 },
      { filename: "valuation-2026.xlsx", content: valuation2026 },
    ]);

    expect(result.proposed).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toMatch(/-5\.8/);
  });

  it("does not warn or propose anything when a dividend precedes a gap but the preceding checkpoint is a valuation, not a dividend", () => {
    // Opening valuation matches the first dividend's own units exactly —
    // no drp needed, no warning (mismatch is 0).
    const valuation = buildValuationWorkbook("2023-06-30", [{ Symbol: "VAS", Units: 100 }]);
    const income = buildIncomeWorkbook("2023-07-01 - 2024-06-30", [
      { "Ex-Dividend Date": "2023-07-01", "Payment Date": "2023-07-16", Symbol: "VAS", Type: "Final Dividend", Units: "100" },
    ]);
    const result = analyzeStakeDrp([
      { filename: "valuation-2023.xlsx", content: valuation },
      { filename: "dividends-2024.xlsx", content: income },
    ]);
    expect(result.proposed).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("produces stable externalIds so re-running with the same files is idempotent", () => {
    const income = buildIncomeWorkbook("2023-07-01 - 2024-06-30", [
      { "Ex-Dividend Date": "2023-07-01", "Payment Date": "2023-07-16", Symbol: "VAS", Type: "Final Dividend", Units: "100" },
      { "Ex-Dividend Date": "2023-10-01", "Payment Date": "2023-10-16", Symbol: "VAS", Type: "Interim Dividend", Units: "101" },
    ]);
    const r1 = analyzeStakeDrp([{ filename: "dividends-2024.xlsx", content: income }]);
    const r2 = analyzeStakeDrp([{ filename: "dividends-2024.xlsx", content: income }]);
    expect(r1.proposed[0]!.externalId).toBe(r2.proposed[0]!.externalId);
  });

  it("flags unrecognized files instead of throwing", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["hello"]]), "Sheet1");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const result = analyzeStakeDrp([{ filename: "not-stake.xlsx", content: buf }]);
    expect(result.unrecognizedFiles).toEqual(["not-stake.xlsx"]);
    expect(result.proposed).toHaveLength(0);
  });
});
