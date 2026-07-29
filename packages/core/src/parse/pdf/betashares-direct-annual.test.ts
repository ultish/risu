import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectPdfLayout } from "./detect.js";
import { betasharesDirectAnnualLayout, parseBetasharesDirectAnnualText } from "./layouts/betashares-direct-annual.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(
  __dirname,
  "../../../../../fixtures/pdf/betashares-direct-annual-sample.txt",
);

function readFixture(): string {
  return fs.readFileSync(FIXTURE, "utf8");
}

describe("betashares_direct.platform_annual — detect", () => {
  it("scores the synthetic fixture as a high-confidence match", () => {
    const text = readFixture();
    const detected = detectPdfLayout({ filename: "sample.pdf", text });
    expect(detected.layoutId).toBe("betashares_direct.platform_annual");
    expect(detected.confidence).toBe("high");
    expect(detected.suggestedBroker).toBe("betashares_direct");
    expect(detected.suggestedCustody).toBe("betashares_direct");
  });

  it("scores plain unrelated text as unknown", () => {
    const detected = detectPdfLayout({
      filename: "whatever.pdf",
      text: "Just some random PDF text with no fingerprints at all.",
    });
    expect(detected.layoutId).toBe("unknown");
    expect(detected.confidence).toBe("none");
  });
});

describe("betashares_direct.platform_annual — parse", () => {
  it("parses buys, a sell, fees and a cash distribution from the synthetic fixture", () => {
    const text = readFixture();
    const result = parseBetasharesDirectAnnualText(text, "sample.pdf");

    expect(result.broker).toBe("betashares_direct");
    expect(result.transactions).toHaveLength(5);

    const buys = result.transactions.filter((t) => t.type === "buy");
    const sells = result.transactions.filter((t) => t.type === "sell");
    const fees = result.transactions.filter((t) => t.type === "fee");
    const dividends = result.transactions.filter(
      (t) => t.type === "dividend_cash",
    );
    expect(buys).toHaveLength(3);
    expect(sells).toHaveLength(1);
    expect(fees).toHaveLength(0);
    expect(dividends).toHaveLength(1);

    const ndqBuy = buys.find(
      (t) => t.ticker === "NDQ" && t.date === "2025-08-01",
    )!;
    expect(ndqBuy).toMatchObject({
      exchange: "ASX",
      currency: "AUD",
      quantity: 5,
      price: 40,
      amount: 200,
      brokerage: 0,
      externalId: "bsd-2025-08-01-buy-NDQ-5-40",
    });

    const bgblBuy = buys.find((t) => t.ticker === "BGBL")!;
    expect(bgblBuy).toMatchObject({ quantity: 2, price: 50, amount: 100 });

    const bgblSell = sells[0]!;
    expect(bgblSell).toMatchObject({
      ticker: "BGBL",
      date: "2025-09-15",
      quantity: 1,
      price: 55,
      amount: 55,
      externalId: "bsd-2025-09-15-sell-BGBL-1-55",
    });

    // Fees aren't tied to any instrument (docs/import-layouts-plan.md
    // Appendix C.4, revised): skip them like deposits rather than importing
    // a synthetic "FEE" ticker, which showed up as a phantom holding.
    expect(
      result.warnings.some(
        (w) => w.severity === "info" && /auto-pilot fee/i.test(w.message),
      ),
    ).toBe(true);

    const dist = dividends[0]!;
    expect(dist).toMatchObject({
      ticker: "NDQ",
      date: "2026-01-17",
      quantity: 0,
      price: 0.576,
      amount: 5.76,
      externalId: "bsd-2026-01-17-dividend_cash-NDQ-0-0.576",
    });

    // Deposits are skipped but surfaced as a single info warning, not silently
    // dropped (docs §15.3 "warn > silent drop").
    expect(
      result.warnings.some(
        (w) => w.severity === "info" && /deposit/i.test(w.message),
      ),
    ).toBe(true);
    expect(result.warnings.every((w) => w.severity !== "error")).toBe(true);
  });

  it("returns 0 security transactions (not an error) for a deposit-only statement", () => {
    const text = `
Betashares Capital Ltd ABN 78 139 566 868 AFSL 341181 is the issuer of Betashares Invest Fund ARSN 667 811 627, the IDPS-like scheme available through Betashares Direct.
Annual Statement
Transaction list
E ective DateActivity typeDescriptionGross ValueTransaction costNet Value
19/01/2024DepositDeposit into your cash account$1.00$0.00$1.00
Total$1.00$0.00$1.00
`;
    const result = parseBetasharesDirectAnnualText(text, "empty.pdf");
    expect(result.transactions).toHaveLength(0);
    expect(result.broker).toBe("betashares_direct");
    expect(
      result.warnings.some(
        (w) => w.severity === "info" && /no security transactions/i.test(w.message),
      ),
    ).toBe(true);
    expect(result.warnings.every((w) => w.severity !== "error")).toBe(true);
  });

  it("layout.parse wraps the text-parsing function", () => {
    const text = readFixture();
    const result = betasharesDirectAnnualLayout.parse({
      content: Buffer.from(""),
      filename: "sample.pdf",
      text,
    });
    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.broker).toBe("betashares_direct");
  });
});
