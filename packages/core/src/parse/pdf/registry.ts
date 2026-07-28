import { betasharesDirectAnnualLayout } from "./layouts/betashares-direct-annual.js";
import { computershareEtfAnnualLayout } from "./layouts/computershare-etf-annual.js";
import { linkMufgIssuerAnnualLayout } from "./layouts/link-mufg-issuer-annual.js";
import type { LayoutParser } from "./types.js";

/**
 * Ordered layout matchers (Phase 4 added computershareEtfAnnualLayout (VGS,
 * IOZ) and linkMufgIssuerAnnualLayout (NDQ) alongside the Phase 3 Betashares
 * Direct layout). Order doesn't matter for scoring (best score wins) but
 * keep it stable for readability / diff hygiene.
 */
export const LAYOUT_PARSERS: LayoutParser[] = [
  betasharesDirectAnnualLayout,
  computershareEtfAnnualLayout,
  linkMufgIssuerAnnualLayout,
];

export function getLayoutParser(id: string): LayoutParser | undefined {
  return LAYOUT_PARSERS.find((l) => l.id === id);
}
