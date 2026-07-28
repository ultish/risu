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

function stakeExternalId(row: Record<string, string>): string | null {
  return (
    getField(
      row,
      "trade identifier",
      "unique order id",
      "order id",
      "id",
      "reference",
    ) || null
  );
}

/** Stake AU / US investment activity (CSV or sheet rows) */
export function parseStakeRows(rows: Record<string, unknown>[]): ParseResult {
  const transactions: ParsedTransaction[] = [];
  const warnings: ParseResult["warnings"] = [];
  let skippedRows = 0;

  rows.forEach((raw, idx) => {
    const row = lowerKeys(raw as Record<string, unknown>);
    const date = parseDate(
      getField(
        row,
        "date",
        "filled at",
        "trade date",
        "settlement date",
        "activity date",
        "timestamp",
      ),
    );
    if (!date) {
      skippedRows++;
      return;
    }

    const ticker = normaliseTicker(
      getField(row, "symbol", "ticker", "instrument", "stock", "code"),
    );
    const side = getField(
      row,
      "side",
      "order type",
      "type",
      "transaction type",
      "activity",
      "action",
    );
    const details = getField(row, "description", "details", "notes");
    const type = classifyType(side, details);
    const market = getField(row, "market", "exchange", "venue", "region");
    const currencyField = getField(row, "currency", "ccy");
    const { exchange, currency } = inferExchangeAndCurrency({
      market,
      currency: currencyField,
      ticker,
    });

    let quantity =
      parseNumber(
        getField(row, "quantity", "qty", "units", "shares", "filled qty"),
      ) ?? 0;
    quantity = Math.abs(quantity);
    let price = parseNumber(
      getField(
        row,
        "price",
        "average price",
        "avg price",
        "avg. price",
        "fill price",
        "unit price",
      ),
    );
    const fees =
      parseNumber(getField(row, "fees", "fee", "brokerage", "commission")) ?? 0;
    const gst = parseNumber(getField(row, "gst")) ?? 0;
    const brokerage = Math.abs(fees) + Math.abs(gst);
    // Prefer "Value" (pre-fee) over "Total Value" when both exist
    let amount = parseNumber(
      getField(
        row,
        "amount",
        "value",
        "net amount",
        "consideration",
        "total value",
        "total",
      ),
    );

    if (!ticker) {
      skippedRows++;
      return;
    }

    if (type === "dividend_cash" && quantity > 0) {
      transactions.push({
        date,
        ticker,
        exchange,
        type: "drp",
        quantity,
        price,
        amount,
        brokerage: 0,
        currency,
        externalId: stakeExternalId(row),
        notes: details || side || "DRP/DRIP reinvest inferred",
        raw: row,
      });
      return;
    }

    if (price == null && amount != null && quantity > 0) {
      price = amount / quantity;
    }

    if (quantity === 0) {
      if (type === "dividend_cash" || /dividend/i.test(side + details)) {
        transactions.push({
          date,
          ticker,
          exchange,
          type: "dividend_cash",
          quantity: 0,
          price: null,
          amount,
          brokerage: 0,
          currency,
          externalId: stakeExternalId(row),
          notes: details || side || null,
          raw: row,
        });
        return;
      }
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
      brokerage,
      currency,
      externalId: stakeExternalId(row),
      notes: details || side || null,
      raw: row,
    });
  });

  return { broker: "stake", transactions, warnings, skippedRows };
}
