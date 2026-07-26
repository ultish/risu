/**
 * CSV helpers for ledger export.
 */

export type CsvTransactionRow = {
  date: string;
  ticker: string;
  exchange?: string | null;
  type: string;
  quantity: number;
  price?: number | null;
  amount?: number | null;
  brokerage?: number | null;
  currency?: string | null;
  broker?: string | null;
  source?: string | null;
  portfolio_id?: number | null;
  notes?: string | null;
  external_id?: string | null;
  id?: number | null;
};

const DEFAULT_HEADERS = [
  "id",
  "date",
  "ticker",
  "exchange",
  "type",
  "quantity",
  "price",
  "amount",
  "brokerage",
  "currency",
  "broker",
  "source",
  "portfolio_id",
  "notes",
  "external_id",
] as const;

/**
 * Convert transaction rows to a CSV string (UTF-8, RFC-style quoting).
 */
export function transactionsToCsv(
  rows: CsvTransactionRow[],
  headers: readonly string[] = DEFAULT_HEADERS,
): string {
  const lines: string[] = [headers.join(",")];
  for (const row of rows) {
    const rec = row as Record<string, unknown>;
    lines.push(
      headers
        .map((h) => csvCell(rec[h] ?? rec[snakeToCamel(h)]))
        .join(","),
    );
  }
  return lines.join("\n") + (rows.length ? "\n" : "");
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function csvCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "";
    return String(value);
  }
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
