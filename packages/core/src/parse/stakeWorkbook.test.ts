import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseBrokerFile } from "./index.js";
import { normaliseTicker } from "./utils.js";

function buildActivityWorkbook(opts: {
  aus?: Record<string, unknown>[];
  wall?: Record<string, unknown>[];
}): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Report Type: Investment Activity"],
      ["Name: TEST"],
      ["Statement Date: 2024-07-01 - 2025-06-30"],
    ]),
    "Summary",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([["Notes"], ["disclaimer text"]]),
    "Disclaimers",
  );

  const ausHeaders = [
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
  const wallHeaders = [...ausHeaders, "AUD/USD rate"];

  const ausRows = (opts.aus ?? []).map((r) =>
    ausHeaders.map((h) => r[h] ?? ""),
  );
  const wallRows = (opts.wall ?? []).map((r) =>
    wallHeaders.map((h) => r[h] ?? ""),
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([ausHeaders, ...ausRows]),
    "Aus Equities",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([wallHeaders, ...wallRows]),
    "Wall St Equities",
  );

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function buildIncomeWorkbook(opts: {
  aus?: Record<string, unknown>[];
  wall?: Record<string, unknown>[];
}): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["Report Type: Investment Income"],
      ["Name: TEST"],
      ["Statement Date: 2023-07-01 - 2024-06-30"],
    ]),
    "Summary",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([["Notes"]]),
    "Disclaimers",
  );

  const ausHeaders = [
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
  const wallHeaders = [
    "Payment Date",
    "Symbol",
    "Name",
    "Type",
    "Total Amount",
    "Withholding Rate",
    "Tax Withheld",
    "Net Amount",
    "Currency",
    "AUD/USD rate",
  ];

  const ausRows = (opts.aus ?? []).map((r) =>
    ausHeaders.map((h) => r[h] ?? ""),
  );
  const wallRows = (opts.wall ?? []).map((r) =>
    wallHeaders.map((h) => r[h] ?? ""),
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([ausHeaders, ...ausRows]),
    "Aus Dividends (Estimated)",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([wallHeaders, ...wallRows]),
    "Wall St Dividends",
  );

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("normaliseTicker", () => {
  it("strips .ASX suffix", async () => {
    expect(normaliseTicker("VAS.ASX")).toBe("VAS");
    expect(normaliseTicker("vgs.asx")).toBe("VGS");
  });
});

describe("Stake activity workbook", () => {
  it("merges Aus + Wall St sheets and maps Trade Identifier / Avg. Price", async () => {
    const buf = buildActivityWorkbook({
      aus: [
        {
          "Trade Date": "2023-06-15",
          Symbol: "VAS.ASX",
          Side: "Buy",
          "Trade Identifier": "AUS1",
          Units: 10,
          "Avg. Price": 90.5,
          Value: 905,
          Fees: 0,
          GST: 0,
          "Total Value": 905,
          Currency: "AUD",
        },
      ],
      wall: [
        {
          "Trade Date": "2024-12-10",
          Symbol: "TSLA ",
          Side: "Buy",
          "Trade Identifier": "3261932724",
          Units: 0.0686277,
          "Avg. Price": 392.99,
          Value: 26.97,
          Fees: 3,
          GST: 0,
          "Total Value": 29.97,
          Currency: "USD",
          "AUD/USD rate": "$1.567",
        },
      ],
    });

    const result = await parseBrokerFile({
      content: buf,
      filename: "annual-2025.xlsx",
    });

    expect(result.broker).toBe("stake");
    expect(result.transactions).toHaveLength(2);

    const vas = result.transactions.find((t) => t.ticker === "VAS");
    expect(vas).toMatchObject({
      type: "buy",
      exchange: "ASX",
      currency: "AUD",
      quantity: 10,
      price: 90.5,
      amount: 905,
      externalId: "AUS1",
    });

    const tsla = result.transactions.find((t) => t.ticker === "TSLA");
    expect(tsla).toMatchObject({
      type: "buy",
      exchange: "US",
      currency: "USD",
      quantity: 0.0686277,
      price: 392.99,
      amount: 26.97,
      brokerage: 3,
      externalId: "3261932724",
    });
  });

  it("maps sells with negative units and abs quantity", async () => {
    const buf = buildActivityWorkbook({
      wall: [
        {
          "Trade Date": "2020-12-17",
          Symbol: "TSLA",
          Side: "Sell",
          "Trade Identifier": "407720026",
          Units: -0.9805,
          "Avg. Price": 648.78,
          Value: -636.13,
          Fees: 0.17,
          GST: 0,
          Currency: "USD",
        },
      ],
    });

    const result = await parseBrokerFile({
      content: buf,
      filename: "annual-2021.xlsx",
      broker: "stake",
    });

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      type: "sell",
      quantity: 0.9805,
      price: 648.78,
      externalId: "407720026",
      brokerage: 0.17,
    });
  });

  it("empty equity sheets → 0 txs with info warning (not hard error)", async () => {
    const buf = buildActivityWorkbook({ aus: [], wall: [] });
    const result = await parseBrokerFile({
      content: buf,
      filename: "annual-2022.xlsx",
    });
    expect(result.transactions).toHaveLength(0);
    expect(result.broker).toBe("stake");
    expect(
      result.warnings.some(
        (w) => w.severity === "info" && /no trades/i.test(w.message),
      ),
    ).toBe(true);
  });
});

describe("Stake income workbook", () => {
  it("maps AU dividends to dividend_cash with qty 0 (Units is holding size)", async () => {
    const buf = buildIncomeWorkbook({
      aus: [
        {
          "Ex-Dividend Date": "2023-07-03",
          "Payment Date": "2023-07-18",
          Symbol: "VAS",
          Type: "Final Dividend",
          Units: 126,
          "Dividend/Share": "$0.8890",
          "Total Amount": 112.014,
          Unfranked: 5.44,
          Franked: 92.33,
          "Franking Credit": 39.37,
        },
      ],
    });

    const result = await parseBrokerFile({
      content: buf,
      filename: "dividends-2024.xlsx",
    });

    expect(result.broker).toBe("stake");
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      type: "dividend_cash",
      ticker: "VAS",
      exchange: "ASX",
      quantity: 0,
      amount: 112.014,
      date: "2023-07-18",
      externalId: "stake-div-2023-07-18-VAS-112.014",
    });
    expect(result.transactions[0]!.notes).toMatch(/estimate/i);
  });
});

describe("jimmy Stake corpus (local, optional)", () => {
  const jimmyStake =
    "/Users/jxhui/Documents/Finances/stocks/exports/jimmy/stake";

  const hasJimmy = fs.existsSync(jimmyStake);

  it.skipIf(!hasJimmy)("annual-2025.xlsx → 7 TSLA buys with trade ids", async () => {
    const file = path.join(jimmyStake, "annual-2025.xlsx");
    const buf = fs.readFileSync(file);
    const result = await parseBrokerFile({
      content: buf,
      filename: "annual-2025.xlsx",
    });
    expect(result.broker).toBe("stake");
    const tsla = result.transactions.filter((t) => t.ticker === "TSLA");
    expect(tsla).toHaveLength(7);
    expect(tsla.every((t) => t.type === "buy")).toBe(true);
    expect(tsla.every((t) => t.exchange === "US" && t.currency === "USD")).toBe(
      true,
    );
    expect(tsla.map((t) => t.externalId).sort()).toEqual(
      [
        "3261932724",
        "3393279957",
        "3417197126",
        "3417197127",
        "3426974070",
        "3570849106",
        "3570849107",
      ].sort(),
    );
  });

  it.skipIf(!hasJimmy)("annual-2021.xlsx → 3 TSLA sells", async () => {
    const file = path.join(jimmyStake, "annual-2021.xlsx");
    const buf = fs.readFileSync(file);
    const result = await parseBrokerFile({
      content: buf,
      filename: "annual-2021.xlsx",
    });
    const tsla = result.transactions.filter((t) => t.ticker === "TSLA");
    expect(tsla).toHaveLength(3);
    expect(tsla.every((t) => t.type === "sell")).toBe(true);
    expect(tsla.every((t) => t.externalId)).toBeTruthy();
  });

  it.skipIf(!hasJimmy)("empty FY annual-2022 → 0 transactions", async () => {
    const file = path.join(jimmyStake, "annual-2022.xlsx");
    const buf = fs.readFileSync(file);
    const result = await parseBrokerFile({
      content: buf,
      filename: "annual-2022.xlsx",
    });
    expect(result.transactions).toHaveLength(0);
    expect(result.broker).toBe("stake");
  });
});
