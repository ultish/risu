import { describe, expect, it } from "vitest";
import {
  applyForeignWithholding,
  DEFAULT_US_WITHHOLDING_RATE,
  estimateDividendTax,
  estimateDividendTaxBatch,
  estimateFyDividendTax,
  isAsxDividendLine,
  isForeignDividendLine,
} from "./incomeTax.js";
import type { TaxProfile } from "./types.js";

const profile37: TaxProfile = {
  label: "Test",
  marginalRate: 0.37,
  medicareLevy: 0.02,
};

describe("applyForeignWithholding", () => {
  it("defaults to AU–US treaty style 15% rate constant", () => {
    expect(DEFAULT_US_WITHHOLDING_RATE).toBe(0.15);
  });

  it("withholds from gross cash when ledger is not net", () => {
    const r = applyForeignWithholding(100, 0.15, false);
    expect(r.gross).toBe(100);
    expect(r.withheld).toBe(15);
    expect(r.netCash).toBe(85);
    expect(r.rate).toBe(0.15);
  });

  it("grosses up when ledger cash is already net", () => {
    // net 85 at 15% → gross 100
    const r = applyForeignWithholding(85, 0.15, true);
    expect(r.netCash).toBe(85);
    expect(r.gross).toBe(100);
    expect(r.withheld).toBe(15);
  });

  it("identity when rate is 0", () => {
    const r = applyForeignWithholding(50, 0, true);
    expect(r).toEqual({ gross: 50, withheld: 0, netCash: 50, rate: 0 });
  });

  it("identity when cash is 0", () => {
    const r = applyForeignWithholding(0, 0.15, true);
    expect(r.gross).toBe(0);
    expect(r.withheld).toBe(0);
    expect(r.netCash).toBe(0);
  });

  it("clamps rate to avoid infinite gross-up", () => {
    const r = applyForeignWithholding(100, 1.5, true);
    // rate clamped to 0.99 → gross = 100/0.01 = 10000
    expect(r.rate).toBe(0.99);
    expect(r.gross).toBe(10000);
    expect(r.netCash).toBe(100);
  });

  it("defaults ledgerIsNet to false", () => {
    const r = applyForeignWithholding(100, 0.1);
    expect(r.gross).toBe(100);
    expect(r.withheld).toBe(10);
    expect(r.netCash).toBe(90);
  });
});

describe("isForeignDividendLine / isAsxDividendLine", () => {
  it("classifies ASX as domestic", () => {
    expect(isAsxDividendLine("ASX")).toBe(true);
    expect(isForeignDividendLine("ASX", "AUD")).toBe(false);
  });

  it("treats AUD non-ASX as non-foreign for withholding", () => {
    expect(isForeignDividendLine("NYSE", "AUD")).toBe(false);
  });

  it("treats US listings as foreign", () => {
    expect(isForeignDividendLine("NASDAQ", "USD")).toBe(true);
    expect(isForeignDividendLine("US", "USD")).toBe(true);
    expect(isAsxDividendLine("NASDAQ")).toBe(false);
  });
});

describe("estimateDividendTax", () => {
  it("applies franking credit gross-up at 30% company tax", () => {
    // $70 fully franked → credits = 70 * 30/70 = 30; assessable 100
    const r = estimateDividendTax({
      cashAud: 70,
      frankingPercent: 100,
      profile: profile37,
    });
    expect(r.frankingCredits).toBe(30);
    expect(r.assessableIncome).toBe(100);
    // tax = 100 * 0.39 - 30 = 9
    expect(r.netTax).toBe(9);
  });

  it("unfranked foreign is cash × combined rate", () => {
    const r = estimateDividendTax({
      cashAud: 100,
      frankingPercent: 0,
      profile: profile37,
    });
    expect(r.frankingCredits).toBe(0);
    expect(r.netTax).toBe(39);
  });
});

describe("estimateDividendTaxBatch", () => {
  it("aggregates lines", () => {
    const r = estimateDividendTaxBatch(
      [
        { cashAud: 70, frankingPercent: 100 },
        { cashAud: 100, frankingPercent: 0 },
      ],
      profile37,
    );
    expect(r.cashAud).toBe(170);
    expect(r.frankingCredits).toBe(30);
    expect(r.assessableIncome).toBe(200);
    // grossTax = 200 * 0.39 = 78; net = 78 - 30 = 48
    expect(r.netTax).toBe(48);
  });
});

describe("estimateFyDividendTax", () => {
  it("applies ASX franking default and foreign withholding gross-up", () => {
    const summary = estimateFyDividendTax(
      [
        {
          financialYear: "FY2025",
          exchange: "ASX",
          currency: "AUD",
          amountAud: 70,
        },
        {
          financialYear: "FY2025",
          exchange: "NASDAQ",
          currency: "USD",
          // ledger net of 15% withholding on 100 gross → 85
          amountAud: 85,
        },
      ],
      {
        profile: profile37,
        asxFrankingPercent: 100,
        usWithholdingRate: 0.15,
        ledgerIsNetOfWithholding: true,
      },
    );

    expect(summary.byFy).toHaveLength(1);
    const fy = summary.byFy[0]!;
    // ledger cash: 70 + 85
    expect(fy.cashAud).toBe(155);
    // assessable cash: ASX 70 + foreign gross 100
    expect(fy.assessableCashAud).toBe(170);
    // franking on ASX 100%: 30
    expect(fy.frankingCredits).toBe(30);
    expect(fy.withheldEstimate).toBe(15);
    // assessable income 170+30=200; gross tax 78; after franking 48
    expect(fy.assessableIncome).toBe(200);
    expect(fy.grossTax).toBe(78);
    // FITO proxy: min(withheld 15, foreign gross tax 39, after franking 48) = 15
    expect(fy.fitoEstimate).toBe(15);
    expect(fy.netTax).toBe(33);
    expect(summary.totals.netTax).toBe(33);
  });

  it("when ledger is gross, does not gross up foreign cash and applies FITO", () => {
    const summary = estimateFyDividendTax(
      [
        {
          financialYear: "FY2024",
          exchange: "US",
          currency: "USD",
          amountAud: 100,
        },
      ],
      {
        profile: profile37,
        usWithholdingRate: 0.15,
        ledgerIsNetOfWithholding: false,
      },
    );
    const fy = summary.byFy[0]!;
    expect(fy.assessableCashAud).toBe(100);
    expect(fy.withheldEstimate).toBe(15);
    expect(fy.frankingCredits).toBe(0);
    // gross tax 39; FITO min(15, 39, 39) = 15 → net 24
    expect(fy.fitoEstimate).toBe(15);
    expect(fy.netTax).toBe(24);
  });

  it("skips null amountAud lines", () => {
    const summary = estimateFyDividendTax(
      [
        {
          financialYear: "FY2025",
          exchange: "NASDAQ",
          currency: "USD",
          amountAud: null,
        },
      ],
      { profile: profile37 },
    );
    expect(summary.byFy).toHaveLength(0);
    expect(summary.totals.cashAud).toBe(0);
  });

  it("rolls multiple FYs independently", () => {
    const summary = estimateFyDividendTax(
      [
        {
          financialYear: "FY2025",
          exchange: "ASX",
          currency: "AUD",
          amountAud: 100,
        },
        {
          financialYear: "FY2024",
          exchange: "ASX",
          currency: "AUD",
          amountAud: 50,
        },
      ],
      {
        profile: profile37,
        asxFrankingPercent: 0,
      },
    );
    expect(summary.byFy.map((r) => r.financialYear)).toEqual([
      "FY2025",
      "FY2024",
    ]);
    expect(summary.byFy[0]!.netTax).toBe(39);
    expect(summary.byFy[1]!.netTax).toBe(19.5);
    expect(summary.totals.netTax).toBe(58.5);
  });

  it("uses 70% franking default for ASX when not specified", () => {
    // cash 100 @ 70% franking → credits = 100 * 0.7 * 30/70 = 30
    const summary = estimateFyDividendTax(
      [
        {
          financialYear: "FY2025",
          exchange: "ASX",
          currency: "AUD",
          amountAud: 100,
        },
      ],
      { profile: profile37 },
    );
    expect(summary.byFy[0]!.frankingCredits).toBe(30);
  });
});
