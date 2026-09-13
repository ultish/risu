/**
 * StakeDrpPanel — separate, on-demand DRP detection for Stake imports.
 *
 * Stake's Investment Activity export never shows dividend reinvestment as a
 * trade; the only trace is the Investment Income workbook's "Units held"
 * column drifting upward with no matching Activity buy. Drop any mix of
 * Activity/Income/Valuation workbooks (any years) here to detect it —
 * independent of the regular per-file import above, which is unaffected.
 *
 * Two-step: Analyze (preview only, no writes) → Confirm & insert. Anything
 * that can't be confidently attributed to DRP (no dividend record covers the
 * gap — e.g. a corporate action) is a warning, never a guess.
 */
import { useRef, useState } from "react";
import {
  analyzeStakeDrp,
  type Portfolio,
  type StakeDrpProposed,
  type StakeDrpResult,
} from "./api";
import { Panel } from "./App";

type Props = {
  portfolioId: number | "all";
  portfolios: Portfolio[];
  onPortfolioChange: (id: number) => void;
  /** Called after a successful commit so the caller can reload holdings/transactions. */
  onCommitted?: () => void;
  /** Called after analyze or commit so file history can refresh. */
  onHistoryChange?: () => void;
};

export default function StakeDrpPanel({
  portfolioId,
  portfolios,
  onPortfolioChange,
  onCommitted,
  onHistoryChange,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [result, setResult] = useState<StakeDrpResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  function addFiles(list: FileList | null) {
    if (!list) return;
    setResult(null);
    setError(null);
    setFiles((prev) => {
      const next = [...prev];
      for (const f of Array.from(list)) {
        if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
      }
      return next;
    });
  }

  function removeFile(name: string) {
    setFiles((prev) => prev.filter((f) => f.name !== name));
    setResult(null);
  }

  function removeAll() {
    setFiles([]);
    setResult(null);
    setError(null);
  }

  async function onAnalyze() {
    if (portfolioId === "all") {
      setError("Select a portfolio first");
      return;
    }
    if (files.length === 0) {
      setError("Add at least one Stake Activity/Income/Valuation file");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await analyzeStakeDrp({ files, portfolioId, commit: false });
      setResult(r);
      onHistoryChange?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm() {
    if (portfolioId === "all" || !result) return;
    const newCount = result.proposed.filter((p) => !p.alreadyInLedger).length;
    const dupCount = result.proposed.length - newCount;
    const ok = confirm(
      newCount === 0
        ? "Nothing new to insert — every suggested DRP is already in the ledger."
        : `Insert ${newCount} new DRP transaction(s) into the ledger?${
            dupCount ? ` ${dupCount} already in the ledger will be skipped.` : ""
          }\n\nThis writes to your database.`,
    );
    if (!ok || newCount === 0) return;
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const r = await analyzeStakeDrp({ files, portfolioId, commit: true });
      setResult(r);
      onCommitted?.();
      onHistoryChange?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Stake DRP check">
      <div className="mb-4 space-y-3 text-sm text-gray-400">
        <p>
          Stake’s <strong className="text-gray-200">Investment Activity</strong>{" "}
          export never lists dividend reinvestment as a buy — extra units just
          appear. This page finds those missing <strong className="text-gray-200">DRP lots</strong>{" "}
          so cost base and tax estimates aren’t short.
        </p>
        <p>
          Drop Stake <strong className="text-gray-200">Investment Activity</strong>,{" "}
          <strong className="text-gray-200">Investment Income</strong>, and
          optionally <strong className="text-gray-200">Portfolio Valuation</strong>{" "}
          workbooks (any years, mixed together). It is{" "}
          <strong className="text-gray-200">not</strong> a second file import —
          regular Import file is unchanged.
        </p>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            <strong className="text-gray-200">Analyze</strong> — preview only.
            Suggests a DRP row only when a dividend sits just before the extra
            units.
          </li>
          <li>
            <strong className="text-gray-200">Confirm &amp; insert</strong> —
            writes those <code className="text-gray-300">drp</code> lots into
            the selected portfolio. Re-running skips rows already inserted.
          </li>
        </ol>
        <p>
          Other unit jumps (share purchase plans, liquidations, splits) show as{" "}
          <strong className="text-gray-200">warnings</strong> — it will not
          invent lots. Pick a portfolio first.
        </p>
      </div>

      <label className="mb-3 block text-sm">
        <span className="mb-1 block text-xs text-gray-400">Portfolio</span>
        <select
          className="w-full max-w-xs rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
          value={portfolioId === "all" ? "" : String(portfolioId)}
          onChange={(e) => onPortfolioChange(Number(e.target.value))}
        >
          <option value="" disabled>
            Select portfolio…
          </option>
          {portfolios.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={
          "mb-3 cursor-pointer rounded-lg border border-dashed p-4 text-center text-xs transition-colors " +
          (dragOver
            ? "border-emerald-400 bg-emerald-400/10 text-emerald-300"
            : "border-gray-700 text-gray-500 hover:border-gray-500")
        }
      >
        Drag & drop XLSX files here, or click to browse
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".xlsx"
          className="hidden"
          onChange={(e) => addFiles(e.target.files)}
        />
      </div>

      {files.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs text-gray-500">{files.length} file(s)</span>
            <button
              type="button"
              onClick={removeAll}
              className="text-xs text-gray-500 hover:text-red-400"
            >
              Remove all
            </button>
          </div>
          <ul className="space-y-1">
            {files.map((f) => (
              <li key={f.name} className="flex items-center justify-between text-xs text-gray-300">
                <span>{f.name}</span>
                <button
                  type="button"
                  onClick={() => removeFile(f.name)}
                  className="text-gray-500 hover:text-red-400"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || files.length === 0}
          onClick={() => void onAnalyze()}
          className="rounded-lg bg-gray-700 px-3 py-1.5 text-xs font-medium text-gray-100 hover:bg-gray-600 disabled:opacity-50"
        >
          {busy ? "Working…" : "Analyze"}
        </button>
        {result &&
          !result.committed &&
          result.proposed.some((p) => !p.alreadyInLedger) && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void onConfirm()}
            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-gray-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            Confirm & insert{" "}
            {result.proposed.filter((p) => !p.alreadyInLedger).length}
          </button>
        )}
      </div>

      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

      {result && result.unrecognizedFiles.length > 0 && (
        <p className="mt-3 text-xs text-amber-400">
          Not recognized as a Stake Activity/Income/Valuation export: {result.unrecognizedFiles.join(", ")}
        </p>
      )}

      {result && (
        <div className="mt-3">
          {result.committed ? (
            <p className="text-xs text-emerald-400">
              Inserted {result.inserted} transaction(s)
              {result.skippedExisting
                ? ` (${result.skippedExisting} already in the ledger, skipped)`
                : ""}
              .
            </p>
          ) : (
            <p className="text-xs text-gray-400">
              {result.proposed.filter((p) => !p.alreadyInLedger).length} new DRP
              event(s)
              {result.proposed.some((p) => p.alreadyInLedger)
                ? `, ${result.proposed.filter((p) => p.alreadyInLedger).length} already in the ledger`
                : ""}
              , {result.warnings.length} unexplained gap(s).
            </p>
          )}

          <DrpTable
            title={result.committed ? "Inserted" : "New — will insert"}
            rows={result.proposed.filter((p) => !p.alreadyInLedger)}
          />
          <DrpTable
            title={
              result.committed
                ? "Already in the ledger — skipped"
                : "Already in the ledger — will skip"
            }
            rows={result.proposed.filter((p) => p.alreadyInLedger)}
            duplicate
          />

          {result.warnings.length > 0 && (
            <ul className="mt-3 space-y-1">
              {result.warnings.map((w, i) => (
                <li key={i} className="text-xs text-amber-400">
                  {w.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}

function DrpTable({
  title,
  rows,
  duplicate = false,
}: {
  title: string;
  rows: StakeDrpProposed[];
  duplicate?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-3">
      <p
        className={`mb-1 text-xs font-medium ${
          duplicate ? "text-amber-300/90" : "text-gray-400"
        }`}
      >
        {title} ({rows.length})
      </p>
      <table className="w-full text-left text-xs">
        <thead className="text-gray-500">
          <tr>
            <th className="pb-1 pr-4">Date</th>
            <th className="pb-1 pr-4">Ticker</th>
            <th className="pb-1 pr-4">Units</th>
            <th className="pb-1">{duplicate ? "Why skipped" : "Funded by"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.externalId ?? `${p.date}-${p.ticker}-${p.quantity}`}>
              <td className="border-t border-gray-800 py-1 pr-4 text-gray-300">
                {p.date}
              </td>
              <td className="border-t border-gray-800 py-1 pr-4 font-medium text-gray-200">
                {p.ticker}
              </td>
              <td className="border-t border-gray-800 py-1 pr-4 text-gray-300">
                {p.quantity}
              </td>
              <td className="border-t border-gray-800 py-1 text-gray-400">
                {duplicate ? (p.alreadyHow ?? "already in ledger") : p.fundedBy}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
