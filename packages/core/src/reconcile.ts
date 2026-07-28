import type { ParsedTransaction } from "./types.js";

/**
 * Ledger row shape as returned by the `transactions` SQL query used for
 * reconcile (subset of columns the matching algorithm needs). `external_id`
 * kept snake_case to mirror the DB column / API response shape (§12).
 */
export type ReconcileLedgerRow = {
  id: number;
  date: string;
  ticker: string;
  type: string;
  quantity: number;
  price: number | null;
  external_id: string | null;
};

export type ReconcileConflict = {
  fields: string[];
  file: ParsedTransaction;
  ledger: ReconcileLedgerRow;
};

export type ReconcilePeriod = { from: string; to: string };

export type ReconcileResult = {
  layoutId: "stake.activity";
  period: ReconcilePeriod | null;
  matched: number;
  fileOnly: ParsedTransaction[];
  ledgerOnly: ReconcileLedgerRow[];
  conflicts: ReconcileConflict[];
};

export type ReconcileOptions = {
  /** Absolute quantity tolerance (docs/import-layouts-plan.md §12: 1e-6). */
  epsQty?: number;
  /** Absolute price tolerance in trade currency (§12: 0.015 — cents-ish). */
  epsPrice?: number;
  /**
   * Statement period for `ledgerOnly` filtering. Omit to derive from the
   * min/max date of `parsed` (§12 fallback); pass `null` explicitly to force
   * "no period known" (ledgerOnly then returns empty — see note below).
   */
  period?: ReconcilePeriod | null;
};

const DEFAULT_EPS_QTY = 1e-6;
const DEFAULT_EPS_PRICE = 0.015;

function normaliseKey(s: string): string {
  return s.trim().toUpperCase();
}

function derivePeriod(parsed: ParsedTransaction[]): ReconcilePeriod | null {
  if (!parsed.length) return null;
  let from = parsed[0]!.date;
  let to = parsed[0]!.date;
  for (const t of parsed) {
    if (t.date < from) from = t.date;
    if (t.date > to) to = t.date;
  }
  return { from, to };
}

function inPeriod(date: string, period: ReconcilePeriod | null): boolean {
  // Doc's pseudocode always derives a period from the file being reconciled,
  // so "no period known" (empty file, no statement date) means we can't tell
  // which ledger rows fall inside the statement window — default to none
  // rather than dumping the whole ledger into ledgerOnly.
  if (!period) return false;
  return date >= period.from && date <= period.to;
}

/**
 * Reconcile a parsed Stake activity XLSX against existing ledger rows for the
 * same portfolio/custody. Pure, read-only diff — no DB access, no writes.
 *
 * Matching (docs/import-layouts-plan.md §12):
 * 1. `externalId` (both non-null, exact match) — highest confidence.
 * 2. Else `(date, ticker, type)` exact + `quantity`/`price` within tolerance.
 * A ledger row is used at most once (first parsed tx to claim it wins).
 */
export function reconcileStakeActivity(
  parsed: ParsedTransaction[],
  ledgerRows: ReconcileLedgerRow[],
  opts: ReconcileOptions = {},
): ReconcileResult {
  const epsQty = opts.epsQty ?? DEFAULT_EPS_QTY;
  const epsPrice = opts.epsPrice ?? DEFAULT_EPS_PRICE;
  const period =
    opts.period !== undefined ? opts.period : derivePeriod(parsed);

  const usedLedgerIds = new Set<number>();
  let matched = 0;
  const fileOnly: ParsedTransaction[] = [];
  const conflicts: ReconcileConflict[] = [];

  for (const tx of parsed) {
    let hit: ReconcileLedgerRow | undefined;

    if (tx.externalId) {
      hit = ledgerRows.find(
        (l) =>
          !usedLedgerIds.has(l.id) &&
          l.external_id != null &&
          l.external_id === tx.externalId,
      );
    }

    if (!hit) {
      hit = ledgerRows.find((l) => {
        if (usedLedgerIds.has(l.id)) return false;
        if (l.date !== tx.date) return false;
        if (normaliseKey(l.ticker) !== normaliseKey(tx.ticker)) return false;
        if (l.type !== tx.type) return false;
        const qtyTol = Math.max(epsQty, epsQty * tx.quantity);
        if (Math.abs(Number(l.quantity) - tx.quantity) > qtyTol) return false;
        if (
          tx.price != null &&
          l.price != null &&
          Math.abs(Number(l.price) - tx.price) > epsPrice
        ) {
          return false;
        }
        return true;
      });
    }

    if (!hit) {
      fileOnly.push(tx);
      continue;
    }

    usedLedgerIds.add(hit.id);

    const fields: string[] = [];
    if (Math.abs(Number(hit.quantity) - tx.quantity) > epsQty) {
      fields.push("quantity");
    }
    if (
      tx.price != null &&
      hit.price != null &&
      Math.abs(Number(hit.price) - tx.price) > epsPrice
    ) {
      fields.push("price");
    }
    if (hit.type !== tx.type) fields.push("type");

    if (fields.length) {
      conflicts.push({ fields, file: tx, ledger: hit });
    } else {
      matched++;
    }
  }

  const ledgerOnly = ledgerRows.filter(
    (l) => !usedLedgerIds.has(l.id) && inPeriod(l.date, period),
  );

  return {
    layoutId: "stake.activity",
    period,
    matched,
    fileOnly,
    ledgerOnly,
    conflicts,
  };
}
