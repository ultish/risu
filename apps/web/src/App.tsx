import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type FilterMeta,
  type Holding,
  type ImportResult,
  type Portfolio,
  type ReconcileResult,
  type TxRow,
  type YahooStatus,
  clearYahooCooldown,
  createPortfolio,
  createTransaction,
  deleteTransactions,
  fetchFilterMeta,
  fetchHoldings,
  fetchPortfolios,
  fetchTransactions,
  fetchYahooStatus,
  importFile,
  importSharesightPaste,
  reconcileFile,
  refreshPrices,
} from "./api";
import { Disclaimer } from "./Disclaimer";
import { DrpCheckPanel } from "./DrpCheckPanel";
import ExportBar from "./ExportBar";
import PerformanceChart from "./PerformanceChart";
import { PlannerPanel } from "./PlannerPanel";
import { SettingsPanel } from "./SettingsPanel";
import { TaxSettingsPanel } from "./TaxSettingsPanel";

/** Top-level nav — synced to `?tab=` for copyable links */
const MAIN_TABS = [
  "holdings",
  "transactions",
  "import",
  "tax",
  "planner",
  "settings",
] as const;
type MainTab = (typeof MAIN_TABS)[number];
const IMPORT_SUBS = ["file", "paste", "manual"] as const;
type ImportSub = (typeof IMPORT_SUBS)[number];
const TAX_SUBS = ["profiles", "drp"] as const;
type TaxSub = (typeof TAX_SUBS)[number];

function isMainTab(v: string | null | undefined): v is MainTab {
  return !!v && (MAIN_TABS as readonly string[]).includes(v);
}
function isImportSub(v: string | null | undefined): v is ImportSub {
  return !!v && (IMPORT_SUBS as readonly string[]).includes(v);
}
function isTaxSub(v: string | null | undefined): v is TaxSub {
  return !!v && (TAX_SUBS as readonly string[]).includes(v);
}

/** Read nav from `?tab=` (preferred) or `#tab` hash. */
function readNavFromUrl(): {
  tab: MainTab;
  importSub: ImportSub;
  taxSub: TaxSub;
} {
  const url = new URL(window.location.href);
  const qTab = url.searchParams.get("tab");
  const hash = url.hash.replace(/^#\/?/, "").split(/[?&]/)[0] || "";
  const tab: MainTab = isMainTab(qTab)
    ? qTab
    : isMainTab(hash)
      ? hash
      : "holdings";
  const importSub: ImportSub = isImportSub(url.searchParams.get("import"))
    ? (url.searchParams.get("import") as ImportSub)
    : "file";
  const taxSub: TaxSub = isTaxSub(url.searchParams.get("tax"))
    ? (url.searchParams.get("tax") as TaxSub)
    : "profiles";
  return { tab, importSub, taxSub };
}

/** Push or replace `?tab=` (and import/tax sub params). Clears bare hash. */
function writeNavToUrl(
  tab: MainTab,
  importSub: ImportSub,
  taxSub: TaxSub,
  mode: "push" | "replace" = "push",
) {
  const url = new URL(window.location.href);
  url.searchParams.set("tab", tab);
  if (tab === "import") url.searchParams.set("import", importSub);
  else url.searchParams.delete("import");
  if (tab === "tax") url.searchParams.set("tax", taxSub);
  else url.searchParams.delete("tax");
  url.hash = "";
  const next = `${url.pathname}${url.search}`;
  if (mode === "replace") window.history.replaceState({ tab }, "", next);
  else window.history.pushState({ tab }, "", next);
}

type TxSortKey =
  | "date"
  | "ticker"
  | "exchange"
  | "type"
  | "broker"
  | "source"
  | "quantity"
  | "amount";

const PARSERS = [
  { id: "auto", label: "Auto-detect" },
  { id: "sharesight", label: "Sharesight file" },
  { id: "commsec", label: "CommSec CSV" },
  { id: "pocket", label: "Pocket CSV" },
  { id: "selfwealth", label: "Selfwealth CSV" },
  { id: "stake", label: "Stake XLSX/CSV" },
  { id: "betashares_direct", label: "Betashares Direct" },
  { id: "generic", label: "Generic CSV" },
] as const;

/** Parsers whose server-side custody inference (`inferCustodyFromParser`) always resolves to null. */
const NO_CUSTODY_PARSERS = new Set(["sharesight", "generic"]);

type FileItemStatus =
  | "ready"
  | "needs_custody"
  | "unsupported"
  | "importing"
  | "done"
  | "error";

type FileQueueItem = {
  key: string;
  file: File;
  parserOverride: string | null;
  custodyOverride: string;
  status: FileItemStatus;
  result: ImportResult | null;
  error: string | null;
  reconcile: ReconcileResult | null;
  reconciling: boolean;
  reconcileError: string | null;
};

function fileQueueKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

/**
 * Synchronous, no-network classification. `auto`-parser rows are always
 * "ready" even though the real detected broker (only known post-parse) might
 * resolve to null custody server-side — an intentional v1 simplification
 * (docs/import-layouts-plan.md §10.3 "detect without extra endpoint").
 */
function classifyItem(
  file: File,
  parserOverride: string | null,
  custodyOverride: string,
  globalParser: string,
): FileItemStatus {
  if (/\.pdf$/i.test(file.name)) return "unsupported";
  const effectiveParser = parserOverride ?? globalParser;
  if (NO_CUSTODY_PARSERS.has(effectiveParser) && custodyOverride === "") {
    return "needs_custody";
  }
  return "ready";
}

/**
 * Lightweight client-side heuristic (no network call) for whether a queued
 * file is plausibly a Stake Investment Activity XLSX worth offering a
 * "Reconcile with ledger" button for (Phase 5, docs/import-layouts-plan.md
 * §12). Server does the real detection; this only gates the button.
 */
function looksLikeStakeActivityXlsx(
  file: File,
  parserOverride: string | null,
  globalParser: string,
): boolean {
  if (!/\.xlsx$/i.test(file.name)) return false;
  const effectiveParser = parserOverride ?? globalParser;
  return effectiveParser === "auto" || effectiveParser === "stake";
}

const BROKERS = [
  { id: "stake", label: "Stake" },
  { id: "commsec", label: "CommSec" },
  { id: "pocket", label: "Pocket" },
  { id: "selfwealth", label: "Selfwealth" },
  { id: "betashares_direct", label: "Betashares Direct" },
  { id: "other", label: "Other" },
] as const;

const TX_TYPES = [
  "buy",
  "sell",
  "drp",
  "dividend_cash",
  "transfer_in",
  "transfer_out",
  "fee",
  "other",
] as const;

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

function qty(n: number) {
  return n.toLocaleString("en-AU", { maximumFractionDigits: 6 });
}

export default function App() {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [portfolioId, setPortfolioId] = useState<number | "all">("all");
  const [brokerFilter, setBrokerFilter] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [tickerFilter, setTickerFilter] = useState<string>("");
  const [exchangeFilter, setExchangeFilter] = useState<string>("");
  const [filterMeta, setFilterMeta] = useState<FilterMeta | null>(null);

  const [txSort, setTxSort] = useState<{ key: TxSortKey; dir: "asc" | "desc" }>({
    key: "date",
    dir: "desc",
  });
  const [selectedTxIds, setSelectedTxIds] = useState<Set<number>>(new Set());
  const [txScrollTop, setTxScrollTop] = useState(0);

  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [totals, setTotals] = useState<{
    costBaseAud: number;
    marketValueAud: number | null;
    unrealisedAud: number | null;
  }>({ costBaseAud: 0, marketValueAud: null, unrealisedAud: null });
  const [fx, setFx] = useState<Record<string, number | null>>({});
  const [txs, setTxs] = useState<TxRow[]>([]);

  const [parser, setParser] = useState("auto");
  const [importBroker, setImportBroker] = useState("commsec");
  const [files, setFiles] = useState<FileQueueItem[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [yahooStatus, setYahooStatus] = useState<YahooStatus | null>(null);
  /** Bump after price refresh so PerformanceChart reloads */
  const [pricesReloadToken, setPricesReloadToken] = useState(0);
  /** Top-level nav — mirrored to `?tab=` (import/tax sub via `?import=` / `?tax=`) */
  const initialNav = useMemo(() => readNavFromUrl(), []);
  const [tab, setTabState] = useState<MainTab>(initialNav.tab);
  const [importSub, setImportSubState] = useState<ImportSub>(
    initialNav.importSub,
  );
  const [taxSub, setTaxSubState] = useState<TaxSub>(initialNav.taxSub);

  const setTab = useCallback(
    (next: MainTab) => {
      setTabState(next);
      writeNavToUrl(next, importSub, taxSub, "push");
    },
    [importSub, taxSub],
  );

  const setImportSub = useCallback(
    (next: ImportSub) => {
      setImportSubState(next);
      setTabState("import");
      writeNavToUrl("import", next, taxSub, "push");
    },
    [taxSub],
  );

  const setTaxSub = useCallback(
    (next: TaxSub) => {
      setTaxSubState(next);
      setTabState("tax");
      writeNavToUrl("tax", importSub, next, "push");
    },
    [importSub],
  );

  // Browser back/forward
  useEffect(() => {
    const sync = () => {
      const nav = readNavFromUrl();
      setTabState(nav.tab);
      setImportSubState(nav.importSub);
      setTaxSubState(nav.taxSub);
    };
    // Normalize bare load → always have ?tab= in the address bar
    writeNavToUrl(
      initialNav.tab,
      initialNav.importSub,
      initialNav.taxSub,
      "replace",
    );
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [initialNav]);

  const [newPortfolioName, setNewPortfolioName] = useState("");

  const [paste, setPaste] = useState({
    portfolioId: 0,
    broker: "stake",
    ticker: "TSLA",
    exchange: "US",
    text: "",
  });
  const [pasteResult, setPasteResult] = useState<{
    parsed: number;
    imported: number;
    duplicatesSkipped: number;
  } | null>(null);

  const [manual, setManual] = useState({
    portfolioId: 0,
    broker: "commsec",
    date: new Date().toISOString().slice(0, 10),
    ticker: "",
    exchange: "ASX",
    type: "buy",
    quantity: "",
    price: "",
    currency: "AUD",
    notes: "",
  });

  const filters = useMemo(
    () => ({
      portfolioId: portfolioId === "all" ? undefined : portfolioId,
      broker: brokerFilter || undefined,
      source: sourceFilter || undefined,
      ticker: tickerFilter || undefined,
      exchange: exchangeFilter || undefined,
    }),
    [portfolioId, brokerFilter, sourceFilter, tickerFilter, exchangeFilter],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      // Holdings/ledger only — never triggers Yahoo. Prices come from quote_cache.
      const [ports, meta, h, t, y] = await Promise.all([
        fetchPortfolios(),
        fetchFilterMeta(),
        fetchHoldings(filters),
        fetchTransactions(filters),
        fetchYahooStatus().catch(() => null),
      ]);
      setPortfolios(ports);
      setFilterMeta(meta);
      setHoldings(h.holdings);
      setTotals({
        costBaseAud: h.totals.costBaseAud ?? h.totals.costBase,
        marketValueAud: h.totals.marketValueAud ?? h.totals.marketValue,
        unrealisedAud: h.totals.unrealisedAud ?? h.totals.unrealised,
      });
      setFx(h.fx ?? {});
      setTxs(t);
      setSelectedTxIds(new Set());
      if (y) setYahooStatus(y);

      if (ports[0]) {
        setPaste((p) =>
          p.portfolioId === 0 ? { ...p, portfolioId: ports[0]!.id } : p,
        );
        setManual((m) =>
          m.portfolioId === 0 ? { ...m, portfolioId: ports[0]!.id } : m,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [filters]);

  // Tick cool-down countdown in the UI without calling Yahoo
  useEffect(() => {
    if (!yahooStatus || yahooStatus.waitSeconds <= 0) return;
    const id = window.setInterval(() => {
      setYahooStatus((prev) => {
        if (!prev?.blockedUntil) return prev;
        const wait = Math.max(
          0,
          Math.ceil((prev.blockedUntil - Date.now()) / 1000),
        );
        if (wait <= 0) {
          void fetchYahooStatus()
            .then(setYahooStatus)
            .catch(() => undefined);
          return {
            ...prev,
            waitSeconds: 0,
            state: "ok",
            blockedUntil: null,
            label: "Yahoo ready",
          };
        }
        return {
          ...prev,
          waitSeconds: wait,
          state: "cooling",
          label: `Yahoo cool-down · ${formatYahooWait(wait)}`,
        };
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [yahooStatus?.blockedUntil, yahooStatus?.waitSeconds]);

  const sortedTxs = useMemo(() => {
    const list = [...txs];
    const { key, dir } = txSort;
    const mul = dir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      if (av < bv) return -1 * mul;
      if (av > bv) return 1 * mul;
      return (b.id - a.id) * mul;
    });
    return list;
  }, [txs, txSort]);

  const TX_ROW_H = 40;
  const TX_VIEW_H = 480;
  const txVirtual = useMemo(() => {
    const total = sortedTxs.length;
    const visible = Math.ceil(TX_VIEW_H / TX_ROW_H) + 6;
    const start = Math.max(0, Math.floor(txScrollTop / TX_ROW_H) - 2);
    const end = Math.min(total, start + visible);
    return {
      start,
      end,
      total,
      padTop: start * TX_ROW_H,
      padBottom: Math.max(0, (total - end) * TX_ROW_H),
      rows: sortedTxs.slice(start, end),
    };
  }, [sortedTxs, txScrollTop]);

  function toggleTxSort(key: TxSortKey) {
    setTxSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "date" ? "desc" : "asc" },
    );
  }

  function openHoldingTrades(h: Holding) {
    setTickerFilter(h.ticker);
    setExchangeFilter(h.exchange);
    setTab("transactions");
    setTxScrollTop(0);
  }

  useEffect(() => {
    void load();
  }, [load]);

  const selectedPortfolioLabel = useMemo(() => {
    if (portfolioId === "all") return "All portfolios";
    return portfolios.find((p) => p.id === portfolioId)?.name ?? "Portfolio";
  }, [portfolioId, portfolios]);

  // Re-classify queue items that inherit the global parser when it changes.
  useEffect(() => {
    setFiles((prev) =>
      prev.map((item) =>
        item.parserOverride == null
          ? {
              ...item,
              status: classifyItem(
                item.file,
                null,
                item.custodyOverride,
                parser,
              ),
            }
          : item,
      ),
    );
  }, [parser]);

  function addFiles(list: FileList | File[]) {
    setFiles((prev) => {
      const existingKeys = new Set(prev.map((i) => i.key));
      const next = [...prev];
      for (const f of Array.from(list)) {
        const key = fileQueueKey(f);
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        next.push({
          key,
          file: f,
          parserOverride: null,
          custodyOverride: importBroker,
          status: classifyItem(f, null, importBroker, parser),
          result: null,
          error: null,
          reconcile: null,
          reconciling: false,
          reconcileError: null,
        });
      }
      return next;
    });
  }

  function removeFile(key: string) {
    setFiles((prev) => prev.filter((i) => i.key !== key));
  }

  function setItemParser(key: string, value: string) {
    setFiles((prev) =>
      prev.map((i) => {
        if (i.key !== key) return i;
        const parserOverride = value === "" ? null : value;
        return {
          ...i,
          parserOverride,
          status: classifyItem(i.file, parserOverride, i.custodyOverride, parser),
        };
      }),
    );
  }

  function setItemCustody(key: string, value: string) {
    setFiles((prev) =>
      prev.map((i) =>
        i.key === key
          ? {
              ...i,
              custodyOverride: value,
              status: classifyItem(i.file, i.parserOverride, value, parser),
            }
          : i,
      ),
    );
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(true);
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
  }

  async function onCreatePortfolio() {
    if (!newPortfolioName.trim()) return;
    setBusy(true);
    try {
      await createPortfolio(newPortfolioName.trim());
      setNewPortfolioName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onImport() {
    const readyKeys = files.filter((f) => f.status === "ready").map((f) => f.key);
    if (!readyKeys.length) {
      setError("Add at least one CSV or XLSX file");
      return;
    }
    if (portfolioId === "all") {
      setError("Select a portfolio to import into");
      return;
    }
    setBusy(true);
    setError(null);
    setFiles((prev) =>
      prev.map((i) =>
        readyKeys.includes(i.key) ? { ...i, status: "importing" } : i,
      ),
    );
    for (const key of readyKeys) {
      const item = files.find((i) => i.key === key);
      if (!item) continue;
      try {
        const result = await importFile({
          file: item.file,
          portfolioId,
          parser: item.parserOverride ?? parser,
          broker: item.custodyOverride || undefined,
        });
        setFiles((prev) =>
          prev.map((i) =>
            i.key === key ? { ...i, status: "done", result, error: null } : i,
          ),
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setFiles((prev) =>
          prev.map((i) =>
            i.key === key ? { ...i, status: "error", error: message } : i,
          ),
        );
      }
    }
    await load();
    setBusy(false);
  }

  /** Phase 5: read-only diff of a Stake activity XLSX vs the ledger — never writes. */
  async function onReconcile(key: string) {
    const item = files.find((i) => i.key === key);
    if (!item) return;
    if (portfolioId === "all") {
      setError("Select a portfolio to reconcile against");
      return;
    }
    setFiles((prev) =>
      prev.map((i) =>
        i.key === key
          ? { ...i, reconciling: true, reconcileError: null }
          : i,
      ),
    );
    try {
      const reconcile = await reconcileFile({
        file: item.file,
        portfolioId,
        custody: item.custodyOverride || undefined,
      });
      setFiles((prev) =>
        prev.map((i) =>
          i.key === key ? { ...i, reconciling: false, reconcile } : i,
        ),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setFiles((prev) =>
        prev.map((i) =>
          i.key === key
            ? { ...i, reconciling: false, reconcileError: message }
            : i,
        ),
      );
    }
  }

  async function onRefreshPrices() {
    const cooling =
      yahooStatus?.state === "cooling" && (yahooStatus.waitSeconds ?? 0) > 0;
    if (cooling) {
      // Cool-down only skips Yahoo — refresh still runs ASX/Nasdaq/FX fallbacks.
      // Optional: force Yahoo anyway (usually worsens ban).
      const forceYahoo = window.confirm(
        `Yahoo is in cool-down (${formatYahooWait(yahooStatus!.waitSeconds)} left).\n\n` +
          `OK = refresh prices via fallbacks (ASX / Nasdaq / FX) without hitting Yahoo.\n` +
          `Cancel = abort.\n\n` +
          `Tip: do not force Yahoo while banned — use OK for fallbacks only.`,
      );
      if (!forceYahoo) return;
      // force:false — use fallbacks, skip Yahoo
    }
    setBusy(true);
    setError(null);
    try {
      // History fills price_cache for the performance chart (1y Yahoo chart/spark).
      // Never force Yahoo from the main button while cooling (fallbacks only).
      const r = await refreshPrices({ force: false, includeHistory: true });
      if (r.yahoo) setYahooStatus(r.yahoo);
      else {
        const y = await fetchYahooStatus().catch(() => null);
        if (y) setYahooStatus(y);
      }
      const failed = r.results.filter((x) => x.error);
      if (r.yahooCircuitOpen || failed.length) {
        setError(
          r.note ||
            `Some prices failed: ${failed
              .slice(0, 3)
              .map((f) => `${f.ticker}(${f.exchange})`)
              .join(", ")}`,
        );
      } else if (r.note) {
        // Show success path (e.g. fallbacks used) briefly as non-error is fine
      }
      setPricesReloadToken((n) => n + 1);
      await load();
    } catch (e) {
      const ye = e as Error & { yahoo?: YahooStatus };
      if (ye.yahoo) setYahooStatus(ye.yahoo);
      else {
        const y = await fetchYahooStatus().catch(() => null);
        if (y) setYahooStatus(y);
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onClearYahooCooldown() {
    try {
      const y = await clearYahooCooldown();
      setYahooStatus(y);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onManualSave() {
    if (!manual.portfolioId || !manual.ticker || !manual.date) {
      setError("Portfolio, ticker and date are required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const quantity = Number(manual.quantity) || 0;
      const price = manual.price === "" ? null : Number(manual.price);
      await createTransaction({
        portfolioId: manual.portfolioId,
        date: manual.date,
        ticker: manual.ticker.trim().toUpperCase(),
        exchange: manual.exchange,
        type: manual.type,
        quantity,
        price,
        amount: price != null && quantity ? price * quantity : null,
        currency: manual.currency,
        notes: manual.notes || null,
        broker: manual.broker,
        source: "manual",
      });
      setManual((m) => ({
        ...m,
        ticker: "",
        quantity: "",
        price: "",
        notes: "",
      }));
      await load();
      setTab("transactions");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onPasteImport() {
    if (!paste.text.trim() || !paste.ticker.trim() || !paste.portfolioId) {
      setError("Portfolio, ticker, and pasted text are required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await importSharesightPaste({
        portfolioId: paste.portfolioId,
        ticker: paste.ticker.trim(),
        exchange: paste.exchange,
        text: paste.text,
        broker: paste.broker,
        source: "sharesight_paste",
      });
      setPasteResult(result);
      setPaste((p) => ({ ...p, text: "" }));
      await load();
      setTab("transactions");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteSelected() {
    const ids = [...selectedTxIds];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} transaction(s)?`)) return;
    setBusy(true);
    try {
      await deleteTransactions(ids);
      setSelectedTxIds(new Set());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleSelectTx(id: number) {
    setSelectedTxIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    const ids = sortedTxs.map((t) => t.id);
    const allOn = ids.length > 0 && ids.every((id) => selectedTxIds.has(id));
    setSelectedTxIds(allOn ? new Set() : new Set(ids));
  }

  const brokerOptions = useMemo(() => {
    const fromData = filterMeta?.brokers ?? [];
    const known = BROKERS.map((b) => b.id);
    return Array.from(new Set([...known, ...fromData]));
  }, [filterMeta]);

  const sourceOptions = useMemo(() => {
    return filterMeta?.sources ?? [];
  }, [filterMeta]);

  return (
    <div className="mx-auto min-h-screen max-w-6xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-4">
            <img
              src="/risu-icon.png"
              alt="Risu"
              width={56}
              height={56}
              className="h-14 w-14 rounded-2xl shadow-md shadow-black/30 ring-1 ring-white/10"
            />
            <div>
              <h1 className="text-2xl font-semibold tracking-wide text-emerald-400/90 sm:text-3xl">
                RISU · りす
              </h1>
              <p className="mt-0.5 max-w-xl text-sm text-gray-400">
                Local portfolio tracker · ASX &amp; US. Portfolios can mix
                brokers. Filter by portfolio, broker, or import source.
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          <YahooStatusBadge
            status={yahooStatus}
            busy={busy}
            onRefresh={() => void onRefreshPrices()}
            onClearCooldown={() => void onClearYahooCooldown()}
          />
          <p className="max-w-xs text-right text-[11px] text-gray-500">
            Page load never calls Yahoo — only this button (or force DRP).
          </p>
        </div>
      </header>

      {/* Filters */}
      <div className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-gray-800 bg-gray-900/50 p-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-gray-500">Portfolio</span>
          <select
            className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm"
            value={portfolioId === "all" ? "all" : String(portfolioId)}
            onChange={(e) => {
              const v = e.target.value;
              setPortfolioId(v === "all" ? "all" : Number(v));
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
        <label className="text-sm">
          <span className="mb-1 block text-xs text-gray-500">Broker</span>
          <select
            className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm"
            value={brokerFilter}
            onChange={(e) => setBrokerFilter(e.target.value)}
          >
            <option value="">All brokers</option>
            {brokerOptions.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-gray-500">Source</span>
          <select
            className="rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
          >
            <option value="">All sources</option>
            {sourceOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-gray-500">Ticker</span>
          <input
            className="w-28 rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm uppercase"
            placeholder="All"
            value={tickerFilter}
            onChange={(e) => setTickerFilter(e.target.value.toUpperCase())}
          />
        </label>
        {(brokerFilter ||
          sourceFilter ||
          portfolioId !== "all" ||
          tickerFilter ||
          exchangeFilter) && (
          <button
            type="button"
            className="text-xs text-gray-400 underline hover:text-gray-200"
            onClick={() => {
              setPortfolioId("all");
              setBrokerFilter("");
              setSourceFilter("");
              setTickerFilter("");
              setExchangeFilter("");
            }}
          >
            Clear filters
          </button>
        )}
        <div className="ml-auto">
          <ExportBar filters={filters} />
        </div>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Cost base (AUD)" value={money(totals.costBaseAud)} />
        <Stat label="Market value (AUD)" value={money(totals.marketValueAud)} />
        <Stat
          label="Unrealised (AUD)"
          value={money(totals.unrealisedAud)}
          accent={
            totals.unrealisedAud == null
              ? undefined
              : totals.unrealisedAud >= 0
                ? "up"
                : "down"
          }
        />
      </div>

      {fx["AUDUSD=X"] != null && (
        <p className="mb-4 text-xs text-gray-500">
          FX AUDUSD=X {fx["AUDUSD=X"].toFixed(4)} (USD per 1 AUD)
        </p>
      )}

      <nav className="mb-4 flex flex-wrap gap-1 rounded-xl border border-gray-800 bg-gray-900/60 p-1">
        {(
          [
            ["holdings", "Holdings"],
            ["transactions", "Transactions"],
            ["import", "Import"],
            ["tax", "Tax"],
            ["planner", "Planner"],
            ["settings", "Settings"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex-1 rounded-lg px-2 py-2 text-xs sm:text-sm transition-colors duration-150 ${
              tab === id
                ? "bg-emerald-500/15 text-emerald-300"
                : "text-gray-400 hover:bg-gray-800 hover:text-emerald-200/90"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {error && (
        <div className="mb-4 rounded-lg border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {tab === "holdings" && (
        <div className="space-y-4">
          <Panel title={`Holdings · ${selectedPortfolioLabel}`}>
            <p className="mb-3 text-xs text-gray-500">
              Click a row to open that ticker’s transactions.
            </p>
            {holdings.length === 0 ? (
              <Empty hint="Import or paste trades into a portfolio." />
            ) : (
              <div className="max-h-[520px] overflow-auto rounded-lg border border-gray-800">
                <table className="w-full min-w-[800px] text-left text-sm">
                  <thead className="sticky top-0 z-10 bg-gray-900 text-xs uppercase tracking-wide text-gray-500 shadow">
                    <tr>
                      <th className="px-3 py-2.5 font-medium">Ticker</th>
                      <th className="px-3 py-2.5 font-medium">Mkt</th>
                      <th className="px-3 py-2.5 font-medium">Units</th>
                      <th className="px-3 py-2.5 font-medium">Avg cost</th>
                      <th className="px-3 py-2.5 font-medium">Price</th>
                      <th className="px-3 py-2.5 font-medium">Value</th>
                      <th className="px-3 py-2.5 font-medium">Value AUD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.map((h) => (
                      <tr
                        key={`${h.exchange}:${h.ticker}`}
                        className="cursor-pointer border-t border-gray-800/80 hover:bg-emerald-500/10"
                        onClick={() => openHoldingTrades(h)}
                      >
                        <td className="px-3 py-2.5 font-medium text-emerald-300">
                          {h.ticker}
                        </td>
                        <td className="px-3 py-2.5">
                          <ExchangeBadge
                            exchange={h.exchange}
                            currency={h.currency}
                          />
                        </td>
                        <td className="px-3 py-2.5 tabular-nums">
                          {qty(h.quantity)}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums">
                          {money(h.avgCost, h.currency)}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums">
                          {money(h.marketPrice, h.currency)}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums">
                          {money(h.marketValue, h.currency)}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums">
                          {money(h.marketValueAud)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          <PerformanceChart
            filters={filters}
            reloadToken={pricesReloadToken}
          />
        </div>
      )}

      {tab === "transactions" && (
        <Panel
          title={
            tickerFilter
              ? `Ledger · ${tickerFilter}${exchangeFilter ? ` (${exchangeFilter})` : ""}`
              : `Ledger · ${selectedPortfolioLabel}`
          }
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {tickerFilter && (
              <button
                type="button"
                className="rounded-md bg-emerald-500/15 px-2 py-1 text-xs text-emerald-300"
                onClick={() => {
                  setTickerFilter("");
                  setExchangeFilter("");
                }}
              >
                Clear ticker filter ×
              </button>
            )}
            <span className="text-xs text-gray-500">
              {sortedTxs.length} row{sortedTxs.length === 1 ? "" : "s"}
              {selectedTxIds.size > 0
                ? ` · ${selectedTxIds.size} selected`
                : ""}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              disabled={busy || selectedTxIds.size === 0}
              onClick={() => void onDeleteSelected()}
              className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs text-red-200 hover:bg-red-900/40 disabled:opacity-40"
            >
              Delete selected
            </button>
          </div>

          {sortedTxs.length === 0 ? (
            <Empty hint="No transactions for current filters." />
          ) : (
            <div
              className="overflow-auto rounded-lg border border-gray-800"
              style={{ height: TX_VIEW_H }}
              onScroll={(e) => setTxScrollTop(e.currentTarget.scrollTop)}
            >
              <table className="w-full min-w-[1000px] table-fixed text-left text-sm">
                <thead className="sticky top-0 z-10 bg-gray-900 text-xs uppercase tracking-wide text-gray-500 shadow">
                  <tr>
                    <th className="w-10 px-2 py-2.5">
                      <input
                        type="checkbox"
                        checked={
                          sortedTxs.length > 0 &&
                          sortedTxs.every((t) => selectedTxIds.has(t.id))
                        }
                        onChange={toggleSelectAllVisible}
                        aria-label="Select all"
                      />
                    </th>
                    <SortTh
                      label="Date"
                      active={txSort.key === "date"}
                      dir={txSort.dir}
                      onClick={() => toggleTxSort("date")}
                    />
                    <SortTh
                      label="Ticker"
                      active={txSort.key === "ticker"}
                      dir={txSort.dir}
                      onClick={() => toggleTxSort("ticker")}
                    />
                    <SortTh
                      label="Mkt"
                      active={txSort.key === "exchange"}
                      dir={txSort.dir}
                      onClick={() => toggleTxSort("exchange")}
                    />
                    <SortTh
                      label="Type"
                      active={txSort.key === "type"}
                      dir={txSort.dir}
                      onClick={() => toggleTxSort("type")}
                    />
                    <SortTh
                      label="Broker"
                      active={txSort.key === "broker"}
                      dir={txSort.dir}
                      onClick={() => toggleTxSort("broker")}
                    />
                    <SortTh
                      label="Source"
                      active={txSort.key === "source"}
                      dir={txSort.dir}
                      onClick={() => toggleTxSort("source")}
                    />
                    <SortTh
                      label="Qty"
                      active={txSort.key === "quantity"}
                      dir={txSort.dir}
                      onClick={() => toggleTxSort("quantity")}
                    />
                    <SortTh
                      label="Amount"
                      active={txSort.key === "amount"}
                      dir={txSort.dir}
                      onClick={() => toggleTxSort("amount")}
                    />
                  </tr>
                </thead>
                <tbody>
                  {txVirtual.padTop > 0 && (
                    <tr aria-hidden>
                      <td
                        colSpan={9}
                        style={{ height: txVirtual.padTop, padding: 0 }}
                      />
                    </tr>
                  )}
                  {txVirtual.rows.map((t) => (
                    <tr
                      key={t.id}
                      className={`border-t border-gray-800/80 ${
                        selectedTxIds.has(t.id) ? "bg-sky-500/10" : ""
                      }`}
                      style={{ height: TX_ROW_H }}
                    >
                      <td className="px-2 py-1">
                        <input
                          type="checkbox"
                          checked={selectedTxIds.has(t.id)}
                          onChange={() => toggleSelectTx(t.id)}
                          aria-label={`Select ${t.id}`}
                        />
                      </td>
                      <td className="px-2 py-1 tabular-nums text-gray-300">
                        {t.date}
                      </td>
                      <td className="px-2 py-1 font-medium">{t.ticker}</td>
                      <td className="px-2 py-1">
                        <ExchangeBadge
                          exchange={t.exchange}
                          currency={t.currency}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <TypeBadge type={t.type} />
                      </td>
                      <td className="px-2 py-1 text-xs text-gray-400">
                        {t.broker || t.custody || "—"}
                      </td>
                      <td className="max-w-[100px] truncate px-2 py-1 text-xs text-gray-500">
                        {t.source || "—"}
                      </td>
                      <td className="px-2 py-1 tabular-nums">
                        {qty(t.quantity)}
                      </td>
                      <td className="px-2 py-1 tabular-nums">
                        {money(t.amount, t.currency)}
                      </td>
                    </tr>
                  ))}
                  {txVirtual.padBottom > 0 && (
                    <tr aria-hidden>
                      <td
                        colSpan={9}
                        style={{ height: txVirtual.padBottom, padding: 0 }}
                      />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {tab === "import" && (
        <div className="space-y-4">
          <SubNav<"file" | "paste" | "manual">
            options={[
              ["file", "Import file"],
              ["paste", "Paste Sharesight"],
              ["manual", "Add trade"],
            ]}
            value={importSub}
            onChange={setImportSub}
          />

          {importSub === "file" && (
            <Panel title="Import broker / Sharesight file">
              <p className="mb-4 text-sm text-gray-400">
                Drop or choose one or more files — each imports into the
                selected <strong className="text-gray-200">portfolio</strong>.{" "}
                <strong className="text-gray-200">Auto-detect</strong> picks
                the parser per file and, when left on “Auto”, custody is
                inferred from what was detected. Override parser/custody per
                file below if needed.
              </p>
              <div className="grid gap-4 sm:grid-cols-3">
                <label className="block text-sm">
                  <span className="mb-1 block text-gray-400">Portfolio</span>
                  <select
                    className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2"
                    value={portfolioId === "all" ? "" : String(portfolioId)}
                    onChange={(e) => setPortfolioId(Number(e.target.value))}
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
                <label className="block text-sm">
                  <span className="mb-1 block text-gray-400">
                    Default parser
                  </span>
                  <select
                    className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2"
                    value={parser}
                    onChange={(e) => setParser(e.target.value)}
                  >
                    {PARSERS.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-gray-400">
                    Default custody
                  </span>
                  <select
                    className="w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2"
                    value={importBroker}
                    onChange={(e) => setImportBroker(e.target.value)}
                  >
                    {BROKERS.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="mt-2 text-xs text-gray-500">
                Auto detects Stake XLSX, broker CSVs, and (when enabled)
                issuer PDFs. Set custody per file for issuer statements.
              </p>

              <label
                onDrop={onDrop}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                className={`mt-4 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-8 text-center text-sm transition-colors ${
                  dragActive
                    ? "border-emerald-500 bg-emerald-500/10 text-emerald-200"
                    : "border-gray-700 text-gray-400 hover:border-gray-600"
                }`}
              >
                <span>Drag &amp; drop CSV/XLSX files here, or click to browse</span>
                <span className="text-xs text-gray-600">
                  Stake PDF isn’t supported — use the XLSX export from Tax &amp;
                  Documents.
                </span>
                <input
                  type="file"
                  multiple
                  accept=".csv,.xlsx,.xls,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.length) addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>

              {files.length > 0 && (
                <div className="mt-4 divide-y divide-gray-800 rounded-lg border border-gray-800">
                  {files.map((item) => (
                    <div
                      key={item.key}
                      className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
                    >
                      <div className="min-w-[140px] flex-1">
                        <div className="truncate text-gray-200">
                          {item.file.name}
                        </div>
                        <div className="text-[10px] text-gray-500">
                          {(item.file.size / 1024).toFixed(1)} KB
                        </div>
                      </div>
                      <select
                        className="rounded-lg border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300"
                        value={item.parserOverride ?? ""}
                        onChange={(e) => setItemParser(item.key, e.target.value)}
                        disabled={
                          item.status === "importing" || item.status === "done"
                        }
                      >
                        <option value="">
                          Default (
                          {PARSERS.find((p) => p.id === parser)?.label ??
                            parser}
                          )
                        </option>
                        {PARSERS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                      <select
                        className="rounded-lg border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-300"
                        value={item.custodyOverride}
                        onChange={(e) =>
                          setItemCustody(item.key, e.target.value)
                        }
                        disabled={
                          item.status === "importing" || item.status === "done"
                        }
                      >
                        <option value="">Auto (from detected broker)</option>
                        {BROKERS.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.label}
                          </option>
                        ))}
                      </select>
                      <FileStatusBadge item={item} />
                      {looksLikeStakeActivityXlsx(
                        item.file,
                        item.parserOverride,
                        parser,
                      ) && (
                        <button
                          type="button"
                          onClick={() => void onReconcile(item.key)}
                          disabled={
                            item.reconciling ||
                            item.status === "importing" ||
                            portfolioId === "all"
                          }
                          title="Read-only diff vs the ledger — does not import anything"
                          className="rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800 hover:text-emerald-200 disabled:opacity-40"
                        >
                          {item.reconciling ? "Reconciling…" : "Reconcile with ledger"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => removeFile(item.key)}
                        disabled={item.status === "importing"}
                        className="rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-800 hover:text-gray-300 disabled:opacity-40"
                      >
                        Remove
                      </button>
                      {item.status === "error" && item.error && (
                        <p className="w-full text-xs text-red-300">
                          {item.error}
                        </p>
                      )}
                      {item.status === "done" &&
                        item.result &&
                        item.result.warnings.length > 0 && (
                          <p className="w-full text-xs text-amber-200/80">
                            {item.result.warnings.length} warning
                            {item.result.warnings.length === 1 ? "" : "s"} ·{" "}
                            {item.result.warnings[0]?.message}
                          </p>
                        )}
                      {item.reconcileError && (
                        <p className="w-full text-xs text-red-300">
                          Reconcile failed: {item.reconcileError}
                        </p>
                      )}
                      {item.reconcile && (
                        <ReconcileReport
                          result={item.reconcile}
                          onClear={() =>
                            setFiles((prev) =>
                              prev.map((i) =>
                                i.key === item.key
                                  ? { ...i, reconcile: null }
                                  : i,
                              ),
                            )
                          }
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}

              <button
                type="button"
                disabled={busy || !files.some((f) => f.status === "ready")}
                onClick={() => void onImport()}
                className="mt-5 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-gray-950 hover:bg-emerald-400 disabled:opacity-50"
              >
                {busy
                  ? "Importing…"
                  : `Import ready (${
                      files.filter((f) => f.status === "ready").length
                    })`}
              </button>

              <ImportBatchSummary files={files} />
            </Panel>
          )}

          {importSub === "paste" && (
            <Panel title="Paste Sharesight holding trades">
              <p className="mb-4 text-sm text-gray-400">
                <strong className="text-gray-200">Portfolio</strong> = whose
                book (you / partner).{" "}
                <strong className="text-gray-200">Broker</strong> = where it is
                held (Stake, CommSec…). Source is recorded as{" "}
                <code className="text-gray-300">sharesight_paste</code>.
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Portfolio">
                  <select
                    className="field"
                    value={paste.portfolioId || ""}
                    onChange={(e) =>
                      setPaste((p) => ({
                        ...p,
                        portfolioId: Number(e.target.value),
                      }))
                    }
                  >
                    {portfolios.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Broker (held at)">
                  <select
                    className="field"
                    value={paste.broker}
                    onChange={(e) =>
                      setPaste((p) => ({ ...p, broker: e.target.value }))
                    }
                  >
                    {BROKERS.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Ticker">
                  <input
                    className="field"
                    value={paste.ticker}
                    onChange={(e) =>
                      setPaste((p) => ({ ...p, ticker: e.target.value }))
                    }
                    placeholder="TSLA"
                  />
                </Field>
                <Field label="Exchange">
                  <select
                    className="field"
                    value={paste.exchange}
                    onChange={(e) =>
                      setPaste((p) => ({ ...p, exchange: e.target.value }))
                    }
                  >
                    <option value="US">US</option>
                    <option value="ASX">ASX</option>
                    <option value="LSE">LSE</option>
                  </select>
                </Field>
              </div>
              <Field label="Paste trades">
                <textarea
                  className="field mt-1 min-h-[220px] font-mono text-xs"
                  placeholder={`10 Jun 2025\nBuy\n1.00889087\nUS$312.68\n...`}
                  value={paste.text}
                  onChange={(e) =>
                    setPaste((p) => ({ ...p, text: e.target.value }))
                  }
                />
              </Field>
              <button
                type="button"
                disabled={busy || !paste.text.trim()}
                onClick={() => void onPasteImport()}
                className="mt-4 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-gray-950 hover:bg-emerald-400 disabled:opacity-50"
              >
                {busy ? "Importing…" : "Import paste"}
              </button>
              {pasteResult && (
                <p className="mt-3 text-sm text-emerald-300">
                  Parsed {pasteResult.parsed}, imported {pasteResult.imported},
                  duplicates skipped {pasteResult.duplicatesSkipped}
                </p>
              )}
            </Panel>
          )}

          {importSub === "manual" && (
            <Panel title="Add trade manually">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Portfolio">
                  <select
                    className="field"
                    value={manual.portfolioId || ""}
                    onChange={(e) =>
                      setManual((m) => ({
                        ...m,
                        portfolioId: Number(e.target.value),
                      }))
                    }
                  >
                    {portfolios.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Broker">
                  <select
                    className="field"
                    value={manual.broker}
                    onChange={(e) =>
                      setManual((m) => ({ ...m, broker: e.target.value }))
                    }
                  >
                    {BROKERS.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Date">
                  <input
                    type="date"
                    className="field"
                    value={manual.date}
                    onChange={(e) =>
                      setManual((m) => ({ ...m, date: e.target.value }))
                    }
                  />
                </Field>
                <Field label="Ticker">
                  <input
                    className="field"
                    placeholder="VAS or AAPL"
                    value={manual.ticker}
                    onChange={(e) =>
                      setManual((m) => ({ ...m, ticker: e.target.value }))
                    }
                  />
                </Field>
                <Field label="Exchange">
                  <select
                    className="field"
                    value={manual.exchange}
                    onChange={(e) => {
                      const exchange = e.target.value;
                      setManual((m) => ({
                        ...m,
                        exchange,
                        currency:
                          exchange === "US"
                            ? "USD"
                            : exchange === "LSE"
                              ? "GBP"
                              : "AUD",
                      }));
                    }}
                  >
                    <option value="ASX">ASX</option>
                    <option value="US">US</option>
                    <option value="LSE">LSE</option>
                  </select>
                </Field>
                <Field label="Type">
                  <select
                    className="field"
                    value={manual.type}
                    onChange={(e) =>
                      setManual((m) => ({ ...m, type: e.target.value }))
                    }
                  >
                    {TX_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Currency">
                  <select
                    className="field"
                    value={manual.currency}
                    onChange={(e) =>
                      setManual((m) => ({ ...m, currency: e.target.value }))
                    }
                  >
                    <option value="AUD">AUD</option>
                    <option value="USD">USD</option>
                    <option value="GBP">GBP</option>
                  </select>
                </Field>
                <Field label="Quantity">
                  <input
                    className="field"
                    inputMode="decimal"
                    value={manual.quantity}
                    onChange={(e) =>
                      setManual((m) => ({ ...m, quantity: e.target.value }))
                    }
                  />
                </Field>
                <Field label="Price">
                  <input
                    className="field"
                    inputMode="decimal"
                    value={manual.price}
                    onChange={(e) =>
                      setManual((m) => ({ ...m, price: e.target.value }))
                    }
                  />
                </Field>
                <Field label="Notes">
                  <input
                    className="field"
                    value={manual.notes}
                    onChange={(e) =>
                      setManual((m) => ({ ...m, notes: e.target.value }))
                    }
                  />
                </Field>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onManualSave()}
                className="mt-5 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-gray-950 hover:bg-emerald-400 disabled:opacity-50"
              >
                Save transaction
              </button>
            </Panel>
          )}
        </div>
      )}

      {tab === "tax" && (
        <div className="space-y-4">
          <SubNav<"profiles" | "drp">
            options={[
              ["profiles", "Tax profiles"],
              ["drp", "DRP check"],
            ]}
            value={taxSub}
            onChange={setTaxSub}
          />
          {taxSub === "profiles" && <TaxSettingsPanel />}
          {taxSub === "drp" && (
            <DrpCheckPanel
              portfolioId={portfolioId === "all" ? undefined : portfolioId}
              holdings={holdings}
            />
          )}
        </div>
      )}

      {tab === "planner" && <PlannerPanel />}

      {tab === "settings" && (
        <div className="space-y-4">
          <Panel title="Portfolios">
            <p className="mb-4 text-sm text-gray-400">
              A portfolio is an ownership book (you, partner, SMSF). Each can
              include trades from many brokers. Switch the active book with the
              filter bar above.
            </p>
            <ul className="mb-4 space-y-2 text-sm">
              {portfolios.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between rounded-lg border border-gray-800 px-3 py-2"
                >
                  <span className="font-medium text-gray-100">{p.name}</span>
                  <span className="text-xs text-gray-500">{p.notes}</span>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <input
                className="field max-w-xs"
                placeholder="New portfolio name"
                value={newPortfolioName}
                onChange={(e) => setNewPortfolioName(e.target.value)}
              />
              <button
                type="button"
                disabled={busy || !newPortfolioName.trim()}
                onClick={() => void onCreatePortfolio()}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-gray-950 hover:bg-emerald-400 disabled:opacity-50"
              >
                Create portfolio
              </button>
            </div>
          </Panel>
          <SettingsPanel />
        </div>
      )}

      <div className="mt-8">
        <Disclaimer compact />
      </div>

      <footer className="mt-4 text-center text-xs text-gray-600">
        Local-only · SQLite · Yahoo prices · Not financial advice
      </footer>

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
    </div>
  );
}

function formatYahooWait(seconds: number): string {
  if (seconds <= 0) return "ready";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function YahooStatusBadge({
  status,
  busy,
  onRefresh,
  onClearCooldown,
}: {
  status: YahooStatus | null;
  busy: boolean;
  onRefresh: () => void;
  onClearCooldown: () => void;
}) {
  const cooling = status?.state === "cooling" && (status.waitSeconds ?? 0) > 0;
  const badgeClass = cooling
    ? "border-amber-800/60 bg-amber-950/40 text-amber-100"
    : "border-emerald-800/50 bg-emerald-950/30 text-emerald-200";

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <div
        className={`rounded-lg border px-2.5 py-1.5 text-xs ${badgeClass}`}
        title={status?.note ?? "Yahoo status"}
      >
        <div className="font-medium">
          {status?.label ?? "Yahoo status…"}
        </div>
        {cooling && status?.lastError && (
          <div className="mt-0.5 max-w-[220px] truncate text-[10px] text-amber-200/70">
            {status.lastError}
          </div>
        )}
        {!cooling && status?.lastOkAt && (
          <div className="mt-0.5 text-[10px] text-emerald-200/60">
            Last OK {status.lastOkAt.slice(0, 16).replace("T", " ")} UTC
          </div>
        )}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={onRefresh}
        className={`rounded-lg border px-3 py-2 text-sm disabled:opacity-50 ${
          cooling
            ? "border-amber-700/50 bg-amber-950/30 text-amber-100 hover:bg-amber-900/40"
            : "border-gray-600 bg-gray-800 hover:bg-gray-700"
        }`}
      >
        {busy
          ? "Refreshing…"
          : cooling
            ? `Wait ${formatYahooWait(status!.waitSeconds)} (or force)`
            : "Refresh Yahoo prices + FX"}
      </button>
      {cooling && (
        <button
          type="button"
          disabled={busy}
          onClick={onClearCooldown}
          className="rounded-lg border border-gray-700 bg-gray-900 px-2 py-2 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-50"
          title="Clear local cool-down timer only — does not unblock Yahoo’s servers"
        >
          Clear timer
        </button>
      )}
    </div>
  );
}

function sortValue(t: TxRow, key: TxSortKey): string | number {
  switch (key) {
    case "date":
      return t.date;
    case "ticker":
      return t.ticker;
    case "exchange":
      return t.exchange;
    case "type":
      return t.type;
    case "broker":
      return (t.broker || t.custody || "").toLowerCase();
    case "source":
      return (t.source || "").toLowerCase();
    case "quantity":
      return t.quantity;
    case "amount":
      return t.amount ?? 0;
    default:
      return t.date;
  }
}

function SortTh({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <th className="px-2 py-2.5 font-medium">
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 hover:text-gray-200 ${
          active ? "text-emerald-300" : ""
        }`}
      >
        {label}
        {active ? (dir === "asc" ? " ↑" : " ↓") : ""}
      </button>
    </th>
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
      <span className="mb-1 block text-gray-400">{label}</span>
      {children}
    </label>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "up" | "down";
}) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p
        className={`mt-1 text-xl font-semibold tabular-nums ${
          accent === "up"
            ? "text-emerald-300"
            : accent === "down"
              ? "text-red-300"
              : "text-gray-100"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function SubNav<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<[T, string]>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 rounded-xl border border-gray-800 bg-gray-950/50 p-1">
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`rounded-lg px-3 py-1.5 text-sm transition-colors duration-150 ${
            value === id
              ? "bg-gray-800 text-emerald-300"
              : "text-gray-400 hover:bg-gray-800/80 hover:text-emerald-200/90"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-gray-800 bg-gray-900/40 p-5 shadow-xl shadow-black/20">
      <h2 className="mb-4 text-lg font-medium text-gray-100">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ hint }: { hint: string }) {
  return <p className="text-sm text-gray-500">{hint}</p>;
}

function FileStatusBadge({ item }: { item: FileQueueItem }) {
  const base =
    "inline-block rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide";
  switch (item.status) {
    case "ready":
      return (
        <span className={`${base} bg-emerald-500/15 text-emerald-300`}>
          Ready
        </span>
      );
    case "needs_custody":
      return (
        <span className={`${base} bg-amber-500/15 text-amber-200`}>
          Set custody
        </span>
      );
    case "unsupported":
      return (
        <span
          className={`${base} bg-red-500/15 text-red-300`}
          title="Use Stake XLSX from Tax & Documents, not the PDF."
        >
          Unsupported
        </span>
      );
    case "importing":
      return (
        <span className={`${base} bg-gray-500/20 text-gray-300`}>
          Importing…
        </span>
      );
    case "done":
      return (
        <span className={`${base} bg-emerald-500/15 text-emerald-300`}>
          {item.result
            ? `Imported ${item.result.imported}/${item.result.parsed}`
            : "Done"}
        </span>
      );
    case "error":
      return (
        <span
          className={`${base} bg-red-500/15 text-red-300`}
          title={item.error ?? undefined}
        >
          Error
        </span>
      );
  }
}

function ImportBatchSummary({ files }: { files: FileQueueItem[] }) {
  const done = files.filter((f) => f.status === "done" && f.result);
  const errored = files.filter((f) => f.status === "error");
  const unsupported = files.filter((f) => f.status === "unsupported");
  if (!done.length && !errored.length) return null;
  const totals = done.reduce(
    (acc, f) => ({
      imported: acc.imported + (f.result?.imported ?? 0),
      parsed: acc.parsed + (f.result?.parsed ?? 0),
      duplicatesSkipped: acc.duplicatesSkipped + (f.result?.duplicatesSkipped ?? 0),
    }),
    { imported: 0, parsed: 0, duplicatesSkipped: 0 },
  );
  return (
    <div className="mt-3 rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2 text-sm">
      {done.length > 0 && (
        <p className="text-emerald-300">
          Imported {totals.imported} / {totals.parsed} across {done.length}{" "}
          file{done.length === 1 ? "" : "s"} · {totals.duplicatesSkipped}{" "}
          duplicates skipped
        </p>
      )}
      {errored.length > 0 && (
        <p className="mt-1 text-red-300">
          {errored.length} file{errored.length === 1 ? "" : "s"} failed to
          import
        </p>
      )}
      {unsupported.length > 0 && (
        <p className="mt-1 text-gray-500">
          {unsupported.length} unsupported file
          {unsupported.length === 1 ? "" : "s"} skipped
        </p>
      )}
    </div>
  );
}

/**
 * Phase 5 reconcile report (docs/import-layouts-plan.md §12). Read-only —
 * shows counts + the actual mismatched/unmatched rows so the operator can
 * decide what (if anything) to import or fix by hand. No import action here
 * in v1 per the plan's "don't overbuild" guidance — Transactions tab already
 * covers editing/importing.
 */
function ReconcileReport({
  result,
  onClear,
}: {
  result: ReconcileResult;
  onClear: () => void;
}) {
  return (
    <div className="mt-2 w-full rounded-lg border border-gray-800 bg-gray-900/60 p-3 text-xs">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-300">
            {result.matched} matched
          </span>
          <span className="rounded-md bg-gray-700/40 px-2 py-0.5 text-gray-300">
            {result.fileOnly.length} file-only
          </span>
          <span className="rounded-md bg-gray-700/40 px-2 py-0.5 text-gray-300">
            {result.ledgerOnly.length} ledger-only
          </span>
          <span
            className={`rounded-md px-2 py-0.5 ${
              result.conflicts.length
                ? "bg-red-500/15 text-red-300"
                : "bg-gray-700/40 text-gray-300"
            }`}
          >
            {result.conflicts.length} conflict
            {result.conflicts.length === 1 ? "" : "s"}
          </span>
          {result.period && (
            <span className="text-gray-500">
              Statement {result.period.from} → {result.period.to}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClear}
          className="rounded-md px-2 py-0.5 text-gray-500 hover:bg-gray-800 hover:text-gray-300"
        >
          Dismiss
        </button>
      </div>

      {result.conflicts.length > 0 && (
        <ReconcileTable title="Conflicts (matched, but a field differs)">
          <table className="w-full text-left">
            <thead className="text-gray-500">
              <tr>
                <th className="py-1 pr-2">Date</th>
                <th className="py-1 pr-2">Ticker</th>
                <th className="py-1 pr-2">Field(s)</th>
                <th className="py-1 pr-2">File</th>
                <th className="py-1 pr-2">Ledger</th>
              </tr>
            </thead>
            <tbody>
              {result.conflicts.map((c, i) => (
                <tr key={i} className="border-t border-gray-800/80">
                  <td className="py-1 pr-2 text-gray-300">{c.file.date}</td>
                  <td className="py-1 pr-2 text-gray-300">{c.file.ticker}</td>
                  <td className="py-1 pr-2 text-amber-300">
                    {c.fields.join(", ")}
                  </td>
                  <td className="py-1 pr-2 text-gray-400">
                    {c.file.type} · qty {c.file.quantity} · price{" "}
                    {c.file.price ?? "—"}
                  </td>
                  <td className="py-1 pr-2 text-gray-400">
                    {c.ledger.type} · qty {c.ledger.quantity} · price{" "}
                    {c.ledger.price ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ReconcileTable>
      )}

      {result.fileOnly.length > 0 && (
        <ReconcileTable title="File-only (in the XLSX, not found in the ledger)">
          <table className="w-full text-left">
            <thead className="text-gray-500">
              <tr>
                <th className="py-1 pr-2">Date</th>
                <th className="py-1 pr-2">Ticker</th>
                <th className="py-1 pr-2">Type</th>
                <th className="py-1 pr-2">Qty</th>
                <th className="py-1 pr-2">Price</th>
                <th className="py-1 pr-2">External ID</th>
              </tr>
            </thead>
            <tbody>
              {result.fileOnly.map((t, i) => (
                <tr key={i} className="border-t border-gray-800/80">
                  <td className="py-1 pr-2 text-gray-300">{t.date}</td>
                  <td className="py-1 pr-2 text-gray-300">{t.ticker}</td>
                  <td className="py-1 pr-2 text-gray-400">{t.type}</td>
                  <td className="py-1 pr-2 text-gray-400">{t.quantity}</td>
                  <td className="py-1 pr-2 text-gray-400">{t.price ?? "—"}</td>
                  <td className="py-1 pr-2 text-gray-500">
                    {t.externalId ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ReconcileTable>
      )}

      {result.ledgerOnly.length > 0 && (
        <ReconcileTable title="Ledger-only (in the ledger within the statement period, not in the file)">
          <table className="w-full text-left">
            <thead className="text-gray-500">
              <tr>
                <th className="py-1 pr-2">Date</th>
                <th className="py-1 pr-2">Ticker</th>
                <th className="py-1 pr-2">Type</th>
                <th className="py-1 pr-2">Qty</th>
                <th className="py-1 pr-2">Price</th>
                <th className="py-1 pr-2">External ID</th>
              </tr>
            </thead>
            <tbody>
              {result.ledgerOnly.map((l) => (
                <tr key={l.id} className="border-t border-gray-800/80">
                  <td className="py-1 pr-2 text-gray-300">{l.date}</td>
                  <td className="py-1 pr-2 text-gray-300">{l.ticker}</td>
                  <td className="py-1 pr-2 text-gray-400">{l.type}</td>
                  <td className="py-1 pr-2 text-gray-400">{l.quantity}</td>
                  <td className="py-1 pr-2 text-gray-400">{l.price ?? "—"}</td>
                  <td className="py-1 pr-2 text-gray-500">
                    {l.external_id ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ReconcileTable>
      )}
    </div>
  );
}

function ReconcileTable({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3 last:mb-0">
      <p className="mb-1 text-gray-500">{title}</p>
      <div className="max-h-48 overflow-auto rounded-md border border-gray-800/80">
        {children}
      </div>
    </div>
  );
}

function ExchangeBadge({
  exchange,
  currency,
}: {
  exchange: string;
  currency: string;
}) {
  const us = exchange === "US" || currency === "USD";
  return (
    <span
      className={`inline-block rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        us
          ? "bg-blue-500/15 text-blue-300"
          : exchange === "ASX"
            ? "bg-amber-500/15 text-amber-200"
            : "bg-gray-500/20 text-gray-300"
      }`}
    >
      {exchange}
    </span>
  );
}

function TypeBadge({ type }: { type: string }) {
  const styles: Record<string, string> = {
    buy: "bg-sky-500/15 text-sky-300",
    sell: "bg-orange-500/15 text-orange-300",
    drp: "bg-emerald-500/15 text-emerald-300",
    dividend_cash: "bg-violet-500/15 text-violet-300",
  };
  return (
    <span
      className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${
        styles[type] ?? "bg-gray-700 text-gray-300"
      }`}
    >
      {type}
    </span>
  );
}
