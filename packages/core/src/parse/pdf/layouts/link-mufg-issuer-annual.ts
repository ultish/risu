import type { ParsedTransaction, ParseResult, ParseWarning } from "../../../types.js";
import { parseDate, parseNumber } from "../../utils.js";
import type { LayoutParser, LayoutScoreInput } from "../types.js";

/**
 * Link/MUFG Betashares issuer ETF annual statement (docs/import-layouts-plan.md
 * Appendix B — NDQ; Link Market Services rebranded to MUFG Corporate Markets
 * partway through the real jimmy corpus, both are the same family/layout).
 *
 * The raw extracted text glues adjacent numeric columns together with no
 * separator, e.g. (NDQ-2024, `pdf-parse` output):
 *
 *   01/01/2024Opening Balance4444$37.38125800$1,644.78
 *   16/07/2024ALLOTMENT Dividend Plan Allotment145
 *   31/12/2024Closing Balance045$50.45116500$2,270.30
 *
 * Appendix B.2 calls the naive "split the glued digits with a regex" approach
 * "ambiguous"/"fragile" and instead recommends tracking a running balance
 * from Opening Balance and computing `qty = newBalance - oldBalance` for each
 * subsequent row. We do that, but *also* use the running balance to resolve
 * the glued-digit split itself: `findBalanceSplit` below tries every split
 * point `k` of the glued "unitsBalance" digit string and accepts the first
 * one where `balance - oldBalance === units` — i.e. the split is validated
 * against arithmetic consistency with the known prior balance, rather than
 * guessed from digit-count heuristics. This generalises across every shape
 * seen in the real jimmy ndq/annual-2020..2025 corpus (2-vs-2 digit opening
 * balances, 1-vs-2 digit allotments, 1-vs-2 digit CHESS movements, etc.)
 * without hardcoding per-row-type digit widths.
 *
 * A further real-world wrinkle (not in Appendix B.1's simplified example):
 * "Holding Net Movement (CHESS 510)" rows are NOT glued onto one line like
 * Opening/Closing/Allotment are. They print across four lines:
 *
 *   14/12/2023
 *   MISCELLANEOUS TRANSACTION
 *   Holding Net Movement (CHESS 510)
 *   544
 *
 * — a bare date, a literal "MISCELLANEOUS TRANSACTION" label, the row's
 * description, then the glued units+balance digits on their own line. We
 * handle this as a distinct 4-line lookahead (docs B.2 point 3: "MISCELLANEOUS
 * TRANSACTION pair with following line").
 *
 * Phase 6 (docs/import-layouts-plan.md §19): unlike Computershare, this
 * document family DOES carry a labelled "Distribution Details" section,
 * distinct from "Transaction Details" above — confirmed against the full
 * real jimmy ndq/annual-2020..2025 corpus. Its rows are glued the same way
 * as Transaction Details, but unambiguously (every numeric field after the
 * leading units count is `$`-prefixed, so there's no split-point ambiguity
 * like `findBalanceSplit` has to resolve above), e.g. (NDQ-2024):
 *
 *   Distribution Details
 *   Period Ended
 *   UnitsDistribution RateDistributionTax WithheldNet Distribution
 *   31/12/202344$0.02945941$1.30$0.00$1.30
 *   30/06/202444$0.91684553$40.34$0.00$40.34
 *   Total*$41.64$0.00$41.64
 *
 * i.e. `{date}{units}${distributionRatePerUnit}${distribution}${taxWithheld}${netDistribution}`.
 * We take `Distribution` (before tax withheld — matches "full gross amount
 * paid" per §19) as `amount`, and `Distribution Rate` as `price` (a real,
 * confidently-labelled per-unit rate — unlike Computershare, where no such
 * rate is ever disclosed). Cross-checked against every corpus year's
 * `Total*` line: distribution amounts sum to it exactly. 2020 has no
 * Distribution Details section at all (opening balance was 0 all year, only
 * CHESS transfers in late — genuinely no distributions that period, not a
 * parse failure), handled by treating a missing section as zero rows, no
 * warning.
 */

const OPENING_RE = /^(\d{2}\/\d{2}\/\d{4})Opening Balance(\d+)(?:\$[\d,.]+\$[\d,.]+)?$/;
const CLOSING_RE = /^(\d{2}\/\d{2}\/\d{4})Closing Balance(\d+)(?:\$[\d,.]+\$[\d,.]+)?$/;
const ALLOTMENT_RE =
  /^(\d{2}\/\d{2}\/\d{4})ALLOTMENT Dividend Plan Allotment(\d+)$/i;
const BARE_DATE_RE = /^(\d{2}\/\d{2}\/\d{4})$/;
const DIGITS_ONLY_RE = /^\d+$/;
const MISC_LABEL = "MISCELLANEOUS TRANSACTION";
const CHESS_DESC = "Holding Net Movement (CHESS 510)";
const ISSUER_SPONSORED_DESC = "Issuer Sponsored to CHESS Transfer";

// Phase 6: "Distribution Details" row, e.g.
// "31/12/202344$0.02945941$1.30$0.00$1.30" ->
// date=31/12/2023, units=44, rate=$0.02945941, distribution=$1.30,
// taxWithheld=$0.00, netDistribution=$1.30. Unambiguous (every field after
// the leading units count is `$`-prefixed) — see module doc comment.
const DISTRIBUTION_DETAILS_ROW_RE =
  /^(\d{2}\/\d{2}\/\d{4})(\d+)\$([\d.]+)\$([\d,.]+)\$([\d,.]+)\$([\d,.]+)$/;
const DIST_DETAILS_END_MARKERS = [
  /Estimated Fees and Charges/i,
  /Fees and Costs Summary/i,
];
const DATE_PREFIX_RE = /^\d{2}\/\d{2}\/\d{4}/;

function num(raw: string | undefined): number | null {
  if (raw == null) return null;
  return parseNumber(raw);
}

/**
 * Resolve a glued "unitsBalance" digit string (e.g. "145" for units=1,
 * balance=45) against a known prior balance: the correct split point is the
 * one where `balance - oldBalance === units` (see module doc comment above).
 */
function findBalanceSplit(
  digits: string,
  oldBalance: number,
): { units: number; balance: number } | null {
  for (let k = 1; k < digits.length; k++) {
    const units = Number(digits.slice(0, k));
    const balance = Number(digits.slice(k));
    if (balance - oldBalance === units) {
      return { units, balance };
    }
  }
  return null;
}

type DistributionDetailsRow = {
  iso: string;
  perUnitRate: number | null;
  grossAmount: number;
};

/**
 * Parse the "Distribution Details" section (Phase 6, docs §19) — distinct
 * from "Transaction Details" above. Returns one row per parseable period; a
 * date-prefixed line that doesn't match the expected glued shape produces a
 * warning (pushed into `warnings`) rather than a row (docs §15.3 "warn >
 * silent drop"). A statement with no "Distribution Details" section at all
 * (e.g. real NDQ-2020: opening balance 0, no distributions that period)
 * yields zero rows and no warning — that's a legitimate empty case, not a
 * parse failure.
 */
function parseDistributionDetails(
  text: string,
  warnings: ParseWarning[],
): DistributionDetailsRow[] {
  const startIdx = text.search(/Distribution Details/i);
  if (startIdx < 0) return [];

  let endIdx = text.length;
  for (const marker of DIST_DETAILS_END_MARKERS) {
    const m = marker.exec(text.slice(startIdx));
    if (m) {
      const idx = startIdx + m.index;
      if (idx < endIdx) endIdx = idx;
    }
  }

  const lines = text
    .slice(startIdx, endIdx)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const rows: DistributionDetailsRow[] = [];
  for (const line of lines) {
    if (!DATE_PREFIX_RE.test(line)) continue; // header/footnote noise, not a data row
    const m = DISTRIBUTION_DETAILS_ROW_RE.exec(line);
    if (!m) {
      warnings.push({
        message: `Link/MUFG: unparseable Distribution Details entry starting "${line.slice(0, 20)}" — skipped, not imported as a dividend_cash row`,
        severity: "warn",
      });
      continue;
    }
    const [, dateRaw, , rateRaw, distRaw] = m;
    const iso = parseDate(dateRaw!);
    if (!iso) {
      warnings.push({
        message: `Link/MUFG: unparseable Distribution Details date "${dateRaw}" — skipped`,
        severity: "warn",
      });
      continue;
    }
    const grossAmount = num(distRaw);
    if (grossAmount == null || !Number.isFinite(grossAmount) || grossAmount <= 0) {
      warnings.push({
        message: `Link/MUFG: Distribution Details entry for ${iso} had no parsable gross distribution amount — skipped`,
        severity: "warn",
      });
      continue;
    }
    rows.push({ iso, perUnitRate: num(rateRaw), grossAmount });
  }
  return rows;
}

/**
 * Parse pre-extracted Link/MUFG issuer ETF annual statement text into
 * transactions. Exposed directly (as well as via `LayoutParser.parse`) so
 * unit tests can feed synthetic text (docs/import-layouts-plan.md A.5/B.5).
 */
export function parseLinkMufgIssuerAnnualText(
  text: string,
  _filename: string,
): ParseResult {
  const transactions: ParsedTransaction[] = [];
  const warnings: ParseWarning[] = [];

  const tickerMatch = /ASX Code:\s*([A-Z0-9]+)/.exec(text);
  const ticker = tickerMatch?.[1]?.toUpperCase() ?? "UNKNOWN";
  if (!tickerMatch) {
    warnings.push({
      message: 'Link/MUFG: no "ASX Code:" found — ticker set to UNKNOWN',
      severity: "warn",
    });
  }

  const startIdx = text.search(/Transaction Details/i);
  if (startIdx < 0) {
    warnings.push({
      message:
        "Link/MUFG: could not find the Transaction Details section — statement not imported",
      severity: "error",
    });
    return { broker: "generic", transactions, warnings, skippedRows: 0 };
  }
  let endIdx = text.length;
  for (const marker of [/Distribution Details/i, /^\d\.The unit price shown/im]) {
    const m = marker.exec(text.slice(startIdx));
    if (m) {
      const idx = startIdx + m.index;
      if (idx < endIdx) endIdx = idx;
    }
  }

  const lines = text
    .slice(startIdx, endIdx)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let oldBalance: number | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    const openMatch = OPENING_RE.exec(line);
    if (openMatch) {
      const [, , digits] = openMatch;
      const split = findBalanceSplit(digits!, 0);
      if (split) {
        oldBalance = split.balance;
      } else {
        warnings.push({
          message: `Link/MUFG: could not parse Opening Balance units/balance from "${digits}" — running balance tracking may be unreliable from here`,
          severity: "warn",
        });
      }
      i++;
      continue;
    }

    const closeMatch = CLOSING_RE.exec(line);
    if (closeMatch) {
      // Reconcile-only — not a ledger transaction (docs Appendix B.2 point 1).
      i++;
      continue;
    }

    const allotMatch = ALLOTMENT_RE.exec(line);
    if (allotMatch) {
      const [, dateRaw, digits] = allotMatch;
      const iso = parseDate(dateRaw!);
      if (!iso) {
        warnings.push({
          message: `Link/MUFG: unparseable allotment date "${dateRaw}" — row skipped`,
          severity: "warn",
        });
        i++;
        continue;
      }
      if (oldBalance == null) {
        warnings.push({
          message: `Link/MUFG: Allotment on ${iso} appears before a parsed Opening Balance — cannot compute quantity, row skipped`,
          severity: "warn",
        });
        i++;
        continue;
      }
      const split = findBalanceSplit(digits!, oldBalance);
      if (!split || split.units <= 0) {
        warnings.push({
          message: `Link/MUFG: could not determine Allotment quantity on ${iso} from "${digits}" — row skipped`,
          severity: "warn",
        });
        i++;
        continue;
      }
      oldBalance = split.balance;
      transactions.push({
        date: iso,
        ticker,
        exchange: "ASX",
        type: "drp",
        quantity: split.units,
        price: null,
        amount: null,
        brokerage: 0,
        currency: "AUD",
        externalId: `link-${ticker.toLowerCase()}-${iso}-drp`,
        notes: "Dividend Plan Allotment",
      });
      i++;
      continue;
    }

    const bareDateMatch = BARE_DATE_RE.exec(line);
    if (bareDateMatch) {
      const dateRaw = bareDateMatch[1]!;
      let j = i + 1;
      if (lines[j] === MISC_LABEL) j++;
      const descLine = lines[j];
      const isChess = descLine === CHESS_DESC;
      const isIssuerSponsored = descLine === ISSUER_SPONSORED_DESC;
      if (!isChess && !isIssuerSponsored) {
        warnings.push({
          message: `Link/MUFG: unrecognised transaction row starting ${dateRaw} — skipped`,
          severity: "warn",
        });
        i++;
        continue;
      }
      j++;
      const digitsLine = lines[j];
      const iso = parseDate(dateRaw);
      if (!digitsLine || !DIGITS_ONLY_RE.test(digitsLine) || !iso) {
        warnings.push({
          message: `Link/MUFG: could not find quantity/balance digits for the ${
            isChess ? "CHESS" : "issuer-sponsored"
          } movement on ${dateRaw} — skipped`,
          severity: "warn",
        });
        i = j + 1;
        continue;
      }
      if (oldBalance == null) {
        warnings.push({
          message: `Link/MUFG: movement on ${iso} appears before a parsed Opening Balance — cannot compute quantity, row skipped`,
          severity: "warn",
        });
        i = j + 1;
        continue;
      }
      const split = findBalanceSplit(digitsLine, oldBalance);
      if (!split) {
        warnings.push({
          message: `Link/MUFG: ambiguous units/balance split for the movement on ${iso} ("${digitsLine}") — skipped`,
          severity: "warn",
        });
        i = j + 1;
        continue;
      }
      oldBalance = split.balance;
      const qty = split.units;
      if (qty === 0) {
        i = j + 1;
        continue;
      }
      const type = qty < 0 ? "transfer_out" : "transfer_in";
      const absQty = Math.abs(qty);
      const label = isChess ? "Holding Net Movement (CHESS 510)" : "Issuer Sponsored to CHESS Transfer";
      transactions.push({
        date: iso,
        ticker,
        exchange: "ASX",
        type,
        quantity: absQty,
        price: null,
        amount: null,
        brokerage: 0,
        currency: "AUD",
        externalId: `link-${ticker.toLowerCase()}-${iso}-${type}-${absQty}`,
        notes: `${label} — issuer does not know your market price; set the real cost base manually`,
      });
      // Never buy at NAV (docs §15.5) — CHESS/issuer-sponsored movements are
      // registration changes, not priced trades. Always warn.
      warnings.push({
        message: `Link/MUFG: ${label} of ${absQty} unit(s) on ${iso} imported as ${type} with price null — set the real cost base from your broker records`,
        severity: "warn",
      });
      i = j + 1;
      continue;
    }

    // Unrecognised line inside the section (table headers, footnote
    // superscripts, "Value" column label, etc.) — not a data row, skip
    // silently. Anything that looked like a real transaction row was already
    // handled (or warned about) above.
    i++;
  }

  // Phase 6: "Distribution Details" is a separate section from
  // "Transaction Details" above — emit one dividend_cash row per period for
  // the full gross amount, ALONGSIDE (not instead of) the drp/transfer rows
  // already emitted from the Transaction Details loop above (unchanged).
  const distRows = parseDistributionDetails(text, warnings);
  for (const row of distRows) {
    transactions.push({
      date: row.iso,
      ticker,
      exchange: "ASX",
      type: "dividend_cash",
      quantity: 0,
      price: row.perUnitRate,
      amount: row.grossAmount,
      brokerage: 0,
      currency: "AUD",
      externalId: `link-${ticker.toLowerCase()}-${row.iso}-dividend_cash`,
      notes: "Distribution Details — gross distribution for the period",
    });
  }

  if (transactions.length === 0) {
    warnings.push({
      message:
        "No ledger transactions found in this Link/MUFG annual statement (holding unchanged for the period) — not an error.",
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
  if (/Link Market Services/i.test(t) || /MUFG Corporate Markets/i.test(t)) hits += 1;
  if (/ALLOTMENT Dividend Plan/i.test(t) || /Holding Net Movement/i.test(t)) hits += 1;
  // Case-sensitive on purpose: real NDQ statements print this heading in
  // ALL CAPS ("ANNUAL STATEMENT"), which reliably distinguishes it from
  // Computershare's / Betashares Direct's Title Case "Annual Statement" —
  // avoids double-counting this signal against the other two PDF layouts.
  if (/ANNUAL STATEMENT/.test(t)) hits += 1;
  if (/BETASHARES/i.test(t)) hits += 1;
  return hits;
}

export const linkMufgIssuerAnnualLayout: LayoutParser = {
  id: "link_mufg.issuer_etf_annual",
  score,
  parse(input) {
    return parseLinkMufgIssuerAnnualText(input.text ?? "", input.filename);
  },
};
