import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectPdfLayout } from "./detect.js";
import {
  parseSelfwealthAnnualText,
  selfwealthAnnualLayout,
} from "./layouts/selfwealth-annual.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "../../../../../fixtures/pdf");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

describe("selfwealth.annual — detect", () => {
  it("scores the synthetic 2020+-style fixture as a high-confidence match", () => {
    const text = readFixture("selfwealth-annual-sample.txt");
    const detected = detectPdfLayout({ filename: "SelfWealth-Annual.pdf", text });
    expect(detected.layoutId).toBe("selfwealth.annual");
    expect(detected.confidence).toBe("high");
    expect(detected.suggestedBroker).toBe("selfwealth");
    expect(detected.suggestedCustody).toBe("selfwealth");
  });

  it("scores the synthetic 2019-style fixture (Order ID + Contract Note columns) as a high-confidence match", () => {
    const text = readFixture("selfwealth-annual-2019-style-sample.txt");
    const detected = detectPdfLayout({ filename: "SelfWealth-Annual.pdf", text });
    expect(detected.layoutId).toBe("selfwealth.annual");
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

describe("selfwealth.annual — parse (2019-style: Order ID + Contract Note, no Fees column)", () => {
  it("parses a single Buy plus its dividend_cash row", () => {
    const text = readFixture("selfwealth-annual-2019-style-sample.txt");
    const result = parseSelfwealthAnnualText(text, "SelfWealth-Annual.pdf");

    expect(result.broker).toBe("selfwealth");
    expect(result.transactions).toHaveLength(2);

    const buy = result.transactions.find((t) => t.type === "buy")!;
    expect(buy).toMatchObject({
      date: "2018-08-11",
      ticker: "ZZE",
      exchange: "ASX",
      type: "buy",
      quantity: 50,
      price: 10,
      amount: 500,
      brokerage: 9.5,
      currency: "AUD",
    });

    const div = result.transactions.find((t) => t.type === "dividend_cash")!;
    expect(div).toMatchObject({
      date: "2019-01-02",
      ticker: "ZZE",
      type: "dividend_cash",
      quantity: 0,
      price: 0.2,
      amount: 10,
    });
  });
});

describe("selfwealth.annual — parse (2020+ style: Reference + Fees column, multi-ticker)", () => {
  it("resolves Buy/Sell quantities via arithmetic cross-check against consideration", () => {
    const text = readFixture("selfwealth-annual-sample.txt");
    const result = parseSelfwealthAnnualText(text, "SelfWealth-Annual.pdf");

    const buy = result.transactions.find((t) => t.ticker === "ZZA" && t.type === "buy")!;
    expect(buy).toMatchObject({
      date: "2023-08-01",
      quantity: 50,
      price: 10,
      amount: 500,
      brokerage: 9.5,
    });

    const sell = result.transactions.find((t) => t.ticker === "ZZA" && t.type === "sell")!;
    expect(sell).toMatchObject({
      date: "2024-02-01",
      quantity: 20,
      price: 11,
      amount: 220,
      brokerage: 9.5,
    });
  });

  it("resolves DRP quantities via balance reconciliation (opening -> dividend-table checkpoint -> closing), no cost/price attached", () => {
    const text = readFixture("selfwealth-annual-sample.txt");
    const result = parseSelfwealthAnnualText(text, "SelfWealth-Annual.pdf");

    const drps = result.transactions.filter((t) => t.ticker === "ZZB" && t.type === "drp");
    expect(drps).toHaveLength(2);
    expect(drps.find((d) => d.date === "2023-07-16")).toMatchObject({
      quantity: 1,
      price: null,
      amount: null,
      notes: "Security In: Dividend Plan Allotment",
    });
    expect(drps.find((d) => d.date === "2023-10-16")).toMatchObject({ quantity: 1 });

    // Neither DRP resolution should have produced a reconciliation warning —
    // both are cleanly solvable (one via the Oct dividend-table checkpoint,
    // one via the closing holdings balance).
    expect(result.warnings.filter((w) => /ZZB/.test(w.message))).toHaveLength(0);
  });

  it("emits dividend_cash rows with the disambiguated per-unit rate and franking%, using the franking-credit cross-check (not just estDiv) to split the glued digits", () => {
    const text = readFixture("selfwealth-annual-sample.txt");
    const result = parseSelfwealthAnnualText(text, "SelfWealth-Annual.pdf");

    const div = result.transactions.find(
      (t) => t.ticker === "ZZB" && t.type === "dividend_cash" && t.date === "2023-10-01",
    )!;
    // Glued source text is "$0.04984.7%101..." — divAmount=0.049, franking=84.7%.
    // estDiv alone can't tell this apart from e.g. divAmount=0.0498,franking=4.7
    // (both land on ~$4.95 once rounded) -- only the Franking Credit/Unfranked
    // Amount cross-check disambiguates correctly.
    expect(div.price).toBe(0.049);
    expect(div.amount).toBeCloseTo(4.95, 2);
    expect(div.notes).toContain("84.7% franked");
  });

  it("classifies a non-DRP 'Security In' row as transfer_in with a cleanly reconciled quantity", () => {
    const text = readFixture("selfwealth-annual-sample.txt");
    const result = parseSelfwealthAnnualText(text, "SelfWealth-Annual.pdf");

    const transferIn = result.transactions.find((t) => t.ticker === "ZZD")!;
    expect(transferIn).toMatchObject({
      type: "transfer_in",
      quantity: 200,
      price: null,
      amount: null,
      notes: "Security In: Effected Registry to HIN Conversion",
    });
  });

  it("does not emit a transaction for 'Security Out' rows, logging an info note instead", () => {
    const text = readFixture("selfwealth-annual-sample.txt");
    const result = parseSelfwealthAnnualText(text, "SelfWealth-Annual.pdf");

    expect(result.transactions.some((t) => /Move.Out/.test(t.notes ?? ""))).toBe(false);
    expect(
      result.warnings.some((w) => w.severity === "info" && /Security Out.*not recorded/.test(w.message)),
    ).toBe(true);
  });

  it("warns (rather than silently guessing with false confidence) when a DRP allotment has no reconciliation checkpoint between it and the ticker's own full Move-Out", () => {
    const text = readFixture("selfwealth-annual-sample.txt");
    const result = parseSelfwealthAnnualText(text, "SelfWealth-Annual.pdf");

    // ZZC: opening 40 -> DRP (20 Apr) -> Out (13 May, full exit) -> closing
    // absent (0). No dividend/holdings checkpoint falls between the DRP and
    // the Out, so their individual quantities are genuinely underdetermined
    // from this statement alone (2 unknowns, 1 equation).
    const drp = result.transactions.find((t) => t.ticker === "ZZC" && t.type === "drp")!;
    expect(drp).toBeDefined();
    expect(
      result.warnings.some(
        (w) => w.severity === "warn" && /ZZC/.test(w.message) && /could not confidently determine units/.test(w.message),
      ),
    ).toBe(true);
  });

  it("dedupes rows collected across duplicated pages (fixture repeats the whole statement twice)", () => {
    const text = readFixture("selfwealth-annual-sample.txt");
    const result = parseSelfwealthAnnualText(text, "SelfWealth-Annual.pdf");

    // 2 ZZA (buy+sell) + 4 ZZB (2 div + 2 drp) + 2 ZZC (1 div + 1 drp) + 1 ZZD
    // (transfer_in) = 9, not 18 — the fixture's page-duplication must not
    // double-count.
    expect(result.transactions).toHaveLength(9);
  });
});

describe("selfwealth.annual — layout wiring", () => {
  it("exposes the registered LayoutParser with the expected id", () => {
    expect(selfwealthAnnualLayout.id).toBe("selfwealth.annual");
  });
});
