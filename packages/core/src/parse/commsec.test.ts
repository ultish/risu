import { describe, expect, it } from "vitest";
import { computeHoldings } from "../holdings.js";
import { inferExchangeAndCurrency } from "../market.js";
import { toYahooSymbol } from "../yahoo.js";
import { parseBrokerFile } from "./index.js";

const confirmationsCsv = `Trade Date,Stock Code,Buy/Sell,Quantity,Price,Brokerage,Consideration,Reference
15/03/2020,VAS,Buy,50,75.20,10.00,3760.00,CN1001
01/06/2021,VAS,DRP,1.85,88.40,0,163.54,DRP2001
12/08/2022,VGS,Buy,20,95.00,10.00,1900.00,CN1002
03/02/2023,VAS,Sell,10,90.00,10.00,900.00,CN1003
`;

const stakeUsCsv = `Date,Symbol,Side,Quantity,Price,Fees,Currency,Market,Unique Order Id
2022-01-15,AAPL,Buy,10,150.00,0,USD,NASDAQ,STK1
2023-03-20,AAPL,DRIP,0.5,160.00,0,USD,US,STK2
2021-06-01,VAS,Buy,5,80.00,0,AUD,ASX,STK3
`;

const selfwealthCsv = `Date,Symbol,Side,Quantity,Price,Brokerage,Value,Market,Currency,Order Id
10/01/2021,BHP,Buy,100,40.00,9.50,4000.00,ASX,AUD,SW1
11/02/2022,VOO,Buy,5,400.00,0,2000.00,US,USD,SW2
`;

/** Live CommSec web Confirmations CSV column names (as of 2026) */
const liveConfirmationsCsv = `Confirmation Number,Order Number,Trade Date,Buy/ Sell,Security,Units,Average Price ($),Brokerage (inc GST.),Net Proceeds ($),Settlement Date,Confirmation Status
173136605,N213664045,23/03/2026,S,AUZ,2335,0.015,4.99,30.04,25/03/2026,Confirmed
163328781,N202235713,30/06/2025,S,ARL,980,0.400,4.99,387.01,2/07/2025,Confirmed
91935202,N110263900,16/08/2019,B,LYC,187,2.680,10.00,511.16,20/08/2019,Confirmed
81477702,N96727912,22/12/2017,B,VGS,15,66.740,19.95,1021.05,28/12/2017,Confirmed
80451894,N95386226,7/11/2017,B,AUZ,6666,0.150,10.00,1009.90,9/11/2017,Confirmed
80069230,N94854317,19/10/2017,B,AUZ,16680,0.060,10.00,1010.80,23/10/2017,Confirmed
80018075,N94818790,18/10/2017,B,ARL,980,1.020,10.00,1009.60,20/10/2017,Confirmed
80032142,N94818870,18/10/2017,B,VGS,15,63.130,10.00,956.95,20/10/2017,Confirmed
`;

describe("CommSec parser + holdings", () => {
  it("parses buys, DRP, sells and updates holdings", async () => {
    const result = await parseBrokerFile({
      content: confirmationsCsv,
      filename: "commsec-confirmations.csv",
      broker: "commsec",
    });
    expect(result.transactions).toHaveLength(4);
    expect(result.transactions.map((t) => t.type)).toEqual([
      "buy",
      "drp",
      "buy",
      "sell",
    ]);

    const drp = result.transactions.find((t) => t.type === "drp")!;
    expect(drp.ticker).toBe("VAS");
    expect(drp.quantity).toBeCloseTo(1.85);
    expect(drp.exchange).toBe("ASX");

    const holdings = computeHoldings(result.transactions);
    const vas = holdings.find((h) => h.ticker === "VAS")!;
    expect(vas.quantity).toBeCloseTo(41.85, 5);
    expect(vas.costBase).toBeGreaterThan(0);
  });

  it("parses live Confirmations CSV (B/S, Security, Units, Net Proceeds)", async () => {
    const result = await parseBrokerFile({
      content: liveConfirmationsCsv,
      filename: "commsec-confirmations.csv",
      broker: "commsec",
    });
    expect(result.skippedRows).toBe(0);
    expect(result.transactions).toHaveLength(8);
    // Parser sorts by date (oldest first), not file order
    expect(result.transactions.filter((t) => t.type === "buy")).toHaveLength(6);
    expect(result.transactions.filter((t) => t.type === "sell")).toHaveLength(2);
    expect(result.transactions.every((t) => t.type !== "other")).toBe(true);

    const auzSells = result.transactions.filter(
      (t) => t.ticker === "AUZ" && t.type === "sell",
    );
    expect(auzSells[0]!.quantity).toBe(2335);
    expect(auzSells[0]!.price).toBeCloseTo(0.015);
    expect(auzSells[0]!.amount).toBeCloseTo(30.04);
    expect(auzSells[0]!.brokerage).toBeCloseTo(4.99);
    expect(auzSells[0]!.externalId).toBe("173136605");

    const holdings = computeHoldings(result.transactions);
    // AUZ: 6666+16680 - 2335 = 21011
    expect(holdings.find((h) => h.ticker === "AUZ")!.quantity).toBe(21011);
    // ARL: 980 - 980 = 0 (closed)
    expect(holdings.find((h) => h.ticker === "ARL")).toBeUndefined();
    // VGS: 15+15 = 30
    expect(holdings.find((h) => h.ticker === "VGS")!.quantity).toBe(30);
    expect(holdings.find((h) => h.ticker === "LYC")!.quantity).toBe(187);
  });

  it("auto-detects live Confirmations headers as commsec and maps B/S", async () => {
    const result = await parseBrokerFile({
      content: liveConfirmationsCsv,
      filename: "export.csv", // no "commsec" in name
    });
    expect(result.broker).toBe("commsec");
    expect(result.transactions.filter((t) => t.type === "other")).toHaveLength(
      0,
    );
    expect(result.transactions.filter((t) => t.type === "buy")).toHaveLength(6);
  });

  it("maps Buy/ Sell with odd spacing via generic path B/S tokens", async () => {
    const csv = `Trade Date,Buy / Sell,Security,Units,Average Price ($),Net Proceeds ($)
18/10/2017,B,VGS,15,63.13,956.95
23/03/2026,S,AUZ,10,1.00,10.00
`;
    const result = await parseBrokerFile({
      content: csv,
      filename: "x.csv",
      broker: "generic",
    });
    expect(result.transactions.map((t) => t.type).sort()).toEqual([
      "buy",
      "sell",
    ]);
  });

  it("auto-detects commsec from filename", async () => {
    const result = await parseBrokerFile({
      content: confirmationsCsv,
      filename: "my-commsec-export.csv",
    });
    expect(result.broker).toBe("commsec");
  });

  it("parses tab-separated Confirmations paste (browser copy)", async () => {
    const tsv = [
      "Confirmation Number\tOrder Number\tTrade Date\tBuy/ Sell\tSecurity\tUnits\tAverage Price ($)\tBrokerage (inc GST.)\tNet Proceeds ($)\tSettlement Date\tConfirmation Status",
      "173136605\tN213664045\t23/03/2026\tS\tAUZ\t2335\t0.015\t4.99\t30.04\t25/03/2026\tConfirmed",
      "91935202\tN110263900\t16/08/2019\tB\tLYC\t187\t2.680\t10.00\t511.16\t20/08/2019\tConfirmed",
    ].join("\n");
    const result = await parseBrokerFile({
      content: tsv,
      filename: "paste.tsv",
      broker: "commsec",
    });
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions.map((t) => t.type).sort()).toEqual([
      "buy",
      "sell",
    ]);
    expect(result.transactions.find((t) => t.ticker === "AUZ")!.type).toBe(
      "sell",
    );
  });
});

describe("multi-market", () => {
  it("infers US from currency/market", async () => {
    expect(inferExchangeAndCurrency({ currency: "USD", ticker: "AAPL" })).toEqual({
      exchange: "US",
      currency: "USD",
    });
    expect(inferExchangeAndCurrency({ market: "NASDAQ", ticker: "AAPL" })).toEqual({
      exchange: "US",
      currency: "USD",
    });
    expect(toYahooSymbol("AAPL", "US")).toBe("AAPL");
    expect(toYahooSymbol("VAS", "ASX")).toBe("VAS.AX");
  });

  it("parses Stake AU + US with DRIP", async () => {
    const result = await parseBrokerFile({
      content: stakeUsCsv,
      filename: "stake-activity.csv",
      broker: "stake",
    });
    expect(result.transactions).toHaveLength(3);
    const aapl = result.transactions.filter((t) => t.ticker === "AAPL");
    expect(aapl[0]!.exchange).toBe("US");
    expect(aapl[0]!.currency).toBe("USD");
    expect(aapl[1]!.type).toBe("drp");
    const vas = result.transactions.find((t) => t.ticker === "VAS")!;
    expect(vas.exchange).toBe("ASX");
    expect(vas.currency).toBe("AUD");

    const holdings = computeHoldings(result.transactions, {
      prices: {
        "US:AAPL": 170,
        "ASX:VAS": 90,
      },
      fxRates: { "AUDUSD=X": 0.65 },
    });
    const hAapl = holdings.find((h) => h.ticker === "AAPL")!;
    expect(hAapl.quantity).toBeCloseTo(10.5);
    expect(hAapl.currency).toBe("USD");
    expect(hAapl.marketValueAud).not.toBeNull();
    expect(hAapl.marketValueAud!).toBeCloseTo((170 * 10.5) / 0.65, 0);
  });

  it("parses Selfwealth mixed markets", async () => {
    const result = await parseBrokerFile({
      content: selfwealthCsv,
      filename: "selfwealth-report.csv",
      broker: "selfwealth",
    });
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions.find((t) => t.ticker === "VOO")!.exchange).toBe(
      "US",
    );
    expect(result.transactions.find((t) => t.ticker === "BHP")!.exchange).toBe(
      "ASX",
    );
  });

  it("parses Sharesight All Trades style export", async () => {
    const csv = `Trade Date,Instrument Code,Market Code,Transaction Type,Quantity,Price,Brokerage,Value,Currency,Comments
2020-03-15,VAS,ASX,BUY,50,75.20,10.00,3760.00,AUD,
2021-06-01,VAS,ASX,DRP,1.85,88.40,0,163.54,AUD,Dividend reinvestment
2022-01-15,AAPL,NASDAQ,BUY,10,150.00,0,1500.00,USD,
`;
    const result = await parseBrokerFile({
      content: csv,
      filename: "sharesight-all-trades.csv",
      broker: "sharesight",
    });
    expect(result.broker).toBe("sharesight");
    expect(result.transactions).toHaveLength(3);
    expect(result.transactions.find((t) => t.type === "drp")!.ticker).toBe(
      "VAS",
    );
    expect(result.transactions.find((t) => t.ticker === "AAPL")!.exchange).toBe(
      "US",
    );
  });
});
