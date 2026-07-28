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
 *
 * Phase 6 (docs/import-layouts-plan.md §19): Computershare statements have
 * **no** labelled "Distribution Details" section the way Link/MUFG's do —
 * confirmed against the full real jimmy corpus (grepped every VGS/IOZ year
 * for "Distribution": nothing but the Transaction List rows and this second
 * block). iShares' own glossary text says as much: "For further details of
 * the specific dollar amount and dates of each distribution amount paid,
 * please see your Distribution Payment Statement... this information is not
 * provided to Computershare/Vanguard/iShares in this document." What *is*
 * present, right after the Transaction List (bounded by the same
 * `Cash Distribution Received` / `Distribution Reinvestment Cash Balance`
 * text used below as `END_MARKERS`), is a second parallel-column block:
 *
 *   Cash Distribution Received-        <- glued: "-" (no cash paid out, all
 *                                          reinvested) or "$15.00" (glossary:
 *                                          "Any payments received in cash for
 *                                          distributions... paid to your
 *                                          nominated bank account" — a whole-
 *                                          statement total, not per-period)
 *   Distribution Reinvestment Cash Balance
 *   Date
 *   1
 *   Balance
 *   30/06/2023                         <- same dates as the Transaction List,
 *   18/07/2023                            MINUS any Purchase/Sale dates (a
 *   17/10/2023                            Purchase doesn't touch the DRP
 *   17/01/2024                            residual cash account) — verified
 *   17/04/2024                            against the real IOZ-2024 file,
 *   30/06/2024                            which has a Purchase row that is
 *   $45.98                                absent from this date list.
 *   $81.71
 *   $103.21
 *   $11.02
 *   $44.12
 *   $44.12
 *
 * This "Balance" is the running *unspent residual* left over after each
 * period's distribution reinvested what whole units it could (glossary:
 * "Any money left over after purchasing DRP units is held in a cash balance
 * account. This amount will be added to your next distribution and put
 * towards the purchase of new ETF units."). That means the period's actual
 * gross distribution is recoverable arithmetically — the same
 * arithmetic-consistency trick Phase 4 used for the Link/MUFG glued
 * units/balance split:
 *
 *   grossDistribution[i] = (balance[i] - balance[i-1]) + delta_units[i] * price[i]
 *
 * (the residual account gained this period's distribution, then spent
 * `delta*price` buying whole units — whatever's left is `balance[i]`).
 * Verified end-to-end against the real jimmy corpus: for every
 * Distribution Reinvested row (0-unit and whole-unit alike) across all 7 VGS
 * years and both IOZ years, `balance[i-1] + grossDistribution[i] - delta*price
 * === balance[i]` exactly, and — for the one file with a nonzero opening
 * balance of $0 (VGS-2020, no prior-year carryover) — the four periods' sum
 * lands exactly on the closing balance, an independent cross-check of the
 * formula.
 *
 * Caveat, found in VGS-2019 only (nonzero `Cash Distribution Received$15.00`):
 * when part of the distribution was paid to the bank account instead of the
 * DRP residual account, that portion isn't attributable to a single period
 * from this document alone (it's a whole-statement total). We warn instead
 * of guessing which period(s) it belongs to (docs §15.3 "warn > silent
 * drop") — see `parseDistributionReinvestmentBalances`.
 *
 * No per-unit distribution *rate* is ever disclosed in this document family
 * (unlike Link/MUFG's explicit "Distribution Rate" column) — the Transaction
 * List's "Unit Price" is the DRP reinvestment/NAV price, not a distribution
 * rate — so `dividend_cash` rows here always carry `price: null`.
 */

const HEADER_ANCHOR_RE = /Unit TransactionsUnit Price/i;
const END_MARKERS = [
  /Cash Distribution Received/i,
  /Distribution Reinvestment Cash Balance/i,
  /Fees and Costs/i,
];

// Phase 6: where the "Distribution Reinvestment Cash Balance" block ends —
// searched *after* the block start, so these never match anything earlier in
// the letter/glossary preamble.
const DIST_BALANCE_END_MARKERS = [
  /Return on Investment/i,
  /Fees and Costs Summary/i,
  /^Broadcast\d/im,
];
const CASH_DIST_RECEIVED_RE = /^Cash Distribution Received(-|\$[\d,]+\.\d{2})$/;

function findDistBalanceEnd(text: string, from: number): number {
  let end = text.length;
  for (const marker of DIST_BALANCE_END_MARKERS) {
    const m = marker.exec(text.slice(from));
    if (m) {
      const idx = from + m.index;
      if (idx < end) end = idx;
    }
  }
  return end;
}

type DistBalanceResult =
  | { balanceByIso: Map<string, number>; cashReceivedTotal: number }
  | { error: string };

/**
 * Parse the "Distribution Reinvestment Cash Balance" block (Phase 6) into a
 * date → residual-balance map, plus the whole-statement
 * "Cash Distribution Received" total (see module doc comment above). `from`
 * should be the index of the `Cash Distribution Received` line (i.e.
 * `sectionEnd` from the Transaction List parse, which already anchors there).
 */
function parseDistributionReinvestmentBalances(
  text: string,
  from: number,
): DistBalanceResult {
  const to = findDistBalanceEnd(text, from);
  const lines = text
    .slice(from, to)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const cashMatch = lines[0] ? CASH_DIST_RECEIVED_RE.exec(lines[0]) : null;
  if (!cashMatch) {
    return {
      error: `expected a "Cash Distribution Received" line, got "${lines[0] ?? "(nothing)"}"`,
    };
  }
  const cashReceivedTotal = cashMatch[1] === "-" ? 0 : (num(cashMatch[1]!) ?? 0);

  let i = 1;
  // Skip "Distribution Reinvestment Cash Balance" / "Date" / footnote digit /
  // "Balance" label noise — anything up to the first date line.
  while (i < lines.length && !DATE_RE.test(lines[i]!)) i++;

  const dates: string[] = [];
  while (i < lines.length && DATE_RE.test(lines[i]!)) {
    dates.push(lines[i]!);
    i++;
  }

  const values: string[] = [];
  for (let k = 0; k < dates.length && i < lines.length; k++, i++) {
    if (!PRICE_TOKEN_RE.test(lines[i]!)) break;
    values.push(lines[i]!);
  }

  if (dates.length === 0 || values.length !== dates.length) {
    return {
      error: `could not read the balance table cleanly (${dates.length} date(s), ${values.length} balance value(s))`,
    };
  }

  const balanceByIso = new Map<string, number>();
  for (let k = 0; k < dates.length; k++) {
    const iso = parseDate(dates[k]!);
    if (!iso) continue;
    balanceByIso.set(iso, num(values[k]!) ?? 0);
  }

  return { balanceByIso, cashReceivedTotal };
}

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
const DESC_RE =
  /^(Opening Balance|Closing Balance|Distribution Reinvested|Purchase|Sale)$/;
const PRICE_TOKEN_RE = /^-$|^\$[\d,]+\.\d{2}$/;
const UNITS_TOKEN_RE = /^-$|^\d+(?:\.\d+)?$/;

function num(raw: string): number | null {
  if (raw === "-") return null;
  return parseNumber(raw);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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

  // Phase 6: derive gross per-period distributions from the
  // "Distribution Reinvestment Cash Balance" block that follows the
  // Transaction List (see module doc comment). `sectionEnd` already anchors
  // at the "Cash Distribution Received" line (it's the closest END_MARKERS
  // hit), so reuse it as the start of this second block.
  const distResult = parseDistributionReinvestmentBalances(text, sectionEnd);
  let balanceByIso: Map<string, number> | null = null;
  if ("error" in distResult) {
    warnings.push({
      message: `Computershare: could not parse the Distribution Reinvestment Cash Balance table (${distResult.error}) — dividend_cash rows not recovered for this statement (drp rows, if any, are unaffected)`,
      severity: "warn",
    });
  } else {
    balanceByIso = distResult.balanceByIso;
    if (distResult.cashReceivedTotal > 0) {
      warnings.push({
        message: `Computershare: $${distResult.cashReceivedTotal.toFixed(2)} in "Cash Distribution Received" (paid directly to the bank account, not reinvested) for this statement could not be attributed to a specific distribution date — dividend_cash rows below may understate total distributions for the year by this amount`,
        severity: "warn",
      });
    }
  }
  let prevBalanceCash: number | null = null;

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
      // Still track the residual cash balance across these rows (Phase 6) —
      // Purchase/Sale rows below deliberately do NOT update it, since a
      // Purchase doesn't touch the DRP residual account (verified: the real
      // IOZ-2024 balance table skips its Purchase date entirely).
      if (balanceByIso) {
        const bal = balanceByIso.get(iso);
        if (bal != null) prevBalanceCash = bal;
      }
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
      // Phase 6: emit the full gross distribution for this period as a
      // dividend_cash row, ALONGSIDE (not instead of) the existing drp-only
      // logic below — the dividend was paid whether or not it stretched to a
      // whole reinvested unit. See module doc comment for the formula.
      if (balanceByIso) {
        const curBalanceCash = balanceByIso.get(iso);
        if (curBalanceCash == null || prevBalanceCash == null) {
          warnings.push({
            message: `Computershare: could not determine the DRP residual cash balance around ${iso} — dividend_cash row not recovered for this period`,
            severity: "warn",
          });
        } else if (price == null && delta !== 0) {
          warnings.push({
            message: `Computershare: Distribution Reinvested on ${iso} has an unknown unit price and a non-zero unit delta — gross distribution amount cannot be confidently computed, dividend_cash row not recovered for this period`,
            severity: "warn",
          });
        } else {
          const spent = delta !== 0 && price != null ? delta * price : 0;
          const gross = curBalanceCash - prevBalanceCash + spent;
          if (!Number.isFinite(gross) || gross <= 0) {
            warnings.push({
              message: `Computershare: computed a non-positive gross distribution ($${gross.toFixed(2)}) for ${iso} — dividend_cash row not recovered for this period, check the statement manually`,
              severity: "warn",
            });
          } else {
            transactions.push({
              date: iso,
              ticker,
              exchange: "ASX",
              type: "dividend_cash",
              quantity: 0,
              price: null,
              amount: round2(gross),
              brokerage: 0,
              currency: "AUD",
              externalId: `cs-${ticker.toLowerCase()}-${iso}-dividend_cash`,
              notes:
                "Distribution Reinvested — gross distribution for the period (derived from the Distribution Reinvestment Cash Balance table; no per-unit rate is disclosed)",
            });
          }
        }
        prevBalanceCash = curBalanceCash ?? prevBalanceCash;
      }

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
