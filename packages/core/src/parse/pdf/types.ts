import type { ParseResult } from "../../types.js";
import type { LayoutId } from "../layouts.js";

/** Signals available to a layout's `score` before a full parse is attempted. */
export type LayoutScoreInput = {
  filename: string;
  /** Extracted PDF text */
  text?: string;
  sheetNames?: string[];
  meta?: { creator?: string };
};

export type LayoutParseInput = {
  content: Buffer;
  filename: string;
  /** Pre-extracted text — always present for PDF layouts by the time `parse` runs */
  text?: string;
};

/**
 * One issuer/version file layout. New layouts are new modules registered in
 * `registry.ts` — never grow a single mega-regex (see docs/import-layouts-plan.md §1).
 */
export type LayoutParser = {
  id: LayoutId;
  /** Higher wins; 0 = no match. Registry picks the max; below threshold → unknown. */
  score(input: LayoutScoreInput): number;
  parse(input: LayoutParseInput): ParseResult;
};
