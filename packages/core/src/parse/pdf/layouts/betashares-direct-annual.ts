import type { ParsedTransaction, ParseResult, ParseWarning } from "../../../types.js";
import { parseDate, parseNumber } from "../../utils.js";
import type { LayoutParser, LayoutScoreInput } from "../types.js";

/**
 * Betashares Direct platform annual statement (docs/import-layouts-plan.md
 * Appendix C). Transaction list rows look like (line-wrapped for readability):
 *
 *   15/07/2024DepositDeposit into your cash account$350.00$0.00$350.00
 *   15/07/2024BuyNDQ (0.0022 units @ $44.74)($0.10)$0.00($0.10)
 *   01/08/2024FeesJuly-2024 Auto-pilot fees cha ged($2.19)$0.00($2.19)
 *
 * `lineRe`/`tradeRe` below follow Appendix C.3 exactly. Deviations from the
 * literal doc regexes (and why) are called out inline — see also the Phase 3
 * agent report for the full list.
 */

// Appendix C.3, extended with `Distribution` (see deviation note above
// parseBetasharesDirectAnnualText): the doc's activity list omits it, but
// real statements (2025-06 jimmy corpus) contain cash-distribution rows and
// without a matching alternative here they get glued onto the *next*
// Buy/Sell/Deposit/Fees row's captured text (lineRe's lookahead only stops at
// those four words) — harmless to the numbers (which sit right after the
// row's own date) but pollutes `notes` and silently drops real distributions,
// which violates the "warn > silent drop" principle (docs §15.3).
const LINE_RE =
  /(\d{2}\/\d{2}\/\d{4})(Buy|Sell|Deposit|Fees|Distribution)(.*?)(?=\d{2}\/\d{2}\/\d{4}(?:Buy|Sell|Deposit|Fees|Distribution)|Total|$)/gs;

// Appendix C.3 verbatim.
const TRADE_RE =
  /([A-Z]{2,5})\s*\(([\d.]+)\s*units?\s*@\s*\$?([\d.]+)\)\(?\$?([\d.,-]+)?\)?/i;

// Deviation from Appendix C.3's literal `feeRe` (`/\$?\(?([\d.]+)\)?/`): every
// token in that pattern is optional, so on a real fee row like
// "July-2024 Auto-pilot fees cha ged($2.19)$0.00($2.19)" it matches "2024"
// (from "July-2024") before ever reaching the actual fee amount. Requiring
// the leading "$" fixes this without changing the intent of the regex.
const FEE_RE = /\(?\$(-?[\d,]+(?:\.\d+)?)\)?/;

// Not in Appendix C at all — added for the real "Distribution" rows (cash
// distributions credited to the account, not reinvested). Matches
// "NDQ @ $0.0284 per unit" and leaves the caller to read the gross $ amount
// that immediately follows in the source text.
const DISTRIBUTION_RE = /^\s*([A-Z]{2,5})\s*@\s*\$?([\d.]+)\s*per\s*unit/i;

function num(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  return parseNumber(raw);
}

/**
 * Parse pre-extracted Betashares Direct annual statement text into
 * transactions. Exposed directly (not just via the `LayoutParser.parse`
 * wrapper) so unit tests can feed synthetic text without round-tripping a
 * real PDF binary (docs/import-layouts-plan.md Appendix A.5).
 */
export function parseBetasharesDirectAnnualText(
  text: string,
  _filename: string,
): ParseResult {
  const transactions: ParsedTransaction[] = [];
  const warnings: ParseWarning[] = [];

  const startIdx = text.search(/Transaction list/i);
  const scoped = startIdx >= 0 ? text.slice(startIdx) : text;

  let depositCount = 0;
  let depositTotal = 0;
  let feeCount = 0;
  let feeTotal = 0;

  LINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINE_RE.exec(scoped))) {
    const dateRaw = match[1]!;
    const kind = match[2]!;
    const body = match[3] ?? "";
    const iso = parseDate(dateRaw);
    if (!iso) {
      warnings.push({
        message: `Betashares Direct: unparseable date "${dateRaw}" — row skipped`,
        severity: "warn",
      });
      continue;
    }

    if (kind === "Deposit") {
      depositCount += 1;
      const amt = num(/\$([\d,.]+)/.exec(body)?.[1]);
      if (amt != null) depositTotal += amt;
      continue;
    }

    if (kind === "Fees") {
      // Auto-pilot fees aren't tied to any instrument — importing them as a
      // "FEE" ticker made them show up as a phantom holding needing a price
      // quote (which always fails, since it's not a real security). Skip
      // them like deposits and surface the total instead.
      const feeMatch = FEE_RE.exec(body);
      const feeAmount = feeMatch ? num(feeMatch[1]) : null;
      if (feeAmount == null) {
        warnings.push({
          message: `Betashares Direct: fee row on ${iso} had no parsable amount — skipped`,
          severity: "warn",
        });
        continue;
      }
      feeCount += 1;
      feeTotal += Math.abs(feeAmount);
      continue;
    }

    if (kind === "Distribution") {
      const distMatch = DISTRIBUTION_RE.exec(body);
      if (!distMatch) {
        warnings.push({
          message: `Betashares Direct: distribution row on ${iso} could not be parsed — skipped`,
          severity: "warn",
        });
        continue;
      }
      const ticker = distMatch[1]!.toUpperCase();
      const perUnit = num(distMatch[2]);
      const rest = body.slice(distMatch[0].length);
      const grossRaw = /^\$([\d,.]+)/.exec(rest)?.[1];
      const gross = num(grossRaw ?? null);
      transactions.push({
        date: iso,
        ticker,
        exchange: "ASX",
        type: "dividend_cash",
        quantity: 0,
        price: perUnit,
        amount: gross != null ? Math.abs(gross) : null,
        brokerage: 0,
        currency: "AUD",
        externalId: `bsd-${iso}-dividend_cash-${ticker}-0-${perUnit ?? ""}`,
        notes: distMatch[0].trim(),
      });
      continue;
    }

    // Buy / Sell
    const tradeMatch = TRADE_RE.exec(body);
    if (!tradeMatch) {
      warnings.push({
        message: `Betashares Direct: ${kind} row on ${iso} did not match the expected "TICKER (qty units @ $price)" pattern — skipped`,
        severity: "warn",
      });
      continue;
    }
    const ticker = tradeMatch[1]!.toUpperCase();
    const quantity = Math.abs(num(tradeMatch[2]) ?? 0);
    const price = num(tradeMatch[3]);
    const amountRaw = num(tradeMatch[4]);
    const amount = amountRaw != null ? Math.abs(amountRaw) : null;
    const type = kind === "Buy" ? "buy" : "sell";
    const notes = body
      .slice(0, tradeMatch.index + tradeMatch[0].length)
      .trim();

    transactions.push({
      date: iso,
      ticker,
      exchange: "ASX",
      type,
      quantity,
      price,
      amount,
      brokerage: 0,
      currency: "AUD",
      externalId: `bsd-${iso}-${type}-${ticker}-${quantity}-${price ?? ""}`,
      notes,
    });
  }

  if (depositCount > 0) {
    warnings.push({
      message: `Skipped ${depositCount} deposit line(s) totalling $${depositTotal.toFixed(2)} — cash deposits are not ledger transactions`,
      severity: "info",
    });
  }

  if (feeCount > 0) {
    warnings.push({
      message: `Skipped ${feeCount} auto-pilot fee line(s) totalling $${feeTotal.toFixed(2)} — not tied to any instrument, not a ledger transaction`,
      severity: "info",
    });
  }

  if (transactions.length === 0) {
    warnings.push({
      message:
        "No security transactions found in this Betashares Direct annual statement (deposit-only or empty period) — not an error.",
      severity: "info",
    });
  }

  return {
    broker: "betashares_direct",
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
  if (/Betashares Direct/i.test(t)) hits += 1;
  if (/IDPS-like/i.test(t) || /Betashares Invest Fund/i.test(t)) hits += 1;
  if (/Auto-pilot fees/i.test(t) || /Custom Portfolio holding/i.test(t)) hits += 1;
  if (/Activity type/i.test(t)) hits += 1;
  return hits;
}

export const betasharesDirectAnnualLayout: LayoutParser = {
  id: "betashares_direct.platform_annual",
  score,
  parse(input) {
    return parseBetasharesDirectAnnualText(input.text ?? "", input.filename);
  },
};
