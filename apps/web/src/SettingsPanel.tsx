/**
 * Settings — app preferences, DB path, cache wipe (Phase 5).
 * Preferences only; Yahoo refresh remains a manual button elsewhere.
 */
import { useCallback, useEffect, useState } from "react";
import {
  fetchHealth,
  fetchSettings,
  fetchYahooStatus,
  importYahooPayload,
  putSettings,
  wipeCaches,
  type AppSettings,
  type YahooStatus,
} from "./api";
import { Disclaimer } from "./Disclaimer";

export function SettingsPanel() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [dbPath, setDbPath] = useState<string | null>(null);
  const [yahooRefresh, setYahooRefresh] = useState(false);
  const [usWithholdingPct, setUsWithholdingPct] = useState("15");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [wipeMsg, setWipeMsg] = useState<string | null>(null);
  const [yahooStatus, setYahooStatus] = useState<YahooStatus | null>(null);
  const [yahooPaste, setYahooPaste] = useState("");
  const [yahooSymbolHint, setYahooSymbolHint] = useState("");
  const [yahooImportMsg, setYahooImportMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [s, health, y] = await Promise.all([
        fetchSettings(),
        fetchHealth().catch(() => null),
        fetchYahooStatus().catch(() => null),
      ]);
      setSettings(s.settings);
      setDbPath(s.dbPath ?? health?.dbPath ?? null);
      setYahooRefresh(
        s.settings.yahoo_refresh_enabled === "1" ||
          s.settings.yahoo_refresh_enabled === "true",
      );
      setUsWithholdingPct(s.settings.us_withholding_pct ?? "15");
      if (y) setYahooStatus(y);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSave() {
    const pct = Number(usWithholdingPct);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) {
      setError("US withholding % must be between 0 and 100");
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await putSettings({
        yahoo_refresh_enabled: yahooRefresh ? "1" : "0",
        us_withholding_pct: String(pct),
      });
      setSettings(res.settings);
      setDbPath(res.dbPath ?? dbPath);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onWipeCaches() {
    if (
      !window.confirm(
        "Wipe quote, price, dividend, and FX caches?\n\nTransactions and portfolios are NOT deleted.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setWipeMsg(null);
    try {
      const res = await wipeCaches();
      const d = res.deleted;
      setWipeMsg(
        `Cleared caches: quotes ${d.quote_cache}, bars ${d.price_cache}, dividends ${d.dividend_cache}, FX ${d.fx_cache}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onImportYahooPaste() {
    const text = yahooPaste.trim();
    if (!text) {
      setError("Paste Yahoo chart/spark/quote JSON first");
      return;
    }
    let payload: unknown = text;
    try {
      payload = JSON.parse(text);
    } catch {
      // API accepts string too, but prefer parse here for better local errors
      setError("Paste must be valid JSON (copy full response body from browser)");
      return;
    }
    setBusy(true);
    setError(null);
    setYahooImportMsg(null);
    try {
      const r = await importYahooPayload(
        payload,
        yahooSymbolHint.trim() || undefined,
      );
      setYahooImportMsg(
        `Imported ${r.kind}: ${r.symbols.join(", ") || "—"} · ${r.barsWritten} bars · ${r.quotesWritten} quotes`,
      );
      setYahooPaste("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-gray-800 bg-gray-900/40 p-5 shadow-xl shadow-black/20">
      <h2 className="mb-1 text-lg font-medium text-gray-100">Settings</h2>
      <p className="mb-4 text-sm text-gray-400">
        App preferences and cache maintenance. Tax profiles live under the Tax
        tab; planner scenarios under Planner.
      </p>

      {error && (
        <div className="mb-3 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="space-y-4">
        <div className="rounded-xl border border-gray-800 bg-gray-950/40 p-4">
          <h3 className="mb-2 text-sm font-medium text-gray-200">Database</h3>
          <p className="text-xs text-gray-500">SQLite path (read-only)</p>
          <p className="mt-1 break-all font-mono text-sm text-gray-300">
            {dbPath ?? "local SQLite via API"}
          </p>
        </div>

        <div className="rounded-xl border border-gray-800 bg-gray-950/40 p-4 space-y-3">
          <h3 className="text-sm font-medium text-gray-200">Preferences</h3>

          <label className="flex items-start gap-3 text-sm text-gray-300">
            <input
              type="checkbox"
              className="mt-1"
              checked={yahooRefresh}
              disabled={busy}
              onChange={(e) => {
                setSaved(false);
                setYahooRefresh(e.target.checked);
              }}
            />
            <span>
              <span className="block">Yahoo preference flag (manual still)</span>
              <span className="mt-0.5 block text-xs text-gray-500">
                Page load never calls Yahoo. Prices refresh only via the header
                button. After a 429, the app cools down (15m→1h→3h→6h, or
                Retry-After if Yahoo sends one) and shows a countdown badge.
              </span>
            </span>
          </label>

          <label className="block text-sm max-w-xs">
            <span className="mb-1 block text-xs text-gray-500">
              US withholding default %
            </span>
            <input
              className="field"
              inputMode="decimal"
              value={usWithholdingPct}
              disabled={busy}
              onChange={(e) => {
                setSaved(false);
                setUsWithholdingPct(e.target.value);
              }}
            />
            <span className="mt-1 block text-xs text-gray-500">
              Default 15% for future US dividend income estimates (not applied
              automatically yet).
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              disabled={busy || !settings}
              onClick={() => void onSave()}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-gray-950 hover:bg-emerald-400 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save preferences"}
            </button>
            {saved && (
              <span className="text-xs text-emerald-300">Saved</span>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-gray-800 bg-gray-950/40 p-4">
          <h3 className="mb-2 text-sm font-medium text-gray-200">
            Manual Yahoo import
          </h3>
          <p className="mb-2 text-xs text-gray-500">
            When Node is rate-limited but your browser still works: open a Yahoo
            URL → copy the JSON → paste here (or use the browser console{" "}
            <code className="text-gray-400">risu.importYahoo(json)</code>).
          </p>
          {yahooStatus?.lastUrl && (
            <p className="mb-2 break-all text-xs">
              <span className="text-gray-500">Last failed URL: </span>
              <a
                href={yahooStatus.lastUrl}
                target="_blank"
                rel="noreferrer"
                className="text-sky-400 hover:underline"
              >
                {yahooStatus.lastUrl}
              </a>
            </p>
          )}
          <p className="mb-2 text-[11px] text-gray-600">
            Bulk history:{" "}
            <code className="text-gray-500">
              risu.sparkUrl([&quot;TSLA&quot;,&quot;VAS.AX&quot;])
            </code>
            · single:{" "}
            <code className="text-gray-500">risu.chartUrl(&quot;TSLA&quot;)</code>
          </p>
          <label className="mb-2 block text-sm max-w-xs">
            <span className="mb-1 block text-xs text-gray-500">
              Symbol hint (optional, chart-only)
            </span>
            <input
              className="field"
              value={yahooSymbolHint}
              disabled={busy}
              placeholder="e.g. TSLA or VAS.AX"
              onChange={(e) => setYahooSymbolHint(e.target.value)}
            />
          </label>
          <textarea
            className="field min-h-[120px] w-full font-mono text-xs"
            disabled={busy}
            placeholder='Paste full Yahoo JSON here — chart, spark, or quote body…'
            value={yahooPaste}
            onChange={(e) => setYahooPaste(e.target.value)}
          />
          <button
            type="button"
            disabled={busy || !yahooPaste.trim()}
            onClick={() => void onImportYahooPaste()}
            className="mt-2 rounded-lg border border-sky-800/60 bg-sky-950/40 px-4 py-2 text-sm text-sky-100 hover:bg-sky-900/40 disabled:opacity-50"
          >
            Import into price cache
          </button>
          {yahooImportMsg && (
            <p className="mt-2 text-xs text-emerald-300/90">{yahooImportMsg}</p>
          )}
        </div>

        <div className="rounded-xl border border-gray-800 bg-gray-950/40 p-4">
          <h3 className="mb-2 text-sm font-medium text-gray-200">Caches</h3>
          <p className="mb-3 text-xs text-gray-500">
            Clears Yahoo quote, historical price, dividend, and FX tables only.
            Ledger transactions, portfolios, and scenarios are untouched.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onWipeCaches()}
            className="rounded-lg border border-amber-800/60 bg-amber-950/40 px-4 py-2 text-sm text-amber-100 hover:bg-amber-900/40 disabled:opacity-50"
          >
            Wipe quote / price / dividend / FX caches
          </button>
          {wipeMsg && (
            <p className="mt-2 text-xs text-emerald-300/90">{wipeMsg}</p>
          )}
        </div>
      </div>

      <div className="mt-4">
        <Disclaimer />
      </div>

      <style>{`
        .field {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid #374151;
          background: #111827;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          color: #f3f4f6;
        }
      `}</style>
    </section>
  );
}
