import type { BrokerId } from "../types.js";
import { lowerKeys } from "./utils.js";

/**
 * Heuristic broker detection from header row + optional filename.
 * User can still override in the UI.
 */
export function detectBroker(headers: string[], filename = ""): BrokerId {
  const h = headers.map((x) => x.trim().toLowerCase());
  const joined = h.join("|");
  const fn = filename.toLowerCase();

  if (fn.includes("sharesight") || fn.includes("all_trades") || fn.includes("all-trades")) {
    return "sharesight";
  }
  if (fn.includes("selfwealth") || fn.includes("self_wealth")) return "selfwealth";
  if (fn.includes("stake")) return "stake";
  if (fn.includes("betashares") || fn.includes("beta-shares")) {
    return "betashares_direct";
  }
  if (fn.includes("pocket")) return "pocket";
  if (fn.includes("commsec") || fn.includes("cba")) return "commsec";

  // Sharesight All Trades / bulk import style
  if (
    joined.includes("instrument code") ||
    (joined.includes("market code") && joined.includes("trade date")) ||
    (joined.includes("transaction type") &&
      joined.includes("quantity") &&
      joined.includes("instrument"))
  ) {
    return "sharesight";
  }

  if (
    joined.includes("stock code") ||
    joined.includes("confirmation") ||
    joined.includes("net proceeds") ||
    (joined.includes("security") &&
      joined.includes("units") &&
      (joined.includes("buy") || joined.includes("sell"))) ||
    (joined.includes("debit") &&
      joined.includes("credit") &&
      joined.includes("details"))
  ) {
    return "commsec";
  }

  if (
    joined.includes("order id") ||
    (joined.includes("market") &&
      joined.includes("side") &&
      joined.includes("symbol"))
  ) {
    return "selfwealth";
  }

  if (
    joined.includes("filled at") ||
    joined.includes("order type") ||
    joined.includes("unique order id")
  ) {
    return "stake";
  }

  if (
    joined.includes("betashares") ||
    (joined.includes("unit price") && joined.includes("fund"))
  ) {
    return "betashares_direct";
  }

  return "generic";
}

export function headerMap(headers: string[]): Record<string, string> {
  const row: Record<string, string> = {};
  headers.forEach((h) => {
    row[h] = h;
  });
  return lowerKeys(row);
}
