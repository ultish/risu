/**
 * TaxEstimatePanel — roughly how much tax is owed for a financial year:
 * dividend income tax + realised CGT on actual sells, using per-parcel
 * cost base (FIFO or minimise-CGT matching) so each disposal's own
 * acquisition date decides which CGT regime (pre/post 1 Jul 2027) and
 * discount/indexation applies. GET /api/tax/fy-estimate.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import {
  type CgtRegime,
  type FyTaxEstimateDto,
  type LotMatchingMethod,
  type Portfolio,
  type TaxProfileDto,
  fetchFyTaxEstimate,
  fetchTaxProfiles,
} from "./api";
import { Disclaimer } from "./Disclaimer";
import { Empty, Panel, cgtActDetail, cgtLineRegimeLabel, money } from "./App";

/** Current AU financial year label (browser local date) — e.g. "FY2027" for any date in 1 Jul 2026–30 Jun 2027. */
function currentAuFinancialYear(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return `FY${m >= 7 ? y + 1 : y}`;
}

const MATCHING: Array<{ id: LotMatchingMethod; label: string; hint: string }> = [
  {
    id: "fifo",
    label: "Auto (FIFO)",
    hint: "Oldest parcel sold first",
  },
  {
    id: "min_cgt",
    label: "Auto (minimize CGT)",
    hint: "Where you can choose; platform-report brokers stay FIFO",
  },
];

const REGIMES: Array<{ id: CgtRegime; label: string }> = [
  { id: "auto_by_date", label: "Auto — as legislated (sales from 1 Jul 2027 split at 30 Jun 2027)" },
  { id: "discount_50", label: "50% discount (legacy, all disposals) — reference" },
  { id: "indexation_min30", label: "Indexed from purchase, no discount (all disposals) — reference" },
];

export function TaxEstimatePanel({
  portfolioId,
  portfolios,
  onPortfolioChange,
}: {
  portfolioId: number | "all";
  portfolios: Portfolio[];
  onPortfolioChange: (id: number | "all") => void;
}) {
  const [profiles, setProfiles] = useState<TaxProfileDto[]>([]);
  const [profileId, setProfileId] = useState<number | undefined>(undefined);
  const [lotMatching, setLotMatching] = useState<LotMatchingMethod>("fifo");
  const [regime, setRegime] = useState<CgtRegime>("auto_by_date");
  const [inflationPct, setInflationPct] = useState("2.5");
  const [report, setReport] = useState<FyTaxEstimateDto | null>(null);
  const [expandedFy, setExpandedFy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentFy = currentAuFinancialYear();

  useEffect(() => {
    void fetchTaxProfiles().then((rows) => {
      setProfiles(rows);
      const def = rows.find((r) => r.isDefault) ?? rows[0];
      if (def) setProfileId(def.id);
    });
  }, []);

  const load = useCallback(async () => {
    if (profileId == null) return;
    setBusy(true);
    setError(null);
    try {
      const inflation = Number(inflationPct);
      const result = await fetchFyTaxEstimate({
        portfolioId: portfolioId === "all" ? null : portfolioId,
        taxProfileId: profileId,
        regime,
        lotMatching,
        inflationRate: Number.isFinite(inflation) ? inflation / 100 : undefined,
      });
      setReport(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [portfolioId, profileId, regime, lotMatching, inflationPct]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Panel title="Tax estimate (FY)">
      <div className="mb-4 flex items-start justify-between gap-4">
        <p className="text-sm text-gray-400">
          Roughly how much tax to set aside for a financial year: dividend
          income tax plus realised capital gains tax on your actual sells.
          Each sold parcel keeps its own acquisition date, so the 1 Jul 2027
          CGT rule change applies per-disposal: a parcel held across it is
          split at its 30 June 2027 value — the gain before keeps the 50%
          discount if held 12 months by the sale, the gain after is indexed
          from 1 July 2027 with a 30% minimum. Losses go against the pre-2027
          gains first, as the Act requires. The 30 June 2027 value comes
          from a saved valuation (Valuations tab) if you have one.{" "}
          <strong className="text-gray-300">Auto (FIFO)</strong> sells oldest
          parcels first;{" "}
          <strong className="text-gray-300">Auto (minimize CGT)</strong>{" "}
          re-identifies parcels on sells you can choose (Stake, CommSec,
          Selfwealth, or a sale you confirmed here).{" "}
          <strong className="text-gray-300">
            Brokers that issue their own CGT report stay FIFO
          </strong>{" "}
          on imported statement sells (default: Betashares Direct, including
          auto-rebalance) — change the list under Settings → Tax. If you
          sell those units yourself and want a different mix, confirm the
          sale on the ticker page. The 50% discount and indexed options
          force one regime on every disposal — kept for reference.{" "}
          <strong className="text-gray-300">Portfolio</strong> picks whose
          stocks to analyse; <strong className="text-gray-300">tax profile</strong>{" "}
          picks whose marginal rate to apply — set them to the same person for
          a meaningful number.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void load()}
          className="shrink-0 rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-xs text-gray-200 hover:bg-gray-700 disabled:opacity-50"
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div className="mb-4">
        <span className="mb-1 block text-xs text-gray-500">Parcels</span>
        <div className="flex flex-wrap gap-1 rounded-lg border border-gray-800 bg-gray-950/40 p-1">
          {MATCHING.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setLotMatching(m.id)}
              className={`flex-1 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                lotMatching === m.id
                  ? "bg-emerald-500/15 text-emerald-200"
                  : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
              }`}
            >
              <span className="block font-medium">{m.label}</span>
              <span className="block text-[11px] text-gray-500">{m.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-4">
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-gray-500">Portfolio</span>
          <select
            className="field"
            value={portfolioId === "all" ? "all" : String(portfolioId)}
            onChange={(e) => {
              const v = e.target.value;
              onPortfolioChange(v === "all" ? "all" : Number(v));
            }}
          >
            <option value="all">All portfolios</option>
            {portfolios.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
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
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-gray-500">CGT regime</span>
          <select
            className="field"
            value={regime}
            onChange={(e) => setRegime(e.target.value as CgtRegime)}
          >
            {REGIMES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        {regime !== "discount_50" && (
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-gray-500">
              CPI indexation % p.a. (post-2027)
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

      {error && (
        <div className="mb-3 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      {busy && !report && <Empty hint="Loading…" />}

      {report && report.byFy.length === 0 && (
        <Empty hint="No dividends or sells found for this filter." />
      )}

      {report && report.byFy.length > 0 && (
        <div className="overflow-x-auto">
          <p className="mb-2 text-xs text-gray-500">
            <strong className="text-gray-300">Est. tax payable</strong> is
            the headline number — dividend tax + CGT tax combined, what you
            might actually need to set aside for that FY.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="py-2 pr-4">FY</th>
                <th className="py-2 pr-4 text-right">Dividend tax</th>
                <th className="py-2 pr-4 text-right">Net gain/loss</th>
                <th className="py-2 pr-4 text-right">Loss carried fwd</th>
                <th className="py-2 pr-4 text-right">CGT tax</th>
                <th className="py-2 pr-4 text-right">Est. tax payable</th>
                <th className="py-2 pr-4 text-right">Detail</th>
              </tr>
            </thead>
            <tbody>
              {report.byFy.map((row) => {
                const lines = report.cgt.lines.filter(
                  (l) => l.financialYear === row.financialYear,
                );
                const divEvents = report.dividendEvents.filter(
                  (e) => e.financialYear === row.financialYear,
                );
                const fyCgt = report.cgt.fyTotals.find(
                  (t) => t.financialYear === row.financialYear,
                );
                const detailCount = lines.length + divEvents.length;
                const isOpen = expandedFy === row.financialYear;
                const isCurrentFy = row.financialYear === currentFy;
                return (
                  <Fragment key={row.financialYear}>
                    <tr
                      className={`border-b border-gray-900 hover:bg-gray-900/40 ${
                        isCurrentFy ? "bg-sky-500/5" : ""
                      }`}
                    >
                      <td className="py-2 pr-4 font-medium text-gray-100">
                        {row.financialYear}
                        {isCurrentFy && (
                          <span className="ml-2 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[10px] font-normal uppercase tracking-wide text-sky-300">
                            Current
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right">
                        {money(row.dividendNetTax)}
                      </td>
                      <td
                        className={`py-2 pr-4 text-right ${
                          row.netCapitalGain < 0 ? "text-red-300" : ""
                        }`}
                      >
                        {money(row.netCapitalGain)}
                      </td>
                      <td className="py-2 pr-4 text-right">
                        {row.lossCarriedForward > 0 ? (
                          <div>
                            <span className="text-amber-300/90">
                              {money(row.lossCarriedForward)}
                            </span>
                            {fyCgt && fyCgt.lossCarriedIn - fyCgt.priorLossApplied > 0 && (
                              <div className="text-[10px] text-gray-500">
                                {money(fyCgt.netCapitalLoss)} +{" "}
                                {money(fyCgt.lossCarriedIn - fyCgt.priorLossApplied)}{" "}
                                prior
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-600">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right">
                        {money(row.cgtTax)}
                      </td>
                      <td className="py-2 pr-4 text-right">
                        <span className="rounded-md bg-gray-800 px-2 py-1 font-semibold text-gray-50">
                          {money(row.totalTax)}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-right">
                        {detailCount > 0 ? (
                          <button
                            type="button"
                            className="text-xs text-emerald-300 underline"
                            onClick={() =>
                              setExpandedFy(isOpen ? null : row.financialYear)
                            }
                          >
                            {detailCount} {isOpen ? "▲" : "▼"}
                          </button>
                        ) : (
                          <span className="text-xs text-gray-600">0</span>
                        )}
                      </td>
                    </tr>
                    {isOpen && detailCount > 0 && (
                      <tr>
                        <td colSpan={7} className="bg-gray-950/40 p-3">
                          {divEvents.length > 0 && (
                            <>
                              <p className="mb-1 text-xs font-medium text-gray-400">
                                Dividend income — where the {money(row.dividendNetTax)}{" "}
                                dividend tax above comes from
                              </p>
                              <table className="mb-3 w-full text-xs">
                                <thead>
                                  <tr className="text-left text-gray-500">
                                    <th className="py-1 pr-3">Ticker</th>
                                    <th className="py-1 pr-3">Date</th>
                                    <th className="py-1 pr-3">Type</th>
                                    <th className="py-1 pr-3 text-right">Amount (AUD)</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {divEvents.map((e, i) => (
                                    <tr
                                      key={`${e.ticker}-${e.date}-${i}`}
                                      className="border-t border-gray-900"
                                    >
                                      <td className="py-1 pr-3 font-medium text-gray-200">
                                        {e.ticker}
                                      </td>
                                      <td className="py-1 pr-3 text-gray-400">{e.date}</td>
                                      <td className="py-1 pr-3 text-gray-400">
                                        {e.source === "cash" ? "Cash" : "DRP"}
                                      </td>
                                      <td className="py-1 pr-3 text-right">
                                        {e.amountAud != null ? money(e.amountAud) : "—"}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </>
                          )}
                          {fyCgt && fyCgt.priorLossApplied > 0 && (
                            <p className="mb-1 text-xs text-emerald-300/90">
                              Applied {money(fyCgt.priorLossApplied)} of an earlier
                              FY's unused capital loss to reduce this year's CGT tax.
                            </p>
                          )}
                          {fyCgt && fyCgt.netCapitalLoss > 0 && (
                            <p className="mb-1 text-xs text-amber-300/90">
                              Net capital loss this FY: {money(fyCgt.netCapitalLoss)} — $0 tax.
                            </p>
                          )}
                          {fyCgt && fyCgt.lossCarriedOut > 0 && (
                            <p className="mb-2 text-xs text-amber-300/90">
                              {money(fyCgt.lossCarriedOut)} carried forward, available
                              to offset a capital gain in a future FY.
                            </p>
                          )}
                          {lines.length > 0 && (
                          <>
                          <p className="mb-1 text-xs font-medium text-gray-400">
                            Capital gains — where the net gain/loss above comes from
                          </p>
                          <p className="mb-2 text-xs text-gray-500">
                            Gains and losses below net together into the FY
                            total above — a per-line "tax" figure would be
                            misleading, since a loss on one parcel offsets a
                            gain on another sold the same year.
                          </p>
                          {(fyCgt?.minimumTaxGain ?? 0) > 0 && (
                            <p className="mb-2 text-xs text-gray-500">
                              {money(fyCgt?.minimumTaxGain)} of this year&apos;s
                              gains accrued after 1 Jul 2027 and is taxed at no
                              less than 30%.
                            </p>
                          )}
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-left text-gray-500">
                                <th className="py-1 pr-3">Ticker</th>
                                <th className="py-1 pr-3">Acquired</th>
                                <th className="py-1 pr-3">Disposed</th>
                                <th className="py-1 pr-3 text-right">Qty</th>
                                <th className="py-1 pr-3 text-right">Proceeds</th>
                                <th className="py-1 pr-3 text-right">Cost base</th>
                                <th className="py-1 pr-3 text-right">Gain/loss</th>
                                <th className="py-1 pr-3">Term</th>
                                <th className="py-1 pr-3">Parcels</th>
                                <th className="py-1 pr-3">Regime</th>
                              </tr>
                            </thead>
                            <tbody>
                              {lines.map((l, i) => (
                                <tr
                                  key={`${l.ticker}-${l.acquiredDate}-${l.disposedDate}-${i}`}
                                  className="border-t border-gray-900"
                                >
                                  <td className="py-1 pr-3 font-medium text-gray-200">
                                    {l.ticker}
                                  </td>
                                  <td className="py-1 pr-3 text-gray-400">
                                    {l.acquiredDate}
                                  </td>
                                  <td className="py-1 pr-3 text-gray-400">
                                    {l.disposedDate}
                                  </td>
                                  <td className="py-1 pr-3 text-right">
                                    {l.quantity}
                                  </td>
                                  <td className="py-1 pr-3 text-right">
                                    {money(l.proceedsAud)}
                                  </td>
                                  <td className="py-1 pr-3 text-right">
                                    {money(l.costBaseAud)}
                                  </td>
                                  <td
                                    className={`py-1 pr-3 text-right ${
                                      l.capitalGain < 0 ? "text-red-300" : ""
                                    }`}
                                  >
                                    {money(l.capitalGain)}
                                  </td>
                                  <td className="py-1 pr-3 text-gray-400">
                                    {l.longTerm ? "Long" : "Short"}
                                  </td>
                                  <td className="py-1 pr-3 text-gray-400">
                                    {l.parcelMatch === "recorded"
                                      ? "Recorded"
                                      : l.parcelMatch === "min_cgt"
                                        ? "Min CGT"
                                        : "FIFO"}
                                  </td>
                                  <td className="py-1 pr-3 text-gray-400">
                                    {cgtLineRegimeLabel(l.appliedRegime, l.longTerm, l.act)}
                                    {cgtActDetail(l.act) && (
                                      <span className="block text-[11px] text-gray-500">
                                        {cgtActDetail(l.act)}
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          </>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 rounded-lg border border-gray-800 bg-gray-950/30 p-3 text-xs text-gray-500">
        <p className="mb-1 font-medium text-gray-400">How this is estimated</p>
        <ul className="list-inside list-disc space-y-1">
          <li>
            Capital gains use per-parcel cost base (not average cost) so
            discount eligibility and indexation use each parcel's real
            acquisition date.{" "}
            {lotMatching === "min_cgt"
              ? "Sells you can identify yourself use minimize-CGT parcel picking. Imported sells from brokers marked in Settings as issuing their own CGT report stay FIFO. A sale confirmed on the ticker page uses the parcels you recorded."
              : "Sells consume the oldest remaining parcel first (FIFO), except sales you confirmed with a specific parcel mix."}
          </li>
          <li>
            <strong className="text-gray-400">Gains and losses net within the FY</strong>{" "}
            before tax is calculated — a loss on one parcel offsets a gain on
            another sold the same year (losses are applied to non-discount-eligible
            gains first, the order most favourable to you). A net loss for
            the year means $0 CGT tax, not a negative one.
          </li>
          <li>
            <strong className="text-gray-400">Unused losses carry forward across FYs</strong>{" "}
            — a net capital loss reduces a later FY's net gain (oldest FY
            first), the same short-term-first order as within-FY netting. A
            loss can only ever offset a capital gain, never dividend/other
            income, and it carries forward regardless of the pre/post
            2027 regime change.
          </li>
          <li>
            Dividend tax assumes 70% ASX franking / 15% US withholding when
            not otherwise known (adjustable via the API; not yet exposed in
            this panel).
          </li>
          <li>
            Estimate only — not a tax return. Excludes salary/other income
            and non-portfolio deductions.
          </li>
        </ul>
      </div>

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
