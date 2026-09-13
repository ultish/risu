/**
 * Hypothetical CGT if you sell N units of the ticker on the ticker page.
 * GET /api/tax/sell-estimate — FIFO vs minimise-CGT parcel picking, with
 * the 1 Jul 2027 cutover applied by sale date.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type Filters,
  type Holding,
  type LotMatchingMethod,
  type Portfolio,
  type SellEstimateDto,
  type TaxProfileDto,
  confirmSale,
  fetchSellEstimate,
  fetchTaxProfiles,
} from "./api";
import { Disclaimer } from "./Disclaimer";
import { Empty, Panel, cgtLineRegimeLabel, money, qty } from "./App";

const MATCHING: Array<{ id: LotMatchingMethod; label: string }> = [
  { id: "fifo", label: "FIFO" },
  { id: "min_cgt", label: "Minimize CGT" },
];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function TickerSellTaxPanel({
  ticker,
  exchange,
  holding,
  filters,
  portfolios,
  reloadToken,
  onConfirmed,
}: {
  ticker: string;
  exchange: string;
  holding: Holding | undefined;
  filters: Filters;
  portfolios: Portfolio[];
  reloadToken?: number | string;
  onConfirmed?: () => void;
}) {
  const [profiles, setProfiles] = useState<TaxProfileDto[]>([]);
  const [profileId, setProfileId] = useState<number | undefined>(undefined);
  const [matching, setMatching] = useState<LotMatchingMethod>("fifo");
  const [qtyStr, setQtyStr] = useState("");
  const [saleDate, setSaleDate] = useState(todayIso);
  const [inflationPct, setInflationPct] = useState("2.5");
  const [report, setReport] = useState<SellEstimateDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);
  const [confirmPortfolioId, setConfirmPortfolioId] = useState<number | "">("");

  const maxQty = holding?.quantity ?? 0;
  const postCutover = saleDate >= "2027-07-01";

  useEffect(() => {
    void fetchTaxProfiles().then((rows) => {
      setProfiles(rows);
      const def = rows.find((r) => r.isDefault) ?? rows[0];
      if (def) setProfileId(def.id);
    });
  }, []);

  useEffect(() => {
    setQtyStr("");
    setReport(null);
    setError(null);
    setConfirmMsg(null);
  }, [ticker, exchange]);

  useEffect(() => {
    if (filters.portfolioId != null) {
      setConfirmPortfolioId(filters.portfolioId);
    } else if (portfolios.length === 1) {
      setConfirmPortfolioId(portfolios[0]!.id);
    } else {
      setConfirmPortfolioId("");
    }
  }, [filters.portfolioId, portfolios]);

  const quantity = Number(qtyStr);

  const load = useCallback(async () => {
    if (profileId == null) return;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setReport(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const inflation = Number(inflationPct);
      const result = await fetchSellEstimate({
        ticker,
        exchange: exchange || undefined,
        quantity,
        lotMatching: matching,
        disposedDate: saleDate,
        taxProfileId: profileId,
        inflationRate: Number.isFinite(inflation) ? inflation / 100 : undefined,
        portfolioId: filters.portfolioId ?? null,
        broker: filters.broker,
        source: filters.source,
      });
      setReport(result);
    } catch (e) {
      setReport(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [
    ticker,
    exchange,
    quantity,
    matching,
    saleDate,
    profileId,
    inflationPct,
    filters.portfolioId,
    filters.broker,
    filters.source,
  ]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  async function onConfirmSale() {
    if (confirmPortfolioId === "" || !report) return;
    const method = matching === "min_cgt" ? "minimize CGT" : "FIFO";
    if (
      !confirm(
        `Record a sell of ${qty(report.quantitySold)} ${ticker} on ${saleDate} using ${method} (${report.parcels.length} parcel${report.parcels.length === 1 ? "" : "s"})?\n\nThis writes the sale and which parcels were consumed into the ledger. You still place the trade with your broker.`,
      )
    ) {
      return;
    }
    setConfirming(true);
    setError(null);
    setConfirmMsg(null);
    try {
      const inflation = Number(inflationPct);
      const result = await confirmSale({
        ticker,
        exchange: exchange || undefined,
        quantity: report.quantitySold,
        disposedDate: saleDate,
        lotMatching: matching,
        portfolioId: confirmPortfolioId,
        taxProfileId: profileId,
        inflationRate: Number.isFinite(inflation) ? inflation / 100 : undefined,
      });
      setConfirmMsg(
        `Recorded sell · ${qty(result.quantitySold)} ${ticker} · ${result.parcels.length} parcel(s). Buy/DRP rows now show sold or partial.`,
      );
      setQtyStr("");
      setReport(null);
      onConfirmed?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfirming(false);
    }
  }

  const alt = useMemo(() => {
    if (!report) return null;
    const other = matching === "fifo" ? report.comparison.min_cgt : report.comparison.fifo;
    const otherLabel = matching === "fifo" ? "Minimize CGT" : "FIFO";
    const delta = other.tax - report.tax;
    return { other, otherLabel, delta };
  }, [report, matching]);

  if (!holding || holding.quantity <= 0) {
    return (
      <Panel title="If you sell">
        <Empty hint="No open position — nothing to sell for a CGT estimate." />
      </Panel>
    );
  }

  return (
    <Panel title="If you sell">
      <p className="mb-4 text-sm text-gray-400">
        Estimate CGT if you sold some or all of {ticker} on the sale date,
        at the last cached price.{" "}
        <strong className="text-gray-300">FIFO</strong> sells the oldest
        parcel first;{" "}
        <strong className="text-gray-300">Minimize CGT</strong> picks
        which parcels to sell to reduce estimated tax (specific
        identification). Confirming records that mix on the ledger — use
        this for a sale you choose yourself (including a manual Betashares
        Direct sell). Auto-rebalance sells imported from a Betashares
        Direct statement stay FIFO on the Tax tab, matching their report.
        The 1 Jul 2027 cutoff is applied by sale date: before it, parcels
        held ≥ 12 months get the 50% discount; from that date, cost is
        CPI-indexed and there is no discount.
      </p>

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-gray-500">
            Units to sell
            {maxQty > 0 ? ` (of ${qty(maxQty)})` : ""}
          </span>
          <div className="flex gap-1">
            <input
              className="field"
              inputMode="decimal"
              placeholder="e.g. 10"
              value={qtyStr}
              onChange={(e) => setQtyStr(e.target.value)}
            />
            <button
              type="button"
              className="shrink-0 rounded-lg border border-gray-600 bg-gray-800 px-2 text-xs text-gray-300 hover:bg-gray-700"
              onClick={() => setQtyStr(String(maxQty))}
            >
              All
            </button>
          </div>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-gray-500">Sale date</span>
          <input
            className="field"
            type="date"
            value={saleDate}
            onChange={(e) => setSaleDate(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-gray-500">Tax profile</span>
          <select
            className="field"
            value={profileId ?? ""}
            onChange={(e) => setProfileId(Number(e.target.value))}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {postCutover && (
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-gray-500">
              CPI indexation % p.a.
            </span>
            <input
              className="field"
              inputMode="decimal"
              value={inflationPct}
              onChange={(e) => setInflationPct(e.target.value)}
            />
          </label>
        )}
      </div>

      <div className="mb-4">
        <span className="mb-1 block text-xs text-gray-500">Parcels</span>
        <div className="flex gap-1 rounded-lg border border-gray-800 bg-gray-950/40 p-1">
          {MATCHING.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMatching(m.id)}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                matching === m.id
                  ? "bg-emerald-500/15 text-emerald-200"
                  : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <p
        className={`mb-4 rounded-lg border px-3 py-2 text-xs ${
          postCutover
            ? "border-amber-900/50 bg-amber-950/30 text-amber-200/90"
            : "border-gray-800 bg-gray-950/40 text-gray-400"
        }`}
      >
        {postCutover ? (
          <>
            Sale is on or after 1 Jul 2027: no 50% CGT discount. Cost base
            is CPI-indexed and tax is max(MTR+Medicare, 30%) of the indexed
            gain. Older parcels get more indexation, which can shrink their
            gain relative to FIFO.
          </>
        ) : (
          <>
            Sale is before 1 Jul 2027: parcels held at least 12 months get
            the 50% CGT discount. Set the sale date to 1 Jul 2027 or later
            to see the post-cutover (indexed, no discount) estimate.
          </>
        )}
      </p>

      {error && (
        <div className="mb-3 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}
      {confirmMsg && (
        <div className="mb-3 rounded-lg border border-emerald-900/50 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-200">
          {confirmMsg}
        </div>
      )}

      {!Number.isFinite(quantity) || quantity <= 0 ? (
        <Empty hint="Enter how many units to sell, or click All. A quantity below the full holding is where FIFO and minimize CGT can differ." />
      ) : null}

      {busy && !report && quantity > 0 && <Empty hint="Estimating…" />}

      {report && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Est. CGT" value={money(report.tax)} emphasize />
            <Stat
              label="Gain / loss"
              value={money(report.capitalGain)}
              down={report.capitalGain < 0}
            />
            <Stat label="Taxable gain" value={money(report.taxableGain)} />
            <Stat label="Proceeds" value={money(report.proceedsAud)} />
          </div>

          {alt && Math.abs(alt.delta) >= 0.005 && (
            <p className="text-xs text-gray-400">
              {alt.delta > 0 ? (
                <>
                  {alt.otherLabel} would cost{" "}
                  <span className="text-gray-200">{money(alt.other.tax)}</span>
                  {" "}(+{money(alt.delta)} more).
                </>
              ) : (
                <>
                  {alt.otherLabel} would cost{" "}
                  <span className="text-gray-200">{money(alt.other.tax)}</span>
                  {" "}({money(-alt.delta)} less).
                </>
              )}
            </p>
          )}
          {alt && Math.abs(alt.delta) < 0.005 && (
            <p className="text-xs text-gray-500">
              {report.unitsHeld > 0 &&
              report.quantitySold >= report.unitsHeld - 1e-9
                ? "Selling the full holding uses every remaining parcel, so FIFO and minimize CGT match. Try a smaller quantity to see them differ."
                : "FIFO and minimize CGT pick the same parcels for this quantity."}
            </p>
          )}

          {report.unmatchedQuantity > 0 && (
            <p className="text-xs text-amber-300/90">
              Only {qty(report.quantitySold)} of {qty(report.quantityRequested)}{" "}
              units match known lots — the rest has no cost base in the ledger.
            </p>
          )}

          {report.parcels.length > 0 && (
            <div className="max-h-[320px] overflow-auto rounded-lg border border-gray-800">
              <p className="sticky top-0 z-10 mb-0 bg-gray-900 px-2 py-1.5 text-xs font-medium text-gray-400">
                Parcels that would be sold
              </p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="py-1 pr-3">Acquired</th>
                    <th className="py-1 pr-3 text-right">Qty</th>
                    <th className="py-1 pr-3 text-right">Cost base</th>
                    <th className="py-1 pr-3 text-right">Proceeds</th>
                    <th className="py-1 pr-3 text-right">Gain/loss</th>
                    <th className="py-1 pr-3">Term</th>
                    <th className="py-1 pr-3">Regime</th>
                  </tr>
                </thead>
                <tbody>
                  {report.parcels.map((p, i) => (
                    <tr
                      key={`${p.acquiredDate}-${i}`}
                      className="border-t border-gray-900"
                    >
                      <td className="py-1 pr-3 text-gray-200">{p.acquiredDate}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">
                        {qty(p.quantity)}
                      </td>
                      <td className="py-1 pr-3 text-right tabular-nums">
                        {money(p.costBaseAud)}
                      </td>
                      <td className="py-1 pr-3 text-right tabular-nums">
                        {money(p.proceedsAud)}
                      </td>
                      <td
                        className={`py-1 pr-3 text-right tabular-nums ${
                          p.capitalGain < 0 ? "text-red-300" : ""
                        }`}
                      >
                        {money(p.capitalGain)}
                      </td>
                      <td className="py-1 pr-3 text-gray-400">
                        {p.longTerm ? "Long" : "Short"}
                      </td>
                      <td className="py-1 pr-3 text-gray-400">
                        {cgtLineRegimeLabel(p.appliedRegime, p.longTerm)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {report.parcels.length > 0 && report.parcels.every((p) => p.acquireTxId != null) && (
            <div className="rounded-lg border border-gray-800 bg-gray-950/40 p-3">
              <p className="mb-2 text-xs text-gray-400">
                Record this as a sell in the ledger, with the parcels above
                stored so later tax estimates use this identification (not
                a fresh FIFO guess). You still place the trade with your
                broker — this only writes Risu's books.
              </p>
              {filters.portfolioId == null && (
                <label className="mb-2 block text-sm">
                  <span className="mb-1 block text-xs text-gray-500">
                    Portfolio to record against
                  </span>
                  <select
                    className="field"
                    value={confirmPortfolioId}
                    onChange={(e) =>
                      setConfirmPortfolioId(
                        e.target.value ? Number(e.target.value) : "",
                      )
                    }
                  >
                    <option value="">Select portfolio…</option>
                    {portfolios.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                type="button"
                disabled={
                  confirming ||
                  busy ||
                  confirmPortfolioId === "" ||
                  report.quantitySold <= 0
                }
                onClick={() => void onConfirmSale()}
                className="rounded-lg border border-emerald-700/60 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-200 hover:bg-emerald-900/40 disabled:opacity-40"
              >
                {confirming
                  ? "Recording…"
                  : `Confirm ${matching === "min_cgt" ? "minimize CGT" : "FIFO"} sale of ${qty(report.quantitySold)} ${ticker}`}
              </button>
            </div>
          )}

          {report.openLots.length > 0 && (
            <details className="text-xs text-gray-500">
              <summary className="cursor-pointer text-gray-400 hover:text-gray-200">
                All open parcels ({report.openLots.length})
              </summary>
              <table className="mt-2 w-full">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="py-1 pr-3">Acquired</th>
                    <th className="py-1 pr-3 text-right">Qty held</th>
                    <th className="py-1 pr-3 text-right">Unit cost</th>
                    <th className="py-1 pr-3 text-right">Cost base</th>
                  </tr>
                </thead>
                <tbody>
                  {report.openLots.map((l, i) => (
                    <tr
                      key={`${l.acquiredDate}-${i}`}
                      className="border-t border-gray-900"
                    >
                      <td className="py-1 pr-3 text-gray-300">{l.acquiredDate}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">
                        {qty(l.quantity)}
                      </td>
                      <td className="py-1 pr-3 text-right tabular-nums">
                        {money(l.unitCostAud)}
                      </td>
                      <td className="py-1 pr-3 text-right tabular-nums">
                        {money(l.costBaseAud)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </div>
      )}

      <div className="mt-4">
        <Disclaimer />
      </div>

      <style>{`
        .field {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid #374151;
          background-color: #111827;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          color: #f3f4f6;
        }
      `}</style>
    </Panel>
  );
}

function Stat({
  label,
  value,
  emphasize,
  down,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
  down?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div
        className={`text-sm font-medium tabular-nums ${
          emphasize
            ? "text-gray-50"
            : down
              ? "text-red-300"
              : "text-gray-100"
        }`}
      >
        {emphasize ? (
          <span className="rounded-md bg-gray-800 px-2 py-1">{value}</span>
        ) : (
          value
        )}
      </div>
    </div>
  );
}
