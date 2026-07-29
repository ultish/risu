import type { ParseResult, ParsedTransaction, TransactionType } from "../types.js";
import { parseNumber } from "./utils.js";

/**
 * Parse a paste of Sharesight's per-holding "All trades & adjustments" list.
 *
 * Example block (repeated):
 *   10 Jun 2025
 *   Buy
 *   1.00889087
 *   US$312.68
 *   US$3.00
 *   0.65278054 AUD/USD
 *   AU$487.85
 *   Confirmed
 *   Edit
 *
 * Free-plan users often have this view when the All Trades Report is locked.
 * Native trade currency (the US$/AU$ price line) is preferred, matching every
 * other parser in this codebase (Stake, CommSec, …) — the ledger keeps native
 * currency and `holdings.ts` converts to AUD via FX for display. The
 * separately-shown "AU$ value" total (Sharesight's own FX conversion at trade
 * date) is only used as a fallback when no native price line is present.
 */
export function parseSharesightPaste(
  text: string,
  options: {
    ticker: string;
    exchange?: string;
    /** Default trade currency if only US$/AU$ markers appear */
    defaultCurrency?: string;
  },
): ParseResult {
  const ticker = options.ticker.trim().toUpperCase();
  const exchange = (options.exchange || "US").toUpperCase();
  const warnings: ParseResult["warnings"] = [];
  const transactions: ParsedTransaction[] = [];

  if (!ticker) {
    return {
      broker: "sharesight",
      transactions: [],
      warnings: [
        { message: "Ticker is required for paste import", severity: "error" },
      ],
      skippedRows: 0,
    };
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Drop chrome
  const skipExact = new Set([
    "all trades & adjustments",
    "add trade or adjustment",
    "confirmed",
    "edit",
    "delete",
  ]);

  const cleaned = lines.filter((l) => !skipExact.has(l.toLowerCase()));

  // Find date lines and parse blocks starting there
  const dateLineIdx: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (parseSharesightDate(cleaned[i]!)) dateLineIdx.push(i);
  }

  if (!dateLineIdx.length) {
    return {
      broker: "sharesight",
      transactions: [],
      warnings: [
        {
          message:
            "No dates found. Paste the full “All trades & adjustments” list from a holding (date, Buy/Sell/Split, qty, prices…).",
          severity: "error",
        },
      ],
      skippedRows: 0,
    };
  }

  for (let d = 0; d < dateLineIdx.length; d++) {
    const start = dateLineIdx[d]!;
    const end = dateLineIdx[d + 1] ?? cleaned.length;
    const block = cleaned.slice(start, end);
    const tx = parseBlock(block, ticker, exchange);
    if (tx) transactions.push(tx);
    else {
      warnings.push({
        message: `Could not parse block starting: ${block[0]}`,
        severity: "warn",
      });
    }
  }

  transactions.sort((a, b) => a.date.localeCompare(b.date));

  return {
    broker: "sharesight",
    transactions,
    warnings,
    skippedRows: 0,
  };
}

function parseBlock(
  block: string[],
  ticker: string,
  exchange: string,
): ParsedTransaction | null {
  if (block.length < 2) return null;
  const date = parseSharesightDate(block[0]!);
  if (!date) return null;

  const typeRaw = block[1]!.toLowerCase();
  let type: TransactionType = "other";
  if (typeRaw === "buy") type = "buy";
  else if (typeRaw === "sell") type = "sell";
  else if (typeRaw === "split") type = "split";
  else if (typeRaw.includes("drp") || typeRaw.includes("drip") || typeRaw.includes("reinvest"))
    type = "drp";
  else if (typeRaw.includes("dividend")) type = "dividend_cash";
  else if (typeRaw.includes("transfer in") || typeRaw.includes("opening"))
    type = "transfer_in";
  else if (typeRaw.includes("transfer out")) type = "transfer_out";
  else type = classifyLoose(typeRaw);

  // Remaining fields in order: qty, price, brokerage, fx, value (some may be —)
  const fields = block.slice(2).filter((l) => {
    const x = l.toLowerCase();
    return x !== "confirmed" && x !== "edit" && x !== "delete";
  });

  let quantity = parseNumber(fields[0] ?? "") ?? 0;
  const priceField = fields[1] ?? "";
  const brokerageField = fields[2] ?? "";
  const fxField = fields[3] ?? "";
  const valueField = fields[4] ?? "";

  // Sells often negative qty in Sharesight
  if (type === "sell" && quantity < 0) quantity = Math.abs(quantity);
  if (type === "buy" && quantity < 0) {
    type = "sell";
    quantity = Math.abs(quantity);
  }

  const priceNative = parseMoney(priceField);
  const brokerageNative = parseMoney(brokerageField);
  const valueAud = parseMoney(valueField); // AU$…
  const valueIsAud = /au\$|a\$/i.test(valueField) || valueField.includes("AU");
  const fxRate = parseFxRate(fxField); // USD per 1 AUD when labelled AUD/USD in Sharesight UI

  // Prefer AUD cost base for AU residents when AU$ value present
  let currency = "USD";
  let price: number | null = priceNative;
  let amount: number | null = null;
  let brokerage = 0;

  if (type === "split") {
    // Sharesight split row quantity = adjustment to units (treat as delta)
    return {
      date,
      ticker,
      exchange,
      type: "split",
      quantity,
      price: null,
      amount: null,
      brokerage: 0,
      currency: "USD",
      externalId: `ss-paste|${date}|${ticker}|split|${quantity}`,
      notes: `Sharesight split adjustment`,
    };
  }

  // Prefer the native trade-currency price line — consistent with every
  // other parser (Stake, CommSec, …), which keep native currency and let
  // holdings.ts convert to AUD via FX. Fall back to Sharesight's own AU$
  // total only when no native price line is present at all.
  if (priceNative != null) {
    currency = detectCurrency(priceField) || "USD";
    amount =
      quantity > 0
        ? Math.abs(priceNative * quantity) + Math.abs(brokerageNative ?? 0)
        : null;
    brokerage = Math.abs(brokerageNative ?? 0);
    price = priceNative;
  } else if (valueAud != null && (valueIsAud || /au|a\$/i.test(valueField))) {
    currency = "AUD";
    amount = Math.abs(valueAud);
    brokerage = 0;
    if (quantity > 0) price = amount / quantity;
  }
  if (quantity === 0 && type !== "dividend_cash") return null;

  const notesParts = [
    block[1],
    priceField && priceField !== "—" ? `px ${priceField}` : null,
    brokerageField && brokerageField !== "—" ? `fee ${brokerageField}` : null,
    fxField && fxField !== "—" ? `fx ${fxField}` : null,
    fxRate != null ? `(stored cost in ${currency})` : null,
  ].filter(Boolean);

  return {
    date,
    ticker,
    exchange,
    type,
    quantity,
    price,
    amount,
    brokerage,
    currency,
    externalId: `ss-paste|${date}|${ticker}|${type}|${quantity}|${price ?? ""}|${amount ?? ""}`,
    notes: notesParts.join(" · "),
  };
}

function classifyLoose(s: string): TransactionType {
  if (s.includes("buy")) return "buy";
  if (s.includes("sell")) return "sell";
  return "other";
}

/** e.g. "10 Jun 2025", "8 Aug 2018" — strict (do not use loose Date.parse). */
export function parseSharesightDate(raw: string): string | null {
  const s = raw.trim();
  // d MMM yyyy
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (m) {
    const day = Number(m[1]);
    const mon = monthNum(m[2]!);
    const year = Number(m[3]);
    if (mon && day >= 1 && day <= 31 && year >= 1970 && year <= 2100) {
      return `${year}-${pad(mon)}-${pad(day)}`;
    }
  }
  // ISO only as alternate
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function monthNum(name: string): number | null {
  const key = name.slice(0, 3).toLowerCase();
  const map: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  return map[key] ?? null;
}

function pad(n: number) {
  return n < 10 ? `0${n}` : String(n);
}

function parseMoney(raw: string): number | null {
  if (!raw || raw === "—" || raw === "-" || raw === "–") return null;
  // -AU$9,352.01 or US$312.68
  const neg = /^-/.test(raw.trim()) || /\(-/.test(raw);
  const n = parseNumber(raw.replace(/^[A-Z]{0,3}\$/i, "").replace(/AU\$|US\$|A\$|\$/gi, ""));
  if (n == null) return null;
  return neg ? -Math.abs(n) : n;
}

function detectCurrency(raw: string): string | null {
  if (/us\$/i.test(raw)) return "USD";
  if (/au\$|a\$/i.test(raw)) return "AUD";
  if (/£|gbp/i.test(raw)) return "GBP";
  if (/€|eur/i.test(raw)) return "EUR";
  return null;
}

/** Sharesight "0.65 AUD/USD" in examples is USD per 1 AUD (same as Yahoo AUDUSD=X). */
function parseFxRate(raw: string): number | null {
  if (!raw || raw === "—") return null;
  const m = raw.match(/([0-9.]+)\s*AUD\s*\/\s*USD/i);
  if (m) return Number(m[1]);
  const n = parseNumber(raw);
  return n;
}
