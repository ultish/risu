import { inferExchangeAndCurrency } from "../market.js";
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

/** Fallback column mapper for unknown broker CSVs */
export function parseGenericRows(rows: Record<string, unknown>[]): ParseResult {
  const transactions: ParsedTransaction[] = [];
  const warnings: ParseResult["warnings"] = [];
  let skippedRows = 0;

  rows.forEach((raw) => {
    const row = lowerKeys(raw as Record<string, unknown>);
    const date = parseDate(
      getField(row, "date", "trade date", "transaction date", "settlement date"),
    );
    if (!date) {
      skippedRows++;
      return;
    }

    const ticker = normaliseTicker(
      getField(row, "ticker", "symbol", "code", "stock", "security"),
    );
    if (!ticker) {
      skippedRows++;
      return;
    }

    const side = getField(
      row,
      "buy/sell",
      "buy / sell",
      "b/s",
      "side",
      "action",
      "transaction type",
      "type",
    );
    const details = getField(row, "details", "description", "notes");
    const type =
      parseBuySellToken(side) ?? classifyType(side || details, details);
    const { exchange, currency } = inferExchangeAndCurrency({
      market: getField(row, "market", "exchange"),
      currency: getField(row, "currency"),
      ticker,
    });

    let quantity =
      parseNumber(getField(row, "quantity", "qty", "units", "shares")) ?? 0;
    quantity = Math.abs(quantity);
    let price = parseNumber(getField(row, "price", "unit price"));
    const brokerage =
      parseNumber(getField(row, "brokerage", "fees", "fee")) ?? 0;
    let amount = parseNumber(
      getField(row, "amount", "value", "total", "consideration"),
    );
    if (price == null && amount != null && quantity > 0) {
      price = amount / quantity;
    }

    if (quantity === 0 && type !== "dividend_cash") {
      skippedRows++;
      return;
    }

    transactions.push({
      date,
      ticker,
      exchange,
      type,
      quantity,
      price,
      amount,
      brokerage: Math.abs(brokerage),
      currency,
      externalId: getField(row, "id", "reference", "external id") || null,
      notes: details || null,
      raw: row,
    });
  });

  if (!transactions.length) {
    warnings.push({
      message:
        "Generic parser found no transactions. Pick a broker or check column headers (date, ticker, type, quantity, price).",
      severity: "error",
    });
  }

  return { broker: "generic", transactions, warnings, skippedRows };
}
