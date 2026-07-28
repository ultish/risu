import { betasharesDirectAnnualLayout } from "./layouts/betashares-direct-annual.js";
import type { LayoutParser } from "./types.js";

/**
 * Ordered layout matchers. Phase 4 appends:
 *   computershareEtfAnnualLayout (VGS, IOZ)
 *   linkMufgIssuerAnnualLayout (NDQ)
 * Order doesn't matter for scoring (best score wins) but keep it stable for
 * readability / diff hygiene.
 */
export const LAYOUT_PARSERS: LayoutParser[] = [betasharesDirectAnnualLayout];

export function getLayoutParser(id: string): LayoutParser | undefined {
  return LAYOUT_PARSERS.find((l) => l.id === id);
}
