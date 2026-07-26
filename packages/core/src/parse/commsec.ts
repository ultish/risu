import type { ParseResult, ParsedTransaction } from "../types.js";
import {
  classifyType,
  getField,
  lowerKeys,
  normaliseTicker,
  parseBuySellToken,
  parseDate,
  parseNumber,
} from "./utils.js";

/**
 * CommSec / Pocket confirmations & transaction CSV variants.
 * Formats evolve; we accept several column aliases.
 *
 * DRP rows typically appear in details as "DRP" / "Dividend Reinvestment"
 * and should become type=drp with positive quantity.
 */
export function parseCommsecRows(
  rows: Record<string, unknown>[],
  broker: "commsec" | "pocket" = "commsec",
): ParseResult {
  const transactions: ParsedTransaction[] = [];
  const warnings: ParseResult["warnings"] = [];
  let skippedRows = 0;

  rows.forEach((raw, idx) => {
    const row = lowerKeys(raw as Record<string, unknown>);
    const dateRaw = getField(
      row,
      "date",
      "trade date",
      "trade_date",
      "settlement date",
      "effective date",
    );
    const date = parseDate(dateRaw);
    if (!date) {
      skippedRows++;
      return;
    }

    const details = getField(
      row,
      "details",
      "description",
      "narrative",
      "particulars",
      "transaction details",
    );
    const code = getField(
      row,
      "stock code",
      "code",
      "security",
      "symbol",
      "ticker",
      "asx code",
    );

    // CommSec details often: "BHP BHP Group Limited - Buy 10"
    let ticker = normaliseTicker(code);
    if (!ticker && details) {
      const m = details.match(/\b([A-Z0-9]{2,6})\b/);
      if (m) ticker = normaliseTicker(m[1]!);
    }

    const side = getField(
      row,
      "buy/sell",
      "buy / sell",
      "buy sell",
      "b/s",
      "side",
      "transaction type",
      "action",
      // Avoid bare "type" — can false-match unrelated columns on some exports
    );
    // Prefer explicit B/S token (CommSec Confirmations); fall back to free-text
    const sideToken = parseBuySellToken(side);
    let type = sideToken ?? classifyType(side || details, details);

    let quantity =
      parseNumber(
        getField(row, "quantity", "qty", "units", "volume", "shares"),
      ) ?? 0;
    quantity = Math.abs(quantity);

    let price = parseNumber(
      getField(
        row,
        "price",
        "unit price",
        "avg price",
        "average price",
        "average price ($)",
      ),
    );
    const brokerage =
      parseNumber(
        getField(
          row,
          "brokerage",
          "brokerage($)",
          "brokerage (inc gst.)",
          "brokerage (inc gst)",
          "fees",
          "brokerage gst",
        ),
      ) ?? 0;

    // Debit/Credit style cash ledgers
    const debit = parseNumber(getField(row, "debit($)", "debit", "debit $"));
    const credit = parseNumber(getField(row, "credit($)", "credit", "credit $"));

    let amount: number | null = parseNumber(
      getField(
        row,
        "consideration",
        "net proceeds",
        "net proceeds ($)",
        "amount",
        "value",
        "total",
        "net amount",
      ),
    );

    if (amount == null) {
      if (debit != null && debit !== 0) amount = Math.abs(debit);
      else if (credit != null && credit !== 0) amount = Math.abs(credit);
    }

    // Cash dividend only (no units) — still import for income, no holding change
    if (type === "dividend_cash" && quantity === 0) {
      transactions.push({
        date,
        ticker: ticker || "CASH",
        exchange: "ASX",
        type: "dividend_cash",
        quantity: 0,
        price: null,
        amount,
        brokerage: 0,
        currency: "AUD",
        externalId: getField(row, "reference", "ref", "confirmation", "contract note") || null,
        notes: details || null,
        raw: row,
      });
      return;
    }

    if (!ticker) {
      warnings.push({
        row: idx + 2,
        message: `Skipped row: could not determine ticker (${details || dateRaw})`,
        severity: "warn",
      });
      skippedRows++;
      return;
    }

    // Buys/DRP need quantity; sells need quantity
    if (
      (type === "buy" || type === "sell" || type === "drp" || type === "transfer_in") &&
      quantity === 0
    ) {
      // Try parse from details: "Buy 12" / "DRP 3.5"
      const qm = details.match(
        /(?:buy|sell|drp|reinvest(?:ment)?|units?)[^\d]*([\d,.]+)/i,
      );
      if (qm) quantity = Math.abs(parseNumber(qm[1]) ?? 0);
    }

    if (quantity === 0 && type !== "fee" && type !== "other") {
      warnings.push({
        row: idx + 2,
        message: `Skipped ${ticker}: zero quantity (${side || details})`,
        severity: "info",
      });
      skippedRows++;
      return;
    }

    if (price == null && amount != null && quantity > 0) {
      price = amount / quantity;
    }

    // Cash ledger fallback: debit ≈ buy, credit ≈ sell when side missing
    if (type === "other") {
      if (debit != null && debit > 0) type = "buy";
      else if (credit != null && credit > 0) type = "sell";
    }
    // Net proceeds present + quantity: still other → treat as buy if we have
    // units and average price (Confirmations always have B/S; this is last resort)
    if (type === "other" && quantity > 0 && (price != null || amount != null)) {
      // Prefer sell if confirmation notes say sold; else leave other
      if (/\bsell\b|\bsold\b/i.test(details)) type = "sell";
      else if (/\bbuy\b|\bbought\b/i.test(details)) type = "buy";
    }

    // Normalise sell quantity positive; engine treats type
    const tx: ParsedTransaction = {
      date,
      ticker,
      exchange: "ASX",
      type,
      quantity,
      price,
      amount,
      brokerage: Math.abs(brokerage),
      currency: "AUD",
      externalId:
        getField(
          row,
          "confirmation number",
          "confirmation",
          "reference",
          "ref",
          "contract note",
          "order number",
          "order id",
        ) || null,
      notes: details || side || null,
      raw: row,
    };

    // Force DRP if details scream DRP even when side said Buy
    if (classifyType(details) === "drp") {
      tx.type = "drp";
    }

    transactions.push(tx);
  });

  return {
    broker,
    transactions,
    warnings,
    skippedRows,
  };
}
