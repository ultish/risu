import { parse as parseCsv } from "csv-parse/sync";
import * as XLSX from "xlsx";
import type { BrokerId, ParseResult } from "../types.js";
import { parseBetasharesRows } from "./betashares.js";
import { parseCommsecRows } from "./commsec.js";
import { detectBroker } from "./detect.js";
import { parseGenericRows } from "./generic.js";
import { parseSelfwealthRows } from "./selfwealth.js";
import { parseSharesightRows } from "./sharesight.js";
import { parseStakeRows } from "./stake.js";
import {
  resolveForcedBroker,
  unsupportedPdfResult,
} from "./layouts.js";
import {
  detectStakeWorkbookKind,
  parseStakeActivityWorkbook,
  parseStakeIncomeWorkbook,
  readWorkbook,
} from "./stakeWorkbook.js";
import { extractPdf } from "./pdf/extract.js";
import { detectPdfLayout } from "./pdf/detect.js";
import { getLayoutParser } from "./pdf/registry.js";

export { detectBroker } from "./detect.js";
export { classifyType } from "./utils.js";
export type {
  DetectConfidence,
  DetectResult,
  LayoutId,
} from "./layouts.js";
export {
  LAYOUT_LABELS,
  resolveForcedBroker,
  unsupportedPdfResult,
} from "./layouts.js";
export {
  detectStakeWorkbookKind,
  getStakeStatementPeriod,
  parseStakeActivityWorkbook,
  parseStakeIncomeWorkbook,
  readWorkbook,
} from "./stakeWorkbook.js";
export { extractPdf } from "./pdf/extract.js";
export type { ExtractedPdf } from "./pdf/extract.js";
export { detectPdfLayout } from "./pdf/detect.js";
export { LAYOUT_PARSERS, getLayoutParser } from "./pdf/registry.js";
export type {
  LayoutParser,
  LayoutParseInput,
  LayoutScoreInput,
} from "./pdf/types.js";

export type ParseFileInput = {
  /** File contents as UTF-8 text (CSV) or binary buffer (xlsx / pdf bytes) */
  content: string | ArrayBuffer | Buffer;
  filename: string;
  /**
   * Force broker parser. Omit, `""`, or `"auto"` → detect from content.
   * (UI Phase 2 sends `auto`.)
   */
  broker?: BrokerId | "auto";
};

function isExcel(filename: string): boolean {
  const f = filename.toLowerCase();
  return f.endsWith(".xlsx") || f.endsWith(".xls");
}

function isPdf(filename: string): boolean {
  return filename.toLowerCase().endsWith(".pdf");
}

/** CommSec browser copy is often tab-separated; downloads are usually commas. */
function detectDelimiter(text: string): string {
  const first = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return ",";
  const tabs = (first.match(/\t/g) ?? []).length;
  const commas = (first.match(/,/g) ?? []).length;
  // Prefer tabs when clearly a TSV (paste from CommSec HTML tables)
  if (tabs >= 3 && tabs > commas) return "\t";
  return ",";
}

function rowsFromCsv(text: string): Record<string, unknown>[] {
  const cleaned = text.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(cleaned);
  return parseCsv(cleaned, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    bom: true,
    delimiter,
    // Drop fully empty records from trailing tabs
    relax_quotes: true,
  }) as Record<string, unknown>[];
}

/**
 * Read Excel; try each sheet and pick the one with the most data-like rows.
 * Stake sometimes ships multi-sheet workbooks or a cover sheet first.
 */
function rowsFromExcel(buf: ArrayBuffer | Buffer): {
  rows: Record<string, unknown>[];
  sheetName: string | null;
} {
  const workbook = XLSX.read(buf, { type: "buffer", cellDates: true });
  let best: Record<string, unknown>[] = [];
  let bestName: string | null = null;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]!;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
      raw: false,
    });
    // Prefer sheets that look like trade tables
    const score = rows.length + (looksLikeTradeSheet(rows) ? 1000 : 0);
    const bestScore = best.length + (looksLikeTradeSheet(best) ? 1000 : 0);
    if (score > bestScore) {
      best = rows;
      bestName = sheetName;
    }
  }

  return { rows: best, sheetName: bestName };
}

function looksLikeTradeSheet(rows: Record<string, unknown>[]): boolean {
  if (!rows[0]) return false;
  const keys = Object.keys(rows[0]).map((k) => k.toLowerCase()).join("|");
  return (
    keys.includes("quantity") ||
    keys.includes("ticker") ||
    keys.includes("symbol") ||
    keys.includes("instrument") ||
    keys.includes("stock") ||
    keys.includes("code")
  );
}

function parseWithBroker(
  broker: BrokerId,
  rows: Record<string, unknown>[],
): ParseResult {
  switch (broker) {
    case "commsec":
      return parseCommsecRows(rows, "commsec");
    case "pocket":
      return parseCommsecRows(rows, "pocket");
    case "selfwealth":
      return parseSelfwealthRows(rows);
    case "stake":
      return parseStakeRows(rows);
    case "betashares_direct":
      return parseBetasharesRows(rows);
    case "sharesight":
      return parseSharesightRows(rows);
    case "generic":
    default:
      return parseGenericRows(rows);
  }
}

function toBuffer(content: string | ArrayBuffer | Buffer): Buffer {
  if (typeof content === "string") return Buffer.from(content);
  if (Buffer.isBuffer(content)) return content;
  return Buffer.from(content);
}

/**
 * Parse a broker / Sharesight / Stake export into normalised transactions.
 * DRP/DRIP rows become type=drp and update holdings like buys.
 *
 * - CSV / single-sheet XLSX: existing broker row parsers
 * - Stake multi-sheet Tax XLSX: both Aus + Wall St sheets (Phase 1)
 * - PDF: extractPdf → registry detect → layout.parse (Phase 3+); unregistered
 *   layouts (incl. Stake PDF, out of scope forever) fall back to
 *   `unsupportedPdfResult`
 *
 * Async since PDF extraction (`pdf-parse`) is inherently async — CSV/XLSX
 * branches resolve immediately.
 *
 * Alias: {@link parseImportFile}
 */
export async function parseBrokerFile(
  input: ParseFileInput,
): Promise<ParseResult> {
  const { filename } = input;
  const forced = resolveForcedBroker(input.broker);

  if (isPdf(filename)) {
    const buf = toBuffer(input.content);
    let text = "";
    try {
      const extracted = await extractPdf(buf);
      text = extracted.text;
    } catch {
      // Not a readable/born-digital PDF (scanned image, corrupt file, …) —
      // fall through to the structured unsupported result below.
      return unsupportedPdfResult(filename);
    }

    const detected = detectPdfLayout({ filename, text });
    const layout =
      detected.layoutId === "unknown"
        ? undefined
        : getLayoutParser(detected.layoutId);
    if (!layout) {
      return unsupportedPdfResult(filename);
    }

    const result = layout.parse({ content: buf, filename, text });
    result.layoutId = detected.layoutId;
    result.confidence = detected.confidence;
    sortTransactions(result);
    return result;
  }

  if (isExcel(filename)) {
    const buf = toBuffer(input.content);
    const workbook = readWorkbook(buf);
    const stakeKind = detectStakeWorkbookKind(workbook, filename);
    const allowStake =
      forced == null || forced === "stake" || forced === "generic";

    if (stakeKind === "activity" && allowStake) {
      const result = parseStakeActivityWorkbook(workbook);
      result.layoutId = "stake.activity";
      result.confidence = "high";
      sortTransactions(result);
      return result;
    }
    if (stakeKind === "income" && allowStake) {
      const result = parseStakeIncomeWorkbook(workbook);
      result.layoutId = "stake.income";
      result.confidence = "high";
      sortTransactions(result);
      return result;
    }

    const parsed = rowsFromExcel(buf);
    const rows = parsed.rows;
    const sheetNote = parsed.sheetName;

    if (!rows.length) {
      return {
        broker: forced ?? "generic",
        transactions: [],
        warnings: [
          {
            message:
              "No data rows found in spreadsheet. Stake/Sharesight Excel exports are sometimes empty or header-only — try Google Sheets export (Sharesight) or another FY (Stake Tax & Documents → Investment activity). PDF is not supported yet.",
            severity: "error",
          },
        ],
        skippedRows: 0,
      };
    }

    const headers = Object.keys(rows[0] ?? {});
    const broker = forced ?? detectBroker(headers, filename);
    const result = parseWithBroker(broker, rows);
    if (sheetNote) {
      result.warnings.unshift({
        message: `Read Excel sheet “${sheetNote}”`,
        severity: "info",
      });
    }
    sortTransactions(result);
    return result;
  }

  const text =
    typeof input.content === "string"
      ? input.content
      : Buffer.from(input.content as ArrayBuffer).toString("utf8");
  const rows = rowsFromCsv(text);

  if (!rows.length) {
    return {
      broker: forced ?? "generic",
      transactions: [],
      warnings: [
        {
          message: "No data rows found in file",
          severity: "error",
        },
      ],
      skippedRows: 0,
    };
  }

  const headers = Object.keys(rows[0] ?? {});
  const broker = forced ?? detectBroker(headers, filename);
  const result = parseWithBroker(broker, rows);
  sortTransactions(result);
  return result;
}

/** Preferred name for multi-source import (same as parseBrokerFile). */
export const parseImportFile = parseBrokerFile;

function sortTransactions(result: ParseResult): void {
  result.transactions.sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    if (d !== 0) return d;
    return a.ticker.localeCompare(b.ticker);
  });
}
