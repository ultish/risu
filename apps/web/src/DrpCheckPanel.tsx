/**
 * DrpCheckPanel — DRP/DRIP expected vs imported check (Phase 2).
 *
 * Wire-up in App.tsx (do not gut App — add tab only):
 *
 *   import { DrpCheckPanel } from "./DrpCheckPanel";
 *
 *   // extend tab union with "drp"
 *   // nav: ["drp", "DRP check"]
 *
 *   {tab === "drp" && (
 *     <DrpCheckPanel
 *       portfolioId={portfolioId === "all" ? portfolios[0]?.id : portfolioId}
 *       holdings={holdings}
 *     />
 *   )}
 *
 * APIs:
 *   GET  /api/holdings/flags?portfolioId=
 *   PUT  /api/holdings/flags  { portfolioId, ticker, exchange, drpEnabled, drpFromDate }
 *   GET  /api/drp-check?portfolioId=&ticker=&exchange=
 *
 * Does NOT write ledger transactions — suggestions are for user confirmation.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchDrpCheck,
  fetchHoldingFlags,
  putHoldingFlag,
  type DrpCheckResult,
  type Holding,
  type HoldingFlag,
} from "./api";

function money(n: number | null | undefined, currency = "AUD") {
  if (n == null || Number.isNaN(n)) return "—";
  try {
    return n.toLocaleString("en-AU", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    });
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

function qty(n: number | null | undefined) {
  if (n == null) return "—";
  return n.toLocaleString("en-AU", { maximumFractionDigits: 6 });
}

export type DrpCheckPanelProps = {
  /** Required for flags + check. If undefined, panel prompts to pick a portfolio. */
  portfolioId?: number;
  holdings?: Holding[];
  /** Optional initial ticker selection */
  initialTicker?: string;
  initialExchange?: string;
};

export function DrpCheckPanel({
  portfolioId,
  holdings = [],
  initialTicker,
  initialExchange,
}: DrpCheckPanelProps) {
  const instruments = useMemo(() => {
    const fromHoldings = holdings.map((h) => ({
      ticker: h.ticker,
      exchange: h.exchange,
      label: `${h.ticker} · ${h.exchange}`,
    }));
    // Dedupe
    const seen = new Set<string>();
    return fromHoldings.filter((i) => {
      const k = `${i.exchange}:${i.ticker}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [holdings]);

  const [ticker, setTicker] = useState(
    initialTicker || instruments[0]?.ticker || "",
  );
  const [exchange, setExchange] = useState(
    initialExchange || instruments[0]?.exchange || "ASX",
  );
  const [flags, setFlags] = useState<HoldingFlag[]>([]);
  const [check, setCheck] = useState<DrpCheckResult | null>(null);
  const [drpFromDate, setDrpFromDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const currentFlag = useMemo(
    () =>
      flags.find(
        (f) =>
          f.ticker === ticker.toUpperCase() &&
          f.exchange === exchange.toUpperCase(),
      ),
    [flags, ticker, exchange],
  );

  const loadFlags = useCallback(async () => {
    if (!portfolioId) return;
    const res = await fetchHoldingFlags(portfolioId);
    setFlags(res.flags);
  }, [portfolioId]);

  const runCheck = useCallback(async () => {
    if (!portfolioId || !ticker.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await fetchDrpCheck({
        portfolioId,
        ticker: ticker.trim().toUpperCase(),
        exchange,
      });
      setCheck(result);
      if (result.drpFromDate) setDrpFromDate(result.drpFromDate);
      else if (!currentFlag?.drpFromDate) setDrpFromDate("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [portfolioId, ticker, exchange, currentFlag?.drpFromDate]);

  useEffect(() => {
    void loadFlags().catch((e) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, [loadFlags]);

  useEffect(() => {
    if (portfolioId && ticker) void runCheck();
  }, [portfolioId, ticker, exchange]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (currentFlag?.drpFromDate) setDrpFromDate(currentFlag.drpFromDate);
  }, [currentFlag?.ticker, currentFlag?.exchange, currentFlag?.drpFromDate]);

  async function onToggleDrp(enabled: boolean) {
    if (!portfolioId || !ticker.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await putHoldingFlag({
        portfolioId,
        ticker: ticker.trim().toUpperCase(),
        exchange,
        drpEnabled: enabled,
        drpFromDate: drpFromDate || null,
      });
      await loadFlags();
      await runCheck();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onSaveFromDate() {
    if (!portfolioId || !ticker.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await putHoldingFlag({
        portfolioId,
        ticker: ticker.trim().toUpperCase(),
        exchange,
        drpEnabled: currentFlag?.drpEnabled ?? check?.drpEnabled ?? true,
        drpFromDate: drpFromDate || null,
      });
      await loadFlags();
      await runCheck();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function onPickInstrument(value: string) {
    const [ex, ...rest] = value.split(":");
    const t = rest.join(":");
    if (ex && t) {
      setExchange(ex);
      setTicker(t);
      setCheck(null);
    }
  }

  if (!portfolioId) {
    return (
      <section className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
        <h2 className="text-lg font-medium">DRP / DRIP check</h2>
        <p className="mt-2 text-sm text-gray-400">
          Select a specific portfolio (not “All”) to manage DRP flags and run
          the check.
        </p>
      </section>
    );
  }

  const drpOn = currentFlag?.drpEnabled ?? check?.drpEnabled ?? false;

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
      <div className="mb-3">
        <h2 className="text-lg font-medium text-gray-100">DRP / DRIP check</h2>
        <p className="text-xs text-gray-500">
          Flag holdings that reinvest dividends. Compare Yahoo cash dividends ×
          units held against imported <code className="text-gray-400">drp</code>{" "}
          lots. Suggestions are never auto-written to the ledger.
        </p>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-gray-500">Instrument</span>
          {instruments.length > 0 ? (
            <select
              className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm"
              value={`${exchange}:${ticker}`}
              onChange={(e) => onPickInstrument(e.target.value)}
            >
              {instruments.map((i) => (
                <option
                  key={`${i.exchange}:${i.ticker}`}
                  value={`${i.exchange}:${i.ticker}`}
                >
                  {i.label}
                </option>
              ))}
            </select>
          ) : (
            <div className="flex gap-2">
              <input
                className="w-28 rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm uppercase"
                placeholder="TICKER"
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
              />
              <select
                className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm"
                value={exchange}
                onChange={(e) => setExchange(e.target.value)}
              >
                <option value="ASX">ASX</option>
                <option value="US">US</option>
                <option value="LSE">LSE</option>
              </select>
            </div>
          )}
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-gray-600"
            checked={drpOn}
            disabled={busy || !ticker}
            onChange={(e) => void onToggleDrp(e.target.checked)}
          />
          <span>DRP / DRIP enabled</span>
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-xs text-gray-500">
            Enabled from (optional)
          </span>
          <input
            type="date"
            className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm"
            value={drpFromDate}
            onChange={(e) => setDrpFromDate(e.target.value)}
          />
        </label>

        <button
          type="button"
          disabled={busy || !ticker}
          onClick={() => void onSaveFromDate()}
          className="rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-sm hover:bg-gray-700 disabled:opacity-50"
        >
          Save from-date
        </button>

        <button
          type="button"
          disabled={busy || !ticker}
          onClick={() => void runCheck()}
          className="rounded-lg border border-emerald-700/60 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
        >
          {busy ? "Running…" : "Run check"}
        </button>
      </div>

      {check && (
        <>
          {check.yahooError && (
            <p className="mb-2 text-xs text-amber-300/90">
              Yahoo dividends: {check.yahooError}
            </p>
          )}
          <p className="mb-2 text-xs text-gray-500">
            Dividend events: {check.yahooDividendCount}
            {check.yahooSource ? ` (source: ${check.yahooSource})` : ""} · Flag:{" "}
            {check.drpEnabled ? "on" : "off"}
            {check.drpFromDate ? ` from ${check.drpFromDate}` : ""}
          </p>
          <p className="mb-2 text-xs text-gray-600">
            Yahoo is optional. If 429s never clear: import{" "}
            <code className="text-gray-400">dividend_cash</code> / DRP from
            Sharesight or your broker — that is the source of truth for lots.
            Avoid bulk “Refresh prices” while blocked (can last hours).
          </p>

          {check.notes.length > 0 && (
            <ul className="mb-4 list-inside list-disc text-xs text-gray-400">
              {check.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}

          <div className="mb-6 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-medium text-gray-300">
                Expected reinvest (suggestions)
              </h3>
              {check.suggestions.length === 0 ? (
                <p className="text-sm text-gray-500">
                  {check.drpEnabled
                    ? "No suggestions for this period."
                    : "Enable DRP to generate suggestions."}
                </p>
              ) : (
                <div className="max-h-72 overflow-auto rounded-lg border border-gray-800">
                  <table className="w-full text-left text-xs sm:text-sm">
                    <thead className="sticky top-0 bg-gray-900 text-xs uppercase tracking-wide text-gray-500">
                      <tr>
                        <th className="px-2 py-2 font-medium">Date</th>
                        <th className="px-2 py-2 font-medium">Units</th>
                        <th className="px-2 py-2 font-medium">Cash est.</th>
                        <th className="px-2 py-2 font-medium">Exp. shares</th>
                        <th className="px-2 py-2 font-medium">Match</th>
                      </tr>
                    </thead>
                    <tbody>
                      {check.suggestions.map((s) => {
                        const unmatched = check.unmatchedSuggestions.some(
                          (u) => u.date === s.date,
                        );
                        return (
                          <tr
                            key={s.date}
                            className={`border-t border-gray-800/80 ${
                              unmatched ? "bg-amber-500/5" : ""
                            }`}
                            title={s.note}
                          >
                            <td className="px-2 py-1.5 whitespace-nowrap">
                              {s.date}
                            </td>
                            <td className="px-2 py-1.5">{qty(s.unitsHeld)}</td>
                            <td className="px-2 py-1.5">
                              {money(s.cashDiv)}
                              <span className="block text-[10px] text-gray-500">
                                @ {s.amountPerShare}
                              </span>
                            </td>
                            <td className="px-2 py-1.5">
                              {qty(s.expectedShares)}
                            </td>
                            <td className="px-2 py-1.5">
                              {unmatched ? (
                                <span className="text-amber-300">missing?</span>
                              ) : (
                                <span className="text-emerald-400">ok</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-gray-300">
                Imported DRP / DRIP lots
              </h3>
              {check.importedDrp.length === 0 ? (
                <p className="text-sm text-gray-500">
                  No <code className="text-gray-400">drp</code> rows in ledger
                  for this instrument.
                </p>
              ) : (
                <div className="max-h-72 overflow-auto rounded-lg border border-gray-800">
                  <table className="w-full text-left text-xs sm:text-sm">
                    <thead className="sticky top-0 bg-gray-900 text-xs uppercase tracking-wide text-gray-500">
                      <tr>
                        <th className="px-2 py-2 font-medium">Date</th>
                        <th className="px-2 py-2 font-medium">Qty</th>
                        <th className="px-2 py-2 font-medium">Price</th>
                        <th className="px-2 py-2 font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {check.importedDrp.map((row, i) => (
                        <tr
                          key={`${row.date}-${i}`}
                          className="border-t border-gray-800/80"
                        >
                          <td className="px-2 py-1.5 whitespace-nowrap">
                            {row.date}
                          </td>
                          <td className="px-2 py-1.5">{qty(row.quantity)}</td>
                          <td className="px-2 py-1.5">{money(row.price)}</td>
                          <td className="px-2 py-1.5">{money(row.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
