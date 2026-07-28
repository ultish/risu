import { describe, expect, it } from "vitest";
import { detectPdfLayout } from "./detect.js";
import { LAYOUT_PARSERS } from "./registry.js";

/**
 * Registry-level guard (docs/import-layouts-plan.md §11.3: "Reject Stake
 * PDF"): Stake PDF was never in scope for this plan (XLSX only — see §1
 * non-goals) and no real Stake PDF sample exists on disk, so this constructs
 * a small synthetic "looks like a Stake PDF export" text sample. It must
 * keep resolving to unknown even with all Phase 3+4 layouts registered —
 * i.e. none of Betashares Direct / Computershare / Link-MUFG's fingerprints
 * may accidentally fire on Stake's wording.
 */
const STAKE_LIKE_TEXT = `
Stake Invest Pty Ltd
Investment Activity
Report Type: Investment Activity
Aus Equities
Wall St Equities
Trade Date, Settlement Date, Symbol, Name, Side, Trade Identifier, Units, Avg. Price, Value, Fees, GST, Total Value, Currency
2024-12-10,2024-12-12,TSLA,Tesla Inc,Buy,3261932724,0.0686277,392.99,26.97,3,0,26.97,USD
`;

describe("PDF layout registry — Stake PDF guard", () => {
  it("registers exactly the three Phase 3+4 layouts", () => {
    const ids = LAYOUT_PARSERS.map((l) => l.id).sort();
    expect(ids).toEqual(
      [
        "betashares_direct.platform_annual",
        "computershare.etf_annual",
        "link_mufg.issuer_etf_annual",
      ].sort(),
    );
  });

  it("Stake-like PDF text never matches any registered layout", () => {
    for (const layout of LAYOUT_PARSERS) {
      expect(layout.score({ filename: "annual-2025.pdf", text: STAKE_LIKE_TEXT })).toBe(0);
    }
    const detected = detectPdfLayout({ filename: "annual-2025.pdf", text: STAKE_LIKE_TEXT });
    expect(detected.layoutId).toBe("unknown");
    expect(detected.confidence).toBe("none");
  });
});
