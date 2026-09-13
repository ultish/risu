import { z } from "zod";

/** Brokers we aim to support via CSV/XLSX import */
export const BrokerId = z.enum([
  "commsec",
  "pocket",
  "selfwealth",
  "stake",
  "betashares_direct",
  "sharesight",
  "generic",
]);
export type BrokerId = z.infer<typeof BrokerId>;

/**
 * Normalised ledger event. Broker CSVs map into this shape.
 * DRP/DRIP allotments are first-class (type = "drp").
 */
export const TransactionType = z.enum([
  "buy",
  "sell",
  "drp",
  "dividend_cash",
  "transfer_in",
  "transfer_out",
  "split",
  "fee",
  "other",
]);
export type TransactionType = z.infer<typeof TransactionType>;

export const ParsedTransaction = z.object({
  /** Ledger row id when loaded from SQLite; omitted for freshly parsed imports. */
  id: z.number().optional(),
  /** Trade / allotment date (ISO yyyy-mm-dd) */
  date: z.string(),
  ticker: z.string(),
  exchange: z.string().default("ASX"),
  type: TransactionType,
  quantity: z.number(),
  /** Unit price in trade currency */
  price: z.number().nullable(),
  /** Total consideration in trade currency excl. brokerage when known */
  amount: z.number().nullable(),
  brokerage: z.number().default(0),
  currency: z.string().default("AUD"),
  /** Broker contract note / row id for dedupe */
  externalId: z.string().nullable(),
  notes: z.string().nullable(),
  /** Custody / broker when loaded from the ledger (e.g. betashares_direct). */
  broker: z.string().nullable().optional(),
  custody: z.string().nullable().optional(),
  /** How the row entered the ledger (e.g. file:betashares_direct.platform_annual, confirm-sale). */
  source: z.string().nullable().optional(),
  /** Raw row from file for debugging */
  raw: z.record(z.string(), z.unknown()).optional(),
  /**
   * Historical AUDUSD=X-style rate (foreign units per 1 AUD) on this
   * transaction's own date — set by the API at import time, never by
   * parsers. Null/undefined for AUD-native transactions or when no
   * historical rate could be resolved (computeHoldings falls back to
   * today's rate for that transaction's contribution).
   */
  fxRateToAud: z.number().nullable().optional(),
});
export type ParsedTransaction = z.infer<typeof ParsedTransaction>;

export const ParseWarning = z.object({
  row: z.number().optional(),
  message: z.string(),
  severity: z.enum(["info", "warn", "error"]).default("warn"),
});
export type ParseWarning = z.infer<typeof ParseWarning>;

export const ParseResult = z.object({
  broker: BrokerId,
  transactions: z.array(ParsedTransaction),
  warnings: z.array(ParseWarning),
  skippedRows: z.number().default(0),
  /** Optional layout fingerprint (multi-source import); see parse/layouts.ts */
  layoutId: z.string().optional(),
  confidence: z.enum(["high", "low", "none"]).optional(),
});
export type ParseResult = z.infer<typeof ParseResult>;

export type Holding = {
  ticker: string;
  exchange: string;
  currency: string;
  quantity: number;
  /** Average cost per unit in trade currency (incl. brokerage on buys/DRP) */
  avgCost: number;
  /** Total cost base in trade currency */
  costBase: number;
  /** Last price in trade currency */
  marketPrice: number | null;
  /** Market value in trade currency */
  marketValue: number | null;
  /** FX used (foreign per 1 AUD for Yahoo AUDUSD=X style), null if AUD */
  fxRate: number | null;
  /** Cost base converted to AUD */
  costBaseAud: number | null;
  /** Market value in AUD */
  marketValueAud: number | null;
};

export type PriceBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  adjClose: number;
  volume: number;
};

export type DividendEvent = {
  date: string;
  amount: number;
  frankingPercent: number | null;
};

export type ManualTransactionInput = {
  accountId: number;
  date: string;
  ticker: string;
  exchange?: string;
  type: TransactionType;
  quantity: number;
  price?: number | null;
  amount?: number | null;
  brokerage?: number;
  currency?: string;
  notes?: string | null;
  externalId?: string | null;
};
