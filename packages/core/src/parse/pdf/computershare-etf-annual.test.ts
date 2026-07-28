import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectPdfLayout } from "./detect.js";
import {
  computershareEtfAnnualLayout,
  parseComputershareEtfAnnualText,
} from "./layouts/computershare-etf-annual.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../../../../fixtures/pdf");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

describe("computershare.etf_annual — detect", () => {
  it("scores the synthetic VGS fixture as a high-confidence match", () => {
    const text = readFixture("computershare-etf-annual-vgs-sample.txt");
    const detected = detectPdfLayout({ filename: "VGS-2024-annualstatement.pdf", text });
    expect(detected.layoutId).toBe("computershare.etf_annual");
    expect(detected.confidence).toBe("high");
    expect(detected.suggestedBroker).toBe("generic");
    // Issuer PDF custody is never auto-assigned (docs §5) — user override required.
    expect(detected.suggestedCustody).toBeNull();
  });

  it("scores the synthetic IOZ fixture as a high-confidence match", () => {
    const text = readFixture("computershare-etf-annual-ioz-sample.txt");
    const detected = detectPdfLayout({ filename: "annual-2024.pdf", text });
    expect(detected.layoutId).toBe("computershare.etf_annual");
    expect(detected.confidence).toBe("high");
    expect(detected.suggestedCustody).toBeNull();
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

describe("computershare.etf_annual — parse (VGS, DRP pattern — Appendix A.3)", () => {
  it("imports the qty>0 DRP row unchanged, PLUS a dividend_cash row per period incl. the 0-unit reinvests (Phase 6 §19)", () => {
    const text = readFixture("computershare-etf-annual-vgs-sample.txt");
    const result = parseComputershareEtfAnnualText(text, "VGS-2024-annualstatement.pdf");

    expect(result.broker).toBe("generic");
    // 1 drp (unchanged from phase 4) + 4 dividend_cash (Phase 6 — one per
    // Distribution Reinvested period, 0-unit or not).
    expect(result.transactions).toHaveLength(5);

    const drp = result.transactions.find((t) => t.type === "drp")!;
    expect(drp).toMatchObject({
      date: "2024-01-17",
      ticker: "VGS",
      exchange: "ASX",
      type: "drp",
      quantity: 1,
      price: 113.19,
      amount: 113.19,
      currency: "AUD",
      externalId: "cs-vgs-2024-01-17-drp-1",
    });

    // Phase 6: one dividend_cash row per Distribution Reinvested period,
    // gross amount derived from the Distribution Reinvestment Cash Balance
    // table deltas (see layout module doc comment) — verified by hand against
    // the real VGS-2024 statement: 81.71-45.98=35.73; 103.21-81.71=21.50;
    // 11.02-103.21+1*113.19=21.00; 44.12-11.02=33.10.
    const cashRows = result.transactions.filter((t) => t.type === "dividend_cash");
    expect(cashRows).toHaveLength(4);
    const byDate = Object.fromEntries(cashRows.map((t) => [t.date, t]));
    expect(byDate["2023-07-18"]).toMatchObject({
      ticker: "VGS",
      exchange: "ASX",
      type: "dividend_cash",
      quantity: 0,
      price: null,
      amount: 35.73,
      currency: "AUD",
      externalId: "cs-vgs-2023-07-18-dividend_cash",
    });
    expect(byDate["2023-10-17"]).toMatchObject({ amount: 21.5, externalId: "cs-vgs-2023-10-17-dividend_cash" });
    // Same date as the drp row above — both must be present (design point 1:
    // dividend_cash runs ALONGSIDE the existing drp row, not instead of it).
    expect(byDate["2024-01-17"]).toMatchObject({ amount: 21, externalId: "cs-vgs-2024-01-17-dividend_cash" });
    expect(byDate["2024-04-17"]).toMatchObject({ amount: 33.1, externalId: "cs-vgs-2024-04-17-dividend_cash" });

    // The three 0-unit reinvests (2023-07-18, 2023-10-17, 2024-04-17) must
    // still warn (drp not imported for them), not silently vanish (docs
    // §15.3 "warn > silent drop") — unchanged from phase 4.
    const zeroUnitWarnings = result.warnings.filter(
      (w) => w.severity === "info" && /0-unit Distribution Reinvested/i.test(w.message),
    );
    expect(zeroUnitWarnings).toHaveLength(3);
    expect(result.warnings.every((w) => w.severity !== "error")).toBe(true);
  });

  it("layout.parse wraps the text-parsing function", () => {
    const text = readFixture("computershare-etf-annual-vgs-sample.txt");
    const result = computershareEtfAnnualLayout.parse({
      content: Buffer.from(""),
      filename: "VGS-2024-annualstatement.pdf",
      text,
    });
    expect(result.transactions).toHaveLength(5);
    expect(result.broker).toBe("generic");
  });
});

describe("computershare.etf_annual — parse (IOZ, unknown-price Purchase — Appendix A.4)", () => {
  it("imports the Purchase as transfer_in with null price (never fabricates a $0 cost base), plus dividend_cash for both 0-unit reinvests (Phase 6)", () => {
    const text = readFixture("computershare-etf-annual-ioz-sample.txt");
    const result = parseComputershareEtfAnnualText(text, "annual-2024.pdf");

    expect(result.broker).toBe("generic");

    const transferIns = result.transactions.filter((t) => t.type === "transfer_in");
    expect(transferIns).toHaveLength(1);
    expect(transferIns[0]).toMatchObject({
      date: "2023-12-13",
      ticker: "IOZ",
      exchange: "ASX",
      quantity: 8,
      price: null,
      amount: null,
      externalId: "cs-ioz-2023-12-13-transfer_in-8",
    });
    expect(result.transactions.some((t) => t.type === "buy")).toBe(false);

    // Strong warning that the cost base was not fabricated.
    expect(
      result.warnings.some(
        (w) => w.severity === "warn" && /price null/i.test(w.message) && /2023-12-13/.test(w.message),
      ),
    ).toBe(true);

    // Both 0-unit reinvests in this fixture still warn (no drp row for
    // either — unchanged from phase 4)...
    const drps = result.transactions.filter((t) => t.type === "drp");
    expect(drps).toHaveLength(0);
    const zeroUnitWarnings = result.warnings.filter(
      (w) => w.severity === "info" && /0-unit Distribution Reinvested/i.test(w.message),
    );
    expect(zeroUnitWarnings).toHaveLength(2);

    // ...but Phase 6 now recovers the real distribution amount for each via
    // the Distribution Reinvestment Cash Balance table: 1.70-0=1.70 (opening
    // balance "-" = $0), 4.23-1.70=2.53.
    const cashRows = result.transactions.filter((t) => t.type === "dividend_cash");
    expect(cashRows).toHaveLength(2);
    const byDate = Object.fromEntries(cashRows.map((t) => [t.date, t]));
    expect(byDate["2024-01-18"]).toMatchObject({
      ticker: "IOZ",
      type: "dividend_cash",
      quantity: 0,
      price: null,
      amount: 1.7,
      externalId: "cs-ioz-2024-01-18-dividend_cash",
    });
    expect(byDate["2024-04-19"]).toMatchObject({ amount: 2.53, externalId: "cs-ioz-2024-04-19-dividend_cash" });

    expect(result.transactions).toHaveLength(3);
  });
});

describe("computershare.etf_annual — malformed input", () => {
  it("errors cleanly (no throw, no fabricated rows) when the transaction table anchor is missing", () => {
    const result = parseComputershareEtfAnnualText("Computershare ASX Code: XYZ nothing else here", "x.pdf");
    expect(result.transactions).toHaveLength(0);
    expect(result.warnings.some((w) => w.severity === "error")).toBe(true);
  });

  it("warns (not fabricates) dividend_cash rows when the Distribution Reinvestment Cash Balance table is missing/malformed (Phase 6)", () => {
    // Same Transaction List shape as the VGS fixture, but the second block
    // ("Cash Distribution Received" / balance table) is missing entirely —
    // e.g. a layout drift in a future statement year.
    const text = `
ASX Code: VGS
Transaction ListUnit TransactionsUnit Price
30/06/2023
18/07/2023
30/06/2024
Opening Balance
Distribution Reinvested
Closing Balance
$107.12
$106.03
$124.73
32
33
33
Fees and Costs Summary
`;
    const result = parseComputershareEtfAnnualText(text, "VGS-malformed.pdf");
    // drp still imports fine (delta 32->33 = 1 unit) — Phase 6 must not
    // regress the existing drp logic.
    const drps = result.transactions.filter((t) => t.type === "drp");
    expect(drps).toHaveLength(1);
    // No dividend_cash rows fabricated — warn instead (docs §15.3).
    expect(result.transactions.some((t) => t.type === "dividend_cash")).toBe(false);
    expect(
      result.warnings.some(
        (w) => w.severity === "warn" && /Distribution Reinvestment Cash Balance/i.test(w.message),
      ),
    ).toBe(true);
    expect(result.warnings.every((w) => w.severity !== "error")).toBe(true);
  });
});
