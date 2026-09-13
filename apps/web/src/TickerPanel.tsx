import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  type Filters,
  type Holding,
  type InstrumentAssumptionsDto,
  type Portfolio,
  type TxRow,
  deleteTransactions,
  fetchInstrumentAssumptions,
  fetchTransactions,
} from "./api";
import {
  Empty,
  ExchangeBadge,
  Panel,
  SortTh,
  ParcelBadge,
  TypeBadge,
  money,
  qty,
  sortValue,
  type TxSortKey,
} from "./App";
import PerformanceChart from "./PerformanceChart";
import { TickerSellTaxPanel } from "./TickerSellTaxPanel";

type Props = {
  ticker: string;
  exchange: string;
  holding: Holding | undefined;
  filters: Filters;
  portfolios: Portfolio[];
  reloadToken?: number | string;
  onBack: () => void;
  onViewLedger: () => void;
  /** Rendered directly above the transactions table, right next to what it filters. */
  filterBar: ReactNode;
  /** Called after a delete so the caller can reload holdings/totals elsewhere. */
  onChanged?: () => void;
};

export function TickerPanel({
  ticker,
  exchange,
  holding,
  filters,
  portfolios,
  reloadToken,
  onBack,
  onViewLedger,
  filterBar,
  onChanged,
}: Props) {
  const [txs, setTxs] = useState<TxRow[]>([]);
  const [txError, setTxError] = useState<string | null>(null);
  const [txLoading, setTxLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [txSort, setTxSort] = useState<{ key: TxSortKey; dir: "asc" | "desc" }>({
    key: "date",
    dir: "desc",
  });
  const [selectedTxIds, setSelectedTxIds] = useState<Set<number>>(new Set());

  const [detail, setDetail] = useState<InstrumentAssumptionsDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTxLoading(true);
    setTxError(null);
    setSelectedTxIds(new Set());
    void fetchTransactions(filters)
      .then((rows) => {
        if (!cancelled) setTxs(rows);
      })
      .catch((e) => {
        if (!cancelled)
          setTxError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setTxLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters.portfolioId, filters.ticker, filters.exchange]);

  function toggleTxSort(key: TxSortKey) {
    setTxSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "date" ? "desc" : "asc" },
    );
  }

  function toggleSelectTx(id: number) {
    setSelectedTxIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible(ids: number[]) {
    const allOn = ids.length > 0 && ids.every((id) => selectedTxIds.has(id));
    setSelectedTxIds(allOn ? new Set() : new Set(ids));
  }

  async function onDeleteSelected() {
    const ids = [...selectedTxIds];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} transaction(s)?`)) return;
    setBusy(true);
    setTxError(null);
    try {
      await deleteTransactions(ids);
      setSelectedTxIds(new Set());
      const rows = await fetchTransactions(filters);
      setTxs(rows);
      onChanged?.();
    } catch (e) {
      setTxError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void fetchInstrumentAssumptions(ticker, { exchange })
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        // Best-effort only — About card just stays hidden on failure.
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, exchange]);

  const sortedTxs = useMemo(() => {
    const list = [...txs];
    const { key, dir } = txSort;
    const mul = dir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      if (av < bv) return -1 * mul;
      if (av > bv) return 1 * mul;
      return (b.id - a.id) * mul;
    });
    return list;
  }, [txs, txSort]);
  const hasAbout = detail && (detail.name || detail.issuer || detail.productUrl);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md bg-gray-800 px-2 py-1 text-xs text-gray-300 hover:bg-gray-700"
        >
          ← Back to holdings
        </button>
        <button
          type="button"
          onClick={onViewLedger}
          className="rounded-md bg-gray-800 px-2 py-1 text-xs text-gray-300 hover:bg-gray-700"
        >
          View in full ledger →
        </button>
      </div>

      <Panel
        title={`${ticker}${
          holding ? "" : " (no current holding in this book)"
        }`}
      >
        <div className="mb-3">
          <ExchangeBadge
            exchange={exchange}
            currency={holding?.currency ?? "AUD"}
          />
        </div>
        {holding ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Units" value={qty(holding.quantity)} />
            <Stat
              label="Avg cost"
              value={money(holding.avgCost, holding.currency, true)}
            />
            <Stat
              label="Price"
              value={money(holding.marketPrice, holding.currency, true)}
            />
            <Stat
              label="Value"
              value={money(holding.marketValue, holding.currency, true)}
            />
            <Stat
              label="Cost base (AUD)"
              value={money(holding.costBaseAud ?? holding.costBase)}
            />
            <Stat
              label="Value (AUD)"
              value={money(holding.marketValueAud)}
            />
            <Stat
              label="Unrealised (AUD)"
              value={
                holding.marketValueAud != null
                  ? money(
                      holding.marketValueAud -
                        (holding.costBaseAud ?? holding.costBase),
                    )
                  : "—"
              }
            />
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            No open position for this filter — showing transaction history
            only.
          </p>
        )}
      </Panel>

      <TickerSellTaxPanel
        ticker={ticker}
        exchange={exchange}
        holding={holding}
        filters={filters}
        portfolios={portfolios}
        reloadToken={reloadToken}
        onConfirmed={() => {
          setSelectedTxIds(new Set());
          void fetchTransactions(filters)
            .then(setTxs)
            .catch(() => undefined);
          onChanged?.();
        }}
      />

      {hasAbout && (
        <Panel title="About">
          <div className="space-y-1 text-sm text-gray-300">
            {detail?.name && <p className="text-gray-100">{detail.name}</p>}
            {detail?.issuer && (
              <p className="text-xs text-gray-500">Issuer: {detail.issuer}</p>
            )}
            {detail?.productUrl && (
              <a
                href={detail.productUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-emerald-400 hover:underline"
              >
                Product page ↗
              </a>
            )}
            {detail?.yieldRate != null && (
              <p className="text-xs text-gray-500">
                Assumed yield: {(detail.yieldRate * 100).toFixed(2)}% · MER:{" "}
                {(detail.mer * 100).toFixed(2)}%
              </p>
            )}
          </div>
        </Panel>
      )}

      <PerformanceChart filters={filters} reloadToken={reloadToken} />

      {filterBar}

      <Panel title={`Transactions · ${ticker}`}>
        {txLoading && <p className="text-xs text-gray-500">Loading…</p>}
        {txError && <p className="text-xs text-red-400">{txError}</p>}
        {!txLoading && !txError && sortedTxs.length === 0 && (
          <Empty hint="No transactions for this ticker in the current filter." />
        )}
        {!txLoading && sortedTxs.length > 0 && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-xs text-gray-500">
                {sortedTxs.length} row{sortedTxs.length === 1 ? "" : "s"}
                {selectedTxIds.size > 0
                  ? ` · ${selectedTxIds.size} selected`
                  : ""}
              </span>
              <div className="flex-1" />
              <button
                type="button"
                disabled={busy || selectedTxIds.size === 0}
                onClick={() => void onDeleteSelected()}
                className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs text-red-200 hover:bg-red-900/40 disabled:opacity-40"
              >
                Delete selected
              </button>
            </div>
            <div className="max-h-[420px] overflow-auto rounded-lg border border-gray-800">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="sticky top-0 z-10 bg-gray-900 text-xs uppercase tracking-wide text-gray-500 shadow">
                  <tr>
                    <th className="w-10 px-2 py-2.5">
                      <input
                        type="checkbox"
                        checked={
                          sortedTxs.length > 0 &&
                          sortedTxs.every((t) => selectedTxIds.has(t.id))
                        }
                        onChange={() =>
                          toggleSelectAllVisible(sortedTxs.map((t) => t.id))
                        }
                        aria-label="Select all"
                      />
                    </th>
                    <SortTh
                      label="Date"
                      active={txSort.key === "date"}
                      dir={txSort.dir}
                      onClick={() => toggleTxSort("date")}
                    />
                    <SortTh
                      label="Type"
                      active={txSort.key === "type"}
                      dir={txSort.dir}
                      onClick={() => toggleTxSort("type")}
                    />
                    <th className="px-2 py-2 font-medium">Parcel</th>
                    <SortTh
                      label="Broker"
                      active={txSort.key === "broker"}
                      dir={txSort.dir}
                      onClick={() => toggleTxSort("broker")}
                    />
                    <SortTh
                      label="Source"
                      active={txSort.key === "source"}
                      dir={txSort.dir}
                      onClick={() => toggleTxSort("source")}
                    />
                    <SortTh
                      label="Qty"
                      active={txSort.key === "quantity"}
                      dir={txSort.dir}
                      onClick={() => toggleTxSort("quantity")}
                    />
                    <th className="px-2 py-2 font-medium">Price</th>
                    <SortTh
                      label="Amount"
                      active={txSort.key === "amount"}
                      dir={txSort.dir}
                      onClick={() => toggleTxSort("amount")}
                    />
                  </tr>
                </thead>
                <tbody>
                  {sortedTxs.map((t) => (
                    <tr
                      key={t.id}
                      className={`border-t border-gray-800/80 ${
                        selectedTxIds.has(t.id) ? "bg-sky-500/10" : ""
                      }`}
                    >
                      <td className="px-2 py-1">
                        <input
                          type="checkbox"
                          checked={selectedTxIds.has(t.id)}
                          onChange={() => toggleSelectTx(t.id)}
                          aria-label={`Select ${t.id}`}
                        />
                      </td>
                      <td className="px-2 py-1.5 tabular-nums text-gray-300">
                        {t.date}
                      </td>
                      <td className="px-2 py-1.5">
                        <TypeBadge type={t.type} />
                      </td>
                      <td className="px-2 py-1.5">
                        <ParcelBadge tx={t} />
                      </td>
                      <td className="px-2 py-1.5 text-xs text-gray-400">
                        {t.broker || t.custody || "—"}
                      </td>
                      <td className="max-w-[120px] truncate px-2 py-1.5 text-xs text-gray-500">
                        {t.source || "—"}
                      </td>
                      <td className="px-2 py-1.5 tabular-nums">
                        {qty(t.quantity)}
                      </td>
                      <td className="px-2 py-1.5 tabular-nums">
                        {t.price != null ? money(t.price, t.currency, true) : "—"}
                      </td>
                      <td className="px-2 py-1.5 tabular-nums">
                        {money(t.amount, t.currency, true)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-sm font-medium tabular-nums text-gray-100">
        {value}
      </div>
    </div>
  );
}
