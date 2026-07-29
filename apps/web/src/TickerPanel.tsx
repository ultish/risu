import { useEffect, useState } from "react";
import {
  type Filters,
  type Holding,
  type InstrumentAssumptionsDto,
  type TxRow,
  fetchInstrumentAssumptions,
  fetchTransactions,
} from "./api";
import { Empty, ExchangeBadge, Panel, TypeBadge, money, qty } from "./App";
import PerformanceChart from "./PerformanceChart";

type Props = {
  ticker: string;
  exchange: string;
  holding: Holding | undefined;
  filters: Filters;
  reloadToken?: number | string;
  onBack: () => void;
  onViewLedger: () => void;
};

export function TickerPanel({
  ticker,
  exchange,
  holding,
  filters,
  reloadToken,
  onBack,
  onViewLedger,
}: Props) {
  const [txs, setTxs] = useState<TxRow[]>([]);
  const [txError, setTxError] = useState<string | null>(null);
  const [txLoading, setTxLoading] = useState(false);

  const [detail, setDetail] = useState<InstrumentAssumptionsDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTxLoading(true);
    setTxError(null);
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

  const sortedTxs = [...txs].sort((a, b) => b.date.localeCompare(a.date));
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

      <Panel title={`Transactions · ${ticker}`}>
        {txLoading && <p className="text-xs text-gray-500">Loading…</p>}
        {txError && <p className="text-xs text-red-400">{txError}</p>}
        {!txLoading && !txError && sortedTxs.length === 0 && (
          <Empty hint="No transactions for this ticker in the current filter." />
        )}
        {!txLoading && sortedTxs.length > 0 && (
          <div className="max-h-[420px] overflow-auto rounded-lg border border-gray-800">
            <table className="w-full min-w-[700px] text-left text-sm">
              <thead className="sticky top-0 z-10 bg-gray-900 text-xs uppercase tracking-wide text-gray-500 shadow">
                <tr>
                  <th className="px-2 py-2 font-medium">Date</th>
                  <th className="px-2 py-2 font-medium">Type</th>
                  <th className="px-2 py-2 font-medium">Broker</th>
                  <th className="px-2 py-2 font-medium">Source</th>
                  <th className="px-2 py-2 font-medium">Qty</th>
                  <th className="px-2 py-2 font-medium">Price</th>
                  <th className="px-2 py-2 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {sortedTxs.map((t) => (
                  <tr key={t.id} className="border-t border-gray-800/80">
                    <td className="px-2 py-1.5 tabular-nums text-gray-300">
                      {t.date}
                    </td>
                    <td className="px-2 py-1.5">
                      <TypeBadge type={t.type} />
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
