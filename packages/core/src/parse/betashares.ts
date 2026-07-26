import type { ParseResult, ParsedTransaction } from "../types.js";
import {
  classifyType,
  getField,
  lowerKeys,
  normaliseTicker,
  parseDate,
  parseNumber,
} from "./utils.js";

/** Betashares Direct activity / cost-base style exports */
export function parseBetasharesRows(
  rows: Record<string, unknown>[],
): ParseResult {
  const transactions: ParsedTransaction[] = [];
  const warnings: ParseResult["warnings"] = [];
  let skippedRows = 0;

  rows.forEach((raw, idx) => {
    const row = lowerKeys(raw as Record<string, unknown>);
    const date = parseDate(
      getField(
        row,
        "date",
        "trade date",
        "transaction date",
        "effective date",
        "purchase date",
      ),
    );
    if (!date) {
      skippedRows++;
      return;
    }

    const ticker = normaliseTicker(
      getField(row, "ticker", "code", "fund", "symbol", "asx code", "etf"),
    );
    const side = getField(
      row,
      "type",
      "transaction type",
      "activity",
      "side",
      "action",
      "description",
    );
    const details = getField(row, "description", "details", "notes", "narrative");
    const type = classifyType(side, details);

    let quantity =
      parseNumber(getField(row, "units", "quantity", "qty", "unit")) ?? 0;
    quantity = Math.abs(quantity);
    let price = parseNumber(
      getField(row, "unit price", "price", "nav", "application price"),
    );
    const brokerage =
      parseNumber(getField(row, "fees", "fee", "brokerage", "cost")) ?? 0;
    let amount = parseNumber(
      getField(
        row,
        "amount",
        "value",
        "consideration",
        "cost base",
        "total",
        "net amount",
      ),
    );

    if (!ticker) {
      warnings.push({
        row: idx + 2,
        message: "Skipped row without ticker",
        severity: "warn",
      });
      skippedRows++;
      return;
    }

    if (price == null && amount != null && quantity > 0) price = amount / quantity;

    // Reinvested distributions
    if (
      type === "drp" ||
      /reinvest|drp/i.test(side + details)
    ) {
      transactions.push({
        date,
        ticker,
        exchange: "ASX",
        type: "drp",
        quantity: quantity || 0,
        price,
        amount,
        brokerage: 0,
        currency: "AUD",
        externalId: getField(row, "reference", "id", "transaction id") || null,
        notes: details || side || "DRP",
        raw: row,
      });
      return;
    }

    if (quantity === 0 && type === "dividend_cash") {
      transactions.push({
        date,
        ticker,
        exchange: "ASX",
        type: "dividend_cash",
        quantity: 0,
        price: null,
        amount,
        brokerage: 0,
        currency: "AUD",
        externalId: getField(row, "reference", "id") || null,
        notes: details || side || null,
        raw: row,
      });
      return;
    }

    if (quantity === 0) {
      skippedRows++;
      return;
    }

    transactions.push({
      date,
      ticker,
      exchange: "ASX",
      type: type === "other" ? "buy" : type,
      quantity,
      price,
      amount,
      brokerage: Math.abs(brokerage),
      currency: "AUD",
      externalId: getField(row, "reference", "id", "transaction id") || null,
      notes: details || side || null,
      raw: row,
    });
  });

  return {
    broker: "betashares_direct",
    transactions,
    warnings,
    skippedRows,
  };
}
