/**
 * ImportHistoryPanel — "what have I already imported, and up to when".
 *
 * Two views on the same GET /api/import/history call:
 * - Per-broker/custody rollup: latest transaction date already in the
 *   ledger, so it's obvious whether this year's statement still needs
 *   importing without cross-referencing individual files.
 * - Per-file history: every filename ever imported (deduped — re-importing
 *   the same filename overwrites its row with the latest attempt rather
 *   than piling up duplicates), newest first, collapsed by default since
 *   this list only grows over time.
 */
import { useCallback, useEffect, useState } from "react";
import { fetchImportHistory, type ImportHistory } from "./api";

type Props = {
  portfolioId: number | "all";
  /** Bump to force a refetch (e.g. after an import completes elsewhere). */
  refreshSignal?: number;
  /** Restrict to one import_batches.source (e.g. stake-drp-detect). */
  source?: string;
  title?: string;
  /** Hide the per-broker rollup; just list files. */
  filesOnly?: boolean;
  defaultShowFiles?: boolean;
};

function formatDateTime(iso: string): string {
  // Server stores SQLite `datetime('now')` strings (UTC, "YYYY-MM-DD HH:MM:SS").
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function ImportHistoryPanel({
  portfolioId,
  refreshSignal,
  source,
  title = "Already imported",
  filesOnly = false,
  defaultShowFiles = false,
}: Props) {
  const [history, setHistory] = useState<ImportHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(defaultShowFiles);

  const load = useCallback(async () => {
    setError(null);
    try {
      const h = await fetchImportHistory(
        portfolioId === "all" ? undefined : portfolioId,
        source ? { source } : undefined,
      );
      setHistory(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [portfolioId, source]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshSignal]);

  if (error) {
    return <p className="text-xs text-red-400">Import history: {error}</p>;
  }
  if (!history) return null;
  if (filesOnly ? history.files.length === 0 : history.byBroker.length === 0 && history.files.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900/50 p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
          {title}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          Refresh
        </button>
      </div>
      {!filesOnly && history.byBroker.length > 0 && (
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-gray-500">
            <tr>
              <th className="pb-1 pr-4">Broker / custody</th>
              <th className="pb-1 pr-4">Latest transaction date</th>
              <th className="pb-1 pr-4">Transactions</th>
              <th className="pb-1">Last imported</th>
            </tr>
          </thead>
          <tbody>
            {history.byBroker.map((b) => (
              <tr key={b.broker} className="border-t border-gray-800">
                <td className="py-1 pr-4 font-medium text-gray-200">{b.broker}</td>
                <td className="py-1 pr-4 text-gray-300">
                  {b.latestTransactionDate ?? "—"}
                </td>
                <td className="py-1 pr-4 text-gray-400">{b.transactionCount}</td>
                <td className="py-1 text-gray-400">
                  {b.lastImportedAt ? formatDateTime(b.lastImportedAt) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      {!filesOnly && (
      <button
        type="button"
        onClick={() => setShowFiles((v) => !v)}
        className={`text-xs text-emerald-400 hover:text-emerald-300 ${history.byBroker.length > 0 ? "mt-3" : ""}`}
      >
        {showFiles ? "Hide" : "Show"} imported files ({history.files.length})
      </button>
      )}

      {(showFiles || filesOnly) && history.files.length > 0 && (
        <div className="mt-2 max-h-64 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-gray-900 text-gray-500">
              <tr>
                <th className="pb-1 pr-4">Filename</th>
                <th className="pb-1 pr-4">Portfolio</th>
                <th className="pb-1 pr-4">Broker</th>
                <th className="pb-1 pr-4">Rows</th>
                <th className="pb-1">{filesOnly ? "Last run" : "Last imported"}</th>
              </tr>
            </thead>
            <tbody>
              {history.files.map((f) => (
                <tr
                  key={`${f.portfolioId}|${f.filename}`}
                  className="border-t border-gray-800"
                >
                  <td className="py-1 pr-4 text-gray-200" title={f.filename}>
                    {f.filename}
                    {f.importCount > 1 && (
                      <span className="ml-1 text-gray-500">
                        ({filesOnly ? "used" : "imported"} {f.importCount}×)
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-4 text-gray-400">{f.portfolioName}</td>
                  <td className="py-1 pr-4 text-gray-400">{f.broker ?? "—"}</td>
                  <td className="py-1 pr-4 text-gray-400">{f.importedCount}</td>
                  <td className="py-1 text-gray-400">{formatDateTime(f.importedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
