import type { ParsedTransaction, ParseResult, ParseWarning } from "../../../types.js";
import { parseDate, parseNumber } from "../../utils.js";
import type { LayoutParser, LayoutScoreInput } from "../types.js";

/**
 * SelfWealth "USA Detailed Holdings Summary" international annual statement
 * — a structurally different report from the AU domestic one
 * (selfwealth-annual.ts): no "Transaction Summary" section at all. Real
 * trades live in a "Contracts between <period>" table instead, e.g.
 * (verified against a real statement):
 *
 *   4 Jan 20216 Jan 20212101020655BUYARKKArk Innovation ETF6$124.16$744.961$744.96$8.64$0.86$0.00$754.46
 *   4 Jan 20216 Jan 20212101020654BUYARKGArk Genomic Revolution
 *   ETF
 *   8$92.96$743.761$743.76$8.64$0.86$0.00$753.26
 *
 * (contract date, settlement date, contract number, B/S, code+instrument
 * name glued, volume, price, value, FX rate (bare, no $ — always "1" for a
 * USD-settlement trade), gross settle amount, brokerage, GST, other charges,
 * net settle amount). Note the second row's instrument name wraps across a
 * line break mid-cell ("Ark Genomic Revolution\nETF") — the row regex uses
 * `[\s\S]*?` rather than per-line splitting so this doesn't need special
 * casing.
 *
 * Unlike the AU layout, the code+name split here is NOT ambiguous: the
 * instrument name is Title Case ("Ark Innovation ETF") while the code is
 * all-caps ("ARKK"), so the boundary is exactly where the run of uppercase
 * letters is followed by a lowercase letter (see `splitTitleCaseTicker`).
 * This also means no arithmetic-consistency reconciliation is needed for
 * quantities here — Volume is cleanly bounded by the code+name blob on one
 * side and a literal "$" on the other, unlike the AU layout's glued
 * reference+units problem.
 *
 * Also unlike the AU layout: the whole real corpus used to build this (5
 * International statements, only one with any actual trades) has zero
 * dividend/distribution activity and zero non-empty "Scrip Movement"/
 * "Corporate Action Cash Movement" sections — those are flagged with a
 * warning if ever non-empty rather than guessed at without evidence.
 *
 * Same page-duplication quirk as the AU layout (verified via pdf.js's own
 * per-page getTextContent: all 6 pages carry byte-identical text) — parsed
 * with global scans and deduped by content signature.
 */

const NBSP_RE = / /g;
const DATE_SRC = "\\d{1,2} [A-Za-z]{3} \\d{4}";

function normalizeText(text: string): string {
  return text.replace(NBSP_RE, " ");
}

function num(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  return parseNumber(raw);
}

/**
 * Code+InstrumentName are glued with no separator, e.g. "ARKKArk Innovation
 * ETF". The name is Title Case while the code is all-caps, so the boundary
 * is the first position where an uppercase letter is followed by a
 * lowercase one.
 */
function splitTitleCaseTicker(blob: string): { ticker: string; name: string } {
  for (let i = 1; i < blob.length; i++) {
    if (/[A-Z]/.test(blob[i]!) && /[a-z]/.test(blob[i + 1] ?? "")) {
      return { ticker: blob.slice(0, i), name: blob.slice(i) };
    }
  }
  return { ticker: blob, name: "" };
}

const CONTRACT_ROW_RE = new RegExp(
  `(${DATE_SRC})(${DATE_SRC})(\\d+)(BUY|SELL)([\\s\\S]*?)(\\d+(?:\\.\\d+)?)\\$([\\d,]+\\.\\d{2})\\$([\\d,]+\\.\\d{2})(\\d+(?:\\.\\d+)?)\\$([\\d,]+\\.\\d{2})\\$([\\d,]+\\.\\d{2})\\$([\\d,]+\\.\\d{2})\\$([\\d,]+\\.\\d{2})\\$([\\d,]+\\.\\d{2})`,
  "g",
);

export function parseSelfwealthInternationalText(
  rawText: string,
  _filename: string,
): ParseResult {
  const text = normalizeText(rawText);
  const warnings: ParseWarning[] = [];

  const contractsIdx = text.search(/Contracts between/i);
  const scopeStart = contractsIdx >= 0 ? contractsIdx : 0;
  const scopeEnd = (() => {
    const idx = text.indexOf("Scrip Movement between", scopeStart);
    return idx >= 0 ? idx : text.length;
  })();
  const scoped = text.slice(scopeStart, scopeEnd);

  type Row = {
    date: string;
    type: "buy" | "sell";
    ticker: string;
    quantity: number;
    price: number;
    value: number;
    brokerage: number;
    gst: number;
    otherCharges: number;
    contractNumber: string;
  };

  const rows: Row[] = [];
  let m: RegExpExecArray | null;
  CONTRACT_ROW_RE.lastIndex = 0;
  while ((m = CONTRACT_ROW_RE.exec(scoped))) {
    const [
      ,
      contractDate,
      ,
      contractNumber,
      side,
      codeNameBlob,
      volumeStr,
      priceStr,
      valueStr,
      ,
      ,
      brokStr,
      gstStr,
      otherStr,
      ,
    ] = m;
    const iso = parseDate(contractDate!);
    if (!iso) continue;
    const { ticker } = splitTitleCaseTicker(codeNameBlob!.trim());
    if (!ticker) continue;
    const quantity = num(volumeStr);
    const price = num(priceStr);
    const value = num(valueStr);
    if (quantity == null || price == null || value == null) continue;
    rows.push({
      date: iso,
      type: side === "BUY" ? "buy" : "sell",
      ticker: ticker.toUpperCase(),
      quantity,
      price,
      value,
      brokerage: num(brokStr) ?? 0,
      gst: num(gstStr) ?? 0,
      otherCharges: num(otherStr) ?? 0,
      contractNumber: contractNumber!,
    });
  }

  const seen = new Set<string>();
  const transactions: ParsedTransaction[] = [];
  for (const r of rows) {
    const key = `${r.date}|${r.type}|${r.ticker}|${r.quantity}|${r.contractNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    transactions.push({
      date: r.date,
      ticker: r.ticker,
      exchange: "US",
      type: r.type,
      quantity: r.quantity,
      price: r.price,
      amount: r.value,
      brokerage: r.brokerage + r.gst + r.otherCharges,
      currency: "USD",
      externalId: `sw-intl-${r.ticker.toLowerCase()}-${r.date}-${r.type}-${r.quantity}-${r.contractNumber}`,
      notes: null,
    });
  }

  transactions.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));

  // Not yet supported (no real evidence in the corpus used to build this
  // layout — flag rather than silently drop if a future statement has one).
  if (/Scrip Movement between/i.test(text) && !/No Scrip Movement during this period/i.test(text)) {
    warnings.push({
      message:
        "This statement has non-empty Scrip Movement activity — not currently parsed, check the statement manually.",
      severity: "warn",
    });
  }
  if (
    /Corporate Action Cash Movement between/i.test(text) &&
    !/No Corporate Action Cash Movement during this period/i.test(text)
  ) {
    warnings.push({
      message:
        "This statement has non-empty Corporate Action Cash Movement activity — not currently parsed, check the statement manually.",
      severity: "warn",
    });
  }
  if (
    /Estimated Dividends and Distributions\$([1-9][\d,.]*)/.test(text.replace(/\n/g, ""))
  ) {
    warnings.push({
      message:
        "This statement reports non-zero estimated dividends/distributions — dividend rows are not currently parsed for International statements, check the statement manually.",
      severity: "warn",
    });
  }

  if (transactions.length === 0) {
    warnings.push({
      message: "No contract (trade) rows found in this SelfWealth International statement — not an error.",
      severity: "info",
    });
  }

  return { broker: "selfwealth", transactions, warnings, skippedRows: 0 };
}

/** Fingerprint hits per docs/import-layouts-plan.md §11.3 conventions. */
function score(input: LayoutScoreInput): number {
  const raw = input.text ?? "";
  if (!raw) return 0;
  const t = normalizeText(raw);
  let hits = 0;
  if (/SelfWealth/i.test(t)) hits += 1;
  if (/Contracts between/i.test(t)) hits += 1;
  if (/Scrip Movement/i.test(t)) hits += 1;
  if (/OpenMarkets Id/i.test(t)) hits += 1;
  return hits;
}

export const selfwealthInternationalLayout: LayoutParser = {
  id: "selfwealth.international_annual",
  score,
  parse(input) {
    return parseSelfwealthInternationalText(input.text ?? "", input.filename);
  },
};
