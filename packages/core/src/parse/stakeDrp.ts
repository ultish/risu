import * as XLSX from "xlsx";
import type { ParsedTransaction, ParseWarning } from "../types.js";
import { normaliseTicker, parseDate, parseNumber } from "./utils.js";

/**
 * Stake DRP detection — a separate, explicit, on-demand tool (not part of the
 * regular per-file Activity/Income import, which is unaffected by this file).
 *
 * The problem: Stake's Investment Activity export never shows dividend
 * reinvestment as a distinct trade — a reinvested unit is invisible there.
 * The only trace is the `Units` (units-held-at-this-date) column in the
 * Investment Income workbook drifting upward between dividend periods with
 * no corresponding Activity buy to explain it. Verified against a real
 * multi-year Stake corpus (2021-2027): every genuine DRP event shows up
 * exactly this way, and the reconciliation (opening/closing Portfolio
 * Valuation snapshots as extra checkpoints, Activity buys/sells netted out
 * in between) closes exactly to the cent/unit across the whole history.
 *
 * Critical guardrail, also confirmed against that same real corpus: NOT
 * every unexplained units-held change is DRP. Two real counterexamples:
 *   - NXT: +13 units appeared between two Portfolio Valuation snapshots
 *     with NO dividend record at all in that gap (NextDC has never paid a
 *     dividend) — that turned out to be a Share Purchase Plan bought
 *     directly from the company, completely outside Stake's own records.
 *   - ORGN: units dropped 6 -> 0.2 (exactly 1-for-30) between two
 *     valuations, again with no dividend in the gap — an auto-liquidation
 *     of an inactive holding, not a reinvestment (DRP only ever adds units).
 * Rule: a units-held mismatch is only ever attributed to DRP when the
 * *immediately preceding* checkpoint was itself a dividend record (i.e.
 * there's an actual distribution whose proceeds could fund it) AND the
 * resulting delta is positive. Every other mismatch is reported as a
 * warning instead of a guess — the user must investigate and enter it
 * manually (per user decision: "for gaps u find, just warn me in the ui").
 *
 * This is intentionally decoupled from the regular ledger/import flow: it
 * takes raw workbook files as input (any mix of Activity/Income/Valuation,
 * any years, any order) and returns proposed `drp` transactions + warnings
 * for the caller (API layer) to preview and, on confirmation, insert.
 */

export type StakeDrpFileKind = "activity" | "income" | "valuation" | "unknown";

function sheetToPlainText(wb: XLSX.WorkBook, sheetName: string): string {
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return "";
  const aoa = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
    header: 1,
    defval: "",
  });
  return aoa.map((row) => (Array.isArray(row) ? row.join(" ") : String(row))).join("\n");
}

function rows(wb: XLSX.WorkBook, sheetName: string): Record<string, unknown>[] {
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });
}

export function detectStakeDrpFileKind(wb: XLSX.WorkBook): StakeDrpFileKind {
  const summaryText = sheetToPlainText(wb, "Summary");
  if (/report\s*type\s*:\s*investment\s*activity/i.test(summaryText)) return "activity";
  if (/report\s*type\s*:\s*investment\s*income/i.test(summaryText)) return "income";
  if (/report\s*type\s*:\s*portfolio\s*valuation/i.test(summaryText)) return "valuation";
  return "unknown";
}

function num(v: unknown): number | null {
  if (v === "" || v == null) return null;
  return parseNumber(v);
}

type CheckpointEvent = {
  date: string; // iso
  kind: "dividend" | "valuation";
  units: number;
  ticker: string;
  exchange: string;
  currency: string;
  /** For dividend checkpoints: the payment date (when reinvestment would land). */
  paymentDate?: string;
  /** Human-readable source description for notes/warnings. */
  label: string;
};

type TradeEvent = {
  date: string;
  ticker: string;
  exchange: string;
  delta: number;
};

/** Reads the "as at" date from a Portfolio Valuation workbook's Summary sheet. */
function readValuationAsAtDate(wb: XLSX.WorkBook): string | null {
  const summaryText = sheetToPlainText(wb, "Summary");
  const m = summaryText.match(/Statement\s*Date\s*:\s*(\d{4}-\d{2}-\d{2})/i);
  return m ? m[1]! : null;
}

function extractValuationCheckpoints(wb: XLSX.WorkBook): CheckpointEvent[] {
  const asAt = readValuationAsAtDate(wb);
  if (!asAt) return [];
  const out: CheckpointEvent[] = [];
  for (const [sheetName, exchange, currency] of [
    ["Aus Equities", "ASX", "AUD"],
    ["Wall St Equities", "US", "USD"],
  ] as const) {
    for (const r of rows(wb, sheetName)) {
      const ticker = normaliseTicker(String(r["Symbol"] ?? ""));
      const units = num(r["Units"]);
      if (!ticker || units == null) continue;
      out.push({
        date: asAt,
        kind: "valuation",
        units,
        ticker,
        exchange,
        currency,
        label: "Portfolio Valuation",
      });
    }
  }
  return out;
}

function extractIncomeCheckpoints(wb: XLSX.WorkBook): CheckpointEvent[] {
  const out: CheckpointEvent[] = [];
  for (const [sheetName, exchange, currency] of [
    ["Aus Dividends (Estimated)", "ASX", "AUD"],
    ["Wall St Dividends", "US", "USD"],
  ] as const) {
    for (const r of rows(wb, sheetName)) {
      const ticker = normaliseTicker(String(r["Symbol"] ?? ""));
      const units = num(r["Units"]);
      const exDivRaw = r["Ex-Dividend Date"] ?? r["Ex Dividend Date"];
      const payRaw = r["Payment Date"];
      const exDiv = exDivRaw ? parseDate(String(exDivRaw)) : null;
      const pay = payRaw ? parseDate(String(payRaw)) : null;
      if (!ticker || units == null || !exDiv) continue;
      out.push({
        date: exDiv,
        kind: "dividend",
        units,
        ticker,
        exchange,
        currency,
        paymentDate: pay ?? exDiv,
        label: `${r["Type"] || "Dividend"} (ex-div ${exDiv})`,
      });
    }
  }
  return out;
}

function extractTrades(wb: XLSX.WorkBook): TradeEvent[] {
  const out: TradeEvent[] = [];
  for (const [sheetName, exchange] of [
    ["Aus Equities", "ASX"],
    ["Wall St Equities", "US"],
  ] as const) {
    for (const r of rows(wb, sheetName)) {
      const ticker = normaliseTicker(String(r["Symbol"] ?? ""));
      const side = String(r["Side"] ?? "");
      const units = num(r["Units"]);
      const dateRaw = r["Trade Date"];
      if (!ticker || units == null || !dateRaw || !side) continue;
      const date = parseDate(String(dateRaw));
      if (!date) continue;
      out.push({ date, ticker, exchange, delta: /sell/i.test(side) ? -units : units });
    }
  }
  return out;
}

export type StakeDrpProposedTransaction = ParsedTransaction & {
  /** Dividend event that funded this reinvestment, for the preview UI. */
  fundedBy: string;
};

export type StakeDrpFileWarning = ParseWarning & { ticker?: string };

export type StakeDrpAnalysis = {
  proposed: StakeDrpProposedTransaction[];
  warnings: StakeDrpFileWarning[];
  /** Filenames that weren't recognized as an Activity/Income/Valuation export. */
  unrecognizedFiles: string[];
};

/**
 * Analyze any mix of Stake Activity/Income/Valuation workbooks (any years,
 * any order) and propose `drp` transactions for units-held changes that are
 * cleanly explained by a preceding dividend record, with a warning for every
 * other unexplained change (see module doc comment for the guardrail).
 */
export function analyzeStakeDrp(
  files: Array<{ filename: string; content: Buffer | ArrayBuffer }>,
): StakeDrpAnalysis {
  const checkpointsByTicker = new Map<string, CheckpointEvent[]>();
  const tradesByTicker = new Map<string, TradeEvent[]>();
  const exchangeByTicker = new Map<string, string>();
  const currencyByTicker = new Map<string, string>();
  const unrecognizedFiles: string[] = [];

  function key(ticker: string, exchange: string) {
    return `${exchange}:${ticker}`;
  }

  for (const f of files) {
    let wb: XLSX.WorkBook;
    try {
      wb = XLSX.read(f.content, { type: "buffer", cellDates: true });
    } catch {
      unrecognizedFiles.push(f.filename);
      continue;
    }
    const kind = detectStakeDrpFileKind(wb);
    if (kind === "unknown") {
      unrecognizedFiles.push(f.filename);
      continue;
    }
    const checkpoints =
      kind === "valuation" ? extractValuationCheckpoints(wb) : kind === "income" ? extractIncomeCheckpoints(wb) : [];
    for (const cp of checkpoints) {
      const k = key(cp.ticker, cp.exchange);
      exchangeByTicker.set(k, cp.exchange);
      currencyByTicker.set(k, cp.currency);
      const list = checkpointsByTicker.get(k) ?? [];
      list.push(cp);
      checkpointsByTicker.set(k, list);
    }
    if (kind === "activity") {
      for (const tr of extractTrades(wb)) {
        const k = key(tr.ticker, tr.exchange);
        exchangeByTicker.set(k, tr.exchange);
        const list = tradesByTicker.get(k) ?? [];
        list.push(tr);
        tradesByTicker.set(k, list);
      }
    }
  }

  const proposed: StakeDrpProposedTransaction[] = [];
  const warnings: StakeDrpFileWarning[] = [];

  const allTickerKeys = new Set([...checkpointsByTicker.keys(), ...tradesByTicker.keys()]);

  for (const k of allTickerKeys) {
    const ticker = k.split(":")[1]!;
    const exchange = exchangeByTicker.get(k) ?? "ASX";
    const currency = currencyByTicker.get(k) ?? "AUD";

    // Dedupe checkpoints (same ticker may appear in multiple uploaded files
    // covering overlapping periods) by (date, kind, units) signature.
    const seen = new Set<string>();
    const checkpoints = (checkpointsByTicker.get(k) ?? []).filter((cp) => {
      const sig = `${cp.date}|${cp.kind}|${cp.units}`;
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
    const trades = tradesByTicker.get(k) ?? [];

    type Event =
      | { date: string; kind: "checkpoint"; cp: CheckpointEvent }
      | { date: string; kind: "trade"; delta: number };
    const events: Event[] = [
      ...checkpoints.map((cp): Event => ({ date: cp.date, kind: "checkpoint", cp })),
      ...trades.map((t): Event => ({ date: t.date, kind: "trade", delta: t.delta })),
    ].sort((a, b) => a.date.localeCompare(b.date));

    let runningBalance: number | null = null;
    let pendingDelta = 0;
    let prevDividend: CheckpointEvent | null = null;
    let prevDate: string | null = null;

    for (const ev of events) {
      if (ev.kind === "trade") {
        pendingDelta += ev.delta;
        continue;
      }
      const cp = ev.cp;
      if (runningBalance == null) {
        runningBalance = cp.units;
        prevDividend = cp.kind === "dividend" ? cp : null;
        prevDate = cp.date;
        pendingDelta = 0;
        continue;
      }
      const expected = runningBalance + pendingDelta;
      const mismatch = cp.units - expected;
      if (Math.abs(mismatch) > 1e-9) {
        if (prevDividend && mismatch > 0) {
          const qty = mismatch;
          const fundingDate = prevDividend.paymentDate ?? prevDividend.date;
          proposed.push({
            date: fundingDate,
            ticker,
            exchange,
            type: "drp",
            quantity: qty,
            price: null,
            amount: null,
            brokerage: 0,
            currency,
            externalId: `stake-drp-${ticker.toLowerCase()}-${fundingDate}-${qty}`,
            notes: `DRP inferred: units held ${runningBalance + pendingDelta} -> ${cp.units} following ${prevDividend.label}, confirmed by ${cp.label} on ${cp.date}`,
            fundedBy: prevDividend.label,
          });
        } else {
          warnings.push({
            ticker,
            severity: "warn",
            message:
              `${ticker}: unexplained ${mismatch > 0 ? "+" : ""}${mismatch} unit change between ${prevDate} and ${cp.date} ` +
              `(${cp.label}) — no dividend record covers this gap, so this can't be confidently attributed to DRP. ` +
              `Check for a corporate action (split, bonus issue, share purchase plan, delisting/liquidation) and enter it manually if needed.`,
          });
        }
      }
      runningBalance = cp.units;
      prevDividend = cp.kind === "dividend" ? cp : null;
      prevDate = cp.date;
      pendingDelta = 0;
    }
  }

  proposed.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));

  return { proposed, warnings, unrecognizedFiles };
}
