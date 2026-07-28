import type { ParsedTransaction, ParseResult, ParseWarning } from "../../../types.js";
import { parseDate, parseNumber } from "../../utils.js";
import type { LayoutParser, LayoutScoreInput } from "../types.js";

/**
 * Computershare ETF annual statement (docs/import-layouts-plan.md Appendix A —
 * covers both Vanguard VGS and iShares IOZ; same issuer-administrator family,
 * "computershare.etf_annual"). The transaction table is extracted as several
 * parallel column blocks rather than row-per-line text, e.g. (VGS-2024,
 * `pdf-parse` output, comments added):
 *
 *   Unit TransactionsUnit Price   <- table header (older statements, pre-~2022,
 *                                     read "TransactionUnit TransactionsUnit
 *                                     Price" — missing the word "List"; both
 *                                     forms contain "Unit TransactionsUnit
 *                                     Price" verbatim, which is what we anchor on)
 *   2
 *   Units Held
 *   3
 *   Unit Value
 *   4
 *   30/06/2023                    <- dates, in order
 *   18/07/2023
 *   17/10/2023
 *   17/01/2024
 *   17/04/2024
 *   30/06/2024
 *   Opening Balance                <- descriptions, in order (same count as dates)
 *   Distribution Reinvested
 *   Distribution Reinvested
 *   Distribution Reinvested
 *   Distribution Reinvested
 *   Closing Balance
 *   1                              <- stray footnote superscript (present on
 *                                     some years, absent on others — skipped)
 *   $107.12                        <- unit prices, in order (or "-" when the
 *   $106.03                           issuer doesn't know the price, e.g. IOZ
 *   $107.75                           Purchase rows — ASIC Class Order 13/1200)
 *   $113.19
 *   $120.67
 *   $124.73
 *   32                              <- units held, in order
 *   32
 *   32
 *   33
 *   33
 *   33
 *
 * Verified against the real jimmy corpus (7 VGS years 2019-2025 + 2 IOZ years
 * 2024-2025): the stray footnote digit before the price block appears on some
 * statements and not others (no reliable rule for which), so we skip it by
 * *shape* — the first token that doesn't look like a price token (`-` or
 * `$x.xx`) right after the description block is discarded, then exactly N
 * price tokens are taken (N = number of dates/descriptions). This is more
 * robust than the literal regexes sketched in Appendix A.2, which the doc
 * itself flags as illustrative ("practical approach that works on these
 * PDFs").
 */

const HEADER_ANCHOR_RE = /Unit TransactionsUnit Price/i;
const END_MARKERS = [
  /Cash Distribution Received/i,
  /Distribution Reinvestment Cash Balance/i,
  /Fees and Costs/i,
];

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
const DESC_RE =
  /^(Opening Balance|Closing Balance|Distribution Reinvested|Purchase|Sale)$/;
const PRICE_TOKEN_RE = /^-$|^\$[\d,]+\.\d{2}$/;
const UNITS_TOKEN_RE = /^-$|^\d+(?:\.\d+)?$/;

function num(raw: string): number | null {
  if (raw === "-") return null;
  return parseNumber(raw);
}

function findSectionEnd(text: string, from: number): number {
  let end = text.length;
  for (const marker of END_MARKERS) {
    const m = marker.exec(text.slice(from));
    if (m) {
      const idx = from + m.index;
      if (idx < end) end = idx;
    }
  }
  return end;
}

/**
 * Parse pre-extracted Computershare ETF annual statement text into
 * transactions. Exposed directly (as well as via `LayoutParser.parse`) so
 * unit tests can feed synthetic text (docs/import-layouts-plan.md A.5).
 */
export function parseComputershareEtfAnnualText(
  text: string,
  _filename: string,
): ParseResult {
  const transactions: ParsedTransaction[] = [];
  const warnings: ParseWarning[] = [];

  const tickerMatch = /ASX Code:\s*([A-Z0-9]+)/.exec(text);
  const ticker = tickerMatch?.[1]?.toUpperCase() ?? "UNKNOWN";
  if (!tickerMatch) {
    warnings.push({
      message: 'Computershare: no "ASX Code:" found — ticker set to UNKNOWN',
      severity: "warn",
    });
  }

  const anchorMatch = HEADER_ANCHOR_RE.exec(text);
  if (!anchorMatch) {
    warnings.push({
      message:
        "Computershare: could not find the transaction table header — statement not imported",
      severity: "error",
    });
    return { broker: "generic", transactions, warnings, skippedRows: 0 };
  }

  const sectionStart = anchorMatch.index;
  const sectionEnd = findSectionEnd(text, sectionStart);
  const lines = text
    .slice(sectionStart, sectionEnd)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let i = 0;
  // Skip header/footnote noise up to the first date line.
  while (i < lines.length && !DATE_RE.test(lines[i]!)) i++;

  const dates: string[] = [];
  while (i < lines.length && DATE_RE.test(lines[i]!)) {
    dates.push(lines[i]!);
    i++;
  }

  const descriptions: string[] = [];
  while (i < lines.length && DESC_RE.test(lines[i]!)) {
    descriptions.push(lines[i]!);
    i++;
  }

  const n = dates.length;
  if (n === 0 || descriptions.length !== n) {
    warnings.push({
      message: `Computershare: transaction table shape did not match expected pattern (${dates.length} date(s), ${descriptions.length} description(s)) — statement not imported, check manually`,
      severity: "error",
    });
    return { broker: "generic", transactions, warnings, skippedRows: 0 };
  }

  // Skip at most one stray footnote token (a bare superscript number) that
  // some (not all) statements print between the description block and the
  // unit-price column.
  let skipped = 0;
  while (i < lines.length && !PRICE_TOKEN_RE.test(lines[i]!) && skipped < 3) {
    i++;
    skipped++;
  }

  const prices: string[] = [];
  for (let k = 0; k < n && i < lines.length; k++, i++) {
    if (!PRICE_TOKEN_RE.test(lines[i]!)) break;
    prices.push(lines[i]!);
  }

  const unitsHeld: string[] = [];
  for (let k = 0; k < n && i < lines.length; k++, i++) {
    if (!UNITS_TOKEN_RE.test(lines[i]!)) break;
    unitsHeld.push(lines[i]!);
  }

  if (prices.length !== n || unitsHeld.length !== n) {
    warnings.push({
      message: `Computershare: could not read unit price / units held columns cleanly (got ${prices.length}/${n} prices, ${unitsHeld.length}/${n} units held) — statement not imported, check manually`,
      severity: "error",
    });
    return { broker: "generic", transactions, warnings, skippedRows: 0 };
  }

  const unitsHeldNum = unitsHeld.map(num);

  for (let idx = 0; idx < n; idx++) {
    const desc = descriptions[idx]!;
    const iso = parseDate(dates[idx]!);
    if (!iso) {
      warnings.push({
        message: `Computershare: unparseable date "${dates[idx]}" — row skipped`,
        severity: "warn",
      });
      continue;
    }

    if (desc === "Opening Balance" || desc === "Closing Balance") {
      // Reconcile-only — not a ledger transaction (docs Appendix A.2 step 4).
      continue;
    }

    const priceRaw = prices[idx]!;
    const price = num(priceRaw);
    const prevHeld = idx > 0 ? unitsHeldNum[idx - 1] : null;
    const curHeld = unitsHeldNum[idx];
    if (prevHeld == null || curHeld == null) {
      warnings.push({
        message: `Computershare: ${desc} on ${iso} — units held unknown, cannot compute quantity, row skipped`,
        severity: "warn",
      });
      continue;
    }
    const delta = curHeld - prevHeld;

    if (desc === "Distribution Reinvested") {
      if (delta <= 0) {
        warnings.push({
          message: `Computershare: 0-unit Distribution Reinvested on ${iso} (DRP cash balance only, no whole units bought) — not imported as a ledger row`,
          severity: "info",
        });
        continue;
      }
      const amount = price != null ? delta * price : null;
      transactions.push({
        date: iso,
        ticker,
        exchange: "ASX",
        type: "drp",
        quantity: delta,
        price,
        amount,
        brokerage: 0,
        currency: "AUD",
        externalId: `cs-${ticker.toLowerCase()}-${iso}-drp-${delta}`,
        notes: "Distribution Reinvested",
      });
      continue;
    }

    // Purchase / Sale
    if (delta === 0) {
      warnings.push({
        message: `Computershare: ${desc} on ${iso} shows no change in units held — row skipped`,
        severity: "warn",
      });
      continue;
    }
    const qty = Math.abs(delta);
    const impliedType: "buy" | "sell" = delta > 0 ? "buy" : "sell";
    if (price == null) {
      // ASIC Class Order 13/1200 — issuer doesn't know the market price for
      // trades executed on-exchange. Never fabricate a $0 (or NAV) cost base
      // (docs §15.5) — import as a transfer so the user must supply the real
      // price/cost base later.
      const type = delta > 0 ? "transfer_in" : "transfer_out";
      transactions.push({
        date: iso,
        ticker,
        exchange: "ASX",
        type,
        quantity: qty,
        price: null,
        amount: null,
        brokerage: 0,
        currency: "AUD",
        externalId: `cs-${ticker.toLowerCase()}-${iso}-${type}-${qty}`,
        notes: `${desc} — issuer does not know your market price (ASIC Class Order 13/1200); set the real trade price/cost base manually`,
      });
      warnings.push({
        message: `Computershare: ${desc} of ${qty} unit(s) on ${iso} imported as ${type} with price null — issuer statements never carry a market price for on-exchange trades; set the real cost base manually`,
        severity: "warn",
      });
      continue;
    }

    const amount = qty * price;
    transactions.push({
      date: iso,
      ticker,
      exchange: "ASX",
      type: impliedType,
      quantity: qty,
      price,
      amount,
      brokerage: 0,
      currency: "AUD",
      externalId: `cs-${ticker.toLowerCase()}-${iso}-${impliedType}-${qty}`,
      notes: desc,
    });
  }

  if (transactions.length === 0) {
    warnings.push({
      message:
        "No ledger transactions found in this Computershare annual statement (holding unchanged, or DRP cash balance only) — not an error.",
      severity: "info",
    });
  }

  return {
    broker: "generic",
    transactions,
    warnings,
    skippedRows: 0,
  };
}

/** Fingerprint hits per docs/import-layouts-plan.md §11.3. */
function score(input: LayoutScoreInput): number {
  const t = input.text ?? "";
  if (!t) return 0;
  let hits = 0;
  if (/Computershare/i.test(t)) hits += 1;
  if (/Transaction List/i.test(t)) hits += 1;
  if (/Distribution Reinvested/i.test(t) || /Opening Balance/i.test(t)) hits += 1;
  if (/ASX Code:/.test(t)) hits += 1;
  if (/Unit Price/i.test(t)) hits += 1;
  return hits;
}

export const computershareEtfAnnualLayout: LayoutParser = {
  id: "computershare.etf_annual",
  score,
  parse(input) {
    return parseComputershareEtfAnnualText(input.text ?? "", input.filename);
  },
};
