import { betasharesDirectAnnualLayout } from "./layouts/betashares-direct-annual.js";
import { computershareEtfAnnualLayout } from "./layouts/computershare-etf-annual.js";
import { linkMufgIssuerAnnualLayout } from "./layouts/link-mufg-issuer-annual.js";
import { selfwealthAnnualLayout } from "./layouts/selfwealth-annual.js";
import { selfwealthInternationalLayout } from "./layouts/selfwealth-international.js";
import type { LayoutParser } from "./types.js";

/**
 * Ordered layout matchers (Phase 4 added computershareEtfAnnualLayout (VGS,
 * IOZ) and linkMufgIssuerAnnualLayout (NDQ) alongside the Phase 3 Betashares
 * Direct layout; selfwealthAnnualLayout/selfwealthInternationalLayout added
 * later for SelfWealth's AU and International annual statement PDFs). Order
 * doesn't matter for scoring (best score wins) but keep it stable for
 * readability / diff hygiene.
 */
export const LAYOUT_PARSERS: LayoutParser[] = [
  betasharesDirectAnnualLayout,
  computershareEtfAnnualLayout,
  linkMufgIssuerAnnualLayout,
  selfwealthAnnualLayout,
  selfwealthInternationalLayout,
];

export function getLayoutParser(id: string): LayoutParser | undefined {
  return LAYOUT_PARSERS.find((l) => l.id === id);
}
