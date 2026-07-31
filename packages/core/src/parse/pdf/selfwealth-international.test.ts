import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectPdfLayout } from "./detect.js";
import {
  parseSelfwealthInternationalText,
  selfwealthInternationalLayout,
} from "./layouts/selfwealth-international.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../../../../fixtures/pdf");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

describe("selfwealth.international_annual — detect", () => {
  it("scores the synthetic fixture as a high-confidence match", () => {
    const text = readFixture("selfwealth-international-sample.txt");
    const detected = detectPdfLayout({ filename: "SelfWealth-International.pdf", text });
    expect(detected.layoutId).toBe("selfwealth.international_annual");
    expect(detected.confidence).toBe("high");
    expect(detected.suggestedBroker).toBe("selfwealth");
    expect(detected.suggestedCustody).toBe("selfwealth");
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

describe("selfwealth.international_annual — parse", () => {
  it("parses Contracts table rows in USD, quantity unambiguous (unlike the AU layout, no arithmetic solve needed)", () => {
    const text = readFixture("selfwealth-international-sample.txt");
    const result = parseSelfwealthInternationalText(text, "SelfWealth-International.pdf");

    expect(result.broker).toBe("selfwealth");
    expect(result.transactions).toHaveLength(2);

    const zzf = result.transactions.find((t) => t.ticker === "ZZF")!;
    expect(zzf).toMatchObject({
      date: "2024-01-04",
      ticker: "ZZF",
      exchange: "US",
      type: "buy",
      quantity: 5,
      price: 100,
      amount: 500,
      currency: "USD",
    });
    // brokerage + GST + other charges folded into one ledger brokerage field
    expect(zzf.brokerage).toBeCloseTo(9.35, 2);
  });

  it("handles an instrument name that line-wraps mid-cell in the source PDF text", () => {
    const text = readFixture("selfwealth-international-sample.txt");
    const result = parseSelfwealthInternationalText(text, "SelfWealth-International.pdf");

    // Fixture's second row: "...BUYZZGZeta Growth Fund\nETF\n10$50.00..." —
    // the ticker/instrument-name split must not choke on the embedded
    // newline inside the instrument name.
    const zzg = result.transactions.find((t) => t.ticker === "ZZG")!;
    expect(zzg).toMatchObject({
      date: "2024-01-04",
      type: "buy",
      quantity: 10,
      price: 50,
      amount: 500,
    });
  });

  it("dedupes rows collected across duplicated pages (fixture repeats the whole statement twice)", () => {
    const text = readFixture("selfwealth-international-sample.txt");
    const result = parseSelfwealthInternationalText(text, "SelfWealth-International.pdf");
    expect(result.transactions).toHaveLength(2);
  });

  it("returns no transactions and an info warning for a statement with no Contracts activity", () => {
    const result = parseSelfwealthInternationalText(
      "Contracts between 1 Jul 2024 - 30 Jun 2025\nNo Contracts during this period.\nScrip Movement between 1 Jul 2024 - 30 Jun 2025\nNo Scrip Movement during this period.",
      "empty.pdf",
    );
    expect(result.transactions).toHaveLength(0);
    expect(result.warnings.some((w) => w.severity === "info")).toBe(true);
  });

  it("warns rather than silently dropping when Scrip Movement or Corporate Action Cash Movement is non-empty (not yet parsed)", () => {
    const result = parseSelfwealthInternationalText(
      "Contracts between 1 Jul 2024 - 30 Jun 2025\nNo Contracts during this period.\n" +
        "Scrip Movement between 1 Jul 2024 - 30 Jun 2025\nSome real scrip movement row here.\n" +
        "Corporate Action Cash Movement between 1 Jul 2024 - 30 Jun 2025\nSome cash dividend row here.",
      "activity.pdf",
    );
    expect(result.warnings.some((w) => w.severity === "warn" && /Scrip Movement/.test(w.message))).toBe(true);
    expect(
      result.warnings.some((w) => w.severity === "warn" && /Corporate Action Cash Movement/.test(w.message)),
    ).toBe(true);
  });
});

describe("selfwealth.international_annual — layout wiring", () => {
  it("exposes the registered LayoutParser with the expected id", () => {
    expect(selfwealthInternationalLayout.id).toBe("selfwealth.international_annual");
  });
});
