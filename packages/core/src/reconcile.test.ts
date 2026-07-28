import { describe, expect, it } from "vitest";
import {
  reconcileStakeActivity,
  type ReconcileLedgerRow,
} from "./reconcile.js";
import type { ParsedTransaction } from "./types.js";

function tx(
  overrides: Partial<ParsedTransaction> & { date: string; ticker: string },
): ParsedTransaction {
  return {
    date: overrides.date,
    ticker: overrides.ticker,
    exchange: overrides.exchange ?? "US",
    type: overrides.type ?? "buy",
    quantity: overrides.quantity ?? 1,
    price: overrides.price ?? null,
    amount: overrides.amount ?? null,
    brokerage: overrides.brokerage ?? 0,
    currency: overrides.currency ?? "USD",
    externalId: overrides.externalId ?? null,
    notes: overrides.notes ?? null,
  };
}

function ledgerRow(
  overrides: Partial<ReconcileLedgerRow> & { id: number; date: string; ticker: string },
): ReconcileLedgerRow {
  return {
    id: overrides.id,
    date: overrides.date,
    ticker: overrides.ticker,
    type: overrides.type ?? "buy",
    quantity: overrides.quantity ?? 1,
    price: overrides.price ?? null,
    external_id: overrides.external_id ?? null,
  };
}

describe("reconcileStakeActivity", () => {
  it("matches exact via externalId regardless of tiny formatting differences", () => {
    const parsed = [
      tx({
        date: "2025-01-10",
        ticker: "TSLA",
        type: "buy",
        quantity: 1,
        price: 300,
        externalId: "ext-1",
      }),
    ];
    const ledger = [
      ledgerRow({
        id: 1,
        date: "2025-01-10",
        ticker: "TSLA",
        type: "buy",
        quantity: 1,
        price: 300,
        external_id: "ext-1",
      }),
    ];

    const result = reconcileStakeActivity(parsed, ledger);
    expect(result.matched).toBe(1);
    expect(result.fileOnly).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    expect(result.ledgerOnly).toHaveLength(0);
  });

  it("matches via (date, ticker, type) when qty/price drift is within epsilon", () => {
    const parsed = [
      tx({
        date: "2025-02-01",
        ticker: "VAS",
        type: "buy",
        quantity: 5.0000001,
        price: 100.01,
        externalId: null,
      }),
    ];
    const ledger = [
      ledgerRow({
        id: 2,
        date: "2025-02-01",
        ticker: "VAS",
        type: "buy",
        quantity: 5,
        price: 100.0,
        external_id: null,
      }),
    ];

    const result = reconcileStakeActivity(parsed, ledger);
    expect(result.matched).toBe(1);
    expect(result.conflicts).toHaveLength(0);
    expect(result.fileOnly).toHaveLength(0);
  });

  it("does NOT tolerance-match when qty/price drift exceeds epsilon", () => {
    const parsed = [
      tx({
        date: "2025-02-05",
        ticker: "VAS",
        type: "buy",
        quantity: 5,
        price: 100.05, // 5c above ledger price — exceeds epsPrice 0.015
        externalId: null,
      }),
    ];
    const ledger = [
      ledgerRow({
        id: 3,
        date: "2025-02-05",
        ticker: "VAS",
        type: "buy",
        quantity: 5,
        price: 100.0,
        external_id: null,
      }),
    ];

    const result = reconcileStakeActivity(parsed, ledger);
    expect(result.fileOnly).toHaveLength(1);
    expect(result.matched).toBe(0);
    // Ledger row is unclaimed but outside the derived period (single-date file → period === that date)
    expect(result.ledgerOnly).toHaveLength(1);
  });

  it("flags a conflict when matched via externalId but type differs", () => {
    const parsed = [
      tx({
        date: "2025-03-01",
        ticker: "TSLA",
        type: "buy",
        quantity: 2,
        price: 250,
        externalId: "ext-3",
      }),
    ];
    const ledger = [
      ledgerRow({
        id: 4,
        date: "2025-03-01",
        ticker: "TSLA",
        type: "sell", // differs from parsed "buy"
        quantity: 2,
        price: 250,
        external_id: "ext-3",
      }),
    ];

    const result = reconcileStakeActivity(parsed, ledger);
    expect(result.matched).toBe(0);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.fields).toEqual(["type"]);
    expect(result.conflicts[0]!.file.externalId).toBe("ext-3");
    expect(result.conflicts[0]!.ledger.id).toBe(4);
  });

  it("categorises an unmatched file row as fileOnly", () => {
    const parsed = [
      tx({
        date: "2025-04-01",
        ticker: "NDQ",
        type: "buy",
        quantity: 10,
        price: 50,
        externalId: "ext-4-file-only",
      }),
    ];
    const result = reconcileStakeActivity(parsed, []);
    expect(result.fileOnly).toHaveLength(1);
    expect(result.matched).toBe(0);
  });

  it("categorises an unmatched ledger row within the statement period as ledgerOnly", () => {
    const parsed = [
      tx({ date: "2025-01-01", ticker: "TSLA", quantity: 1, externalId: "a" }),
      tx({ date: "2025-06-30", ticker: "TSLA", quantity: 1, externalId: "b" }),
    ];
    const ledger = [
      ledgerRow({ id: 1, date: "2025-01-01", ticker: "TSLA", external_id: "a" }),
      ledgerRow({ id: 2, date: "2025-06-30", ticker: "TSLA", external_id: "b" }),
      // Unmatched, but falls inside the derived period [2025-01-01, 2025-06-30]
      ledgerRow({ id: 3, date: "2025-03-15", ticker: "TSLA", external_id: null }),
    ];

    const result = reconcileStakeActivity(parsed, ledger);
    expect(result.matched).toBe(2);
    expect(result.ledgerOnly).toHaveLength(1);
    expect(result.ledgerOnly[0]!.id).toBe(3);
  });

  it("excludes a ledger-only row that falls outside the statement period", () => {
    const parsed = [
      tx({ date: "2025-01-01", ticker: "TSLA", quantity: 1, externalId: "a" }),
      tx({ date: "2025-06-30", ticker: "TSLA", quantity: 1, externalId: "b" }),
    ];
    const ledger = [
      ledgerRow({ id: 1, date: "2025-01-01", ticker: "TSLA", external_id: "a" }),
      ledgerRow({ id: 2, date: "2025-06-30", ticker: "TSLA", external_id: "b" }),
      // Well before the statement period — should NOT appear in ledgerOnly
      ledgerRow({ id: 3, date: "2019-01-01", ticker: "TSLA", external_id: null }),
    ];

    const result = reconcileStakeActivity(parsed, ledger);
    expect(result.matched).toBe(2);
    expect(result.ledgerOnly).toHaveLength(0);
  });

  it("honours an explicitly passed statement period over the derived min/max", () => {
    const parsed = [
      tx({ date: "2025-03-01", ticker: "TSLA", quantity: 1, externalId: "a" }),
    ];
    const ledger = [
      ledgerRow({ id: 1, date: "2025-03-01", ticker: "TSLA", external_id: "a" }),
      ledgerRow({ id: 2, date: "2025-05-15", ticker: "TSLA", external_id: null }),
    ];

    const result = reconcileStakeActivity(parsed, ledger, {
      period: { from: "2025-01-01", to: "2025-06-30" },
    });
    expect(result.period).toEqual({ from: "2025-01-01", to: "2025-06-30" });
    expect(result.matched).toBe(1);
    expect(result.ledgerOnly).toHaveLength(1);
    expect(result.ledgerOnly[0]!.id).toBe(2);
  });

  it("returns no ledgerOnly rows when there is no derivable period (empty file)", () => {
    const ledger = [ledgerRow({ id: 1, date: "2025-01-01", ticker: "TSLA" })];
    const result = reconcileStakeActivity([], ledger);
    expect(result.period).toBeNull();
    expect(result.ledgerOnly).toHaveLength(0);
  });
});
