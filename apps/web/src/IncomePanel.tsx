/**
 * IncomePanel — FY cash-dividend summary + US withholding / tax estimates
 * (Phase 2 + Phase 3).
 *
 * Wire-up in App.tsx (do not gut App — add tab only):
 *
 *   import { IncomePanel } from "./IncomePanel";
 *
 *   // extend tab union:
 *   const [tab, setTab] = useState<
 *     | "holdings" | "transactions" | "import" | "paste"
 *     | "manual" | "portfolios" | "income" | "drp"
 *   >("holdings");
 *
 *   // nav button list — add: ["income", "Income"]
 *
 *   {tab === "income" && (
 *     <IncomePanel
 *       portfolioId={portfolioId === "all" ? undefined : portfolioId}
 *       broker={brokerFilter || undefined}
 *       source={sourceFilter || undefined}
 *     />
 *   )}
 *
 * Uses GET /api/income and GET /api/settings/tax-profiles.
 * Tax / withholding math mirrors packages/core (web has no @yields/core dep).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchIncome,
  fetchTaxProfiles,
  type IncomeLine,
  type IncomeSummary,
  type TaxProfileDto,
} from "./api";

// ─── Thin client copies of @yields/core tax helpers ─────────────────────────

const COMPANY_TAX_RATE = 0.3;
const DEFAULT_US_WITHHOLDING_PCT = 15;
const DEFAULT_ASX_FRANKING_PCT = 70;

type TaxProfileLite = {
  label: string;
  marginalRate: number;
  medicareLevy: number;
};

function combinedMtr(p: TaxProfileLite) {
  return p.marginalRate + p.medicareLevy;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function isForeignDividendLine(exchange: string, currency: string) {
  return (
    (exchange || "").toUpperCase() !== "ASX" &&
    (currency || "").toUpperCase() !== "AUD"
  );
}

function isAsxDividendLine(exchange: string) {
  return (exchange || "").toUpperCase() === "ASX";
}

/** Rate as decimal 0–1. ledgerIsNet grosses up; otherwise withholds from gross. */
function applyForeignWithholding(
  cashAud: number,
  withholdingRate: number,
  ledgerIsNet = false,
): { gross: number; withheld: number; netCash: number; rate: number } {
  const cash = Math.max(0, cashAud);
  const rate = clamp(withholdingRate, 0, 0.99);
  if (cash === 0 || rate === 0) {
    return { gross: round2(cash), withheld: 0, netCash: round2(cash), rate };
  }
  if (ledgerIsNet) {
    const gross = cash / (1 - rate);
    return {
      gross: round2(gross),
      withheld: round2(gross - cash),
      netCash: round2(cash),
      rate,
    };
  }
  const withheld = cash * rate;
  return {
    gross: round2(cash),
    withheld: round2(withheld),
    netCash: round2(cash - withheld),
    rate,
  };
}

function estimateDividendTax(
  cashAud: number,
  frankingPercent: number,
  profile: TaxProfileLite,
) {
  const cash = Math.max(0, cashAud);
  const frankingPct = clamp(frankingPercent, 0, 100);
  let frankingCredits = 0;
  if (frankingPct > 0) {
    frankingCredits = round2(
      cash * (frankingPct / 100) * (COMPANY_TAX_RATE / (1 - COMPANY_TAX_RATE)),
    );
  }
  const assessableIncome = round2(cash + frankingCredits);
  const grossTax = round2(assessableIncome * combinedMtr(profile));
  const netTax = round2(grossTax - frankingCredits);
  return {
    cashAud: round2(cash),
    frankingCredits,
    assessableIncome,
    grossTax,
    netTax,
  };
}

type FyTaxRow = {
  financialYear: string;
  cashAud: number;
  assessableCashAud: number;
  frankingCredits: number;
  assessableIncome: number;
  grossTax: number;
  netTax: number;
  withheldEstimate: number;
};

function estimateFyDividendTax(
  lines: IncomeLine[],
  opts: {
    profile: TaxProfileLite;
    asxFrankingPercent: number;
    usWithholdingRate: number;
    ledgerIsNetOfWithholding: boolean;
  },
): { byFy: FyTaxRow[]; totals: FyTaxRow } {
  type Acc = {
    financialYear: string;
    cashAud: number;
    assessableCashAud: number;
    frankingCredits: number;
    withheldEstimate: number;
  };
  const fyMap = new Map<string, Acc>();

  for (const line of lines) {
    if (line.amountAud == null || !Number.isFinite(line.amountAud)) continue;
    const ledger = Math.max(0, line.amountAud);
    if (ledger === 0) continue;

    const acc = fyMap.get(line.financialYear) ?? {
      financialYear: line.financialYear,
      cashAud: 0,
      assessableCashAud: 0,
      frankingCredits: 0,
      withheldEstimate: 0,
    };
    acc.cashAud += ledger;

    if (isForeignDividendLine(line.exchange, line.currency)) {
      const wh = applyForeignWithholding(
        ledger,
        opts.usWithholdingRate,
        opts.ledgerIsNetOfWithholding,
      );
      acc.assessableCashAud += wh.gross;
      acc.withheldEstimate += wh.withheld;
    } else {
      const frankingPct = isAsxDividendLine(line.exchange)
        ? opts.asxFrankingPercent
        : 0;
      const tax = estimateDividendTax(ledger, frankingPct, opts.profile);
      acc.assessableCashAud += tax.cashAud;
      acc.frankingCredits += tax.frankingCredits;
    }
    fyMap.set(line.financialYear, acc);
  }

  const byFy: FyTaxRow[] = [...fyMap.values()]
    .map((acc) => {
      const cashAud = round2(acc.cashAud);
      const assessableCashAud = round2(acc.assessableCashAud);
      const frankingCredits = round2(acc.frankingCredits);
      const assessableIncome = round2(assessableCashAud + frankingCredits);
      const grossTax = round2(assessableIncome * combinedMtr(opts.profile));
      const netTax = round2(grossTax - frankingCredits);
      return {
        financialYear: acc.financialYear,
        cashAud,
        assessableCashAud,
        frankingCredits,
        assessableIncome,
        grossTax,
        netTax,
        withheldEstimate: round2(acc.withheldEstimate),
      };
    })
    .sort((a, b) => b.financialYear.localeCompare(a.financialYear));

  const totals: FyTaxRow = {
    financialYear: "TOTAL",
    cashAud: 0,
    assessableCashAud: 0,
    frankingCredits: 0,
    assessableIncome: 0,
    grossTax: 0,
    netTax: 0,
    withheldEstimate: 0,
  };
  for (const row of byFy) {
    totals.cashAud += row.cashAud;
    totals.assessableCashAud += row.assessableCashAud;
    totals.frankingCredits += row.frankingCredits;
    totals.assessableIncome += row.assessableIncome;
    totals.grossTax += row.grossTax;
    totals.netTax += row.netTax;
    totals.withheldEstimate += row.withheldEstimate;
  }
  totals.cashAud = round2(totals.cashAud);
  totals.assessableCashAud = round2(totals.assessableCashAud);
  totals.frankingCredits = round2(totals.frankingCredits);
  totals.assessableIncome = round2(totals.assessableIncome);
  totals.grossTax = round2(totals.grossTax);
  totals.netTax = round2(totals.netTax);
  totals.withheldEstimate = round2(totals.withheldEstimate);

  return { byFy, totals };
}

// ─── UI helpers ─────────────────────────────────────────────────────────────

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

export type IncomePanelProps = {
  portfolioId?: number;
  broker?: string;
  source?: string;
};

export function IncomePanel({ portfolioId, broker, source }: IncomePanelProps) {
  const [data, setData] = useState<IncomeSummary | null>(null);
  const [profiles, setProfiles] = useState<TaxProfileDto[]>([]);
  const [profileId, setProfileId] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Assumed US withholding % (default 15% AU–US treaty / W-8BEN). */
  const [usWithholdingPct, setUsWithholdingPct] = useState(
    DEFAULT_US_WITHHOLDING_PCT,
  );
  /**
   * When true (default), imported foreign cash is treated as already net of
   * withholding — we gross up for display / assessable income.
   */
  const [ledgerIsNet, setLedgerIsNet] = useState(true);
  /** Global ASX franking assumption 0–100 (default 70). */
  const [asxFrankingPct, setAsxFrankingPct] = useState(
    DEFAULT_ASX_FRANKING_PCT,
  );

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [summary, taxProfiles] = await Promise.all([
        fetchIncome({ portfolioId, broker, source }),
        fetchTaxProfiles(),
      ]);
      setData(summary);
      setProfiles(taxProfiles);
      setProfileId((prev) => {
        if (prev !== "" && taxProfiles.some((p) => p.id === prev)) return prev;
        const def = taxProfiles.find((p) => p.isDefault) ?? taxProfiles[0];
        return def?.id ?? "";
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [portfolioId, broker, source]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedProfile: TaxProfileLite | null = useMemo(() => {
    if (profileId === "") return null;
    const p = profiles.find((x) => x.id === profileId);
    if (!p) return null;
    return {
      label: p.label,
      marginalRate: p.marginalRate,
      medicareLevy: p.medicareLevy,
    };
  }, [profileId, profiles]);

  const whRate = clamp(usWithholdingPct, 0, 99) / 100;

  const enrichedLines = useMemo(() => {
    if (!data) return [];
    return data.byFy.map((row) => {
      const foreign = isForeignDividendLine(row.exchange, row.currency);
      if (!foreign || row.amountAud == null) {
        return {
          ...row,
          foreign: false,
          estGrossAud: row.amountAud,
          estWithheldAud: null as number | null,
          estNetAud: row.amountAud,
        };
      }
      const wh = applyForeignWithholding(row.amountAud, whRate, ledgerIsNet);
      return {
        ...row,
        foreign: true,
        estGrossAud: wh.gross,
        estWithheldAud: wh.withheld,
        estNetAud: wh.netCash,
      };
    });
  }, [data, whRate, ledgerIsNet]);

  const taxEstimate = useMemo(() => {
    if (!data || !selectedProfile) return null;
    return estimateFyDividendTax(data.byFy, {
      profile: selectedProfile,
      asxFrankingPercent: clamp(asxFrankingPct, 0, 100),
      usWithholdingRate: whRate,
      ledgerIsNetOfWithholding: ledgerIsNet,
    });
  }, [data, selectedProfile, asxFrankingPct, whRate, ledgerIsNet]);

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900/40 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-medium text-gray-100">
            Cash dividend income
          </h2>
          <p className="text-xs text-gray-500">
            Australian FY (1 Jul – 30 Jun) from ledger{" "}
            <code className="text-gray-400">dividend_cash</code> rows. Foreign
            amounts convert to AUD when FX is cached (refresh Yahoo prices).
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void load()}
          className="rounded-lg border border-gray-600 bg-gray-800 px-3 py-1.5 text-sm hover:bg-gray-700 disabled:opacity-50"
        >
          {busy ? "Loading…" : "Reload"}
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      {/* Assumptions */}
      <div className="mb-4 rounded-lg border border-gray-800 bg-gray-950/40 p-3">
        <h3 className="mb-2 text-sm font-medium text-gray-300">
          Assumptions (estimates only)
        </h3>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Assumed US withholding %
            <input
              type="number"
              min={0}
              max={99}
              step={0.5}
              value={usWithholdingPct}
              onChange={(e) =>
                setUsWithholdingPct(Number(e.target.value) || 0)
              }
              className="w-28 rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            ASX franking % (default)
            <input
              type="number"
              min={0}
              max={100}
              step={5}
              value={asxFrankingPct}
              onChange={(e) =>
                setAsxFrankingPct(Number(e.target.value) || 0)
              }
              className="w-28 rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Tax profile
            <select
              value={profileId === "" ? "" : String(profileId)}
              onChange={(e) =>
                setProfileId(
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
              className="min-w-[10rem] rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-100"
            >
              {profiles.length === 0 && (
                <option value="">No profiles — set Tax settings</option>
              )}
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.isDefault ? " (default)" : ""} ·{" "}
                  {((p.marginalRate + p.medicareLevy) * 100).toFixed(0)}%
                </option>
              ))}
            </select>
          </label>
          <label className="flex max-w-md cursor-pointer items-start gap-2 text-xs text-gray-300">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={ledgerIsNet}
              onChange={(e) => setLedgerIsNet(e.target.checked)}
            />
            <span>
              Imported US / foreign dividends are already{" "}
              <strong className="font-medium text-gray-200">net</strong> of
              withholding (typical broker credit). Uncheck to treat ledger as
              gross and estimate withheld separately.
            </span>
          </label>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-gray-500">
          Withholding is a simple % model (default 15% AU–US treaty after
          W-8BEN) — not the ATO foreign income tax offset engine. Franking
          applies to ASX lines only; foreign franking is 0. Ledger cash may
          already be net of US withholding.
        </p>
      </div>

      {data && (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2">
              <p className="text-xs text-gray-500">Grand total ledger (AUD)</p>
              <p className="text-xl font-semibold text-emerald-300">
                {money(data.grandTotalAud)}
              </p>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2">
              <p className="text-xs text-gray-500">Dividend rows</p>
              <p className="text-xl font-semibold">
                {data.byFy.reduce((s, r) => s + r.count, 0)}
              </p>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2">
              <p className="text-xs text-gray-500">Est. franking credits</p>
              <p className="text-xl font-semibold text-sky-300">
                {taxEstimate ? money(taxEstimate.totals.frankingCredits) : "—"}
              </p>
            </div>
            <div className="rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2">
              <p className="text-xs text-gray-500">Est. net tax (all FY)</p>
              <p
                className={`text-xl font-semibold ${
                  taxEstimate && taxEstimate.totals.netTax < 0
                    ? "text-emerald-300"
                    : "text-amber-200"
                }`}
              >
                {taxEstimate ? money(taxEstimate.totals.netTax) : "—"}
              </p>
            </div>
          </div>

          {data.missingFx.length > 0 && (
            <p className="mb-3 text-xs text-amber-300/90">
              Missing FX for: {data.missingFx.join(", ")}. Run “Refresh Yahoo
              prices + FX” for AUD conversion.
            </p>
          )}

          <h3 className="mb-2 text-sm font-medium text-gray-300">
            By financial year
          </h3>
          {data.fyTotals.length === 0 ? (
            <p className="text-sm text-gray-500">
              No <code className="text-gray-400">dividend_cash</code>{" "}
              transactions yet. Import broker files that include cash dividends,
              or add them manually.
            </p>
          ) : (
            <div className="mb-6 max-h-48 overflow-auto rounded-lg border border-gray-800">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-gray-900 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">FY</th>
                    <th className="px-3 py-2 font-medium">Rows</th>
                    <th className="px-3 py-2 font-medium">Total AUD</th>
                  </tr>
                </thead>
                <tbody>
                  {data.fyTotals.map((row) => (
                    <tr
                      key={row.financialYear}
                      className="border-t border-gray-800/80"
                    >
                      <td className="px-3 py-2 font-medium text-emerald-300">
                        {row.financialYear}
                      </td>
                      <td className="px-3 py-2">{row.count}</td>
                      <td className="px-3 py-2">{money(row.amountAud)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* FY tax estimate */}
          <h3 className="mb-2 text-sm font-medium text-gray-300">
            FY tax estimate
          </h3>
          {!selectedProfile ? (
            <p className="mb-6 text-sm text-gray-500">
              Add a tax profile under Tax settings to see estimated net tax on
              dividends.
            </p>
          ) : taxEstimate && taxEstimate.byFy.length === 0 ? (
            <p className="mb-6 text-sm text-gray-500">
              No AUD-convertible dividend lines for tax estimate.
            </p>
          ) : taxEstimate ? (
            <div className="mb-6 max-h-64 overflow-auto rounded-lg border border-gray-800">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="sticky top-0 z-10 bg-gray-900 text-xs uppercase tracking-wide text-gray-500 shadow">
                  <tr>
                    <th className="px-3 py-2 font-medium">FY</th>
                    <th className="px-3 py-2 font-medium">Ledger cash</th>
                    <th className="px-3 py-2 font-medium">Assessable cash</th>
                    <th className="px-3 py-2 font-medium">Est. franking</th>
                    <th className="px-3 py-2 font-medium">Est. withheld</th>
                    <th className="px-3 py-2 font-medium">Est. net tax</th>
                  </tr>
                </thead>
                <tbody>
                  {taxEstimate.byFy.map((row) => (
                    <tr
                      key={row.financialYear}
                      className="border-t border-gray-800/80"
                    >
                      <td className="px-3 py-2 font-medium text-emerald-300">
                        {row.financialYear}
                      </td>
                      <td className="px-3 py-2">{money(row.cashAud)}</td>
                      <td className="px-3 py-2">
                        {money(row.assessableCashAud)}
                      </td>
                      <td className="px-3 py-2 text-sky-300/90">
                        {money(row.frankingCredits)}
                      </td>
                      <td className="px-3 py-2 text-gray-400">
                        {row.withheldEstimate > 0
                          ? money(row.withheldEstimate)
                          : "—"}
                      </td>
                      <td
                        className={`px-3 py-2 font-medium ${
                          row.netTax < 0 ? "text-emerald-300" : "text-amber-200"
                        }`}
                      >
                        {money(row.netTax)}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-gray-700 bg-gray-950/60 font-medium">
                    <td className="px-3 py-2 text-gray-300">All FY</td>
                    <td className="px-3 py-2">
                      {money(taxEstimate.totals.cashAud)}
                    </td>
                    <td className="px-3 py-2">
                      {money(taxEstimate.totals.assessableCashAud)}
                    </td>
                    <td className="px-3 py-2 text-sky-300/90">
                      {money(taxEstimate.totals.frankingCredits)}
                    </td>
                    <td className="px-3 py-2 text-gray-400">
                      {taxEstimate.totals.withheldEstimate > 0
                        ? money(taxEstimate.totals.withheldEstimate)
                        : "—"}
                    </td>
                    <td
                      className={`px-3 py-2 ${
                        taxEstimate.totals.netTax < 0
                          ? "text-emerald-300"
                          : "text-amber-200"
                      }`}
                    >
                      {money(taxEstimate.totals.netTax)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : null}

          <p className="mb-4 text-[11px] leading-relaxed text-amber-200/70">
            Estimates only — not financial or tax advice. Not ATO software.
            Foreign withholding and franking are simplified assumptions; foreign
            income tax offsets (FITO) are not modelled. You remain responsible
            for your own tax returns.
          </p>

          <h3 className="mb-2 text-sm font-medium text-gray-300">
            By FY · market · currency
          </h3>
          {enrichedLines.length === 0 ? (
            <p className="text-sm text-gray-500">No breakdown rows.</p>
          ) : (
            <div className="max-h-[360px] overflow-auto rounded-lg border border-gray-800">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="sticky top-0 z-10 bg-gray-900 text-xs uppercase tracking-wide text-gray-500 shadow">
                  <tr>
                    <th className="px-3 py-2.5 font-medium">FY</th>
                    <th className="px-3 py-2.5 font-medium">Mkt</th>
                    <th className="px-3 py-2.5 font-medium">Ccy</th>
                    <th className="px-3 py-2.5 font-medium">Rows</th>
                    <th className="px-3 py-2.5 font-medium">Native</th>
                    <th className="px-3 py-2.5 font-medium">Ledger AUD</th>
                    <th className="px-3 py-2.5 font-medium">Est. gross</th>
                    <th className="px-3 py-2.5 font-medium">Est. withheld</th>
                  </tr>
                </thead>
                <tbody>
                  {enrichedLines.map((row) => (
                    <tr
                      key={`${row.financialYear}|${row.exchange}|${row.currency}`}
                      className="border-t border-gray-800/80 hover:bg-gray-800/40"
                    >
                      <td className="px-3 py-2">{row.financialYear}</td>
                      <td className="px-3 py-2">
                        <span className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-300">
                          {row.exchange}
                        </span>
                        {row.foreign && (
                          <span className="ml-1 text-[10px] uppercase text-amber-400/80">
                            FX
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-400">{row.currency}</td>
                      <td className="px-3 py-2">{row.count}</td>
                      <td className="px-3 py-2">
                        {money(row.amount, row.currency)}
                      </td>
                      <td className="px-3 py-2 text-emerald-300/90">
                        {money(row.amountAud)}
                      </td>
                      <td className="px-3 py-2 text-gray-300">
                        {row.foreign ? money(row.estGrossAud) : "—"}
                      </td>
                      <td className="px-3 py-2 text-gray-400">
                        {row.foreign && row.estWithheldAud != null
                          ? money(row.estWithheldAud)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
