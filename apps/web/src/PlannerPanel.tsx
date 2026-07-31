/**
 * PlannerPanel — define ticker portfolios (growth / dividend / hybrid),
 * tweak assumed yield/growth/MER, run comparison.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchHoldings,
  fetchInstrumentAssumptions,
  fetchPlannerTemplates,
  fetchTaxProfiles,
  runPlanner,
  type AllocationReport,
  type AssetAssumption,
  type CgtRegime,
  type ExitStrategy,
  type ScenarioAllocation,
  type ScenarioReport,
  type TaxProfileDto,
} from "./api";
import { Disclaimer } from "./Disclaimer";

function money(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  });
}

/** Format a percentage; show + for gains. */
function pct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

/** "$12,345  ·  +23.4%" — omit % when null. */
function moneyPct(
  aud: number | null | undefined,
  percent: number | null | undefined,
  digits = 1,
): string {
  const m = money(aud);
  if (percent == null || !Number.isFinite(percent)) return m;
  return `${m}  ·  ${pct(percent, digits)}`;
}

/**
 * Derive % metrics from an allocation report for the UI.
 * CAGR is a simple compound on total capital in → ending economic wealth after tax
 * (not a true money-weighted IRR when contributions are lumpy).
 */
function allocPctMetrics(
  a: AllocationReport,
  horizonYears: number,
): {
  capitalIn: number;
  netGain: number;
  endingAfterTax: number;
  wealthBeforeExitCgt: number;
  totalTax: number;
  /** net gain / capital in */
  netReturnPct: number | null;
  /** simple CAGR of (capitalIn + netGain) / capitalIn */
  approxCagrPct: number | null;
  /** portfolio+cash divs before exit CGT / capital in − 1 */
  wealthGrowthPct: number | null;
  /** total tax / capital in */
  taxOnCapitalPct: number | null;
  /** total tax / (net gain + total tax) when pretax gain > 0 */
  taxTakeOfGainPct: number | null;
  /** portfolio value / capital in */
  portfolioMultiple: number | null;
} {
  const capitalIn = a.totalCapitalIn ?? a.totalContributions ?? 0;
  const netGain =
    a.netGainAfterTax ??
    a.netIfLiquidated +
      a.totalDividendsCash -
      capitalIn -
      a.totalIncomeTax;
  const endingAfterTax = capitalIn + netGain;
  const wealthBeforeExitCgt =
    a.totalWealthBeforeExitCgt ?? a.finalValue + a.totalDividendsCash;
  const totalTax = a.totalIncomeTax + a.totalCgtTax;

  const netReturnPct =
    capitalIn > 0 ? (netGain / capitalIn) * 100 : null;
  const wealthGrowthPct =
    capitalIn > 0 ? (wealthBeforeExitCgt / capitalIn - 1) * 100 : null;
  const taxOnCapitalPct =
    capitalIn > 0 ? (totalTax / capitalIn) * 100 : null;
  const pretaxEconomic = netGain + totalTax;
  const taxTakeOfGainPct =
    pretaxEconomic > 0 ? (totalTax / pretaxEconomic) * 100 : null;
  const portfolioMultiple =
    capitalIn > 0 ? a.finalValue / capitalIn : null;

  let approxCagrPct: number | null = null;
  if (
    capitalIn > 0 &&
    endingAfterTax > 0 &&
    horizonYears > 0 &&
    Number.isFinite(horizonYears)
  ) {
    approxCagrPct =
      (Math.pow(endingAfterTax / capitalIn, 1 / horizonYears) - 1) * 100;
  }

  return {
    capitalIn,
    netGain,
    endingAfterTax,
    wealthBeforeExitCgt,
    totalTax,
    netReturnPct,
    approxCagrPct,
    wealthGrowthPct,
    taxOnCapitalPct,
    taxTakeOfGainPct,
    portfolioMultiple,
  };
}

/** UI stores rates as percent numbers (e.g. 5.5) for easier editing */
type UiAsset = {
  ticker: string;
  weightPct: number;
  growthPct: number;
  yieldPct: number;
  merPct: number;
  frankingPct: number;
  reinvest: boolean;
};

type UiExit = "liquidate" | "hold" | "drawdown";

type UiAllocation = {
  id: string;
  label: string;
  assets: UiAsset[];
  /** Per-strategy exit — growth often sells, dividend often holds */
  exitType: UiExit;
  drawdownPct: number;
};

/** Contribution change: applies from this point until the next keyframe */
type UiKeyframe = {
  id: string;
  /** 1-based plan year */
  year: number;
  /** 1–12; month within year (1 = start of year) */
  monthInYear: number;
  monthlyAud: number;
};

type UiLumpSum = {
  id: string;
  year: number;
  monthInYear: number;
  amountAud: number;
};

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Map UI year/month to engine monthIndex (0 = start of Y1). */
function toMonthIndex(year: number, monthInYear: number): number {
  const y = Math.max(1, Math.floor(year) || 1);
  const m = Math.min(12, Math.max(1, Math.floor(monthInYear) || 1));
  return (y - 1) * 12 + (m - 1);
}

function formatMoneyMo(n: number) {
  return n.toLocaleString("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  });
}

/**
 * Short schedule preview, e.g. “Y1–Y3: $1,000/mo · Y4+: $1,500/mo”
 * First period uses flat monthly from month 0; keyframes override from their monthIndex.
 */
function contributionSchedulePreview(
  flatMonthly: number,
  keyframes: UiKeyframe[],
  horizonYears: number,
): string {
  const totalMonths = Math.max(1, horizonYears) * 12;
  const events = [...keyframes]
    .map((k) => ({
      monthIndex: toMonthIndex(k.year, k.monthInYear),
      monthlyAud: Math.max(0, Number(k.monthlyAud) || 0),
    }))
    .filter((k) => k.monthIndex >= 0 && k.monthIndex < totalMonths)
    .sort((a, b) => a.monthIndex - b.monthIndex);

  type Seg = { start: number; amount: number };
  const segs: Seg[] = [{ start: 0, amount: Math.max(0, flatMonthly) }];
  for (const e of events) {
    const last = segs[segs.length - 1]!;
    if (e.monthIndex === last.start) {
      last.amount = e.monthlyAud;
    } else if (e.monthlyAud !== last.amount) {
      segs.push({ start: e.monthIndex, amount: e.monthlyAud });
    }
  }

  function labelRange(startMonth: number, endMonthExclusive: number): string {
    const startY = Math.floor(startMonth / 12) + 1;
    const startM = (startMonth % 12) + 1;
    const lastMonth = endMonthExclusive - 1;
    const endY = Math.floor(lastMonth / 12) + 1;
    const endM = (lastMonth % 12) + 1;
    const openEnded = endMonthExclusive >= totalMonths;

    const startLabel =
      startM === 1 ? `Y${startY}` : `Y${startY} M${startM}`;
    if (openEnded) {
      if (startMonth === 0 && segs.length === 1) return `Y1–Y${horizonYears}`;
      return `${startLabel}+`;
    }
    const endLabel = endM === 12 ? `Y${endY}` : `Y${endY} M${endM}`;
    if (startLabel === endLabel) return startLabel;
    // Whole-year span: Y1–Y3
    if (startM === 1 && endM === 12) return `Y${startY}–Y${endY}`;
    return `${startLabel}–${endLabel}`;
  }

  return segs
    .map((s, i) => {
      const end =
        i + 1 < segs.length ? segs[i + 1]!.start : totalMonths;
      return `${labelRange(s.start, end)}: ${formatMoneyMo(s.amount)}/mo`;
    })
    .join(" · ");
}

function fromApiAllocation(a: ScenarioAllocation): UiAllocation {
  const exit = a.exit ?? { type: "liquidate" as const };
  return {
    id: a.id,
    label: a.label,
    exitType: exit.type,
    drawdownPct:
      exit.type === "drawdown" ? round1((exit.annualRate || 0.04) * 100) : 4,
    assets: a.assets.map((x) => ({
      ticker: (x.ticker || x.label || "").toUpperCase(),
      weightPct: round1((x.weight || 0) * 100),
      growthPct: round2((x.growthRate || 0) * 100),
      yieldPct: round2((x.yieldRate || 0) * 100),
      merPct: round3((x.mer || 0) * 100),
      frankingPct: x.frankingPercent ?? 0,
      reinvest: x.reinvestDividends !== false,
    })),
  };
}

function toApiAllocation(a: UiAllocation): ScenarioAllocation {
  const assets: AssetAssumption[] = a.assets
    .filter((x) => x.ticker.trim())
    .map((x) => ({
      ticker: x.ticker.trim().toUpperCase(),
      label: x.ticker.trim().toUpperCase(),
      weight: Math.max(0, x.weightPct) / 100,
      growthRate: x.growthPct / 100,
      yieldRate: x.yieldPct / 100,
      mer: x.merPct / 100,
      frankingPercent: x.frankingPct,
      reinvestDividends: x.reinvest,
    }));
  // Renormalise weights if they don't sum to 1
  const sum = assets.reduce((s, x) => s + x.weight, 0);
  if (sum > 0 && Math.abs(sum - 1) > 0.001) {
    for (const x of assets) x.weight = x.weight / sum;
  }
  const exit: ExitStrategy =
    a.exitType === "drawdown"
      ? { type: "drawdown", annualRate: a.drawdownPct / 100 }
      : { type: a.exitType };
  return { id: a.id, label: a.label, assets, exit };
}

function emptyRow(): UiAsset {
  return {
    ticker: "",
    weightPct: 10,
    growthPct: 6,
    yieldPct: 3,
    merPct: 0.2,
    frankingPct: 0,
    reinvest: true,
  };
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}
function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

/** Browser localStorage key — planner draft (inputs only, not results). */
const PLANNER_LS_KEY = "yields.planner.draft.v1";
const SWITCH_LS_KEY = "yields.planner.switch.v1";

type PlannerDraft = {
  v: 1;
  profileId: number | null;
  horizonYears: number;
  monthlyContribution: number;
  initialValue: number;
  cgtRegime: CgtRegime;
  /** Assumed CPI % p.a. for cost-base indexation (post-2027) */
  inflationPct: number;
  compareOldCgt: boolean;
  showContributionPath: boolean;
  keyframes: UiKeyframe[];
  lumpSums: UiLumpSum[];
  allocations: UiAllocation[];
  activeAlloc: number;
  savedAt: string;
};

function loadPlannerDraft(): Partial<PlannerDraft> | null {
  try {
    const raw = localStorage.getItem(PLANNER_LS_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PlannerDraft;
    if (!data || data.v !== 1) return null;
    return data;
  } catch {
    return null;
  }
}

function savePlannerDraft(draft: Omit<PlannerDraft, "v" | "savedAt">) {
  try {
    const payload: PlannerDraft = {
      v: 1,
      ...draft,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(PLANNER_LS_KEY, JSON.stringify(payload));
  } catch {
    /* private mode / quota */
  }
}

function clearPlannerDraft() {
  try {
    localStorage.removeItem(PLANNER_LS_KEY);
  } catch {
    /* ignore */
  }
}

export function PlannerPanel() {
  const draft = useMemo(() => loadPlannerDraft(), []);

  const [profiles, setProfiles] = useState<TaxProfileDto[]>([]);
  const [profileId, setProfileId] = useState<number | null>(
    () => draft?.profileId ?? null,
  );

  const [horizonYears, setHorizonYears] = useState(
    () => draft?.horizonYears ?? 10,
  );
  const [monthlyContribution, setMonthlyContribution] = useState(
    () => draft?.monthlyContribution ?? 1000,
  );
  const [initialValue, setInitialValue] = useState(
    () => draft?.initialValue ?? 50000,
  );
  /** Planner is post–Jul 2027: indexed cost base, no 50% discount, min 30% rate. */
  const [cgtRegime, setCgtRegime] = useState<CgtRegime>(
    () => draft?.cgtRegime ?? "indexation_min30",
  );
  /** Assumed CPI % p.a. for cost-base indexation */
  const [inflationPct, setInflationPct] = useState(
    () => draft?.inflationPct ?? 2.5,
  );
  /** Optional “what if old 50% discount” — off by default */
  const [compareOldCgt, setCompareOldCgt] = useState(
    () => draft?.compareOldCgt ?? false,
  );

  /** Expandable contribution path (keyframes + lump sums) */
  const [showContributionPath, setShowContributionPath] = useState(
    () => draft?.showContributionPath ?? false,
  );
  const [keyframes, setKeyframes] = useState<UiKeyframe[]>(
    () => draft?.keyframes ?? [],
  );
  const [lumpSums, setLumpSums] = useState<UiLumpSum[]>(
    () => draft?.lumpSums ?? [],
  );
  const [seedNote, setSeedNote] = useState<string | null>(null);
  const [seedBusy, setSeedBusy] = useState(false);

  const [allocations, setAllocations] = useState<UiAllocation[]>(
    () => draft?.allocations ?? [],
  );
  const [activeAlloc, setActiveAlloc] = useState(
    () => draft?.activeAlloc ?? 0,
  );
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(
    () => draft?.savedAt ?? null,
  );
  const [hydrated, setHydrated] = useState(false);

  const [report, setReport] = useState<ScenarioReport | null>(null);
  /** Horizon+1 run so switch table can compare both paths at end of year N+1 */
  const [reportPlus1, setReportPlus1] = useState<ScenarioReport | null>(null);
  const [reportOldCgt, setReportOldCgt] = useState<ScenarioReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const schedulePreview = useMemo(
    () =>
      contributionSchedulePreview(
        monthlyContribution,
        keyframes,
        horizonYears,
      ),
    [monthlyContribution, keyframes, horizonYears],
  );

  const load = useCallback(async () => {
    try {
      const [rows, templates] = await Promise.all([
        fetchTaxProfiles(),
        fetchPlannerTemplates(),
      ]);
      setProfiles(rows);
      const saved = loadPlannerDraft();
      // Prefer saved profile if it still exists; else default
      if (saved?.profileId != null && rows.some((r) => r.id === saved.profileId)) {
        setProfileId(saved.profileId);
      } else {
        const def = rows.find((r) => r.isDefault) ?? rows[0];
        if (def) setProfileId(def.id);
      }
      // Only load server templates if we have no saved strategies
      if (templates.length && !(saved?.allocations && saved.allocations.length)) {
        setAllocations(templates.map(fromApiAllocation));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Persist planner inputs (not run results) to localStorage
  useEffect(() => {
    if (!hydrated) return;
    // Debounce slightly so typing doesn't thrash storage
    const t = window.setTimeout(() => {
      savePlannerDraft({
        profileId,
        horizonYears,
        monthlyContribution,
        initialValue,
        cgtRegime,
        inflationPct,
        compareOldCgt,
        showContributionPath,
        keyframes,
        lumpSums,
        allocations,
        activeAlloc,
      });
      setDraftSavedAt(new Date().toISOString());
    }, 300);
    return () => window.clearTimeout(t);
  }, [
    hydrated,
    profileId,
    horizonYears,
    monthlyContribution,
    initialValue,
    cgtRegime,
    inflationPct,
    compareOldCgt,
    showContributionPath,
    keyframes,
    lumpSums,
    allocations,
    activeAlloc,
  ]);

  const selectedProfile =
    profiles.find((p) => p.id === profileId) ?? profiles[0];

  function onResetPlannerDraft() {
    if (
      !window.confirm(
        "Reset planner inputs to defaults? This clears saved strategies, contributions, and amounts from this browser.",
      )
    ) {
      return;
    }
    clearPlannerDraft();
    setHorizonYears(10);
    setMonthlyContribution(1000);
    setInitialValue(50000);
    setCgtRegime("indexation_min30");
    setInflationPct(2.5);
    setCompareOldCgt(false);
    setShowContributionPath(false);
    setKeyframes([]);
    setLumpSums([]);
    setActiveAlloc(0);
    setSeedNote(null);
    setReport(null);
    setReportPlus1(null);
    setReportOldCgt(null);
    setDraftSavedAt(null);
    // Reload templates as fresh allocations
    void (async () => {
      try {
        const templates = await fetchPlannerTemplates();
        if (templates.length) {
          setAllocations(templates.map(fromApiAllocation));
        }
      } catch {
        setAllocations([]);
      }
    })();
  }

  function updateAsset(
    allocIdx: number,
    assetIdx: number,
    patch: Partial<UiAsset>,
  ) {
    setAllocations((prev) =>
      prev.map((a, i) => {
        if (i !== allocIdx) return a;
        const assets = a.assets.map((row, j) =>
          j === assetIdx ? { ...row, ...patch } : row,
        );
        return { ...a, assets };
      }),
    );
  }

  const [fetchingTicker, setFetchingTicker] = useState<string | null>(null);

  /** Fill yield/growth/MER/franking from seed+cache, or live Yahoo if refresh. */
  async function fillInstrument(
    allocIdx: number,
    assetIdx: number,
    opts: { refresh?: boolean } = {},
  ) {
    const row = allocations[allocIdx]?.assets[assetIdx];
    const ticker = row?.ticker?.trim().toUpperCase();
    if (!ticker) {
      setError("Enter a ticker first (e.g. VAS, A200, BGBL)");
      return;
    }
    setFetchingTicker(`${allocIdx}:${assetIdx}`);
    setError(null);
    try {
      const inst = await fetchInstrumentAssumptions(ticker, {
        exchange: "ASX",
        refresh: opts.refresh === true,
      });
      updateAsset(allocIdx, assetIdx, {
        ticker: inst.ticker,
        growthPct: round2(inst.growthRate * 100),
        yieldPct: round2(inst.yieldRate * 100),
        merPct: round3(inst.mer * 100),
        frankingPct: inst.frankingPercent,
      });
      if (inst.error) {
        setError(inst.error);
      } else if (inst.notes?.length) {
        // Soft note via seed line — keep non-blocking
        setSeedNote(
          `${inst.ticker}: ${inst.sources.join(", ")} · yld ${(inst.yieldRate * 100).toFixed(2)}% · mer ${(inst.mer * 100).toFixed(2)}%` +
            (inst.fromCache ? " (cache)" : ""),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetchingTicker(null);
    }
  }

  function addAsset(allocIdx: number) {
    setAllocations((prev) =>
      prev.map((a, i) =>
        i === allocIdx ? { ...a, assets: [...a.assets, emptyRow()] } : a,
      ),
    );
  }

  function removeAsset(allocIdx: number, assetIdx: number) {
    setAllocations((prev) =>
      prev.map((a, i) => {
        if (i !== allocIdx) return a;
        if (a.assets.length <= 1) return a;
        return { ...a, assets: a.assets.filter((_, j) => j !== assetIdx) };
      }),
    );
  }

  function updateAllocLabel(allocIdx: number, label: string) {
    setAllocations((prev) =>
      prev.map((a, i) => (i === allocIdx ? { ...a, label } : a)),
    );
  }

  /** Set reinvest on every sleeve in a strategy (e.g. whole Dividend plan). */
  function setStrategyReinvest(allocIdx: number, reinvest: boolean) {
    setAllocations((prev) =>
      prev.map((a, i) =>
        i === allocIdx
          ? {
              ...a,
              assets: a.assets.map((row) => ({ ...row, reinvest })),
            }
          : a,
      ),
    );
  }

  async function seedFromHoldings() {
    setSeedBusy(true);
    setSeedNote(null);
    setError(null);
    try {
      const data = await fetchHoldings();
      let market = data.totals.marketValueAud;
      let cost = data.totals.costBaseAud;

      if (market == null || !Number.isFinite(market)) {
        let sumMv = 0;
        let any = false;
        for (const h of data.holdings) {
          if (h.marketValueAud != null && Number.isFinite(h.marketValueAud)) {
            sumMv += h.marketValueAud;
            any = true;
          }
        }
        market = any ? sumMv : null;
      }
      if (cost == null || !Number.isFinite(cost)) {
        let sumCb = 0;
        for (const h of data.holdings) {
          if (h.costBaseAud != null && Number.isFinite(h.costBaseAud)) {
            sumCb += h.costBaseAud;
          }
        }
        // holdings costBase is always present as number on row; prefer totals
        cost =
          data.holdings.length > 0
            ? data.holdings.reduce(
                (s, h) => s + (h.costBaseAud ?? h.costBase ?? 0),
                0,
              )
            : sumCb;
      }

      if (market == null || !Number.isFinite(market) || market <= 0) {
        setSeedNote(
          "No market value available from holdings (prices missing or empty portfolio).",
        );
        return;
      }

      const rounded = Math.round(market);
      setInitialValue(rounded);
      // Run always sets initialCostBaseAud = initialValue (new-money model: buy at market)
      setSeedNote(
        `Starting value set to ${money(rounded)} from holdings market value` +
          (cost != null && Number.isFinite(cost)
            ? ` (holdings cost base ~${money(Math.round(cost))} is not used — planner treats this as fresh capital at cost = market for CGT).`
            : " (treated as fresh capital; cost base starts equal to market value)."),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSeedBusy(false);
    }
  }

  async function onRun() {
    if (!selectedProfile) {
      setError("Add a tax profile under Tax settings first");
      return;
    }
    for (const a of allocations) {
      const sum = a.assets.reduce((s, x) => s + (Number(x.weightPct) || 0), 0);
      if (sum <= 0) {
        setError(`${a.label}: add weights that sum above 0`);
        return;
      }
      if (!a.assets.some((x) => x.ticker.trim())) {
        setError(`${a.label}: add at least one ticker`);
        return;
      }
    }

    setBusy(true);
    setError(null);
    setReportOldCgt(null);
    try {
      const totalMonths = Math.max(1, horizonYears) * 12;
      const contributionKeyframes = keyframes
        .map((k) => ({
          monthIndex: toMonthIndex(k.year, k.monthInYear),
          monthlyAud: Math.max(0, Number(k.monthlyAud) || 0),
        }))
        .filter((k) => k.monthIndex >= 0 && k.monthIndex < totalMonths)
        .sort((a, b) => a.monthIndex - b.monthIndex);

      const lumps = lumpSums
        .map((l) => ({
          monthIndex: toMonthIndex(l.year, l.monthInYear),
          amountAud: Math.max(0, Number(l.amountAud) || 0),
        }))
        .filter(
          (l) =>
            l.amountAud > 0 &&
            l.monthIndex >= 0 &&
            l.monthIndex < totalMonths,
        );

      const base = {
        name: "New buys from Jul 2027 — growth vs dividend tax",
        horizonYears,
        // Fresh capital under new rules — cost base starts at contributions/initial
        initialValueAud: initialValue,
        initialCostBaseAud: initialValue,
        inflationRateAnnual: Math.max(0, inflationPct) / 100,
        monthlyContributionAud: monthlyContribution,
        ...(contributionKeyframes.length
          ? { contributionKeyframes }
          : {}),
        ...(lumps.length ? { lumpSums: lumps } : {}),
        taxProfile: {
          label: selectedProfile.label,
          marginalRate: selectedProfile.marginalRate,
          medicareLevy: selectedProfile.medicareLevy,
        },
        // Default only if an allocation omits exit (each strategy has its own)
        exit: { type: "liquidate" as const },
        allocations: allocations.map(toApiAllocation),
      };

      const result = await runPlanner({ ...base, cgtRegime });
      setReport(result);

      // Extra year so switch table can show Path B at end of year (horizon+1)
      const resultPlus1 = await runPlanner({
        ...base,
        horizonYears: horizonYears + 1,
        name: "Horizon+1 for switch year N+1 compare",
        cgtRegime,
      });
      setReportPlus1(resultPlus1);

      if (compareOldCgt && cgtRegime !== "discount_50") {
        const old = await runPlanner({
          ...base,
          name: "Same plans under old 50% CGT discount",
          cgtRegime: "discount_50",
          // Legacy path: no CPI indexation of cost
          inflationRateAnnual: 0,
        });
        setReportOldCgt(old);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const current = allocations[activeAlloc];

  return (
    <section className="rounded-2xl border border-gray-800 bg-gray-900/40 p-5 shadow-xl shadow-black/20">
      <div className="mb-1 flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-lg font-medium text-gray-100">
          Planner · what to buy from Jul 2027 onwards
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {draftSavedAt && (
            <span
              className="rounded-md border border-gray-700 bg-gray-950/50 px-2 py-1 text-gray-500"
              title="Inputs auto-save in this browser (localStorage)"
            >
              Saved locally ·{" "}
              {new Date(draftSavedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
          <button
            type="button"
            onClick={onResetPlannerDraft}
            className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-gray-400 hover:border-gray-500 hover:text-gray-200"
          >
            Reset inputs
          </button>
        </div>
      </div>
      <p className="mb-3 text-sm text-gray-400">
        For <strong className="text-gray-200">new money only under post–Jul
        2027 CGT</strong>: cost base is CPI-indexed; no 50% discount; tax on the
        indexed gain at{" "}
        <strong className="text-gray-200">
          max(your MTR + Medicare, 30%)
        </strong>{" "}
        — so a 0% tax rate still faces a 30% CGT floor. Compare growth vs
        dividend for the same contributions. Inputs auto-save in this browser.
      </p>
      <ul className="mb-4 list-inside list-disc text-xs text-gray-500">
        <li>
          <strong className="text-gray-400">Indexed cost base</strong> — assumed
          inflation lifts cost each month (reduces taxable gain vs nominal).
        </li>
        <li>
          <strong className="text-gray-400">No 50% CGT discount</strong> — rate =
          max(MTR+Medicare, 30%) on the indexed gain.
        </li>
        <li>
          <strong className="text-gray-400">Growth</strong> — more capital gain
          at sale; <strong className="text-gray-400">Dividend</strong> — more
          yearly income tax, often less exit CGT.
        </li>
      </ul>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Tax profile">
          <select
            className="field"
            value={profileId ?? ""}
            onChange={(e) => setProfileId(Number(e.target.value))}
          >
            {profiles.length === 0 && (
              <option value="">No profiles — set Tax settings</option>
            )}
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} ({(p.marginalRate * 100).toFixed(0)}% +{" "}
                {(p.medicareLevy * 100).toFixed(0)}% Med)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Horizon (years)">
          <input
            className="field"
            type="number"
            min={1}
            max={50}
            value={horizonYears}
            onChange={(e) => setHorizonYears(Number(e.target.value) || 1)}
          />
        </Field>
        <Field label="Monthly contribution (AUD)">
          <input
            className="field"
            type="number"
            min={0}
            step={100}
            value={monthlyContribution}
            onChange={(e) =>
              setMonthlyContribution(Number(e.target.value) || 0)
            }
          />
        </Field>
        <div>
          <Field label="Starting value (AUD)">
            <input
              className="field"
              type="number"
              min={0}
              step={1000}
              value={initialValue}
              onChange={(e) => {
                setInitialValue(Number(e.target.value) || 0);
                setSeedNote(null);
              }}
            />
          </Field>
          <button
            type="button"
            disabled={seedBusy}
            onClick={() => void seedFromHoldings()}
            className="mt-1.5 text-xs text-emerald-400/90 hover:text-emerald-300 disabled:opacity-50"
          >
            {seedBusy
              ? "Loading holdings…"
              : "Seed starting value from holdings"}
          </button>
          {seedNote && (
            <p className="mt-1 text-xs text-gray-400">{seedNote}</p>
          )}
        </div>
        <Field label="CGT regime">
          <select
            className="field"
            value={cgtRegime}
            onChange={(e) => setCgtRegime(e.target.value as CgtRegime)}
          >
            <option value="indexation_min30">
              Post–Jul 2027 (indexed cost · max(MTR, 30%) · no 50% discount)
            </option>
            <option value="discount_50">
              Legacy only: old 50% CGT discount (nominal cost)
            </option>
          </select>
        </Field>
        <Field label="Assumed inflation / CPI (% p.a.)">
          <input
            className="field"
            type="number"
            min={0}
            max={15}
            step={0.1}
            value={inflationPct}
            onChange={(e) => setInflationPct(Number(e.target.value) || 0)}
            disabled={cgtRegime === "discount_50"}
          />
          <span className="mt-1 block text-[11px] text-gray-500">
            Indexes cost base under post‑2027 (default 2.5%). Higher inflation →
            higher cost base → lower CGT gain.
          </span>
        </Field>
        <label className="flex items-end gap-2 pb-2 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={compareOldCgt}
            onChange={(e) => setCompareOldCgt(e.target.checked)}
            className="mb-2"
            disabled={cgtRegime === "discount_50"}
          />
          <span>
            Optional: also show <strong>old 50% discount</strong> side-by-side
          </span>
        </label>
      </div>

      {/* Contribution path: keyframes + lump sums */}
      <div className="mb-4 rounded-xl border border-gray-800 bg-gray-950/30">
        <button
          type="button"
          onClick={() => setShowContributionPath((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-gray-200 hover:bg-gray-900/40"
        >
          <span className="font-medium">
            Change contributions over time
            {(keyframes.length > 0 || lumpSums.length > 0) && (
              <span className="ml-2 text-xs font-normal text-emerald-400/80">
                {keyframes.length > 0 &&
                  `${keyframes.length} step${keyframes.length === 1 ? "" : "s"}`}
                {keyframes.length > 0 && lumpSums.length > 0 && " · "}
                {lumpSums.length > 0 &&
                  `${lumpSums.length} lump${lumpSums.length === 1 ? "" : "s"}`}
              </span>
            )}
          </span>
          <span className="text-xs text-gray-500">
            {showContributionPath ? "Hide" : "Show"}
          </span>
        </button>
        {showContributionPath && (
          <div className="border-t border-gray-800 px-4 py-3">
            <p className="mb-3 text-xs text-gray-500">
              Flat monthly amount applies from month 0. Each step below overrides
              from that year (optional month) until the next step. Year 1 =
              first 12 months of the plan.
            </p>

            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
              Contribution steps
            </div>
            {keyframes.length === 0 && (
              <p className="mb-2 text-xs text-gray-500">
                No steps yet — whole horizon uses{" "}
                {formatMoneyMo(monthlyContribution)}/mo.
              </p>
            )}
            <div className="space-y-2">
              {keyframes.map((k) => (
                <div
                  key={k.id}
                  className="flex flex-wrap items-end gap-2 rounded-lg border border-gray-800/80 bg-gray-900/40 p-2"
                >
                  <Field label="From year">
                    <input
                      className="field w-20"
                      type="number"
                      min={1}
                      max={horizonYears}
                      value={k.year}
                      onChange={(e) => {
                        const year = Math.max(1, Number(e.target.value) || 1);
                        setKeyframes((prev) =>
                          prev.map((row) =>
                            row.id === k.id ? { ...row, year } : row,
                          ),
                        );
                      }}
                    />
                  </Field>
                  <Field label="Month (opt.)">
                    <input
                      className="field w-20"
                      type="number"
                      min={1}
                      max={12}
                      value={k.monthInYear}
                      onChange={(e) => {
                        const monthInYear = Math.min(
                          12,
                          Math.max(1, Number(e.target.value) || 1),
                        );
                        setKeyframes((prev) =>
                          prev.map((row) =>
                            row.id === k.id ? { ...row, monthInYear } : row,
                          ),
                        );
                      }}
                    />
                  </Field>
                  <Field label="Monthly AUD">
                    <input
                      className="field w-28"
                      type="number"
                      min={0}
                      step={100}
                      value={k.monthlyAud}
                      onChange={(e) => {
                        const monthlyAud = Number(e.target.value) || 0;
                        setKeyframes((prev) =>
                          prev.map((row) =>
                            row.id === k.id ? { ...row, monthlyAud } : row,
                          ),
                        );
                      }}
                    />
                  </Field>
                  <button
                    type="button"
                    className="mb-0.5 text-xs text-red-400 hover:text-red-300"
                    onClick={() =>
                      setKeyframes((prev) =>
                        prev.filter((row) => row.id !== k.id),
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() =>
                setKeyframes((prev) => [
                  ...prev,
                  {
                    id: newId(),
                    year: Math.min(
                      horizonYears,
                      Math.max(
                        2,
                        (prev[prev.length - 1]?.year ?? 1) + 1,
                      ),
                    ),
                    monthInYear: 1,
                    monthlyAud: monthlyContribution,
                  },
                ])
              }
              className="mt-2 rounded-lg border border-gray-600 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800"
            >
              + Add contribution step
            </button>

            <p className="mt-3 rounded-lg border border-gray-800/60 bg-gray-900/50 px-3 py-2 text-xs text-gray-300">
              <span className="text-gray-500">Schedule · </span>
              {schedulePreview}
            </p>

            <div className="mb-2 mt-4 text-xs font-medium uppercase tracking-wide text-gray-500">
              Lump sums (optional)
            </div>
            {lumpSums.length === 0 && (
              <p className="mb-2 text-xs text-gray-500">
                One-off amounts in a given plan year (e.g. bonus, inheritance).
              </p>
            )}
            <div className="space-y-2">
              {lumpSums.map((l) => (
                <div
                  key={l.id}
                  className="flex flex-wrap items-end gap-2 rounded-lg border border-gray-800/80 bg-gray-900/40 p-2"
                >
                  <Field label="Year">
                    <input
                      className="field w-20"
                      type="number"
                      min={1}
                      max={horizonYears}
                      value={l.year}
                      onChange={(e) => {
                        const year = Math.max(1, Number(e.target.value) || 1);
                        setLumpSums((prev) =>
                          prev.map((row) =>
                            row.id === l.id ? { ...row, year } : row,
                          ),
                        );
                      }}
                    />
                  </Field>
                  <Field label="Month">
                    <input
                      className="field w-20"
                      type="number"
                      min={1}
                      max={12}
                      value={l.monthInYear}
                      onChange={(e) => {
                        const monthInYear = Math.min(
                          12,
                          Math.max(1, Number(e.target.value) || 1),
                        );
                        setLumpSums((prev) =>
                          prev.map((row) =>
                            row.id === l.id ? { ...row, monthInYear } : row,
                          ),
                        );
                      }}
                    />
                  </Field>
                  <Field label="Amount AUD">
                    <input
                      className="field w-28"
                      type="number"
                      min={0}
                      step={1000}
                      value={l.amountAud}
                      onChange={(e) => {
                        const amountAud = Number(e.target.value) || 0;
                        setLumpSums((prev) =>
                          prev.map((row) =>
                            row.id === l.id ? { ...row, amountAud } : row,
                          ),
                        );
                      }}
                    />
                  </Field>
                  <button
                    type="button"
                    className="mb-0.5 text-xs text-red-400 hover:text-red-300"
                    onClick={() =>
                      setLumpSums((prev) =>
                        prev.filter((row) => row.id !== l.id),
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() =>
                setLumpSums((prev) => [
                  ...prev,
                  {
                    id: newId(),
                    year: 1,
                    monthInYear: 1,
                    amountAud: 10000,
                  },
                ])
              }
              className="mt-2 rounded-lg border border-gray-600 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800"
            >
              + Add lump sum
            </button>
          </div>
        )}
      </div>

      {/* Strategy tabs */}
      <div className="mb-3 flex flex-wrap gap-2">
        {allocations.map((a, i) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setActiveAlloc(i)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              i === activeAlloc
                ? "bg-emerald-500/20 text-emerald-300"
                : "bg-gray-800 text-gray-400 hover:text-gray-200"
            }`}
          >
            {a.label}
            <span className="ml-1 text-xs text-gray-500">
              {a.exitType === "hold"
                ? "· hold"
                : a.exitType === "drawdown"
                  ? "· drawdown"
                  : "· sell"}{" "}
              ·{" "}
              {a.assets
                .filter((x) => x.ticker)
                .map((x) => x.ticker)
                .join(" · ") || "empty"}
            </span>
          </button>
        ))}
      </div>

      {current && (
        <div className="mb-4 rounded-xl border border-gray-800 bg-gray-950/40 p-4">
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <Field label="Strategy name">
              <input
                className="field max-w-xs"
                value={current.label}
                onChange={(e) => updateAllocLabel(activeAlloc, e.target.value)}
              />
            </Field>
            <Field label="Exit for this strategy">
              <select
                className="field max-w-[240px]"
                value={current.exitType}
                onChange={(e) => {
                  const exitType = e.target.value as UiExit;
                  setAllocations((prev) =>
                    prev.map((a, i) =>
                      i === activeAlloc ? { ...a, exitType } : a,
                    ),
                  );
                }}
              >
                <option value="liquidate">Sell all at end (CGT applies)</option>
                <option value="hold">Hold (no exit CGT — income path)</option>
                <option value="drawdown">Annual drawdown</option>
              </select>
            </Field>
            {current.exitType === "drawdown" && (
              <Field label="Drawdown % / year">
                <input
                  className="field w-24"
                  type="number"
                  min={0}
                  max={50}
                  step={0.5}
                  value={current.drawdownPct}
                  onChange={(e) => {
                    const drawdownPct = Number(e.target.value) || 0;
                    setAllocations((prev) =>
                      prev.map((a, i) =>
                        i === activeAlloc ? { ...a, drawdownPct } : a,
                      ),
                    );
                  }}
                />
              </Field>
            )}
            <Field label="Dividends">
              <select
                className="field max-w-[220px]"
                value={
                  current.assets.length > 0 &&
                  current.assets.every((x) => x.reinvest)
                    ? "reinvest"
                    : current.assets.length > 0 &&
                        current.assets.every((x) => !x.reinvest)
                      ? "cash"
                      : "mixed"
                }
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "reinvest") setStrategyReinvest(activeAlloc, true);
                  if (v === "cash") setStrategyReinvest(activeAlloc, false);
                }}
              >
                <option value="reinvest">Reinvest all (DRP)</option>
                <option value="cash">Take cash (no reinvest)</option>
                <option value="mixed" disabled>
                  Mixed (set per ticker)
                </option>
              </select>
            </Field>
            <span className="pb-2 text-xs text-gray-500">
              Weights sum:{" "}
              {current.assets
                .reduce((s, x) => s + (Number(x.weightPct) || 0), 0)
                .toFixed(0)}
              % (auto-normalised on run)
            </span>
            <button
              type="button"
              onClick={() => addAsset(activeAlloc)}
              className="mb-0.5 rounded-lg border border-gray-600 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800"
            >
              + Add ticker
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="pb-2 pr-2 font-medium">Ticker</th>
                  <th className="pb-2 pr-2 font-medium">Weight %</th>
                  <th className="pb-2 pr-2 font-medium">Growth % p.a.</th>
                  <th className="pb-2 pr-2 font-medium">Yield % p.a.</th>
                  <th className="pb-2 pr-2 font-medium">MER % p.a.</th>
                  <th className="pb-2 pr-2 font-medium">Franking %</th>
                  <th className="pb-2 pr-2 font-medium" title="Reinvest yield (DRP)">
                    Reinvest
                  </th>
                  <th className="pb-2 pr-2 font-medium">Data</th>
                  <th className="pb-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {current.assets.map((row, j) => (
                  <tr key={j} className="border-t border-gray-800/80">
                    <td className="py-1.5 pr-2">
                      <input
                        className="field w-24 uppercase"
                        value={row.ticker}
                        placeholder="BGBL"
                        onChange={(e) =>
                          updateAsset(activeAlloc, j, {
                            ticker: e.target.value.toUpperCase(),
                          })
                        }
                        onBlur={() => {
                          // Apply seed/cache once when leaving ticker field (no Yahoo)
                          if (row.ticker.trim().length >= 2) {
                            void fillInstrument(activeAlloc, j, {
                              refresh: false,
                            });
                          }
                        }}
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        className="field w-20"
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={row.weightPct}
                        onChange={(e) =>
                          updateAsset(activeAlloc, j, {
                            weightPct: Number(e.target.value) || 0,
                          })
                        }
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        className="field w-20"
                        type="number"
                        step={0.1}
                        value={row.growthPct}
                        onChange={(e) =>
                          updateAsset(activeAlloc, j, {
                            growthPct: Number(e.target.value) || 0,
                          })
                        }
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        className="field w-20"
                        type="number"
                        step={0.1}
                        value={row.yieldPct}
                        onChange={(e) =>
                          updateAsset(activeAlloc, j, {
                            yieldPct: Number(e.target.value) || 0,
                          })
                        }
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        className="field w-20"
                        type="number"
                        step={0.01}
                        value={row.merPct}
                        onChange={(e) =>
                          updateAsset(activeAlloc, j, {
                            merPct: Number(e.target.value) || 0,
                          })
                        }
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        className="field w-20"
                        type="number"
                        min={0}
                        max={100}
                        step={5}
                        value={row.frankingPct}
                        onChange={(e) =>
                          updateAsset(activeAlloc, j, {
                            frankingPct: Number(e.target.value) || 0,
                          })
                        }
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input
                        type="checkbox"
                        checked={row.reinvest}
                        onChange={(e) =>
                          updateAsset(activeAlloc, j, {
                            reinvest: e.target.checked,
                          })
                        }
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <div className="flex flex-col gap-0.5">
                        <button
                          type="button"
                          disabled={
                            busy ||
                            fetchingTicker === `${activeAlloc}:${j}` ||
                            !row.ticker.trim()
                          }
                          className="whitespace-nowrap text-xs text-sky-400 hover:text-sky-300 disabled:opacity-40"
                          title="Apply BetaShares/Vanguard seed or last cached fetch (no Yahoo)"
                          onClick={() =>
                            void fillInstrument(activeAlloc, j, {
                              refresh: false,
                            })
                          }
                        >
                          {fetchingTicker === `${activeAlloc}:${j}`
                            ? "…"
                            : "Seed"}
                        </button>
                        <button
                          type="button"
                          disabled={
                            busy ||
                            fetchingTicker === `${activeAlloc}:${j}` ||
                            !row.ticker.trim()
                          }
                          className="whitespace-nowrap text-xs text-amber-400/90 hover:text-amber-300 disabled:opacity-40"
                          title="Refresh: seed MER + Yahoo trailing yield / hist. growth (manual only)"
                          onClick={() =>
                            void fillInstrument(activeAlloc, j, {
                              refresh: true,
                            })
                          }
                        >
                          Refresh
                        </button>
                      </div>
                    </td>
                    <td className="py-1.5">
                      <button
                        type="button"
                        className="text-xs text-red-400 hover:text-red-300"
                        onClick={() => removeAsset(activeAlloc, j)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            <strong className="text-gray-400">Seed</strong> = BetaShares /
            Vanguard curated defaults or last cache (no network).{" "}
            <strong className="text-gray-400">Refresh</strong> = optional Yahoo
            trailing yield + rough hist. growth (once per click; respects
            cool-down). MER/franking stay from seed. Growth is never an issuer
            forecast — always an assumption. Blur ticker also applies seed.
          </p>
        </div>
      )}

      {/* Summary of all strategies */}
      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        {allocations.map((a) => (
          <div
            key={a.id}
            className="rounded-lg border border-gray-800 bg-gray-950/30 px-3 py-2 text-xs text-gray-400"
          >
            <div className="font-medium text-gray-200">{a.label}</div>
            {a.assets
              .filter((x) => x.ticker)
              .map((x, i) => (
                <div key={i}>
                  {x.ticker} {x.weightPct}% · yld {x.yieldPct}% · gr{" "}
                  {x.growthPct}%
                </div>
              ))}
          </div>
        ))}
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={() => void onRun()}
        className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-gray-950 hover:bg-emerald-400 disabled:opacity-50"
      >
        {busy ? "Running…" : "Run tax comparison"}
      </button>

      {error && (
        <div className="mt-3 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      {report && (
        <div className="mt-6 space-y-6">
          <div>
            <h3 className="mb-1 text-sm font-medium text-gray-200">
              Tax story · sell at end under{" "}
              <span className="text-emerald-300">
                {cgtRegimeLabel(report.cgtRegime)}
              </span>
            </h3>
            <p className="mb-3 text-xs text-gray-500">
              {report.startDate} → {report.endDate} ({report.horizonYears}y) ·
              exit: {report.exit.type}. Compare{" "}
              <strong className="text-gray-400">income tax along the way</strong>{" "}
              vs <strong className="text-gray-400">CGT when you sell</strong>.
              Percentages are vs capital you put in (start + contributions).
            </p>
            <ResultsGlance report={report} />
            <ResultsTable report={report} emphasizeTax />
            <YearByYearPanel report={report} />
          </div>

          <SwitchIncomePanel
            report={report}
            reportPlus1={reportPlus1}
            allocations={allocations}
            taxProfile={selectedProfile}
            monthlyContribution={monthlyContribution}
            inflationPct={inflationPct}
          />

          {reportOldCgt && (
            <div>
              <h3 className="mb-1 text-sm font-medium text-gray-200">
                Same plans · if CGT still used{" "}
                <span className="text-amber-200">old 50% discount</span>
              </h3>
              <p className="mb-3 text-xs text-gray-500">
                Same contributions and returns — only exit CGT rules change.
                Growth usually loses more under the new floor; high-income paths
                change less if gains are small.
              </p>
              <ResultsTable report={reportOldCgt} emphasizeTax />
              <div className="mt-3 overflow-auto rounded-lg border border-amber-900/40 bg-amber-950/20">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-amber-200/70">
                    <tr>
                      <th className="px-3 py-2 font-medium">
                        Extra tax from new CGT (new − old)
                      </th>
                      {report.allocations.map((a) => (
                        <th key={a.allocationId} className="px-3 py-2 font-medium">
                          {a.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-amber-900/30">
                      <td className="px-3 py-2 text-gray-400">
                        Extra exit CGT under new rules
                      </td>
                      {report.allocations.map((a, i) => {
                        const old = reportOldCgt.allocations[i];
                        const delta =
                          (a.exitCgtTax ?? 0) - (old?.exitCgtTax ?? 0);
                        const base = old?.exitCgtTax ?? 0;
                        const deltaPct =
                          base > 0 ? (delta / base) * 100 : null;
                        return (
                          <td
                            key={a.allocationId}
                            className={`px-3 py-2 tabular-nums ${
                              delta > 0 ? "text-red-300" : "text-gray-200"
                            }`}
                          >
                            {moneyPct(delta, deltaPct)}
                          </td>
                        );
                      })}
                    </tr>
                    <tr className="border-t border-amber-900/30">
                      <td className="px-3 py-2 text-gray-400">
                        Net gain after tax (new vs old)
                      </td>
                      {report.allocations.map((a, i) => {
                        const old = reportOldCgt.allocations[i];
                        const nNew =
                          a.netGainAfterTax ??
                          a.netIfLiquidated - a.totalContributions;
                        const nOld =
                          old?.netGainAfterTax ??
                          (old
                            ? old.netIfLiquidated - old.totalContributions
                            : 0);
                        const delta = nNew - nOld;
                        const capitalIn =
                          a.totalCapitalIn ?? a.totalContributions ?? 0;
                        const deltaPct =
                          capitalIn > 0 ? (delta / capitalIn) * 100 : null;
                        return (
                          <td
                            key={a.allocationId}
                            className={`px-3 py-2 tabular-nums ${
                              delta < 0 ? "text-red-300" : "text-emerald-300"
                            }`}
                          >
                            {moneyPct(delta, deltaPct)}
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-xs text-gray-500">
            <strong className="text-gray-400">Net return %</strong> = net gain
            after tax ÷ capital you put in.{" "}
            <strong className="text-gray-400">Approx. CAGR</strong> compounds
            that ending wealth over the horizon (not a money-weighted IRR when
            contributions vary).{" "}
            <strong className="text-gray-400">Tax take of gain</strong> = total
            tax ÷ (net gain + tax). Post‑2027 CGT: indexed cost base; rate =
            max(MTR+Medicare, 30%) on indexed gain; no 50% discount.
          </p>
        </div>
      )}

      <div className="mt-6">
        <Disclaimer />
      </div>

      <style>{`
        .field {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid #374151;
          background-color: #111827;
          padding: 0.4rem 0.6rem;
          font-size: 0.875rem;
          color: #f3f4f6;
        }
        select.field {
          /* Match left pad (0.6rem) for chevron inset; keep room for icon */
          background-position: right 0.6rem center;
        }
      `}</style>
    </section>
  );
}

function cgtRegimeLabel(r: string) {
  if (r === "indexation_min30")
    return "post–Jul 2027 (indexed cost · max(MTR, 30%))";
  if (r === "discount_50") return "legacy old 50% CGT discount";
  if (r === "auto_by_date") return "auto by sale date";
  return r;
}

/** Company tax rate for franking gross-up (matches packages/core). */
const COMPANY_TAX = 0.3;

/**
 * Rough dividend tax on cash yield — same simplified model as the planner engine.
 * Net tax can be negative when franking exceeds tax (refundable credits).
 */
function estimateDivTaxRough(
  cashAud: number,
  frankingPercent: number,
  marginalRate: number,
  medicareLevy: number,
): { grossTax: number; frankingCredits: number; netTax: number } {
  if (cashAud <= 0) {
    return { grossTax: 0, frankingCredits: 0, netTax: 0 };
  }
  const frank = Math.min(100, Math.max(0, frankingPercent)) / 100;
  const frankingCredits =
    frank > 0 ? cashAud * frank * (COMPANY_TAX / (1 - COMPANY_TAX)) : 0;
  const assessable = cashAud + frankingCredits;
  const rate = marginalRate + medicareLevy;
  const grossTax = assessable * rate;
  return {
    grossTax,
    frankingCredits,
    netTax: grossTax - frankingCredits,
  };
}

/**
 * One year (12 months) of the planner engine on a fixed pile — same growth /
 * yield / MER / DRP / contribution rules as packages/core planner.
 * Used for switch Path A year (horizon+1) after redeploy.
 */
function simulateOneYearOnPile(input: {
  startValue: number;
  startCostBase: number;
  assets: UiAsset[];
  monthlyContribution: number;
  marginalRate: number;
  medicareLevy: number;
  inflationAnnual?: number;
}): {
  endValue: number;
  endCostBase: number;
  dividendsCash: number;
  dividendsReinvested: number;
  incomeTax: number;
  fees: number;
  contributions: number;
} {
  const rows = input.assets.filter((a) => a.ticker.trim());
  const weightSum =
    rows.reduce((s, a) => s + Math.max(0, a.weightPct), 0) || 1;
  const sleeves = rows.map((a) => {
    const w = Math.max(0, a.weightPct) / weightSum;
    return {
      weight: w,
      growth: Math.max(0, a.growthPct) / 100 / 12,
      yield: Math.max(0, a.yieldPct) / 100 / 12,
      mer: Math.max(0, a.merPct) / 100 / 12,
      franking: a.frankingPct,
      reinvest: a.reinvest,
      value: input.startValue * w,
      costBase: input.startCostBase * w,
    };
  });
  if (!sleeves.length) {
    return {
      endValue: input.startValue,
      endCostBase: input.startCostBase,
      dividendsCash: 0,
      dividendsReinvested: 0,
      incomeTax: 0,
      fees: 0,
      contributions: 0,
    };
  }

  const infM = Math.max(0, input.inflationAnnual ?? 0) / 12;
  let dividendsCash = 0;
  let dividendsReinvested = 0;
  let incomeTax = 0;
  let fees = 0;
  let contributions = 0;
  const contrib = Math.max(0, input.monthlyContribution);

  for (let m = 0; m < 12; m++) {
    if (infM > 0) {
      for (const s of sleeves) s.costBase *= 1 + infM;
    }
    if (contrib > 0) {
      contributions += contrib;
      for (const s of sleeves) {
        const add = contrib * s.weight;
        s.value += add;
        s.costBase += add;
      }
    }
    for (const s of sleeves) {
      s.value *= 1 + s.growth;
      const div = s.value * s.yield;
      if (div > 0) {
        const tax = estimateDivTaxRough(
          div,
          s.franking,
          input.marginalRate,
          input.medicareLevy,
        );
        incomeTax += tax.netTax;
        if (s.reinvest) {
          s.value += div;
          s.costBase += div;
          dividendsReinvested += div;
        } else {
          dividendsCash += div;
        }
      }
      const fee = s.value * s.mer;
      s.value = Math.max(0, s.value - fee);
      fees += fee;
    }
  }

  const endValue = sleeves.reduce((s, x) => s + x.value, 0);
  const endCostBase = sleeves.reduce((s, x) => s + x.costBase, 0);
  return {
    endValue,
    endCostBase,
    dividendsCash,
    dividendsReinvested,
    incomeTax,
    fees,
    contributions,
  };
}

/**
 * Net cash available after selling phase‑1 to fund the switch.
 *
 * - **Sell all at end** on the strategy: main sim already applied exit CGT.
 *   Reuse that hit once — do not tax again. Redeploy = netIfLiquidated.
 * - **Hold / drawdown**: main sim did not sell. Estimate CGT on the paper
 *   capital gain so switch still models “sell then buy phase‑2”.
 */
function switchSaleProceeds(
  source: AllocationReport,
  report: ScenarioReport,
  taxProfile?: TaxProfileDto | null,
): {
  capitalGain: number;
  cgtTax: number;
  netProceeds: number;
  /** true = CGT from main sim (exit was liquidate); false = estimated for hold */
  cgtAlreadyInMainSim: boolean;
} {
  const portfolio = source.finalValue ?? 0;
  const capitalGain = Math.max(0, source.exitCapitalGain ?? 0);

  // Main sim already sold at end — one tax hit only
  if (source.exit?.type === "liquidate") {
    const cgtTax = source.exitCgtTax ?? 0;
    return {
      capitalGain,
      cgtTax,
      netProceeds: Math.max(
        0,
        source.netIfLiquidated ?? portfolio - cgtTax,
      ),
      cgtAlreadyInMainSim: true,
    };
  }

  // Hold / drawdown: no exit sale in main sim — estimate CGT for the switch sale.
  // exitCapitalGain from engine is already on indexed cost under post-2027.
  const mtr =
    (taxProfile?.marginalRate ?? report.taxProfile?.marginalRate ?? 0.37) +
    (taxProfile?.medicareLevy ?? report.taxProfile?.medicareLevy ?? 0.02);
  const regime = report.cgtRegime ?? "indexation_min30";
  // Post-2027: max(MTR, 30%). Legacy discount_50: half rate.
  const estimatedRate =
    regime === "discount_50" ? mtr * 0.5 : Math.max(mtr, 0.3);
  const cgtTax = Math.round(capitalGain * estimatedRate * 100) / 100;
  return {
    capitalGain,
    cgtTax,
    netProceeds: Math.max(0, portfolio - cgtTax),
    cgtAlreadyInMainSim: false,
  };
}

/**
 * Switch compare: both paths at **end of year (horizon+1)**.
 * A: Growth (or source) for N years → sell → Dividend for year N+1 (engine-style sim).
 * B: Always Dividend for N+1 years (from reportPlus1).
 */
function SwitchIncomePanel({
  report,
  reportPlus1,
  allocations,
  taxProfile,
  monthlyContribution,
  inflationPct,
}: {
  report: ScenarioReport;
  reportPlus1: ScenarioReport | null;
  allocations: UiAllocation[];
  taxProfile?: TaxProfileDto | null;
  monthlyContribution: number;
  inflationPct: number;
}) {
  const yearN = report.horizonYears;
  const yearN1 = yearN + 1;

  const byId = (id: string) =>
    report.allocations.find((a) => a.allocationId === id) ??
    report.allocations[0];

  const prefer = (ids: string[]) => {
    for (const id of ids) {
      const hit = report.allocations.find(
        (a) =>
          a.allocationId === id ||
          a.label.toLowerCase().includes(id.toLowerCase()),
      );
      if (hit) return hit.allocationId;
    }
    return report.allocations[0]?.allocationId ?? "";
  };

  const switchDraft = useMemo(() => {
    try {
      const raw = localStorage.getItem(SWITCH_LS_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as {
        sourceId?: string;
        targetId?: string;
        includeCashDivs?: boolean;
      };
    } catch {
      return null;
    }
  }, []);

  const [sourceId, setSourceId] = useState(() => {
    if (
      switchDraft?.sourceId &&
      report.allocations.some((a) => a.allocationId === switchDraft.sourceId)
    ) {
      return switchDraft.sourceId;
    }
    return prefer(["growth", "Growth"]);
  });
  // Default phase 2 = Dividend (full high-yield income), not Hybrid
  const [targetId, setTargetId] = useState(() => {
    if (
      switchDraft?.targetId &&
      report.allocations.some((a) => a.allocationId === switchDraft.targetId)
    ) {
      return switchDraft.targetId;
    }
    return prefer(["dividend", "Dividend", "hybrid", "Hybrid"]);
  });
  const [includeCashDivs, setIncludeCashDivs] = useState(
    () => switchDraft?.includeCashDivs ?? false,
  );

  // Keep defaults sensible when report strategies change
  useEffect(() => {
    const ids = new Set(report.allocations.map((a) => a.allocationId));
    if (!ids.has(sourceId)) setSourceId(prefer(["growth", "Growth"]));
    if (!ids.has(targetId))
      setTargetId(prefer(["dividend", "Dividend", "hybrid", "Hybrid"]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-sync when report changes
  }, [report]);

  // Persist switch choices
  useEffect(() => {
    try {
      localStorage.setItem(
        SWITCH_LS_KEY,
        JSON.stringify({ sourceId, targetId, includeCashDivs }),
      );
    } catch {
      /* ignore */
    }
  }, [sourceId, targetId, includeCashDivs]);

  const source = byId(sourceId);
  const targetReport = byId(targetId);
  const targetUi =
    allocations.find(
      (a) => a.id === targetId || a.label === targetReport?.label,
    ) ?? allocations.find((a) => a.id === targetReport?.allocationId);

  if (!source || !targetReport || !targetUi) {
    return null;
  }

  // Sale at end of year N (from N-year report)
  const sale = switchSaleProceeds(source, report, taxProfile);
  const portfolioGross = source.finalValue ?? 0;
  const cgtOnSwitch = sale.cgtTax;
  const portfolioAfterCgt = sale.netProceeds;
  const cashDivs = source.totalDividendsCash ?? 0;
  const redeploy =
    portfolioAfterCgt + (includeCashDivs ? cashDivs : 0);

  const mtr = taxProfile?.marginalRate ?? 0.37;
  const med = taxProfile?.medicareLevy ?? 0.02;

  // Path A year N+1: full monthly sim on redeployed capital (same engine rules)
  const pathA = simulateOneYearOnPile({
    startValue: redeploy,
    startCostBase: redeploy,
    assets: targetUi.assets,
    monthlyContribution,
    marginalRate: mtr,
    medicareLevy: med,
    inflationAnnual:
      report.cgtRegime === "indexation_min30"
        ? Math.max(0, inflationPct) / 100
        : 0,
  });

  const aCash = pathA.dividendsCash;
  const aDrp = pathA.dividendsReinvested;
  const aYield = aCash + aDrp;
  const aTax = pathA.incomeTax;
  const aNetCash = aCash - Math.max(0, aTax * (aCash > 0 && aDrp <= 0 ? 1 : aCash / (aYield || 1)));
  // Economic yield after tax: total yield − full income tax (cash + DRP)
  const aEconomic = aYield - aTax;
  const aEndCapital = pathA.endValue;
  const allDrpAfterSwitch = aCash <= 0 && aDrp > 0;

  // Path B: always in target (dividend) for N+1 years — year N+1 row from plus1 report
  const dividendStrategy =
    (reportPlus1 ?? report).allocations.find(
      (a) =>
        a.allocationId === targetId ||
        a.allocationId === "dividend" ||
        a.label.toLowerCase().includes("dividend") ||
        a.label === targetReport.label,
    ) ?? null;
  const bYearRow =
    dividendStrategy?.years.find((y) => y.year === yearN1) ??
    dividendStrategy?.years[dividendStrategy.years.length - 1] ??
    null;
  const bCash = bYearRow?.dividendsCash ?? 0;
  const bDrp = bYearRow?.dividendsReinvested ?? 0;
  const bYield = bCash + bDrp;
  const bTax = bYearRow?.incomeTax ?? 0;
  const bEndCapital = dividendStrategy?.finalValue ?? 0;
  const bNetCash = bCash; // cash portion; tax still due on DRP from other money
  const bEconomic = bYield - bTax;
  const allDrpDividendPath = bCash <= 0 && bDrp > 0;
  // For cash-in-hand after tax on cash only (proportional when mixed)
  const aCashInHand =
    aCash <= 0
      ? 0
      : aCash -
        (aYield > 0 ? Math.max(0, aTax) * (aCash / aYield) : 0);
  const bCashInHand =
    bCash <= 0
      ? 0
      : bCash -
        (bYield > 0 ? Math.max(0, bTax) * (bCash / bYield) : 0);
  void aNetCash;
  void bNetCash;

  const strategyHint = (label: string) => {
    const l = label.toLowerCase();
    if (l.includes("dividend")) return "Full income mix (~5.5–6% yield)";
    if (l.includes("hybrid")) return "½ growth + ½ yield (~3.5% total)";
    if (l.includes("growth")) return "High growth, low cash yield";
    return "Your custom mix";
  };

  return (
    <div className="rounded-xl border border-sky-900/50 bg-sky-950/20 p-4">
      <h3 className="mb-1 text-sm font-medium text-sky-100">
        Switch at end · choose strategies
      </h3>
      <p className="mb-4 text-xs text-gray-500">
        Both columns are at the{" "}
        <strong className="text-gray-300">end of year {yearN1}</strong> (same
        calendar year).{" "}
        <strong className="text-sky-200/90">A</strong>: years 1–{yearN} in{" "}
        {source.label} → sell → year {yearN1} in {targetReport.label} (monthly
        sim on post‑CGT capital).{" "}
        <strong className="text-violet-200/90">B</strong>: years 1–{yearN1} always
        in {targetReport.label}. Same stocks/yields/contributions rules for year{" "}
        {yearN1}, so larger capital → more $ yield.
      </p>
      {!reportPlus1 && (
        <p className="mb-3 text-xs text-amber-200/90">
          Re-run the planner to load year {yearN1} for path B (horizon+1 sim).
        </p>
      )}

      {/* Strategy choosers — primary UI */}
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-gray-800 bg-gray-950/40 p-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
            1 · Accumulate in (then sell)
          </div>
          <div className="flex flex-wrap gap-2">
            {report.allocations.map((a) => {
              const on = a.allocationId === sourceId;
              return (
                <button
                  key={`src-${a.allocationId}`}
                  type="button"
                  onClick={() => setSourceId(a.allocationId)}
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                    on
                      ? "border-sky-500 bg-sky-500/20 text-sky-100 ring-1 ring-sky-500/50"
                      : "border-gray-700 bg-gray-900 text-gray-300 hover:border-gray-500"
                  }`}
                >
                  <div className="font-medium">{a.label}</div>
                  <div className="text-[10px] text-gray-500">
                    {strategyHint(a.label)}
                  </div>
                  <div className="mt-0.5 text-[11px] tabular-nums text-gray-400">
                    net {money(a.netIfLiquidated)}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 p-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-emerald-300/80">
            2 · Put all sale cash into
          </div>
          <div className="flex flex-wrap gap-2">
            {report.allocations.map((a) => {
              const on = a.allocationId === targetId;
              return (
                <button
                  key={`tgt-${a.allocationId}`}
                  type="button"
                  onClick={() => setTargetId(a.allocationId)}
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                    on
                      ? "border-emerald-500 bg-emerald-500/20 text-emerald-100 ring-1 ring-emerald-500/50"
                      : "border-gray-700 bg-gray-900 text-gray-300 hover:border-gray-500"
                  }`}
                >
                  <div className="font-medium">{a.label}</div>
                  <div className="text-[10px] text-gray-500">
                    {strategyHint(a.label)}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex cursor-pointer items-start gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            className="mt-1"
            checked={includeCashDivs}
            onChange={(e) => setIncludeCashDivs(e.target.checked)}
          />
          <span>
            Also redeploy phase‑1 cash dividends ({money(cashDivs)})
            <span className="mt-0.5 block text-xs text-gray-500">
              Only if you saved them. Default = portfolio after switch-sale CGT
              only.
            </span>
          </span>
        </label>
      </div>

      <div className="mb-3 rounded-lg border border-sky-800/40 bg-sky-950/30 px-3 py-2.5 text-sm text-sky-100/90">
        <div>
          <strong className="text-sky-100">{source.label}</strong>
          <span className="text-gray-500">
            {" "}
            ({money(portfolioGross)}) → sell → CGT {money(cgtOnSwitch)} → net{" "}
          </span>
          <strong className="text-sky-100">{money(portfolioAfterCgt)}</strong>
          <span className="text-gray-500"> → </span>
          <strong className="text-emerald-200">{targetReport.label}</strong>
        </div>
        <div className="mt-1 text-xs text-gray-400">
          Gain on sale {money(sale.capitalGain)}
          {sale.capitalGain > 0
            ? ` · CGT effective ${(
                (cgtOnSwitch / sale.capitalGain) *
                100
              ).toFixed(0)}% of gain`
            : ""}
          {sale.cgtAlreadyInMainSim
            ? " · CGT already in main sim (Sell all at end) — not taxed twice"
            : " · phase‑1 was Hold/drawdown — CGT estimated here for the switch sale"}
        </div>
        <div className="mt-1 text-xs text-gray-400">
          After sale, year {yearN1} is a full monthly sim of {targetReport.label}{" "}
          (same rules as the main planner — not a simple capital × yield %).
        </div>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={`${source.label} before sale (end yr ${yearN})`}
          value={money(portfolioGross)}
          hint="market value"
        />
        <StatCard
          label="CGT on switch sale"
          value={money(cgtOnSwitch)}
          hint={
            sale.capitalGain > 0
              ? `on ${money(sale.capitalGain)} gain`
              : "no gain"
          }
        />
        <StatCard
          label={`A: start yr ${yearN1} capital (post‑CGT)`}
          value={money(redeploy)}
          hint="new buy into phase 2 · cost base resets"
          emphasize
        />
        <StatCard
          label={`A: end yr ${yearN1} capital`}
          value={money(aEndCapital)}
          hint={`after growth, yield, MER, +${money(pathA.contributions)} contrib`}
          emphasize
        />
      </div>

      {(allDrpAfterSwitch || allDrpDividendPath) && (
        <p className="mb-3 rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-100/90">
          <strong>Cash is $0 because reinvest (DRP) is on</strong> — yield still
          happens, but buys more units. Tax on DRP is still due from other cash.
        </p>
      )}

      {!dividendStrategy && (
        <p className="mb-4 text-xs text-amber-200/80">
          No matching “never switched” strategy in the horizon+1 run — re-run
          planner after setting phase‑2 to Dividend (or Hybrid).
        </p>
      )}

      <div className="mb-4 overflow-auto rounded-lg border border-gray-800">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-gray-900/80 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2 font-medium">Metric · year {yearN1}</th>
              <th className="px-3 py-2 font-medium text-sky-200/90">
                A · Switch at end
                <div className="mt-0.5 max-w-[14rem] text-[10px] font-normal normal-case leading-snug text-gray-500">
                  {source.label} yrs 1–{yearN} → sell → {targetReport.label} yr{" "}
                  {yearN1} (monthly sim)
                </div>
              </th>
              {dividendStrategy && (
                <th className="px-3 py-2 font-medium text-violet-200/90">
                  B · Never switched
                  <div className="mt-0.5 max-w-[14rem] text-[10px] font-normal normal-case leading-snug text-gray-500">
                    {dividendStrategy.label} yrs 1–{yearN1} · year {yearN1} from
                    full sim
                  </div>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-gray-800/80">
              <td className="px-3 py-2 text-gray-400">
                Portfolio capital at <strong>end of year {yearN1}</strong>
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-100">
                {money(aEndCapital)}
                <div className="text-[10px] text-gray-500">
                  started year {yearN1} with {money(redeploy)} after CGT
                </div>
              </td>
              {dividendStrategy && (
                <td className="px-3 py-2 tabular-nums text-violet-100/90">
                  {money(bEndCapital)}
                  <div className="text-[10px] text-gray-500">
                    no sale · still invested
                  </div>
                </td>
              )}
            </tr>
            <tr className="border-t border-gray-800/80 bg-emerald-500/5">
              <td className="px-3 py-2 text-gray-400">
                Cash income during year {yearN1}
              </td>
              <td className="px-3 py-2 tabular-nums font-medium text-emerald-200">
                {money(aCash)}
                {allDrpAfterSwitch && (
                  <div className="text-[10px] font-normal text-amber-200/80">
                    all reinvested — see DRP
                  </div>
                )}
              </td>
              {dividendStrategy && (
                <td className="px-3 py-2 tabular-nums font-medium text-violet-100">
                  {money(bCash)}
                  {allDrpDividendPath && (
                    <div className="text-[10px] font-normal text-amber-200/80">
                      all reinvested — see DRP
                    </div>
                  )}
                </td>
              )}
            </tr>
            <tr className="border-t border-gray-800/80">
              <td className="px-3 py-2 text-gray-400">
                DRP during year {yearN1}
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-100">
                {money(aDrp)}
              </td>
              {dividendStrategy && (
                <td className="px-3 py-2 tabular-nums text-violet-100/90">
                  {money(bDrp)}
                </td>
              )}
            </tr>
            <tr className="border-t border-gray-800/80">
              <td className="px-3 py-2 text-gray-400">
                Total yield during year {yearN1} (cash + DRP)
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-100">
                {money(aYield)}
                {redeploy > 0 && (
                  <div className="text-[10px] text-gray-500">
                    {((aYield / redeploy) * 100).toFixed(2)}% of start‑yr capital
                  </div>
                )}
              </td>
              {dividendStrategy && (
                <td className="px-3 py-2 tabular-nums text-violet-100/90">
                  {money(bYield)}
                </td>
              )}
            </tr>
            <tr className="border-t border-gray-800/80 bg-amber-500/5">
              <td className="px-3 py-2 text-gray-400">
                Est. tax on distributions (year {yearN1})
                {taxProfile
                  ? ` (${(mtr * 100).toFixed(0)}%+${(med * 100).toFixed(0)}% Med)`
                  : ""}
                <div className="text-[10px] text-gray-500 normal-case">
                  DRP is still taxable income
                </div>
              </td>
              <td className="px-3 py-2 tabular-nums text-amber-100">
                {money(aTax)}
              </td>
              {dividendStrategy && (
                <td className="px-3 py-2 tabular-nums text-amber-100/90">
                  {money(bTax)}
                </td>
              )}
            </tr>
            <tr className="border-t border-gray-800/80 bg-emerald-500/5">
              <td className="px-3 py-2 text-gray-400">
                Cash in hand after tax on cash portion
              </td>
              <td className="px-3 py-2 tabular-nums font-medium text-emerald-200">
                {money(aCashInHand)}
                {allDrpAfterSwitch && (
                  <div className="text-[10px] font-normal text-gray-500">
                    $0 cash — DRP tax still due from other money
                  </div>
                )}
              </td>
              {dividendStrategy && (
                <td className="px-3 py-2 tabular-nums font-medium text-violet-100">
                  {money(bCashInHand)}
                  {allDrpDividendPath && (
                    <div className="text-[10px] font-normal text-gray-500">
                      $0 cash — DRP tax still due
                    </div>
                  )}
                </td>
              )}
            </tr>
            <tr className="border-t border-gray-800/80">
              <td className="px-3 py-2 text-gray-400">
                Economic yield after all distribution tax
              </td>
              <td className="px-3 py-2 tabular-nums text-gray-100">
                {money(aEconomic)}
              </td>
              {dividendStrategy && (
                <td className="px-3 py-2 tabular-nums text-violet-100/90">
                  {money(bEconomic)}
                </td>
              )}
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-[11px] leading-relaxed text-gray-500">
        Both columns use year <strong className="text-gray-400">{yearN1}</strong>{" "}
        only. Path A runs the same monthly engine for that year on post‑sale
        capital (growth, yield, MER, contributions, DRP tax). Path B is year{" "}
        {yearN1} of the full {yearN1}y {targetReport.label} sim. Larger end
        capital should produce more $ yield when rules match — re-run after
        changing strategies.
      </p>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  emphasize,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasize?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        emphasize
          ? "border-sky-800/60 bg-sky-950/40"
          : "border-gray-800 bg-gray-900/50"
      }`}
    >
      <div className="text-[11px] text-gray-500">{label}</div>
      <div
        className={`mt-0.5 text-base font-medium tabular-nums ${
          emphasize ? "text-sky-100" : "text-gray-100"
        }`}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-gray-500">{hint}</div>}
    </div>
  );
}

/**
 * Collapsible year-by-year breakdown for each strategy allocation.
 */
function ResultsGlance({ report }: { report: ScenarioReport }) {
  const years = report.horizonYears;
  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {report.allocations.map((a) => {
        const m = allocPctMetrics(a, years);
        return (
          <div
            key={a.allocationId}
            className="rounded-xl border border-gray-800 bg-gray-950/50 px-3 py-3"
          >
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-medium text-emerald-300">{a.label}</p>
              <p className="text-[10px] uppercase tracking-wide text-gray-500">
                {a.exit?.type === "hold"
                  ? "hold"
                  : a.exit?.type === "drawdown"
                    ? "drawdown"
                    : "sell"}
              </p>
            </div>
            <p
              className={`mt-2 text-2xl font-semibold tabular-nums ${
                (m.netReturnPct ?? 0) >= 0
                  ? "text-emerald-300"
                  : "text-red-300"
              }`}
            >
              {pct(m.netReturnPct)}
            </p>
            <p className="text-xs text-gray-500">
              net return on capital · {years}y
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-x-2 gap-y-1.5 text-xs">
              <dt className="text-gray-500">Approx. CAGR</dt>
              <dd className="text-right tabular-nums text-gray-200">
                {pct(m.approxCagrPct)}
              </dd>
              <dt className="text-gray-500">Wealth before exit CGT</dt>
              <dd className="text-right tabular-nums text-gray-200">
                {pct(m.wealthGrowthPct)}
              </dd>
              <dt className="text-gray-500">Tax / capital</dt>
              <dd className="text-right tabular-nums text-amber-100/90">
                {pct(m.taxOnCapitalPct)}
              </dd>
              <dt className="text-gray-500">Tax take of gain</dt>
              <dd className="text-right tabular-nums text-amber-100/90">
                {pct(m.taxTakeOfGainPct)}
              </dd>
              <dt className="text-gray-500">Portfolio multiple</dt>
              <dd className="text-right tabular-nums text-gray-200">
                {m.portfolioMultiple != null
                  ? `${m.portfolioMultiple.toFixed(2)}×`
                  : "—"}
              </dd>
              <dt className="text-gray-500">Net gain $</dt>
              <dd className="text-right tabular-nums text-gray-200">
                {money(m.netGain)}
              </dd>
            </dl>
          </div>
        );
      })}
    </div>
  );
}

function YearByYearPanel({ report }: { report: ScenarioReport }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(0);

  useEffect(() => {
    if (tab >= report.allocations.length) setTab(0);
  }, [report, tab]);

  const alloc: AllocationReport | undefined = report.allocations[tab];
  const years = alloc?.years ?? [];

  return (
    <div className="mt-4 rounded-xl border border-gray-800 bg-gray-950/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-gray-200 hover:bg-gray-900/40"
      >
        <span className="font-medium">Year-by-year</span>
        <span className="text-xs text-gray-500">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="border-t border-gray-800 px-4 py-3">
          <div className="mb-3 flex flex-wrap gap-2">
            {report.allocations.map((a, i) => (
              <button
                key={a.allocationId}
                type="button"
                onClick={() => setTab(i)}
                className={`rounded-lg px-3 py-1.5 text-xs ${
                  i === tab
                    ? "bg-emerald-500/20 text-emerald-300"
                    : "bg-gray-800 text-gray-400 hover:text-gray-200"
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
          {years.length === 0 ? (
            <p className="text-xs text-gray-500">
              No year rows on this report.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="pb-2 pr-2 font-medium">Year</th>
                    <th className="pb-2 pr-2 font-medium">End value</th>
                    <th className="pb-2 pr-2 font-medium">YoY value</th>
                    <th className="pb-2 pr-2 font-medium">Contributions</th>
                    <th className="pb-2 pr-2 font-medium">Cash divs</th>
                    <th className="pb-2 pr-2 font-medium">Reinvested</th>
                    <th className="pb-2 pr-2 font-medium">Fees</th>
                    <th className="pb-2 pr-2 font-medium">Income tax</th>
                    <th className="pb-2 font-medium">CGT</th>
                  </tr>
                </thead>
                <tbody>
                  {years.map((y, i) => {
                    const prev = i > 0 ? years[i - 1]!.endValue : null;
                    const yoyPct =
                      prev != null && prev > 0
                        ? ((y.endValue - prev) / prev) * 100
                        : null;
                    return (
                      <tr
                        key={y.year}
                        className="border-t border-gray-800/80"
                      >
                        <td className="py-1.5 pr-2 tabular-nums text-gray-300">
                          {y.year}
                        </td>
                        <td className="py-1.5 pr-2 tabular-nums text-gray-100">
                          {money(y.endValue)}
                        </td>
                        <td
                          className={`py-1.5 pr-2 tabular-nums ${
                            yoyPct == null
                              ? "text-gray-500"
                              : yoyPct >= 0
                                ? "text-emerald-300/90"
                                : "text-red-300/90"
                          }`}
                        >
                          {yoyPct == null ? "—" : pct(yoyPct)}
                        </td>
                        <td className="py-1.5 pr-2 tabular-nums text-gray-300">
                          {money(y.contributions)}
                        </td>
                        <td className="py-1.5 pr-2 tabular-nums text-gray-300">
                          {money(y.dividendsCash)}
                        </td>
                        <td className="py-1.5 pr-2 tabular-nums text-gray-300">
                          {money(y.dividendsReinvested)}
                        </td>
                        <td className="py-1.5 pr-2 tabular-nums text-gray-400">
                          {money(y.fees)}
                        </td>
                        <td className="py-1.5 pr-2 tabular-nums text-amber-100/90">
                          {money(y.incomeTax)}
                        </td>
                        <td className="py-1.5 tabular-nums text-amber-100/90">
                          {money(y.cgtTax)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs text-gray-500">
            YoY value = change in portfolio end value (includes contributions
            and reinvested divs). CGT here is in-horizon (e.g. drawdown); exit
            CGT is in the summary above.
          </p>
        </div>
      )}
    </div>
  );
}

function ResultsTable({
  report,
  emphasizeTax,
}: {
  report: ScenarioReport;
  emphasizeTax?: boolean;
}) {
  const years = report.horizonYears;
  const metrics = report.allocations.map((a) => allocPctMetrics(a, years));

  return (
    <div className="overflow-auto rounded-lg border border-gray-800">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="bg-gray-900 text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-3 py-2.5 font-medium">Metric</th>
            {report.allocations.map((a) => (
              <th
                key={a.allocationId}
                className="px-3 py-2.5 font-medium text-emerald-300/90"
              >
                {a.label}
                <div className="mt-0.5 text-[10px] font-normal normal-case text-gray-500">
                  {a.exit
                    ? a.exit.type === "hold"
                      ? "exit: hold"
                      : a.exit.type === "drawdown"
                        ? `exit: drawdown ${((a.exit.annualRate || 0) * 100).toFixed(0)}%`
                        : "exit: sell"
                    : ""}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <MetricRow
            label="Capital you put in (start + contributions)"
            values={metrics.map((m) => money(m.capitalIn))}
          />
          <MetricRow
            label="Portfolio value only (before exit CGT)"
            values={metrics.map((m, i) =>
              moneyPct(
                report.allocations[i]!.finalValue,
                m.portfolioMultiple != null
                  ? (m.portfolioMultiple - 1) * 100
                  : null,
              ),
            )}
          />
          <MetricRow
            label="Cash dividends taken out (not in portfolio value)"
            values={report.allocations.map((a) => {
              const cap = a.totalCapitalIn ?? a.totalContributions ?? 0;
              const p =
                cap > 0 ? (a.totalDividendsCash / cap) * 100 : null;
              return moneyPct(a.totalDividendsCash, p);
            })}
          />
          <MetricRow
            label="Total wealth before exit CGT (portfolio + cash divs)"
            values={metrics.map((m) =>
              moneyPct(m.wealthBeforeExitCgt, m.wealthGrowthPct),
            )}
            emphasize
          />
          {emphasizeTax && (
            <>
              <MetricRow
                label="Income tax along the way (divs)"
                values={report.allocations.map((a) => {
                  const cap = a.totalCapitalIn ?? a.totalContributions ?? 0;
                  const p =
                    cap > 0 ? (a.totalIncomeTax / cap) * 100 : null;
                  return moneyPct(a.totalIncomeTax, p);
                })}
                highlight="amber"
              />
              <MetricRow
                label="Capital gain if you sell (value − cost)"
                values={report.allocations.map((a) => {
                  const gain = a.exitCapitalGain ?? 0;
                  const cost =
                    a.finalValue - gain > 0 ? a.finalValue - gain : 0;
                  const p = cost > 0 ? (gain / cost) * 100 : null;
                  return moneyPct(gain, p);
                })}
                highlight="amber"
              />
              <MetricRow
                label="Exit CGT if you sell"
                values={report.allocations.map((a) => {
                  const cgt = a.exitCgtTax ?? a.totalCgtTax;
                  const gain = a.exitCapitalGain ?? 0;
                  const p = gain > 0 ? (cgt / gain) * 100 : null;
                  return moneyPct(cgt, p);
                })}
                highlight="amber"
              />
              <MetricRow
                label="Total tax (income + CGT) · % of capital · tax take of gain"
                values={metrics.map((m) => {
                  const base = moneyPct(m.totalTax, m.taxOnCapitalPct);
                  if (m.taxTakeOfGainPct == null) return base;
                  return `${base}  (${pct(m.taxTakeOfGainPct, 0)} of gain)`;
                })}
                highlight="amber"
              />
            </>
          )}
          <MetricRow
            label="Portfolio cash after exit CGT (excludes cash divs already taken)"
            values={report.allocations.map((a) => {
              const cap = a.totalCapitalIn ?? a.totalContributions ?? 0;
              const p =
                cap > 0 ? (a.netIfLiquidated / cap - 1) * 100 : null;
              return moneyPct(a.netIfLiquidated, p);
            })}
          />
          <MetricRow
            label="Net gain after tax · return on capital · approx. CAGR"
            values={metrics.map((m) => {
              const base = moneyPct(m.netGain, m.netReturnPct);
              if (m.approxCagrPct == null) return base;
              return `${base}  ·  ${pct(m.approxCagrPct)} p.a.`;
            })}
            emphasize
          />
          <MetricRow
            label="Dividends reinvested (already inside portfolio value)"
            values={report.allocations.map((a) => {
              const cap = a.totalCapitalIn ?? a.totalContributions ?? 0;
              const p =
                cap > 0
                  ? (a.totalDividendsReinvested / cap) * 100
                  : null;
              return moneyPct(a.totalDividendsReinvested, p);
            })}
          />
          <MetricRow
            label="Fees"
            values={report.allocations.map((a) => {
              const cap = a.totalCapitalIn ?? a.totalContributions ?? 0;
              const p = cap > 0 ? (a.totalFees / cap) * 100 : null;
              return moneyPct(a.totalFees, p);
            })}
          />
        </tbody>
      </table>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs text-gray-500">{label}</span>
      {children}
    </label>
  );
}

function MetricRow({
  label,
  values,
  emphasize,
  highlight,
}: {
  label: string;
  values: string[];
  emphasize?: boolean;
  highlight?: "amber";
}) {
  return (
    <tr
      className={`border-t border-gray-800/80 ${
        emphasize
          ? "bg-emerald-500/5"
          : highlight === "amber"
            ? "bg-amber-500/5"
            : ""
      }`}
    >
      <td className="px-3 py-2 text-gray-400">{label}</td>
      {values.map((v, i) => (
        <td
          key={i}
          className={`px-3 py-2 tabular-nums ${
            emphasize
              ? "font-medium text-emerald-200"
              : highlight === "amber"
                ? "text-amber-100"
                : "text-gray-100"
          }`}
        >
          {v}
        </td>
      ))}
    </tr>
  );
}
