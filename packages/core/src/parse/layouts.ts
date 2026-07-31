import type { BrokerId } from "../types.js";

/**
 * File layout ids for multi-source import (see docs/import-layouts-plan.md).
 * Distinct from BrokerId (parser/custody identity on ParseResult).
 */
export type LayoutId =
  | "stake.activity"
  | "stake.income"
  | "computershare.etf_annual"
  | "link_mufg.issuer_etf_annual"
  | "betashares_direct.platform_annual"
  | "selfwealth.annual"
  | "selfwealth.international_annual"
  | "unknown";

export type DetectConfidence = "high" | "low" | "none";

/** Result of fingerprinting a file before (or instead of) full parse. */
export type DetectResult = {
  layoutId: LayoutId;
  confidence: DetectConfidence;
  /** Maps to ParseResult.broker when known */
  suggestedBroker: BrokerId;
  /** UI prefill for custody; null = user must choose (issuer PDFs) */
  suggestedCustody: string | null;
  /** Short label for UI */
  label: string;
  reasons: string[];
};

export const LAYOUT_LABELS: Record<LayoutId, string> = {
  "stake.activity": "Stake Investment Activity",
  "stake.income": "Stake Investment Income",
  "computershare.etf_annual": "Computershare ETF annual",
  "link_mufg.issuer_etf_annual": "Link/MUFG issuer ETF annual",
  "betashares_direct.platform_annual": "Betashares Direct annual",
  "selfwealth.annual": "SelfWealth AU annual statement",
  "selfwealth.international_annual": "SelfWealth International annual statement",
  unknown: "Unknown layout",
};

/** Phase 0–2: PDF layouts not implemented yet (Phase 3+). */
export function unsupportedPdfResult(filename: string): {
  broker: "generic";
  transactions: [];
  warnings: Array<{ message: string; severity: "error" | "info" }>;
  skippedRows: number;
  layoutId: LayoutId;
  confidence: DetectConfidence;
} {
  return {
    broker: "generic",
    transactions: [],
    warnings: [
      {
        message:
          "PDF import is not implemented yet (layout parsers land in later phases). " +
          "For Stake, use Tax & Documents → Investment Activity / Income as XLSX — not PDF. " +
          "Issuer PDFs (VGS, NDQ, Betashares Direct) are planned separately.",
        severity: "error",
      },
      {
        message: `Rejected PDF: ${filename || "(unnamed)"}`,
        severity: "info",
      },
    ],
    skippedRows: 0,
    layoutId: "unknown",
    confidence: "none",
  };
}

/** Normalise forced broker from UI/API (`auto` / empty → detect). */
export function resolveForcedBroker(
  broker?: BrokerId | "auto" | "" | null,
): BrokerId | undefined {
  if (broker == null || broker === "" || broker === "auto") return undefined;
  return broker;
}
