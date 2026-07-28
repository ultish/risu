import * as XLSX from "xlsx";
import type { ParseResult, ParsedTransaction } from "../types.js";
import { parseStakeRows } from "./stake.js";
import {
  getField,
  lowerKeys,
  normaliseTicker,
  parseDate,
  parseNumber,
} from "./utils.js";

export type StakeWorkbookKind = "activity" | "income";

function sheetToPlainText(
  workbook: XLSX.WorkBook,
  sheetName: string,
): string {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return "";
  const aoa = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
    header: 1,
    defval: "",
  });
  return aoa
    .map((row) => (Array.isArray(row) ? row.join(" ") : String(row)))
    .join("\n");
}

function findSheetName(
  workbook: XLSX.WorkBook,
  predicate: (name: string) => boolean,
): string | null {
  return workbook.SheetNames.find((n) => predicate(n)) ?? null;
}

function sheetRows(
  workbook: XLSX.WorkBook,
  sheetName: string | null,
): Record<string, unknown>[] {
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });
}

/**
 * Detect Stake Tax & Documents multi-sheet workbooks.
 * Returns null for ordinary single-table Excel (fall through to generic path).
 */
export function detectStakeWorkbookKind(
  workbook: XLSX.WorkBook,
  filename = "",
): StakeWorkbookKind | null {
  const summaryText = sheetToPlainText(workbook, "Summary");
  if (/report\s*type\s*:\s*investment\s*activity/i.test(summaryText)) {
    return "activity";
  }
  if (/report\s*type\s*:\s*investment\s*income/i.test(summaryText)) {
    return "income";
  }

  const names = workbook.SheetNames.map((n) => n.toLowerCase());
  const hasAusEq = names.some((n) => n.includes("aus equities"));
  const hasWallEq = names.some((n) => n.includes("wall st equities"));
  if (hasAusEq || hasWallEq) return "activity";

  const hasAusDiv = names.some(
    (n) => n.includes("dividend") && n.includes("aus"),
  );
  const hasWallDiv = names.some(
    (n) => n.includes("dividend") && n.includes("wall"),
  );
  if (hasAusDiv || hasWallDiv) return "income";

  const fn = filename.toLowerCase();
  // Weak filename hints only when sheet structure is ambiguous
  if (fn.includes("dividend") && names.includes("summary")) return "income";

  return null;
}

function annotateMarket(
  rows: Record<string, unknown>[],
  market: string,
  defaultCurrency: string,
): Record<string, unknown>[] {
  return rows.map((r) => {
    const currency =
      r["Currency"] ?? r["currency"] ?? r["CCY"] ?? r["ccy"] ?? "";
    const cur =
      currency === "" || currency == null ? defaultCurrency : currency;
    return {
      ...r,
      Market: r["Market"] ?? r["market"] ?? market,
      Currency: cur,
    };
  });
}

/**
 * Investment Activity: merge Aus Equities + Wall St Equities into one ParseResult.
 */
export function parseStakeActivityWorkbook(
  workbook: XLSX.WorkBook,
): ParseResult {
  const ausName = findSheetName(workbook, (n) =>
    /aus\s*equities/i.test(n),
  );
  const wallName = findSheetName(workbook, (n) =>
    /wall\s*st\s*equities/i.test(n),
  );

  const aus = annotateMarket(sheetRows(workbook, ausName), "ASX", "AUD");
  const wall = annotateMarket(sheetRows(workbook, wallName), "US", "USD");
  const rows = [...aus, ...wall];

  const result = parseStakeRows(rows);
  const sheets = [ausName, wallName].filter(Boolean).join(" + ");
  result.warnings.unshift({
    message: sheets
      ? `Parsed Stake Investment Activity sheets: ${sheets}`
      : "Parsed Stake Investment Activity workbook (no equity sheets found)",
    severity: "info",
  });

  if (result.transactions.length === 0) {
    result.warnings.push({
      message:
        "No trades in Stake activity workbook (empty Aus / Wall St sheets is normal for some FYs)",
      severity: "info",
    });
  }

  return result;
}

/**
 * Investment Income: Aus + Wall St dividend sheets → dividend_cash.
 * Units on these sheets are units held, not trade quantity — always qty 0.
 */
export function parseStakeIncomeWorkbook(
  workbook: XLSX.WorkBook,
): ParseResult {
  const ausName = findSheetName(
    workbook,
    (n) => /dividend/i.test(n) && /aus/i.test(n),
  );
  const wallName = findSheetName(
    workbook,
    (n) => /dividend/i.test(n) && /wall/i.test(n),
  );

  const transactions: ParsedTransaction[] = [];
  const warnings: ParseResult["warnings"] = [
    {
      message:
        "Stake Investment Income figures are estimates (per Stake disclaimers)",
      severity: "info",
    },
    {
      message: `Parsed Stake Investment Income sheets: ${[ausName, wallName].filter(Boolean).join(" + ") || "(none)"}`,
      severity: "info",
    },
  ];
  let skippedRows = 0;

  const parseDivSheet = (
    rows: Record<string, unknown>[],
    exchange: string,
    defaultCurrency: string,
    amountPreferNet: boolean,
  ) => {
    rows.forEach((raw, idx) => {
      const row = lowerKeys(raw);
      const date = parseDate(
        getField(row, "payment date", "ex-dividend date", "ex dividend date", "date"),
      );
      if (!date) {
        skippedRows++;
        return;
      }
      const ticker = normaliseTicker(
        getField(row, "symbol", "ticker", "code", "instrument"),
      );
      if (!ticker) {
        skippedRows++;
        return;
      }

      const amount = amountPreferNet
        ? (parseNumber(
            getField(row, "net amount", "total amount", "amount", "value"),
          ) ?? null)
        : (parseNumber(
            getField(row, "total amount", "net amount", "amount", "value"),
          ) ?? null);

      if (amount == null) {
        warnings.push({
          row: idx + 2,
          message: `Dividend row ${ticker} ${date}: missing amount`,
          severity: "warn",
        });
        skippedRows++;
        return;
      }

      const divType = getField(row, "type", "description");
      const franking = getField(row, "franking credit", "franked");
      const withheld = getField(row, "tax withheld", "withholding rate");
      const noteParts = [
        divType || null,
        franking ? `franking ${franking}` : null,
        withheld ? `withheld ${withheld}` : null,
        "Stake estimate",
      ].filter(Boolean);

      const externalId = `stake-div-${date}-${ticker}-${amount}`;

      transactions.push({
        date,
        ticker,
        exchange,
        type: "dividend_cash",
        quantity: 0,
        price: null,
        amount,
        brokerage: 0,
        currency: getField(row, "currency", "ccy") || defaultCurrency,
        externalId,
        notes: noteParts.join(" · ") || null,
        raw: row,
      });
    });
  };

  parseDivSheet(sheetRows(workbook, ausName), "ASX", "AUD", false);
  parseDivSheet(sheetRows(workbook, wallName), "US", "USD", true);

  transactions.sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    if (d !== 0) return d;
    return a.ticker.localeCompare(b.ticker);
  });

  if (transactions.length === 0) {
    warnings.push({
      message: "No dividend rows in Stake income workbook",
      severity: "info",
    });
  }

  return {
    broker: "stake",
    transactions,
    warnings,
    skippedRows,
  };
}

/** Read workbook buffer (xlsx). */
export function readWorkbook(buf: ArrayBuffer | Buffer): XLSX.WorkBook {
  return XLSX.read(buf, { type: "buffer", cellDates: true });
}
