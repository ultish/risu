import type { LotMatchingMethod, RecordedParcelTake } from "@risu/core";
import type Database from "better-sqlite3";

export type ParcelAllocation = {
  acquireTxId: number;
  acquiredDate: string;
  quantity: number;
  costBaseAud: number;
  proceedsAud: number;
};

export type TxParcelInfo = {
  kind: "acquire" | "sell";
  status?: "partial" | "sold";
  soldQuantity?: number;
  remainingQuantity?: number;
  lastSoldDate?: string | null;
  matching?: LotMatchingMethod;
  allocations?: ParcelAllocation[];
};

type DisposalRow = {
  sell_transaction_id: number;
  acquire_transaction_id: number;
  quantity: number;
  cost_base_aud: number;
  proceeds_aud: number;
  matching: string;
  disposed_date: string;
  acquired_date: string;
};

export function loadParcelTakes(db: Database.Database): RecordedParcelTake[] {
  return (
    db
      .prepare(
        `SELECT sell_transaction_id, acquire_transaction_id, quantity
         FROM parcel_disposals`,
      )
      .all() as Array<{
      sell_transaction_id: number;
      acquire_transaction_id: number;
      quantity: number;
    }>
  ).map((r) => ({
    sellTxId: r.sell_transaction_id,
    acquireTxId: r.acquire_transaction_id,
    quantity: r.quantity,
  }));
}

export function attachParcelInfo<
  T extends { id: number; type: string; quantity: number },
>(db: Database.Database, rows: T[]): Array<T & { parcel?: TxParcelInfo }> {
  if (rows.length === 0) return rows;
  const disposals = db
    .prepare(
      `SELECT d.sell_transaction_id,
              d.acquire_transaction_id,
              d.quantity,
              d.cost_base_aud,
              d.proceeds_aud,
              d.matching,
              s.date AS disposed_date,
              a.date AS acquired_date
       FROM parcel_disposals d
       JOIN transactions s ON s.id = d.sell_transaction_id
       JOIN transactions a ON a.id = d.acquire_transaction_id`,
    )
    .all() as DisposalRow[];

  const byAcquire = new Map<number, DisposalRow[]>();
  const bySell = new Map<number, DisposalRow[]>();
  for (const d of disposals) {
    const acq = byAcquire.get(d.acquire_transaction_id) ?? [];
    if (!byAcquire.has(d.acquire_transaction_id)) {
      byAcquire.set(d.acquire_transaction_id, acq);
    }
    acq.push(d);
    const sell = bySell.get(d.sell_transaction_id) ?? [];
    if (!bySell.has(d.sell_transaction_id)) {
      bySell.set(d.sell_transaction_id, sell);
    }
    sell.push(d);
  }

  return rows.map((row) => {
    if (row.type === "buy" || row.type === "drp") {
      const takes = byAcquire.get(row.id);
      if (!takes?.length) return row;
      const soldQuantity = takes.reduce((s, t) => s + t.quantity, 0);
      const remainingQuantity = Math.max(0, row.quantity - soldQuantity);
      const lastSoldDate = takes
        .map((t) => t.disposed_date)
        .sort()
        .at(-1) ?? null;
      const fullySold = remainingQuantity <= 1e-6;
      return {
        ...row,
        parcel: {
          kind: "acquire" as const,
          status: fullySold ? ("sold" as const) : ("partial" as const),
          soldQuantity,
          remainingQuantity,
          lastSoldDate,
        },
      };
    }
    if (row.type === "sell") {
      const takes = bySell.get(row.id);
      if (!takes?.length) return row;
      return {
        ...row,
        parcel: {
          kind: "sell" as const,
          matching: (takes[0]!.matching === "min_cgt" ? "min_cgt" : "fifo") as LotMatchingMethod,
          allocations: takes.map((t) => ({
            acquireTxId: t.acquire_transaction_id,
            acquiredDate: t.acquired_date,
            quantity: t.quantity,
            costBaseAud: t.cost_base_aud,
            proceedsAud: t.proceeds_aud,
          })),
        },
      };
    }
    return row;
  });
}

export function acquireTxsBlockedByParcels(
  db: Database.Database,
  ids: number[],
): number[] {
  if (!ids.length) return [];
  const rows = db
    .prepare(
      `SELECT DISTINCT acquire_transaction_id AS id
       FROM parcel_disposals
       WHERE acquire_transaction_id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}
