import type { BrokerId } from "../../types.js";
import type { DetectConfidence, DetectResult, LayoutId } from "../layouts.js";
import { LAYOUT_LABELS } from "../layouts.js";
import { LAYOUT_PARSERS } from "./registry.js";
import type { LayoutScoreInput } from "./types.js";

/** score >= 2 fingerprint hits to consider it a match (docs §11.2). */
const THRESHOLD = 2;

/** Custody/broker suggestion per layout — see docs/import-layouts-plan.md §5. */
const LAYOUT_ROUTING: Record<
  Exclude<LayoutId, "unknown" | "stake.activity" | "stake.income">,
  { suggestedBroker: BrokerId; suggestedCustody: string | null }
> = {
  "betashares_direct.platform_annual": {
    suggestedBroker: "betashares_direct",
    suggestedCustody: "betashares_direct",
  },
  "computershare.etf_annual": { suggestedBroker: "generic", suggestedCustody: null },
  "link_mufg.issuer_etf_annual": { suggestedBroker: "generic", suggestedCustody: null },
  "selfwealth.annual": { suggestedBroker: "selfwealth", suggestedCustody: "selfwealth" },
  "selfwealth.international_annual": {
    suggestedBroker: "selfwealth",
    suggestedCustody: "selfwealth",
  },
};

/**
 * Detect which PDF layout (if any) the extracted text matches. Best score
 * wins; below `THRESHOLD` → unknown (caller falls back to
 * `unsupportedPdfResult`). This is also how Stake PDFs stay rejected forever
 * — no registered layout fingerprints Stake's export text, so they always
 * score 0 (docs/import-layouts-plan.md §1 non-goals).
 */
export function detectPdfLayout(input: LayoutScoreInput): DetectResult {
  let bestId: LayoutId = "unknown";
  let bestScore = 0;
  for (const layout of LAYOUT_PARSERS) {
    const s = layout.score(input);
    if (s > bestScore) {
      bestScore = s;
      bestId = layout.id;
    }
  }

  if (bestScore < THRESHOLD || bestId === "unknown") {
    return {
      layoutId: "unknown",
      confidence: "none",
      suggestedBroker: "generic",
      suggestedCustody: null,
      label: LAYOUT_LABELS.unknown,
      reasons: [],
    };
  }

  const confidence: DetectConfidence = bestScore >= 3 ? "high" : "low";
  const routing = LAYOUT_ROUTING[
    bestId as keyof typeof LAYOUT_ROUTING
  ] ?? { suggestedBroker: "generic" as BrokerId, suggestedCustody: null };

  return {
    layoutId: bestId,
    confidence,
    suggestedBroker: routing.suggestedBroker,
    suggestedCustody: routing.suggestedCustody,
    label: LAYOUT_LABELS[bestId],
    reasons: [`fingerprint score ${bestScore}`],
  };
}
