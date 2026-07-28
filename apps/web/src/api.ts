const BASE = "";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json() as Promise<T>;
}

export type Portfolio = {
  id: number;
  name: string;
  notes: string | null;
  created_at?: string;
};

export type Holding = {
  ticker: string;
  exchange: string;
  currency: string;
  quantity: number;
  avgCost: number;
  costBase: number;
  marketPrice: number | null;
  marketValue: number | null;
  fxRate: number | null;
  costBaseAud: number | null;
  marketValueAud: number | null;
};

export type TxRow = {
  id: number;
  date: string;
  ticker: string;
  exchange: string;
  type: string;
  quantity: number;
  price: number | null;
  amount: number | null;
  brokerage: number;
  currency: string;
  notes: string | null;
  portfolio_id: number | null;
  broker: string | null;
  source: string | null;
  custody: string | null;
};

export type FilterMeta = {
  brokers: string[];
  sources: string[];
  knownBrokers: string[];
  knownSources: string[];
};

export type ImportResult = {
  batchId: number;
  portfolioId: number;
  source: string;
  broker: string | null;
  parsed: number;
  imported: number;
  skipped?: number;
  duplicatesSkipped: number;
  warnings: Array<{ row?: number; message: string; severity?: string }>;
  preview: Array<Record<string, unknown>>;
  layoutId?: string | null;
  confidence?: "high" | "low" | "none" | null;
};

/** A parsed row as returned inline on reconcile (subset of ParsedTransaction fields we render). */
export type ReconcileParsedTx = {
  date: string;
  ticker: string;
  exchange: string;
  type: string;
  quantity: number;
  price: number | null;
  amount: number | null;
  brokerage: number;
  currency: string;
  externalId: string | null;
  notes: string | null;
};

export type ReconcileLedgerRow = {
  id: number;
  date: string;
  ticker: string;
  type: string;
  quantity: number;
  price: number | null;
  external_id: string | null;
};

export type ReconcileConflict = {
  fields: string[];
  file: ReconcileParsedTx;
  ledger: ReconcileLedgerRow;
};

export type ReconcileResult = {
  layoutId: string;
  period: { from: string; to: string } | null;
  matched: number;
  fileOnly: ReconcileParsedTx[];
  ledgerOnly: ReconcileLedgerRow[];
  conflicts: ReconcileConflict[];
  warnings?: Array<{ row?: number; message: string; severity?: string }>;
};

export type Filters = {
  portfolioId?: number;
  broker?: string;
  source?: string;
  ticker?: string;
  exchange?: string;
};

function qs(f: Filters) {
  const p = new URLSearchParams();
  if (f.portfolioId != null) p.set("portfolioId", String(f.portfolioId));
  if (f.broker) p.set("broker", f.broker);
  if (f.source) p.set("source", f.source);
  if (f.ticker) p.set("ticker", f.ticker);
  if (f.exchange) p.set("exchange", f.exchange);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export async function fetchPortfolios() {
  return json<Portfolio[]>(await fetch(`${BASE}/api/portfolios`));
}

export async function createPortfolio(name: string, notes?: string) {
  return json<Portfolio>(
    await fetch(`${BASE}/api/portfolios`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, notes }),
    }),
  );
}

export async function fetchFilterMeta() {
  return json<FilterMeta>(await fetch(`${BASE}/api/meta/filters`));
}

export async function fetchHoldings(f: Filters = {}) {
  return json<{
    holdings: Holding[];
    totals: {
      costBaseAud: number;
      marketValueAud: number | null;
      unrealisedAud: number | null;
      costBase: number;
      marketValue: number | null;
      unrealised: number | null;
    };
    fx: Record<string, number | null>;
  }>(await fetch(`${BASE}/api/holdings${qs(f)}`));
}

export async function fetchTransactions(f: Filters = {}) {
  return json<TxRow[]>(await fetch(`${BASE}/api/transactions${qs(f)}`));
}

export async function createTransaction(body: {
  portfolioId: number;
  date: string;
  ticker: string;
  exchange: string;
  type: string;
  quantity: number;
  price?: number | null;
  amount?: number | null;
  brokerage?: number;
  currency: string;
  notes?: string | null;
  broker?: string;
  source?: string;
}) {
  return json<TxRow>(
    await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function deleteTransaction(id: number) {
  return json<{ ok: boolean }>(
    await fetch(`${BASE}/api/transactions/${id}`, { method: "DELETE" }),
  );
}

export async function deleteTransactions(ids: number[]) {
  return json<{ ok: boolean; deleted: number }>(
    await fetch(`${BASE}/api/transactions/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }),
  );
}

export async function importFile(opts: {
  file: File;
  portfolioId: number;
  parser: string;
  broker?: string;
  source?: string;
}) {
  const fd = new FormData();
  fd.append("file", opts.file);
  fd.append("portfolioId", String(opts.portfolioId));
  fd.append("broker", opts.parser);
  if (opts.broker) fd.append("custody", opts.broker);
  if (opts.source) fd.append("source", opts.source);
  return json<ImportResult>(
    await fetch(`${BASE}/api/import`, { method: "POST", body: fd }),
  );
}

/** Read-only diff of a Stake Investment Activity XLSX vs ledger rows — no writes. */
export async function reconcileFile(opts: {
  file: File;
  portfolioId: number;
  ticker?: string;
  custody?: string;
}) {
  const fd = new FormData();
  fd.append("file", opts.file);
  fd.append("portfolioId", String(opts.portfolioId));
  if (opts.ticker) fd.append("ticker", opts.ticker);
  if (opts.custody) fd.append("custody", opts.custody);
  return json<ReconcileResult>(
    await fetch(`${BASE}/api/import/reconcile`, { method: "POST", body: fd }),
  );
}

export async function importSharesightPaste(opts: {
  portfolioId: number;
  ticker: string;
  exchange: string;
  text: string;
  broker: string;
  source?: string;
}) {
  return json<{
    batchId: number;
    portfolioId: number;
    portfolioName: string;
    broker: string;
    source: string;
    ticker: string;
    parsed: number;
    imported: number;
    duplicatesSkipped: number;
    warnings: Array<{ message: string; severity?: string }>;
  }>(
    await fetch(`${BASE}/api/import/paste`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }),
  );
}

export type YahooStatus = {
  state: "ok" | "cooling" | "disabled";
  blockedUntil: number | null;
  waitSeconds: number;
  lastError: string | null;
  lastUrl: string | null;
  lastOkAt: string | null;
  lastRefreshAt: string | null;
  streak429: number;
  label: string;
  note: string;
};

export async function fetchYahooStatus() {
  return json<YahooStatus>(await fetch(`${BASE}/api/yahoo/status`));
}

export async function clearYahooCooldown() {
  return json<YahooStatus>(
    await fetch(`${BASE}/api/yahoo/clear-cooldown`, { method: "POST" }),
  );
}

export async function refreshPrices(
  opts: { force?: boolean; includeHistory?: boolean } = {},
) {
  const res = await fetch(`${BASE}/api/prices/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      force: opts.force === true,
      // Performance chart needs price_cache daily bars (not quotes alone).
      includeHistory: opts.includeHistory !== false,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    refreshed?: number;
    results?: Array<{
      ticker: string;
      exchange: string;
      price: number | null;
      error?: string;
    }>;
    yahoo?: YahooStatus;
    yahooCircuitOpen?: boolean;
    mode?: string;
    includeHistory?: boolean;
    yahooBrowserUrls?: {
      spark: string | null;
      chart: string | null;
      quote: string | null;
    };
    note?: string;
    error?: string;
  };
  if (!res.ok) {
    const err = new Error(
      data.error || data.note || `Refresh failed (HTTP ${res.status})`,
    ) as Error & { yahoo?: YahooStatus; status?: number };
    err.yahoo = data.yahoo;
    err.status = res.status;
    throw err;
  }
  return {
    refreshed: data.refreshed ?? 0,
    results: data.results ?? [],
    yahoo: data.yahoo,
    yahooCircuitOpen: data.yahooCircuitOpen,
    mode: data.mode,
    includeHistory: data.includeHistory,
    yahooBrowserUrls: data.yahooBrowserUrls,
    note: data.note,
  };
}

/** Paste Yahoo chart/spark/quote JSON from a browser tab into price_cache. */
export async function importYahooPayload(
  payload: unknown,
  symbol?: string,
) {
  return json<{
    ok: boolean;
    kind: string;
    symbols: string[];
    barsWritten: number;
    quotesWritten: number;
    note?: string;
    error?: string;
  }>(
    await fetch(`${BASE}/api/prices/import-yahoo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload, symbol }),
    }),
  );
}

// ─── Phase 2: DRP flags / check ─────────────────────────────────────────────
// FY cash-dividend Income UI removed for now; GET /api/income + core helpers remain.

export type HoldingFlag = {
  portfolioId: number;
  ticker: string;
  exchange: string;
  drpEnabled: boolean;
  drpFromDate: string | null;
};

export type DrpSuggestion = {
  date: string;
  ticker: string;
  exchange: string;
  cashDiv: number;
  expectedShares: number | null;
  unitsHeld: number;
  amountPerShare: number;
  note: string;
};

export type DrpCheckResult = {
  portfolioId: number;
  ticker: string;
  exchange: string;
  drpEnabled: boolean;
  drpFromDate: string | null;
  suggestions: DrpSuggestion[];
  importedDrp: Array<{
    date: string;
    quantity: number;
    amount: number | null;
    price: number | null;
  }>;
  unmatchedSuggestions: DrpSuggestion[];
  notes: string[];
  yahooDividendCount: number;
  yahooError: string | null;
  yahooSource?: "cache" | "yahoo" | "none";
  yahooCacheFresh?: boolean;
};

export async function fetchHoldingFlags(portfolioId: number) {
  return json<{ portfolioId: number; flags: HoldingFlag[] }>(
    await fetch(
      `${BASE}/api/holdings/flags?portfolioId=${encodeURIComponent(String(portfolioId))}`,
    ),
  );
}

export async function putHoldingFlag(body: {
  portfolioId: number;
  ticker: string;
  exchange: string;
  drpEnabled: boolean;
  drpFromDate?: string | null;
}) {
  return json<HoldingFlag>(
    await fetch(`${BASE}/api/holdings/flags`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function fetchDrpCheck(opts: {
  portfolioId: number;
  ticker: string;
  exchange?: string;
}) {
  const p = new URLSearchParams();
  p.set("portfolioId", String(opts.portfolioId));
  p.set("ticker", opts.ticker);
  if (opts.exchange) p.set("exchange", opts.exchange);
  return json<DrpCheckResult>(
    await fetch(`${BASE}/api/drp-check?${p.toString()}`),
  );
}

export type PerformancePoint = {
  date: string;
  costBaseAud: number | null;
  marketValueAud: number | null;
};

export async function fetchPerformance(f: Filters = {}) {
  return json<{
    points: PerformancePoint[];
    filters: {
      portfolioId: number | null;
      broker: string | null;
      source: string | null;
    };
  }>(await fetch(`${BASE}/api/performance${qs(f)}`));
}

/** Relative URL for browser download of filtered ledger CSV */
export function exportTransactionsCsvUrl(f: Filters = {}) {
  return `${BASE}/api/export/transactions.csv${qs(f)}`;
}

/** Relative URL for full SQLite backup download */
export function exportBackupUrl() {
  return `${BASE}/api/export/backup`;
}

// ─── Phase 3/4: tax profiles + planner ──────────────────────────────────────

export type TaxProfileDto = {
  id: number;
  label: string;
  marginalRate: number;
  medicareLevy: number;
  isDefault: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type CgtRegime = "discount_50" | "indexation_min30" | "auto_by_date";

export type PlannerTaxProfile = {
  label: string;
  marginalRate: number;
  medicareLevy: number;
};

export type AssetAssumption = {
  label?: string;
  ticker?: string;
  weight: number;
  growthRate: number;
  yieldRate: number;
  mer: number;
  frankingPercent?: number;
  reinvestDividends?: boolean;
};

export type ScenarioAllocation = {
  id: string;
  label: string;
  assets: AssetAssumption[];
  /** Per-strategy exit; overrides scenario default when set */
  exit?: ExitStrategy;
};

export type ExitStrategy =
  | { type: "liquidate" }
  | { type: "hold" }
  | { type: "drawdown"; annualRate: number };

export type PlannerScenarioBody = {
  name: string;
  horizonYears: number;
  startDate?: string;
  initialValueAud?: number;
  initialCostBaseAud?: number;
  taxProfile: PlannerTaxProfile;
  cgtRegime: CgtRegime;
  /** CPI / cost-base indexation p.a. (decimal) for post–2027 */
  inflationRateAnnual?: number;
  monthlyContributionAud?: number;
  contributionKeyframes?: Array<{ monthIndex: number; monthlyAud: number }>;
  lumpSums?: Array<{ monthIndex: number; amountAud: number }>;
  brokeragePerContribution?: number;
  exit: ExitStrategy;
  allocations: ScenarioAllocation[];
};

export type AllocationReport = {
  allocationId: string;
  label: string;
  exit?: ExitStrategy;
  finalValue: number;
  totalContributions: number;
  totalCapitalIn?: number;
  totalDividendsCash: number;
  totalDividendsReinvested: number;
  totalWealthBeforeExitCgt?: number;
  totalFees: number;
  totalIncomeTax: number;
  totalCgtTax: number;
  exitCgtTax: number;
  netIfLiquidated: number;
  netGainAfterTax: number;
  gainBeforeExitCgt: number;
  exitCapitalGain: number;
  effectiveTaxDragPct: number;
  years: Array<{
    year: number;
    endValue: number;
    contributions: number;
    dividendsCash: number;
    dividendsReinvested: number;
    fees: number;
    incomeTax: number;
    cgtTax: number;
  }>;
};

export type ScenarioReport = {
  scenarioName: string;
  horizonYears: number;
  startDate: string;
  endDate: string;
  taxProfile: PlannerTaxProfile;
  cgtRegime: CgtRegime;
  exit: ExitStrategy;
  allocations: AllocationReport[];
  disclaimer: string;
};

export type SavedScenario = {
  id: number;
  name: string;
  body: Partial<PlannerScenarioBody>;
  createdAt?: string;
  updatedAt?: string;
};

export async function fetchTaxProfiles() {
  return json<TaxProfileDto[]>(
    await fetch(`${BASE}/api/settings/tax-profiles`),
  );
}

export async function putTaxProfiles(
  profiles: Array<{
    id?: number;
    label: string;
    marginalRate: number;
    medicareLevy: number;
    isDefault?: boolean;
  }>,
) {
  return json<TaxProfileDto[]>(
    await fetch(`${BASE}/api/settings/tax-profiles`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profiles }),
    }),
  );
}

export type InstrumentAssumptionsDto = {
  ticker: string;
  exchange: string;
  growthRate: number;
  yieldRate: number;
  mer: number;
  frankingPercent: number;
  name?: string;
  issuer?: string;
  productUrl?: string;
  sources: string[];
  notes: string[];
  resolvedAt: string;
  fromCache?: boolean;
  error?: string;
};

/** Cache/seed only unless refresh=true (may call Yahoo). */
export async function fetchInstrumentAssumptions(
  ticker: string,
  opts: { exchange?: string; refresh?: boolean; force?: boolean } = {},
) {
  const q = new URLSearchParams();
  if (opts.exchange) q.set("exchange", opts.exchange);
  if (opts.refresh) q.set("refresh", "1");
  if (opts.force) q.set("force", "1");
  const qs = q.toString() ? `?${q}` : "";
  return json<InstrumentAssumptionsDto>(
    await fetch(
      `${BASE}/api/instruments/${encodeURIComponent(ticker.toUpperCase())}${qs}`,
    ),
  );
}

export async function fetchScenarios() {
  return json<SavedScenario[]>(await fetch(`${BASE}/api/scenarios`));
}

export async function createScenario(name: string, body: object) {
  return json<SavedScenario>(
    await fetch(`${BASE}/api/scenarios`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, body }),
    }),
  );
}

export async function updateScenario(
  id: number,
  opts: { name?: string; body?: object },
) {
  return json<SavedScenario>(
    await fetch(`${BASE}/api/scenarios/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }),
  );
}

export async function deleteScenario(id: number) {
  return json<{ ok: boolean }>(
    await fetch(`${BASE}/api/scenarios/${id}`, { method: "DELETE" }),
  );
}

export async function runPlanner(body: Partial<PlannerScenarioBody>) {
  return json<ScenarioReport>(
    await fetch(`${BASE}/api/planner/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function runSavedScenario(
  id: number,
  overrides?: Partial<PlannerScenarioBody>,
) {
  return json<ScenarioReport>(
    await fetch(`${BASE}/api/scenarios/${id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(overrides ?? {}),
    }),
  );
}

export async function fetchPlannerTemplates() {
  return json<ScenarioAllocation[]>(
    await fetch(`${BASE}/api/planner/templates`),
  );
}

// ─── Phase 5: app settings + health ─────────────────────────────────────────

export type AppSettings = {
  yahoo_refresh_enabled: string;
  us_withholding_pct: string;
  [key: string]: string;
};

export type SettingsResponse = {
  settings: AppSettings;
  dbPath: string;
};

export type HealthResponse = {
  ok: boolean;
  service: string;
  dbPath?: string;
  serveWeb?: boolean;
};

export async function fetchHealth() {
  return json<HealthResponse>(await fetch(`${BASE}/api/health`));
}

export async function fetchSettings() {
  return json<SettingsResponse>(await fetch(`${BASE}/api/settings`));
}

export async function putSettings(
  settings: Partial<{
    yahoo_refresh_enabled: string | boolean;
    us_withholding_pct: string | number;
  }>,
) {
  return json<SettingsResponse>(
    await fetch(`${BASE}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    }),
  );
}

/** Wipe quote/price/dividend/fx caches only (not transactions). */
export async function wipeCaches() {
  return json<{
    ok: boolean;
    deleted: {
      quote_cache: number;
      price_cache: number;
      dividend_cache: number;
      fx_cache: number;
    };
  }>(await fetch(`${BASE}/api/settings/caches`, { method: "DELETE" }));
}
