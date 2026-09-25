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

export type TxParcelAllocation = {
  acquireTxId: number;
  acquiredDate: string;
  quantity: number;
  costBaseAud: number;
  proceedsAud: number;
};

export type TxParcelInfo = {
  kind: "acquire" | "sell";
  status?: "partial" | "sold";
  soldQuantity?: number;
  remainingQuantity?: number;
  lastSoldDate?: string | null;
  matching?: LotMatchingMethod;
  allocations?: TxParcelAllocation[];
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
  parcel?: TxParcelInfo;
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

/** Dry-run of /api/import — parses the file and returns every transaction it would write, but never touches the DB. */
export type ImportPreviewResult = {
  filename: string;
  parser: string;
  layoutId: string | null;
  confidence: "high" | "low" | "none" | null;
  source: string;
  custody: string | null;
  parsed: number;
  skipped: number;
  transactions: ReconcileParsedTx[];
  warnings: Array<{ row?: number; message: string; severity?: string }>;
};

export async function previewImportFile(opts: {
  file: File;
  parser: string;
  broker?: string;
  source?: string;
}) {
  const fd = new FormData();
  fd.append("file", opts.file);
  fd.append("broker", opts.parser);
  if (opts.broker) fd.append("custody", opts.broker);
  if (opts.source) fd.append("source", opts.source);
  return json<ImportPreviewResult>(
    await fetch(`${BASE}/api/import/preview`, { method: "POST", body: fd }),
  );
}

export type ImportHistoryFile = {
  filename: string;
  broker: string | null;
  source: string | null;
  importedAt: string;
  rowCount: number;
  importedCount: number;
  skippedCount: number;
  portfolioId: number;
  portfolioName: string;
  importCount: number;
};

export type ImportHistoryByBroker = {
  broker: string;
  latestTransactionDate: string | null;
  transactionCount: number;
  lastImportedAt: string | null;
};

export type ImportHistory = {
  files: ImportHistoryFile[];
  byBroker: ImportHistoryByBroker[];
};

/** Which files have already been imported (deduped by filename — the latest
 * attempt wins), plus the latest transaction date already in the ledger per
 * broker/custody. Helps answer "have I imported this year's statement yet". */
export async function fetchImportHistory(
  portfolioId?: number,
  opts?: { source?: string },
) {
  const p = new URLSearchParams();
  if (portfolioId != null) p.set("portfolioId", String(portfolioId));
  if (opts?.source) p.set("source", opts.source);
  const qsStr = p.toString();
  return json<ImportHistory>(
    await fetch(`${BASE}/api/import/history${qsStr ? `?${qsStr}` : ""}`),
  );
}

export type StakeDrpProposed = {
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
  fundedBy: string;
  alreadyInLedger?: boolean;
  alreadyHow?: string | null;
};

export type StakeDrpWarning = {
  ticker?: string;
  message: string;
  severity: string;
};

export type StakeDrpResult = {
  proposed: StakeDrpProposed[];
  warnings: StakeDrpWarning[];
  unrecognizedFiles: string[];
  committed: boolean;
  inserted?: number;
  skippedExisting?: number;
  alreadyInLedger?: number;
  newCount?: number;
};

/**
 * Stake DRP detection — analyze (commit=false, default) or insert
 * (commit=true) drp transactions inferred from any mix of Activity/Income/
 * Valuation Stake workbooks. Separate, on-demand tool — does not touch the
 * regular per-file import flow.
 */
export async function analyzeStakeDrp(opts: {
  files: File[];
  portfolioId: number;
  commit?: boolean;
}) {
  const fd = new FormData();
  for (const f of opts.files) fd.append("files", f);
  fd.append("portfolioId", String(opts.portfolioId));
  if (opts.commit) fd.append("commit", "true");
  return json<StakeDrpResult>(
    await fetch(`${BASE}/api/import/stake-drp`, { method: "POST", body: fd }),
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

// ─── Gains by FY (realised vs unrealised, tax-agnostic) ─────────────────────

export type GainsByFyRow = {
  financialYear: string;
  realisedGainAud: number;
  unrealisedGainAud: number | null;
};

export async function fetchGainsByFy(f: Filters = {}) {
  return json<{
    byFy: GainsByFyRow[];
    filters: { portfolioId: number | null; broker: string | null; source: string | null };
  }>(await fetch(`${BASE}/api/gains/by-fy${qs(f)}`));
}

// ─── Dividend income by FY (cash vs DRP) ────────────────────────────────────

export type IncomeFyTotal = {
  financialYear: string;
  amountAud: number | null;
  amountCashAud: number | null;
  amountDrpAud: number | null;
  amountNativeMixed: number;
  count: number;
  cashCount: number;
  drpCount: number;
};

export async function fetchIncome(f: Filters = {}) {
  return json<{
    fyTotals: IncomeFyTotal[];
    grandTotalAud: number | null;
    missingFx: string[];
    notes: string[];
  }>(await fetch(`${BASE}/api/income${qs(f)}`));
}

/** Relative URL for browser download of filtered ledger CSV */
export function exportTransactionsCsvUrl(f: Filters = {}) {
  return `${BASE}/api/export/transactions.csv${qs(f)}`;
}

/** Relative URL for full SQLite backup download */
export function exportBackupUrl() {
  return `${BASE}/api/export/backup`;
}

/**
 * Replace the live SQLite database with an uploaded backup file. Destructive
 * — overwrites all current data (the server keeps a timestamped safety copy
 * of the live file first, so an accidental wrong-file restore is recoverable
 * from disk, but the running app immediately reflects the uploaded file).
 */
export async function restoreBackup(file: File) {
  const fd = new FormData();
  fd.append("file", file);
  return json<{ ok: true; dbPath: string; safetyCopy: string }>(
    await fetch(`${BASE}/api/backup/restore`, { method: "POST", body: fd }),
  );
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

export type LotMatchingMethod = "fifo" | "min_cgt";

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

// ─── FY tax estimate (dividend tax + realised CGT on actual sells) ─────────

export type RealisedCgtLineDto = {
  ticker: string;
  exchange: string;
  acquiredDate: string;
  disposedDate: string;
  quantity: number;
  proceedsAud: number;
  costBaseAud: number;
  financialYear: string;
  /** Raw gain/loss for this disposal — negative = loss. Tax is computed at the FY level (see fyTotals), not per line. */
  capitalGain: number;
  longTerm: boolean;
  appliedRegime: Exclude<CgtRegime, "auto_by_date">;
  parcelMatch?: "fifo" | "min_cgt" | "recorded";
};

export type FyTaxTotalDto = {
  financialYear: string;
  assessableDividendIncome: number;
  dividendNetTax: number;
  /** Net of this FY's own gains and losses — can be negative (a net capital loss). Unaffected by carry-forward. */
  netCapitalGain: number;
  /** How much of a prior FY's unused capital loss was applied to reduce this FY's CGT tax. */
  priorLossApplied: number;
  /** Unused capital loss carried forward into the next FY. */
  lossCarriedForward: number;
  cgtTax: number;
  totalTax: number;
};

export type AssessableDividendEventDto = {
  financialYear: string;
  date: string;
  ticker: string;
  exchange: string;
  currency: string;
  amount: number;
  amountAud: number | null;
  source: "cash" | "drp";
};

export type FyTaxEstimateDto = {
  byFy: FyTaxTotalDto[];
  dividendEvents: AssessableDividendEventDto[];
  cgt: {
    lines: RealisedCgtLineDto[];
    fyTotals: Array<{
      financialYear: string;
      appliedRegime: Exclude<CgtRegime, "auto_by_date">;
      totalGains: number;
      totalLosses: number;
      netCapitalGain: number;
      netCapitalLoss: number;
      lossCarriedIn: number;
      priorLossApplied: number;
      lossCarriedOut: number;
      taxableGain: number;
      tax: number;
      disposalCount: number;
    }>;
  };
  dividendTax: {
    notes: string[];
  };
  notes: string[];
  taxProfile: { id: number; label: string; marginalRate: number; medicareLevy: number };
  regime: CgtRegime;
  lotMatching: LotMatchingMethod;
  filters: { portfolioId: number | null; broker: string | null; source: string | null };
};

export async function fetchFyTaxEstimate(opts: {
  portfolioId?: number | null;
  taxProfileId?: number;
  regime?: CgtRegime;
  lotMatching?: LotMatchingMethod;
  inflationRate?: number;
}) {
  const params = new URLSearchParams();
  if (opts.portfolioId != null) params.set("portfolioId", String(opts.portfolioId));
  if (opts.taxProfileId != null) params.set("taxProfileId", String(opts.taxProfileId));
  if (opts.regime) params.set("regime", opts.regime);
  if (opts.lotMatching) params.set("lotMatching", opts.lotMatching);
  if (opts.inflationRate != null) params.set("inflationRate", String(opts.inflationRate));
  return json<FyTaxEstimateDto>(
    await fetch(`${BASE}/api/tax/fy-estimate?${params.toString()}`),
  );
}

export type SellEstimateParcelDto = {
  ticker: string;
  exchange: string;
  acquiredDate: string;
  disposedDate: string;
  quantity: number;
  proceedsAud: number;
  costBaseAud: number;
  capitalGain: number;
  longTerm: boolean;
  appliedRegime: Exclude<CgtRegime, "auto_by_date">;
  acquireTxId?: number;
};

export type SellEstimateSummaryDto = {
  matching: LotMatchingMethod;
  quantitySold: number;
  proceedsAud: number;
  costBaseAud: number;
  capitalGain: number;
  taxableGain: number;
  tax: number;
  appliedRegime: Exclude<CgtRegime, "auto_by_date"> | null;
};

export type SellEstimateDto = SellEstimateSummaryDto & {
  ticker: string;
  exchange: string | null;
  quantityRequested: number;
  unmatchedQuantity: number;
  proceedsPerUnitAud: number;
  disposedDate: string;
  parcels: SellEstimateParcelDto[];
  comparison: {
    fifo: SellEstimateSummaryDto;
    min_cgt: SellEstimateSummaryDto;
  };
  notes: string[];
  unitsHeld: number;
  marketPrice: number | null;
  currency: string | null;
  openLots: Array<{
    acquiredDate: string;
    quantity: number;
    costBaseAud: number;
    unitCostAud: number;
  }>;
  taxProfile: { id: number; label: string; marginalRate: number; medicareLevy: number };
  regime: CgtRegime;
  lotMatching: LotMatchingMethod;
  inflationRate: number | null;
};

export async function fetchSellEstimate(opts: {
  ticker: string;
  exchange?: string;
  quantity: number;
  lotMatching?: LotMatchingMethod;
  regime?: CgtRegime;
  inflationRate?: number;
  disposedDate?: string;
  taxProfileId?: number;
  portfolioId?: number | null;
  broker?: string;
  source?: string;
}) {
  const params = new URLSearchParams();
  params.set("ticker", opts.ticker);
  if (opts.exchange) params.set("exchange", opts.exchange);
  params.set("quantity", String(opts.quantity));
  if (opts.lotMatching) params.set("lotMatching", opts.lotMatching);
  if (opts.regime) params.set("regime", opts.regime);
  if (opts.inflationRate != null) params.set("inflationRate", String(opts.inflationRate));
  if (opts.disposedDate) params.set("disposedDate", opts.disposedDate);
  if (opts.taxProfileId != null) params.set("taxProfileId", String(opts.taxProfileId));
  if (opts.portfolioId != null) params.set("portfolioId", String(opts.portfolioId));
  if (opts.broker) params.set("broker", opts.broker);
  if (opts.source) params.set("source", opts.source);
  return json<SellEstimateDto>(
    await fetch(`${BASE}/api/tax/sell-estimate?${params.toString()}`),
  );
}

export type ConfirmSaleResult = {
  ok: true;
  sell: TxRow;
  matching: LotMatchingMethod;
  quantitySold: number;
  unmatchedQuantity: number;
  tax: number;
  capitalGain: number;
  parcels: SellEstimateParcelDto[];
};

export async function confirmSale(body: {
  ticker: string;
  exchange?: string;
  quantity: number;
  disposedDate?: string;
  lotMatching?: LotMatchingMethod;
  portfolioId: number;
  taxProfileId?: number;
  inflationRate?: number;
  broker?: string;
}) {
  return json<ConfirmSaleResult>(
    await fetch(`${BASE}/api/tax/confirm-sale`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
  yahoo_auto_refresh_minutes: string;
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
    yahoo_auto_refresh_minutes: string | number;
    us_withholding_pct: string | number;
    platform_fifo_brokers: string;
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

/**
 * Resolve historical AUDUSD-style FX rates for existing non-AUD
 * transactions that don't have one yet (e.g. imported before this feature
 * existed). Safe to re-run — only touches rows still missing a rate.
 */
export async function backfillFxRates() {
  return json<{
    ok: boolean;
    candidates: number;
    resolved: number;
    unresolved: number;
  }>(await fetch(`${BASE}/api/settings/backfill-fx`, { method: "POST" }));
}

// ── Valuations (holdings stamped at a past date) ────────────────────────────

export type ValuationFlag =
  | "no_price"
  | "stale_price"
  | "no_fx"
  | "fx_not_historical"
  | "untracked_units";

export type ValuationLineDto = {
  ticker: string;
  exchange: string;
  currency: string;
  quantity: number;
  costBaseAud: number;
  unitValue: number | null;
  priceDate: string | null;
  priceSymbol: string | null;
  fxRate: number | null;
  fxDate: string | null;
  marketValueAud: number | null;
  parcels: Array<{
    acquiredDate: string;
    quantity: number;
    costBaseAud: number;
    marketValueAud: number | null;
  }>;
  untrackedQuantity: number;
  flags: ValuationFlag[];
};

export type ValuationBrokerDto = {
  broker: string;
  lines: ValuationLineDto[];
  costBaseAud: number;
  marketValueAud: number;
  unvalued: number;
};

export type ValuationReportDto = {
  asOf: string;
  generatedAt: string;
  portfolios: Array<{
    id: number;
    name: string;
    valuation: {
      asOf: string;
      brokers: ValuationBrokerDto[];
      costBaseAud: number;
      marketValueAud: number;
      unvalued: number;
    };
  }>;
  costBaseAud: number;
  marketValueAud: number;
  unvalued: number;
};

export type SavedValuation = {
  id: number;
  asOf: string;
  label: string;
  notes: string | null;
  portfolioId: number | null;
  createdAt: string;
  marketValueAud: number;
  costBaseAud: number;
  unvalued: number;
};

/** Errors from these routes are `{ error }` JSON; surface just the message. */
async function valuationJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    let message = text || res.statusText;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function previewValuation(asOf: string, portfolioId: number | "all") {
  const q = new URLSearchParams({ asOf, portfolioId: String(portfolioId) });
  return valuationJson<ValuationReportDto>(await fetch(`${BASE}/api/valuations/preview?${q}`));
}

export async function saveValuation(body: {
  asOf: string;
  portfolioId: number | "all";
  label: string;
  notes: string;
}) {
  return valuationJson<SavedValuation & { report: ValuationReportDto }>(
    await fetch(`${BASE}/api/valuations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function fetchSavedValuations() {
  return valuationJson<SavedValuation[]>(await fetch(`${BASE}/api/valuations`));
}

export async function fetchSavedValuation(id: number) {
  return valuationJson<SavedValuation & { report: ValuationReportDto }>(
    await fetch(`${BASE}/api/valuations/${id}`),
  );
}

export async function deleteSavedValuation(id: number) {
  return valuationJson<{ ok: true }>(
    await fetch(`${BASE}/api/valuations/${id}`, { method: "DELETE" }),
  );
}

export function savedValuationCsvUrl(id: number) {
  return `${BASE}/api/valuations/${id}/csv`;
}
