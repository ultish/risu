import { inferExchangeAndCurrency } from "../market.js";
import type { ParseResult, ParsedTransaction, TransactionType } from "../types.js";
import {
  classifyType,
  getField,
  lowerKeys,
  normaliseTicker,
  parseDate,
  parseNumber,
} from "./utils.js";

/**
 * Sharesight All Trades Report export (Spreadsheet / Google Sheets → CSV/XLSX).
 *
 * Typical columns (names vary by region/version):
 * Trade Date, Instrument Code, Market Code, Quantity, Price, Brokerage,
 * Value, Transaction Type, Comments, Currency, Exchange Rate, ...
 *
 * Also accepts Sharesight bulk-import style CSVs.
 */
export function parseSharesightRows(
  rows: Record<string, unknown>[],
): ParseResult {
  const transactions: ParsedTransaction[] = [];
  const warnings: ParseResult["warnings"] = [];
  let skippedRows = 0;

  rows.forEach((raw, idx) => {
    const row = lowerKeys(raw as Record<string, unknown>);

    // Skip summary / blank rows
    const date = parseDate(
      getField(
        row,
        "trade date",
        "date",
        "transaction date",
        "settlement date",
        "date traded",
      ),
    );
    if (!date) {
      skippedRows++;
      return;
    }

    const ticker = normaliseTicker(
      getField(
        row,
        "instrument code",
        "code",
        "symbol",
        "ticker",
        "instrument",
        "investment",
        "stock",
      ),
    );
    if (!ticker || ticker === "TOTAL" || ticker === "SUBTOTAL") {
      skippedRows++;
      return;
    }

    const market = getField(
      row,
      "market code",
      "market",
      "exchange",
      "exchange code",
      "country",
    );
    const currencyField = getField(
      row,
      "currency",
      "trading currency",
      "instrument currency",
      "ccy",
    );
    const { exchange, currency } = inferExchangeAndCurrency({
      market,
      currency: currencyField,
      ticker,
    });

    const side = getField(
      row,
      "transaction type",
      "type",
      "trade type",
      "action",
      "buy/sell",
      "side",
    );
    const details = getField(
      row,
      "comments",
      "comment",
      "notes",
      "description",
      "details",
    );
    let type: TransactionType = classifyType(side, details);

    // Sharesight uses BUY / SELL / DRP / DIVIDEND etc.
    const sideU = side.toUpperCase();
    if (sideU === "BUY" || sideU === "B") type = "buy";
    if (sideU === "SELL" || sideU === "S") type = "sell";
    if (sideU.includes("DRP") || sideU.includes("DRIP") || sideU === "REINVEST")
      type = "drp";
    if (sideU.includes("DIVIDEND") || sideU.includes("DISTRIBUTION")) {
      type = type === "drp" ? "drp" : "dividend_cash";
    }
    if (sideU.includes("TRANSFER IN") || sideU === "OPENING BALANCE")
      type = "transfer_in";
    if (sideU.includes("TRANSFER OUT")) type = "transfer_out";
    if (sideU.includes("SPLIT")) type = "split";

    let quantity =
      parseNumber(
        getField(row, "quantity", "qty", "units", "volume", "shares"),
      ) ?? 0;
    // Sharesight sells sometimes negative qty
    if (type === "sell" && quantity < 0) quantity = Math.abs(quantity);
    else quantity = Math.abs(quantity);

    let price = parseNumber(
      getField(
        row,
        "price",
        "unit price",
        "avg price",
        "average price",
        "share price",
      ),
    );
    const brokerage =
      parseNumber(
        getField(
          row,
          "brokerage",
          "brokerage inc gst",
          "brokerage (inc gst)",
          "fees",
          "fee",
          "commission",
        ),
      ) ?? 0;
    let amount = parseNumber(
      getField(
        row,
        "value",
        "amount",
        "consideration",
        "cost",
        "net value",
        "total",
      ),
    );

    if (price == null && amount != null && quantity > 0) {
      price = Math.abs(amount) / quantity;
    }
    if (amount == null && price != null && quantity > 0) {
      amount = price * quantity;
    }
    if (amount != null) amount = Math.abs(amount);

    if (quantity === 0 && type !== "dividend_cash") {
      warnings.push({
        row: idx + 2,
        message: `Skipped ${ticker}: zero quantity (${side || "unknown type"})`,
        severity: "info",
      });
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
      externalId:
        getField(
          row,
          "trade id",
          "id",
          "unique id",
          "transaction id",
          "reference",
        ) || null,
      notes: [side, details].filter(Boolean).join(" — ") || null,
      raw: row,
    });
  });

  if (!transactions.length) {
    warnings.push({
      message:
        "No trades found. Export Sharesight Tax → All Trades Report (date range: since inception) as Spreadsheet or Google Sheets, then save as CSV/XLSX. If Excel columns are blank, use Google Sheets export instead.",
      severity: "error",
    });
  }

  return {
    broker: "sharesight",
    transactions,
    warnings,
    skippedRows,
  };
}
