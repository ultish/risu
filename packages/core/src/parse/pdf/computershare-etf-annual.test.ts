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
  it("imports only the qty>0 DRP row and warns (not silently drops) the 0-unit reinvests", () => {
    const text = readFixture("computershare-etf-annual-vgs-sample.txt");
    const result = parseComputershareEtfAnnualText(text, "VGS-2024-annualstatement.pdf");

    expect(result.broker).toBe("generic");
    expect(result.transactions).toHaveLength(1);

    const drp = result.transactions[0]!;
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

    // The three 0-unit reinvests (2023-07-18, 2023-10-17, 2024-04-17) must
    // warn, not silently vanish (docs §15.3 "warn > silent drop").
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
    expect(result.transactions).toHaveLength(1);
    expect(result.broker).toBe("generic");
  });
});

describe("computershare.etf_annual — parse (IOZ, unknown-price Purchase — Appendix A.4)", () => {
  it("imports the Purchase as transfer_in with null price (never fabricates a $0 cost base)", () => {
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

    // Both 0-unit reinvests in this fixture should warn, not import.
    const drps = result.transactions.filter((t) => t.type === "drp");
    expect(drps).toHaveLength(0);
    const zeroUnitWarnings = result.warnings.filter(
      (w) => w.severity === "info" && /0-unit Distribution Reinvested/i.test(w.message),
    );
    expect(zeroUnitWarnings).toHaveLength(2);
  });
});

describe("computershare.etf_annual — malformed input", () => {
  it("errors cleanly (no throw, no fabricated rows) when the transaction table anchor is missing", () => {
    const result = parseComputershareEtfAnnualText("Computershare ASX Code: XYZ nothing else here", "x.pdf");
    expect(result.transactions).toHaveLength(0);
    expect(result.warnings.some((w) => w.severity === "error")).toBe(true);
  });
});
