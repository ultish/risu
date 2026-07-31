import type { ParsedTransaction, ParseResult, ParseWarning } from "../../../types.js";
import { parseDate, parseNumber } from "../../utils.js";
import type { LayoutParser, LayoutScoreInput } from "../types.js";

/**
 * SelfWealth "Detailed Holdings Summary" AU domestic annual statement.
 *
 * Real quirk #1 (verified against a real 6-page statement via pdf.js's own
 * per-page getTextContent, not just the concatenated .text): every page's
 * text layer contains the FULL statement content byte-for-byte identical,
 * even though the visible/rendered content differs per page (charts, split
 * tables). This is presumably a full-text-search layer stamped once per page
 * by SelfWealth's report generator, decoupled from the visual layout. We
 * parse the whole (fully duplicated) text with global scans and dedupe the
 * resulting rows by content signature — this is correct whether or not a
 * given statement turns out to repeat pages (a non-duplicated statement just
 * produces no duplicates to collapse).
 *
 * Real quirk #2: the column layout changed between statement years, verified
 * against a real jimmy/kozue corpus spanning 2019-2023:
 *   - 2019: `Order ID | Trade Date | Settlement Date | Action | Contract
 *     Note | Units | Unit Price | Consideration | Brokerage | Total
 *     Consideration` (no Fees column)
 *   - 2020 onward: Order ID dropped, `Reference` replaces Contract Note, and
 *     a `Fees *` column is added before Total Consideration.
 * Both are handled by one row parser: the Order ID prefix (if present) is
 * simply skipped, and the Fees column (if present) is folded into brokerage.
 *
 * Real quirk #3: numeric columns are glued with no separator, e.g.
 *   127 Dec 201831 Dec 2018BuyT20181227905031­170$70.96$4,967.20$9.50$4,976.70
 * (order id "1", trade date, settlement date, "Buy", contract note
 * "T20181227905031­1" — note the embedded U+00AD soft hyphen, not "-" — then
 * units "70" glued directly onto the contract note's own trailing digit).
 * The reference/contract-note text carries no meaning we need (confirmed
 * with the user — SelfWealth's own reference numbering isn't stable enough
 * to bother parsing), so rather than trying to characterise its exact shape,
 * we solve for Units the same way the Betashares Direct layout solves for
 * dividend amounts: try every possible split of the glued blob and accept
 * whichever candidate makes `units * unitPrice ≈ consideration` (verified
 * against every real Buy/Sell row in the corpus — arithmetic error is either
 * exactly 0 or a few tenths of a cent from sub-cent unit price rounding).
 *
 * Real quirk #4: "Security In"/"Security Out" rows (DRP allotments, Share
 * Purchase Plan top-ups, SRN→HIN registry conversions, whole-of-holding
 * "Move-Out" transfers to another broker) carry NO unit price at all — only
 * a single trailing "$0.00" — so there is no arithmetic to cross-check units
 * against. Worse, the reference format itself is inconsistent even for the
 * same event type in the same statement (some DRP rows are
 * "CE20210716743412­1", date+sequence+hyphen+suffix; others are a short
 * opaque "CE6838825" with no hyphen at all) — confirmed against the real
 * corpus, not a parsing bug. Units for these rows is instead solved by
 * reconciling each ticker's running unit balance across the year: opening
 * balance (Holdings Valuation as at FY start) → known Buy/Sell deltas →
 * unknown In/Out deltas → checkpoints at each ex-dividend date (the
 * Dividends table's own "Units" column) → closing balance (Holdings
 * Valuation as at FY end, 0 if the ticker is absent). Verified against every
 * real In/Out row in the corpus: every gap between checkpoints has exactly
 * one unresolved row, EXCEPT one case (a DRP allotment immediately preceding
 * a full "Move-Out" with no intervening checkpoint) where the split is
 * genuinely underdetermined — see `reconcileTicker` fallback.
 *
 * Per the user: "Security Out" rows ARE transfer_outs conceptually but are
 * intentionally NOT recorded as ledger transactions (skipped with an info
 * note) — the app doesn't need to track shares leaving via a full HIN
 * transfer. DRP rows carry `price: null, amount: null` (SelfWealth discloses
 * no reinvestment price for DRP allotments) — the actual dollar value of the
 * distribution is captured separately by the `dividend_cash` row emitted
 * from the Estimated Dividends table, so a costless/priceless `drp` row
 * contributes nothing extra to `income.ts`'s assessable-income calculation
 * (dividendRowAmount returns 0 when both are null) — no double-count risk,
 * unlike the Computershare/Link layouts which needed an explicit pooling
 * fix for this (see docs/import-layouts-plan.md §19).
 *
 * Real quirk #5: dividend rows glue the per-unit distribution amount
 * directly onto the franking percentage with no separator, e.g.
 * "$0.82136270.7%" (div amount $0.821362, franking 70.7%). Franking is NOT
 * always a whole number (confirmed: 70.7%, 87.19%, 67.71% in the real
 * corpus), so a naive "franking is 1-2 digits" regex both under- and
 * over-matches. `estDiv` alone can't disambiguate either — it's just
 * `divAmount * units` regardless of franking, so two candidate splits that
 * differ by one digit barely move it (verified: this silently produced
 * "4%" instead of "84%", and "0.7%" instead of "70.7%", on real rows before
 * this was caught). Franking Credit and Unfranked Amount both scale with
 * franking%, so cross-checking against those (30/70 gross-up formula) is
 * what actually discriminates — see `solveDividendSplit`.
 */

const NBSP_RE = / /g;
const SOFT_HYPHEN = "­";
const DATE_SRC = "\\d{1,2} [A-Za-z]{3} \\d{4}";
const ALL_CAPS_LINE_RE = /^[A-Z][A-Z0-9 &./-]*$/;

function normalizeText(text: string): string {
  return text.replace(NBSP_RE, " ");
}

function num(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  return parseNumber(raw);
}

/**
 * ASX ticker codes are (almost always) exactly 3 characters; a minority of
 * ETF codes run to 4 (VDHG, DHHF, ...). None of the real jimmy/kozue corpus
 * used to build this layout has a 4-letter AU code, so this is a known
 * simplification, not a verified general rule — flagged here rather than
 * silently guessed forever.
 */
function splitAuTickerName(blob: string): { ticker: string; name: string } {
  return { ticker: blob.slice(0, 3), name: blob.slice(3) };
}

/**
 * Try every split of a glued reference+quantity blob and accept whichever
 * makes `qty * price` land closest to `consideration` (within tolerance).
 * Mirrors the arithmetic-consistency trick already used by the Computershare
 * and Link/MUFG layouts for their own glued-column ambiguities.
 */
function solveBuySellUnits(
  blob: string,
  price: number,
  consideration: number,
): number | null {
  let best: { qty: number; err: number } | null = null;
  for (let i = 0; i < blob.length; i++) {
    const suffix = blob.slice(i);
    if (!/^\d{1,3}(,\d{3})*(\.\d+)?$/.test(suffix) && !/^\d+(\.\d+)?$/.test(suffix)) {
      continue;
    }
    const qty = parseNumber(suffix);
    if (qty == null || qty <= 0) continue;
    const err = Math.abs(qty * price - consideration);
    if (!best || err < best.err) best = { qty, err };
  }
  if (!best) return null;
  const tolerance = Math.max(0.05, consideration * 0.01);
  if (best.err > tolerance) return null;
  return best.qty;
}

/**
 * Disambiguate a glued "divAmount+franking%" blob (e.g. "0.82136270.7" before
 * the "%"). `estDiv` alone is insufficient (see module doc comment) — Franking
 * Credit and Unfranked Amount both scale with the franking% candidate, so
 * summing all three prediction errors is what actually discriminates.
 */
function solveDividendSplit(
  blob: string,
  units: number,
  estDiv: number,
  frankingCredit: number,
  unfrankedAmount: number,
): { divAmount: number; franking: number } | null {
  let best: { divAmount: number; franking: number; err: number } | null = null;
  for (let i = 1; i < blob.length; i++) {
    const divStr = blob.slice(0, i);
    const frankStr = blob.slice(i);
    if (!/^\d+\.\d+$/.test(divStr)) continue;
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(frankStr)) continue;
    const frankVal = parseFloat(frankStr);
    if (frankVal > 100) continue;
    const divVal = parseFloat(divStr);
    const grossCash = divVal * units;
    const estErr = Math.abs(grossCash - estDiv);
    const predictedCredit = grossCash * (frankVal / 100) * (30 / 70);
    const predictedUnfranked = grossCash * (1 - frankVal / 100);
    const err =
      estErr +
      Math.abs(predictedCredit - frankingCredit) +
      Math.abs(predictedUnfranked - unfrankedAmount);
    if (!best || err < best.err) best = { divAmount: divVal, franking: frankVal, err };
  }
  if (!best) return null;
  return { divAmount: best.divAmount, franking: best.franking };
}

/**
 * Best-effort fallback when a ticker's In/Out rows can't be uniquely
 * resolved by balance reconciliation (2+ ambiguous rows in the same gap
 * between checkpoints — verified to happen exactly once in the real corpus:
 * a DRP allotment immediately preceding that ticker's own full Move-Out,
 * with no checkpoint in between to pin down the DRP's own quantity). Prefers
 * a trailing comma-grouped number (large transfers are comma-formatted,
 * "2,000") else the last single digit (real unresolvable cases in the corpus
 * are all small DRP allotments, 1-3 units).
 */
function fallbackUnitsGuess(blob: string): number {
  const commaGroup = /(\d{1,3}(?:,\d{3})+)$/.exec(blob);
  if (commaGroup) return parseNumber(commaGroup[1]) ?? 1;
  const lastDigit = /(\d)$/.exec(blob);
  return lastDigit ? Number(lastDigit[1]) : 1;
}

type BuySellRow = {
  date: string;
  type: "buy" | "sell";
  quantity: number;
  price: number;
  consideration: number;
  brokerage: number;
};

type InOutRow = {
  date: string;
  action: "In" | "Out";
  description: string;
  blob: string;
};

type DividendRow = {
  exDivDate: string;
  paymentDate: string;
  divType: string;
  units: number;
  divAmount: number;
  franking: number;
  frankingCredit: number;
  unfrankedAmount: number;
  estDiv: number;
};

type TickerData = {
  buysSells: BuySellRow[];
  inOut: InOutRow[];
  dividends: DividendRow[];
};

// Leading `\d*?` (2019-only Order ID prefix) is deliberately non-greedy: a
// greedy `\d*` steals the date's own leading digit whenever no real Order ID
// is present (every 2020+ row, since that format dropped the column) --
// e.g. "10 Mar 2020..." would parse as order id "1" + date "0 Mar 2020".
// Non-greedy only consumes a digit when the date genuinely doesn't fit
// otherwise (the real 2019 case, where an Order ID digit really precedes it).
const BUY_SELL_ROW_RE = new RegExp(
  `^\\d*?(${DATE_SRC})(${DATE_SRC})(Buy|Sell)([A-Za-z0-9,.${SOFT_HYPHEN}]+?)\\$([\\d,.]+)\\$([\\d,.]+)\\$([\\d,.]+)(?:\\$([\\d,.]+))?\\$([\\d,.]+)$`,
);
const IN_OUT_ROW_RE = new RegExp(
  `^(${DATE_SRC})(${DATE_SRC})(In|Out)([A-Za-z0-9,.${SOFT_HYPHEN}]+?)\\$([\\d,.]+)$`,
);
const DIVIDEND_ROW_RE = new RegExp(
  `^(${DATE_SRC})(${DATE_SRC})([A-Za-z]+)\\$([\\d.]+)%(\\d+)\\$([\\d,.]+)\\$([\\d,.]+)\\$([\\d,.]+)$`,
);
const HOLDINGS_ROW_RE = /^(.+?)([\d,]+(?:\.\d+)?)\$([\d,.]+)\$([\d,.]+)$/;
// Anchored to an exact date with nothing trailing — the "Overall Summary"
// table above this section has its OWN "Holdings Valuation as at <date>"
// line with a $ value glued directly onto the date (no section below it);
// a loose `(.+)$` capture would swallow that trailing value into the date
// string, corrupting the opening/closing date-ordering logic.
const HOLDINGS_HEADING_RE = new RegExp(`^Holdings Valuation as at (${DATE_SRC})$`);
const NO_HOLDINGS_RE = /^No holdings as at /;

function parseHoldingsTables(lines: string[]): {
  openingByTicker: Map<string, number>;
  closingByTicker: Map<string, number>;
} {
  const dateOrder: string[] = [];
  const openingByTicker = new Map<string, number>();
  const closingByTicker = new Map<string, number>();

  let currentDate: string | null = null;
  let currentKind: "opening" | "closing" | null = null;

  for (const line of lines) {
    const heading = HOLDINGS_HEADING_RE.exec(line);
    if (heading) {
      const date = heading[1]!;
      if (!dateOrder.includes(date)) dateOrder.push(date);
      currentDate = date;
      currentKind = dateOrder.indexOf(date) === 0 ? "opening" : "closing";
      continue;
    }
    if (!currentDate) continue;
    if (NO_HOLDINGS_RE.test(line) || line === "Code Name Units Unit Price Value") continue;
    if (/^CodeNameUnitsUnit PriceValue$/.test(line)) continue;
    if (/^Total\$/.test(line)) continue;
    const row = HOLDINGS_ROW_RE.exec(line);
    if (!row) continue;
    const [, codeName, unitsStr] = row;
    const { ticker } = splitAuTickerName(codeName!);
    const units = num(unitsStr);
    if (units == null) continue;
    const target = currentKind === "opening" ? openingByTicker : closingByTicker;
    target.set(ticker, units);
  }

  return { openingByTicker, closingByTicker };
}

/**
 * Reconcile one ticker's In/Out rows into resolved unit deltas by walking a
 * running balance across the year (see module doc comment quirk #4).
 */
function reconcileTicker(
  buysSells: BuySellRow[],
  inOutRows: InOutRow[],
  dividends: DividendRow[],
  openingUnits: number,
  closingUnits: number,
  ticker: string,
): { resolved: Map<InOutRow, number>; warnings: ParseWarning[] } {
  const warnings: ParseWarning[] = [];
  const resolved = new Map<InOutRow, number>();

  type Event =
    | { date: string; kind: "known"; delta: number }
    | { date: string; kind: "unknown"; sign: 1 | -1; ref: InOutRow };

  const events: Event[] = [
    ...buysSells.map((r): Event => ({
      date: r.date,
      kind: "known",
      delta: r.type === "buy" ? r.quantity : -r.quantity,
    })),
    ...inOutRows.map((r): Event => ({
      date: r.date,
      kind: "unknown",
      sign: r.action === "In" ? 1 : -1,
      ref: r,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const checkpoints = [...dividends]
    .map((d) => ({ date: d.exDivDate, units: d.units }))
    .sort((a, b) => a.date.localeCompare(b.date));

  let runningBalance = openingUnits;
  let pending: { sign: 1 | -1; ref: InOutRow }[] = [];
  let cpIdx = 0;

  function resolveAt(targetUnits: number) {
    const need = targetUnits - runningBalance;
    if (pending.length === 0) {
      if (Math.abs(need) > 1e-6) {
        warnings.push({
          message: `SelfWealth ${ticker}: balance reconciliation mismatch (expected ${targetUnits}, tracked ${runningBalance}) — holdings/dividend units may be slightly off`,
          severity: "warn",
        });
      }
      runningBalance = targetUnits;
      return;
    }
    if (pending.length === 1) {
      const p = pending[0]!;
      const units = Math.abs(need);
      resolved.set(p.ref, units);
      runningBalance = targetUnits;
      pending = [];
      return;
    }
    for (const p of pending) {
      const guess = fallbackUnitsGuess(p.ref.blob);
      resolved.set(p.ref, guess);
      warnings.push({
        message: `SelfWealth ${ticker}: could not confidently determine units for "${p.ref.description}" on ${p.ref.date} (multiple ambiguous transfer rows between reconciliation checkpoints) — imported best-effort guess of ${guess} unit(s); please verify manually`,
        severity: "warn",
      });
    }
    runningBalance = targetUnits;
    pending = [];
  }

  for (const ev of events) {
    while (cpIdx < checkpoints.length && checkpoints[cpIdx]!.date < ev.date) {
      resolveAt(checkpoints[cpIdx]!.units);
      cpIdx++;
    }
    if (ev.kind === "known") {
      runningBalance += ev.delta;
    } else {
      pending.push({ sign: ev.sign, ref: ev.ref });
    }
  }
  while (cpIdx < checkpoints.length) {
    resolveAt(checkpoints[cpIdx]!.units);
    cpIdx++;
  }
  resolveAt(closingUnits);

  return { resolved, warnings };
}

function isDrpDescription(description: string): boolean {
  return /Dividend Plan Allotment/i.test(description);
}

export function parseSelfwealthAnnualText(
  rawText: string,
  _filename: string,
): ParseResult {
  const text = normalizeText(rawText);
  const lines = text.split("\n").map((l) => l.trim());

  const { openingByTicker, closingByTicker } = parseHoldingsTables(lines);

  const byTicker = new Map<string, TickerData>();
  function getTicker(ticker: string): TickerData {
    let t = byTicker.get(ticker);
    if (!t) {
      t = { buysSells: [], inOut: [], dividends: [] };
      byTicker.set(ticker, t);
    }
    return t;
  }

  type Section = "none" | "transactions" | "dividends";
  let section: Section = "none";
  let ticker: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (/^Page: \d+ of \d+$/.test(line)) {
      section = "none";
      ticker = null;
      continue;
    }
    if (/^Transaction Summary/.test(line)) {
      section = "transactions";
      ticker = null;
      continue;
    }
    if (/^Estimated Dividends and Distributions/.test(line)) {
      section = "dividends";
      ticker = null;
      continue;
    }
    if (section === "none") continue;

    if (ALL_CAPS_LINE_RE.test(line) && line.length >= 4) {
      ticker = splitAuTickerName(line).ticker;
      continue;
    }
    if (!ticker) continue;

    if (section === "transactions") {
      const buySell = BUY_SELL_ROW_RE.exec(line);
      if (buySell) {
        const [, tradeDate, , action, blob, priceStr, considStr, brokStr, feesStr] =
          buySell;
        const iso = parseDate(tradeDate!);
        if (!iso) continue;
        const price = num(priceStr);
        const consid = num(considStr);
        if (price == null || consid == null) continue;
        const qty = solveBuySellUnits(blob!, price, consid);
        if (qty == null) continue;
        const brokerage = (num(brokStr) ?? 0) + (num(feesStr) ?? 0);
        getTicker(ticker).buysSells.push({
          date: iso,
          type: action === "Buy" ? "buy" : "sell",
          quantity: qty,
          price,
          consideration: consid,
          brokerage,
        });
        continue;
      }
      const inOut = IN_OUT_ROW_RE.exec(line);
      if (inOut) {
        const [, tradeDate, , action, blob] = inOut;
        const iso = parseDate(tradeDate!);
        if (!iso) continue;
        const descLine = lines[i + 1] ?? "";
        const desc = /^Security (?:In|Out):/.test(descLine) ? descLine : "";
        getTicker(ticker).inOut.push({
          date: iso,
          action: action as "In" | "Out",
          description: desc,
          blob: blob!,
        });
        continue;
      }
      continue;
    }

    if (section === "dividends") {
      const div = DIVIDEND_ROW_RE.exec(line);
      if (div) {
        const [, exDiv, payDate, divType, blob, unitsStr, fcStr, uaStr, edStr] = div;
        const exIso = parseDate(exDiv!);
        const payIso = parseDate(payDate!);
        const units = Number(unitsStr);
        const frankingCredit = num(fcStr) ?? 0;
        const unfrankedAmount = num(uaStr) ?? 0;
        const estDiv = num(edStr) ?? 0;
        if (!exIso || !payIso) continue;
        const split = solveDividendSplit(blob!, units, estDiv, frankingCredit, unfrankedAmount);
        if (!split) continue;
        getTicker(ticker).dividends.push({
          exDivDate: exIso,
          paymentDate: payIso,
          divType: divType!,
          units,
          divAmount: split.divAmount,
          franking: split.franking,
          frankingCredit,
          unfrankedAmount,
          estDiv,
        });
      }
      continue;
    }
  }

  const transactions: ParsedTransaction[] = [];
  const warnings: ParseWarning[] = [];
  let skippedOutCount = 0;

  function dedupeKey(t: ParsedTransaction): string {
    return `${t.date}|${t.ticker}|${t.type}|${t.quantity}|${t.price}|${t.amount}|${t.externalId}`;
  }
  const seen = new Set<string>();
  function push(t: ParsedTransaction) {
    const key = dedupeKey(t);
    if (seen.has(key)) return;
    seen.add(key);
    transactions.push(t);
  }

  for (const [tkr, data] of byTicker) {
    // Dedupe rows collected across duplicated pages before reconciling.
    const seenBuySell = new Set<string>();
    const buysSells = data.buysSells.filter((r) => {
      const k = `${r.date}|${r.type}|${r.quantity}|${r.price}|${r.consideration}|${r.brokerage}`;
      if (seenBuySell.has(k)) return false;
      seenBuySell.add(k);
      return true;
    });
    const seenInOut = new Set<string>();
    const inOutRows = data.inOut.filter((r) => {
      const k = `${r.date}|${r.action}|${r.description}|${r.blob}`;
      if (seenInOut.has(k)) return false;
      seenInOut.add(k);
      return true;
    });
    const seenDiv = new Set<string>();
    const dividends = data.dividends.filter((r) => {
      const k = `${r.exDivDate}|${r.divAmount}|${r.franking}|${r.units}`;
      if (seenDiv.has(k)) return false;
      seenDiv.add(k);
      return true;
    });

    for (const r of buysSells) {
      push({
        date: r.date,
        ticker: tkr,
        exchange: "ASX",
        type: r.type,
        quantity: r.quantity,
        price: r.price,
        amount: r.consideration,
        brokerage: r.brokerage,
        currency: "AUD",
        externalId: `sw-${tkr.toLowerCase()}-${r.date}-${r.type}-${r.quantity}-${r.price}`,
        notes: null,
      });
    }

    const opening = openingByTicker.get(tkr) ?? 0;
    const closing = closingByTicker.get(tkr) ?? 0;
    const { resolved, warnings: recWarnings } = reconcileTicker(
      buysSells,
      inOutRows,
      dividends,
      opening,
      closing,
      tkr,
    );
    warnings.push(...recWarnings);

    for (const r of inOutRows) {
      if (r.action === "Out") {
        skippedOutCount += 1;
        continue;
      }
      const qty = resolved.get(r) ?? fallbackUnitsGuess(r.blob);
      const isDrp = isDrpDescription(r.description);
      push({
        date: r.date,
        ticker: tkr,
        exchange: "ASX",
        type: isDrp ? "drp" : "transfer_in",
        quantity: qty,
        price: null,
        amount: null,
        brokerage: 0,
        currency: "AUD",
        externalId: `sw-${tkr.toLowerCase()}-${r.date}-${isDrp ? "drp" : "transfer_in"}-${qty}`,
        notes: r.description || null,
      });
    }

    for (const d of dividends) {
      push({
        date: d.exDivDate,
        ticker: tkr,
        exchange: "ASX",
        type: "dividend_cash",
        quantity: 0,
        price: d.divAmount,
        amount: d.estDiv,
        brokerage: 0,
        currency: "AUD",
        externalId: `sw-${tkr.toLowerCase()}-${d.exDivDate}-dividend_cash`,
        notes: `${d.divType} dividend, ${d.franking}% franked (estimate)`,
      });
    }
  }

  if (skippedOutCount > 0) {
    warnings.push({
      message: `Skipped ${skippedOutCount} "Security Out" transfer row(s) — not recorded (shares leaving via a full HIN transfer aren't tracked as ledger transactions)`,
      severity: "info",
    });
  }

  if (transactions.length === 0) {
    warnings.push({
      message: "No transactions found in this SelfWealth annual statement — not an error.",
      severity: "info",
    });
  }

  transactions.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));

  return { broker: "selfwealth", transactions, warnings, skippedRows: 0 };
}

/** Fingerprint hits per docs/import-layouts-plan.md §11.3 conventions. */
function score(input: LayoutScoreInput): number {
  const raw = input.text ?? "";
  if (!raw) return 0;
  // Normalize first — SelfWealth's older-template PDFs use a non-breaking
  // space between many word pairs (verified: "OpenMarkets Id", "Transaction
  // Summary" and "Holding Identification Number (HIN)" all fail a literal-
  // space match against the raw text), same quirk parse() already handles.
  const t = normalizeText(raw);
  let hits = 0;
  if (/SelfWealth/i.test(t)) hits += 1;
  if (/Holding Identification Number \(HIN\)/i.test(t)) hits += 1;
  if (/Transaction Summary/i.test(t)) hits += 1;
  if (/OpenMarkets Id/i.test(t)) hits += 1;
  return hits;
}

export const selfwealthAnnualLayout: LayoutParser = {
  id: "selfwealth.annual",
  score,
  parse(input) {
    return parseSelfwealthAnnualText(input.text ?? "", input.filename);
  },
};
