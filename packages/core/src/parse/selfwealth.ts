import { inferExchangeAndCurrency } from "../market.js";
import type { ParseResult, ParsedTransaction } from "../types.js";
import {
  classifyType,
  getField,
  lowerKeys,
  normaliseTicker,
  parseDate,
  parseNumber,
} from "./utils.js";

/** Selfwealth Trading Account report CSV (ASX + international) */
export function parseSelfwealthRows(
  rows: Record<string, unknown>[],
): ParseResult {
  const transactions: ParsedTransaction[] = [];
  const warnings: ParseResult["warnings"] = [];
  let skippedRows = 0;

  rows.forEach((raw, idx) => {
    const row = lowerKeys(raw as Record<string, unknown>);
    const date = parseDate(
      getField(row, "date", "trade date", "settlement date", "transaction date"),
    );
    if (!date) {
      skippedRows++;
      return;
    }

    const ticker = normaliseTicker(
      getField(row, "symbol", "code", "ticker", "security", "stock"),
    );
    const side = getField(
      row,
      "side",
      "type",
      "transaction type",
      "action",
      "market side",
    );
    const details = getField(
      row,
      "description",
      "details",
      "notes",
      "narrative",
    );
    let type = classifyType(side, details);

    if (type === "other" || side.toLowerCase() === "other") {
      type = classifyType(details || side, details);
    }

    const market = getField(row, "market", "exchange", "venue");
    const currencyField = getField(row, "currency", "ccy");
    const { exchange, currency } = inferExchangeAndCurrency({
      market,
      currency: currencyField,
      ticker,
    });

    let quantity =
      parseNumber(
        getField(row, "quantity", "qty", "units", "volume", "filled"),
      ) ?? 0;
    quantity = Math.abs(quantity);
    let price = parseNumber(
      getField(row, "price", "unit price", "avg. price", "average price"),
    );
    const brokerage =
      parseNumber(getField(row, "brokerage", "fees", "fee", "commission")) ?? 0;
    let amount = parseNumber(
      getField(row, "value", "amount", "total", "consideration", "net value"),
    );

    if (!ticker && type !== "fee") {
      skippedRows++;
      return;
    }

    if (price == null && amount != null && quantity > 0) price = amount / quantity;
    if (amount == null && price != null && quantity > 0) {
      amount = price * quantity;
    }

    if (quantity === 0 && (type === "buy" || type === "sell" || type === "drp")) {
      warnings.push({
        row: idx + 2,
        message: `Skipped ${ticker}: zero quantity`,
        severity: "info",
      });
      skippedRows++;
      return;
    }

    transactions.push({
      date,
      ticker: ticker || "UNKNOWN",
      exchange,
      type,
      quantity,
      price,
      amount,
      brokerage: Math.abs(brokerage),
      currency,
      externalId:
        getField(row, "order id", "trade id", "id", "reference") || null,
      notes: details || side || null,
      raw: row,
    });
  });

  return { broker: "selfwealth", transactions, warnings, skippedRows };
}
