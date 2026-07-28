import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectPdfLayout } from "./detect.js";
import {
  linkMufgIssuerAnnualLayout,
  parseLinkMufgIssuerAnnualText,
} from "./layouts/link-mufg-issuer-annual.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../../../../fixtures/pdf");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

describe("link_mufg.issuer_etf_annual — detect", () => {
  it("scores the synthetic NDQ-2024 fixture (MUFG era) as a high-confidence match", () => {
    const text = readFixture("link-mufg-issuer-annual-ndq2024-sample.txt");
    const detected = detectPdfLayout({ filename: "annual-2024.pdf", text });
    expect(detected.layoutId).toBe("link_mufg.issuer_etf_annual");
    expect(detected.confidence).toBe("high");
    expect(detected.suggestedBroker).toBe("generic");
    expect(detected.suggestedCustody).toBeNull();
  });

  it("scores the synthetic NDQ-2023 fixture (Link era) as a high-confidence match", () => {
    const text = readFixture("link-mufg-issuer-annual-ndq2023-sample.txt");
    const detected = detectPdfLayout({ filename: "annual-2023.pdf", text });
    expect(detected.layoutId).toBe("link_mufg.issuer_etf_annual");
    expect(detected.confidence).toBe("high");
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

describe("link_mufg.issuer_etf_annual — parse (NDQ-2024 — Appendix B.4: exactly 1 drp)", () => {
  it("computes the allotment quantity from the balance delta (44 -> 45 = qty 1), plus dividend_cash per Distribution Details period (Phase 6 §19)", () => {
    const text = readFixture("link-mufg-issuer-annual-ndq2024-sample.txt");
    const result = parseLinkMufgIssuerAnnualText(text, "annual-2024.pdf");

    expect(result.broker).toBe("generic");
    // 1 drp (unchanged from phase 4) + 2 dividend_cash (Phase 6 — one per
    // Distribution Details period: 31/12/2023 and 30/06/2024).
    expect(result.transactions).toHaveLength(3);

    const drp = result.transactions.find((t) => t.type === "drp")!;
    expect(drp).toMatchObject({
      date: "2024-07-16",
      ticker: "NDQ",
      exchange: "ASX",
      type: "drp",
      quantity: 1,
      price: null,
      currency: "AUD",
      externalId: "link-ndq-2024-07-16-drp",
    });

    // Phase 6: gross Distribution amount per period (before tax withheld),
    // Distribution Rate as a confidently-labelled per-unit price — see
    // fixture: "31/12/202344$0.02945941$1.30$0.00$1.30" and
    // "30/06/202444$0.91684553$40.34$0.00$40.34".
    const cashRows = result.transactions.filter((t) => t.type === "dividend_cash");
    expect(cashRows).toHaveLength(2);
    const byDate = Object.fromEntries(cashRows.map((t) => [t.date, t]));
    expect(byDate["2023-12-31"]).toMatchObject({
      ticker: "NDQ",
      exchange: "ASX",
      type: "dividend_cash",
      quantity: 0,
      price: 0.02945941,
      amount: 1.3,
      currency: "AUD",
      externalId: "link-ndq-2023-12-31-dividend_cash",
    });
    expect(byDate["2024-06-30"]).toMatchObject({
      price: 0.91684553,
      amount: 40.34,
      externalId: "link-ndq-2024-06-30-dividend_cash",
    });

    expect(result.warnings.every((w) => w.severity !== "error")).toBe(true);
  });

  it("layout.parse wraps the text-parsing function", () => {
    const text = readFixture("link-mufg-issuer-annual-ndq2024-sample.txt");
    const result = linkMufgIssuerAnnualLayout.parse({
      content: Buffer.from(""),
      filename: "annual-2024.pdf",
      text,
    });
    expect(result.transactions).toHaveLength(3);
    expect(result.broker).toBe("generic");
  });
});

describe("link_mufg.issuer_etf_annual — parse (NDQ-2023 — Appendix B.3: drp + CHESS movement)", () => {
  it("emits 1 drp (allotment) and 1 transfer_in (CHESS net movement) with a warning, plus dividend_cash per Distribution Details period (Phase 6)", () => {
    const text = readFixture("link-mufg-issuer-annual-ndq2023-sample.txt");
    const result = parseLinkMufgIssuerAnnualText(text, "annual-2023.pdf");

    expect(result.broker).toBe("generic");
    // 1 drp + 1 transfer_in (unchanged from phase 4) + 2 dividend_cash
    // (Phase 6 — 31/12/2022 and 30/06/2023 in this fixture's Distribution
    // Details section).
    expect(result.transactions).toHaveLength(4);

    const drp = result.transactions.find((t) => t.type === "drp")!;
    expect(drp).toMatchObject({
      date: "2023-07-18",
      ticker: "NDQ",
      type: "drp",
      quantity: 1,
      price: null,
      externalId: "link-ndq-2023-07-18-drp",
    });

    const chess = result.transactions.find((t) => t.type === "transfer_in")!;
    expect(chess).toMatchObject({
      date: "2023-12-14",
      ticker: "NDQ",
      type: "transfer_in",
      quantity: 5,
      price: null,
      externalId: "link-ndq-2023-12-14-transfer_in-5",
    });
    expect(chess.notes).toMatch(/CHESS/i);

    // Never buy at NAV (docs §15.5) — the CHESS movement must carry a warning.
    expect(
      result.warnings.some(
        (w) => w.severity === "warn" && /CHESS/i.test(w.message) && /2023-12-14/.test(w.message),
      ),
    ).toBe(true);

    const cashRows = result.transactions.filter((t) => t.type === "dividend_cash");
    expect(cashRows).toHaveLength(2);
    const byDate = Object.fromEntries(cashRows.map((t) => [t.date, t]));
    expect(byDate["2022-12-31"]).toMatchObject({
      ticker: "NDQ",
      type: "dividend_cash",
      quantity: 0,
      price: 0.0310288,
      amount: 1.18,
      externalId: "link-ndq-2022-12-31-dividend_cash",
    });
    expect(byDate["2023-06-30"]).toMatchObject({
      price: 0.78268588,
      amount: 29.74,
      externalId: "link-ndq-2023-06-30-dividend_cash",
    });

    expect(result.warnings.every((w) => w.severity !== "error")).toBe(true);
  });
});

describe("link_mufg.issuer_etf_annual — no activity", () => {
  it("returns 0 transactions (not an error) when balance is unchanged for the period", () => {
    const text = `
Name of Fund:BETASHARES NASDAQ 100 ETF
ANNUAL STATEMENT
Transaction Details
DateTransaction DetailsUnitsBalancePrice
1
Value
2
01/01/2025Opening Balance4545$50.45116500$2,270.30
31/12/2025Closing Balance045$55.78722400$2,510.43
ASX Code: NDQ
C/- MUFG Corporate Markets (AU) Limited
`;
    const result = parseLinkMufgIssuerAnnualText(text, "annual-2025.pdf");
    expect(result.transactions).toHaveLength(0);
    expect(result.broker).toBe("generic");
    expect(
      result.warnings.some(
        (w) => w.severity === "info" && /no ledger transactions/i.test(w.message),
      ),
    ).toBe(true);
    expect(result.warnings.every((w) => w.severity !== "error")).toBe(true);
  });
});

describe("link_mufg.issuer_etf_annual — malformed input", () => {
  it("errors cleanly (no throw, no fabricated rows) when the Transaction Details section is missing", () => {
    const result = parseLinkMufgIssuerAnnualText("BETASHARES ANNUAL STATEMENT with nothing else", "x.pdf");
    expect(result.transactions).toHaveLength(0);
    expect(result.warnings.some((w) => w.severity === "error")).toBe(true);
  });

  it("warns (not fabricates) a dividend_cash row for an unparseable Distribution Details entry (Phase 6)", () => {
    const text = `
Name of Fund:BETASHARES NASDAQ 100 ETF
ANNUAL STATEMENT
Transaction Details
DateTransaction DetailsUnitsBalancePrice
1
Value
2
01/01/2025Opening Balance4545$50.45116500$2,270.30
31/12/2025Closing Balance045$55.78722400$2,510.43
ASX Code: NDQ

Distribution Details
Period Ended
UnitsDistribution RateDistributionTax WithheldNet Distribution
30/06/2025 this line is garbled and does not match the expected shape
Total*$0.00$0.00$0.00
`;
    const result = parseLinkMufgIssuerAnnualText(text, "annual-2025.pdf");
    // No dividend_cash row fabricated from the garbled line.
    expect(result.transactions.some((t) => t.type === "dividend_cash")).toBe(false);
    expect(
      result.warnings.some(
        (w) => w.severity === "warn" && /unparseable Distribution Details entry/i.test(w.message),
      ),
    ).toBe(true);
    expect(result.warnings.every((w) => w.severity !== "error")).toBe(true);
  });
});
