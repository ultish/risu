import { fxYahooSymbol } from "./market.js";
import type { DividendEvent, PriceBar } from "./types.js";

const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_CHART_QUERY2 = "https://query2.finance.yahoo.com/v8/finance/chart";
const YAHOO_QUOTE = "https://query1.finance.yahoo.com/v7/finance/quote";
const YAHOO_QUOTE_Q2 = "https://query2.finance.yahoo.com/v7/finance/quote";
const YAHOO_SPARK = "https://query1.finance.yahoo.com/v8/finance/spark";
const YAHOO_SPARK_Q2 = "https://query2.finance.yahoo.com/v8/finance/spark";

/** Prefer bulk multi-symbol calls; keep chunks small when IP is fragile. */
export const YAHOO_BULK_CHUNK = 20;

/**
 * Yahoo's unofficial APIs block plain HTTP clients (curl / Node fetch) at
 * the TLS/handshake level even with browser-identical headers, while a real
 * browser request succeeds. Callers (apps/api) can swap this default for a
 * real-browser-backed fetch (see apps/api/src/yahooBrowserFetch.ts) so every
 * Yahoo call below goes through it without threading fetchImpl everywhere.
 */
let yahooDefaultFetch: typeof fetch = fetch;

export function setYahooFetchImpl(impl: typeof fetch) {
  yahooDefaultFetch = impl;
}

/** Browser-like headers — Yahoo often 401s scrapers / bare clients. */
const YAHOO_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "application/json,text/plain,*/*",
  "Accept-Language": "en-AU,en;q=0.9",
  // Chart/quote sometimes want a referer
  Referer: "https://finance.yahoo.com/",
  Origin: "https://finance.yahoo.com",
};

/**
 * Yahoo often requires a session cookie + crumb for v7 quote (and sometimes
 * chart). Cached ~45 minutes per process.
 */
type YahooSession = {
  cookie: string;
  crumb: string;
  fetchedAt: number;
};

let yahooSession: YahooSession | null = null;
const SESSION_TTL_MS = 45 * 60 * 1000;

/** Drop cached crumb/cookie (call after 401 Invalid Cookie). */
export function clearYahooSession() {
  yahooSession = null;
}

async function ensureYahooSession(
  fetchImpl: typeof fetch,
): Promise<YahooSession | null> {
  if (
    yahooSession &&
    Date.now() - yahooSession.fetchedAt < SESSION_TTL_MS &&
    yahooSession.cookie &&
    yahooSession.crumb
  ) {
    return yahooSession;
  }

  // 1) Best-effort cookie seed (A1 / A3 etc.). A browser-backed fetchImpl
  // already carries cookies in its own jar regardless of whether this call
  // succeeds, so failure here shouldn't abort session setup.
  let cookie = "";
  try {
    const fc = await fetchImpl("https://fc.yahoo.com", {
      headers: YAHOO_HEADERS,
      redirect: "manual",
    });
    const cookies: string[] = [];
    if (typeof fc.headers.getSetCookie === "function") {
      for (const c of fc.headers.getSetCookie()) {
        const part = c.split(";")[0]?.trim();
        if (part) cookies.push(part);
      }
    } else {
      const raw = fc.headers.get("set-cookie");
      if (raw) {
        // Best-effort single header parse
        for (const piece of raw.split(/,(?=\s*[^;]+=)/)) {
          const part = piece.split(";")[0]?.trim();
          if (part) cookies.push(part);
        }
      }
    }
    cookie = cookies.join("; ");
  } catch {
    /* best-effort; fall through to crumb fetch regardless */
  }

  try {
    // 2) Crumb for quote API
    const crumbRes = await fetchImpl(
      "https://query2.finance.yahoo.com/v1/test/getcrumb",
      {
        headers: {
          ...YAHOO_HEADERS,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
    );
    if (!crumbRes.ok) {
      yahooSession = null;
      return null;
    }
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length > 200 || crumb.includes("<")) {
      yahooSession = null;
      return null;
    }

    yahooSession = { cookie, crumb, fetchedAt: Date.now() };
    return yahooSession;
  } catch {
    yahooSession = null;
    return null;
  }
}

function authHeaders(session: YahooSession | null): Record<string, string> {
  if (!session) return { ...YAHOO_HEADERS };
  return {
    ...YAHOO_HEADERS,
    Cookie: session.cookie,
  };
}

export type YahooQuoteSnapshot = {
  symbol: string;
  price: number;
  currency: string | null;
  /** Company/fund display name, when Yahoo's quote response includes one. */
  name?: string | null;
};

function chunkSymbols(symbols: string[], size = YAHOO_BULK_CHUNK): string[][] {
  const uniq = [
    ...new Set(
      symbols.map((s) => s.trim()).filter((s) => s.length > 0),
    ),
  ];
  const out: string[][] = [];
  for (let i = 0; i < uniq.length; i += size) {
    out.push(uniq.slice(i, i + size));
  }
  return out;
}

/** Normalise user tickers to Yahoo symbols */
export function toYahooSymbol(ticker: string, exchange = "ASX"): string {
  const t = ticker.trim().toUpperCase();
  if (t.includes("=")) return t; // FX pairs
  if (t.endsWith(".AX") || t.endsWith(".AU")) return t.replace(/\.AU$/i, ".AX");
  if (t.includes(".")) return t;

  const ex = exchange.toUpperCase();
  if (ex === "ASX" || ex === "AU") return `${t}.AX`;
  if (ex === "LSE" || ex === "LON") return `${t}.L`;
  // US and others: bare ticker
  return t;
}

export function fromYahooSymbol(symbol: string): {
  ticker: string;
  exchange: string;
} {
  const s = symbol.toUpperCase();
  if (s.endsWith(".AX")) return { ticker: s.slice(0, -3), exchange: "ASX" };
  if (s.endsWith(".L")) return { ticker: s.slice(0, -2), exchange: "LSE" };
  if (s.includes("=X")) return { ticker: s, exchange: "FX" };
  return { ticker: s, exchange: "US" };
}

type YahooDivEvent = { amount?: number; date?: number };
type YahooChartResult = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      events?: {
        dividends?: Record<string, YahooDivEvent>;
        splits?: Record<string, unknown>;
      };
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
        adjclose?: Array<{ adjclose?: Array<number | null> }>;
      };
      meta?: { regularMarketPrice?: number; symbol?: string };
    }>;
    error?: { description?: string };
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Structured Yahoo HTTP failure so the API can set cool-down timers. */
export class YahooHttpError extends Error {
  readonly status: number;
  readonly symbol: string;
  /** From Retry-After header when present (seconds). */
  readonly retryAfterSeconds: number | null;
  /** Last request URL attempted (crumb stripped when possible). */
  readonly url: string | null;

  constructor(
    message: string,
    opts: {
      status: number;
      symbol: string;
      retryAfterSeconds?: number | null;
      url?: string | null;
    },
  ) {
    super(message);
    this.name = "YahooHttpError";
    this.status = opts.status;
    this.symbol = opts.symbol;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
    this.url = opts.url ?? null;
  }
}

/** Drop session crumb so the URL is safe to open in a normal browser tab. */
export function stripYahooCrumb(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("crumb");
    return u.toString();
  } catch {
    return url;
  }
}

/** Browser-friendly bulk history URL (spark). */
export function buildYahooSparkHistoryUrl(
  symbols: string[],
  range = "1y",
): string {
  const joined = [
    ...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean)),
  ].join(",");
  const url = new URL(YAHOO_SPARK);
  url.searchParams.set("symbols", joined);
  url.searchParams.set("range", range);
  url.searchParams.set("interval", "1d");
  return url.toString();
}

/** Browser-friendly single-symbol chart history URL. */
export function buildYahooChartHistoryUrl(
  symbol: string,
  opts: { period1?: Date; period2?: Date; rangeDays?: number } = {},
): string {
  const period2 = opts.period2 ?? new Date();
  const period1 =
    opts.period1 ??
    new Date(
      period2.getTime() -
        1000 * 60 * 60 * 24 * (opts.rangeDays ?? 365),
    );
  const url = new URL(`${YAHOO_CHART}/${encodeURIComponent(symbol)}`);
  url.searchParams.set("interval", "1d");
  url.searchParams.set(
    "period1",
    String(Math.floor(period1.getTime() / 1000)),
  );
  url.searchParams.set(
    "period2",
    String(Math.floor(period2.getTime() / 1000)),
  );
  url.searchParams.set("events", "div|split");
  url.searchParams.set("includePrePost", "false");
  return url.toString();
}

/** Browser-friendly bulk quote URL (often needs cookies in Node; browser OK). */
export function buildYahooQuoteUrl(symbols: string[]): string {
  const joined = [
    ...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean)),
  ].join(",");
  const url = new URL(YAHOO_QUOTE);
  url.searchParams.set("symbols", joined);
  url.searchParams.set(
    "fields",
    "regularMarketPrice,currency,symbol,longName,shortName",
  );
  return url.toString();
}

function barsFromCloseSeries(
  timestamps: number[],
  closes: Array<number | null | undefined>,
  ohlc?: {
    open?: Array<number | null | undefined>;
    high?: Array<number | null | undefined>;
    low?: Array<number | null | undefined>;
    volume?: Array<number | null | undefined>;
    adjClose?: Array<number | null | undefined>;
  },
): PriceBar[] {
  const bars: PriceBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close == null || Number.isNaN(Number(close))) continue;
    const c = Number(close);
    const d = new Date(timestamps[i]! * 1000);
    bars.push({
      date: d.toISOString().slice(0, 10),
      open: Number(ohlc?.open?.[i] ?? c),
      high: Number(ohlc?.high?.[i] ?? c),
      low: Number(ohlc?.low?.[i] ?? c),
      close: c,
      adjClose: Number(ohlc?.adjClose?.[i] ?? c),
      volume: Number(ohlc?.volume?.[i] ?? 0),
    });
  }
  return bars;
}

/**
 * Parse Yahoo chart JSON (single symbol) into price bars.
 * Accepts the full API body or `{ chart: … }`.
 */
export function parseYahooChartPayload(
  data: unknown,
  symbolHint?: string,
): { symbol: string; bars: PriceBar[] } | null {
  const root = data as {
    chart?: {
      result?: Array<{
        meta?: { symbol?: string; regularMarketPrice?: number };
        timestamp?: number[];
        indicators?: {
          quote?: Array<{
            open?: Array<number | null>;
            high?: Array<number | null>;
            low?: Array<number | null>;
            close?: Array<number | null>;
            volume?: Array<number | null>;
          }>;
          adjclose?: Array<{ adjclose?: Array<number | null> }>;
        };
      }>;
    };
  };
  const result = root.chart?.result?.[0];
  if (!result?.timestamp?.length) return null;
  const quote = result.indicators?.quote?.[0];
  const adj = result.indicators?.adjclose?.[0]?.adjclose;
  const symbol = (
    result.meta?.symbol ||
    symbolHint ||
    ""
  ).toUpperCase();
  if (!symbol || !quote?.close) return null;
  const bars = barsFromCloseSeries(result.timestamp, quote.close, {
    open: quote.open,
    high: quote.high,
    low: quote.low,
    volume: quote.volume,
    adjClose: adj,
  });
  if (!bars.length) return null;
  return { symbol, bars };
}

/**
 * Parse Yahoo spark JSON (multi-symbol history) into per-symbol bars.
 */
export function parseYahooSparkPayload(
  data: unknown,
): Map<string, PriceBar[]> {
  const out = new Map<string, PriceBar[]>();
  const root = data as {
    spark?: {
      result?: Array<{
        symbol?: string;
        response?: Array<{
          timestamp?: number[];
          indicators?: {
            quote?: Array<{ close?: Array<number | null> }>;
          };
          meta?: { symbol?: string };
        }>;
        timestamp?: number[];
        close?: Array<number | null>;
      }>;
    };
  };
  for (const item of root.spark?.result ?? []) {
    const sym = (
      item.symbol ||
      item.response?.[0]?.meta?.symbol ||
      ""
    ).toUpperCase();
    if (!sym) continue;
    let timestamps: number[] | undefined;
    let closes: Array<number | null> | undefined;
    const resp = item.response?.[0];
    if (resp?.timestamp?.length) {
      timestamps = resp.timestamp;
      closes = resp.indicators?.quote?.[0]?.close;
    } else if (item.timestamp?.length) {
      timestamps = item.timestamp;
      closes = item.close;
    }
    if (!timestamps?.length || !closes?.length) {
      out.set(sym, []);
      continue;
    }
    out.set(sym, barsFromCloseSeries(timestamps, closes));
  }
  return out;
}

/**
 * Parse Yahoo v7 quote JSON into symbol → last price.
 */
export function parseYahooQuotePayload(
  data: unknown,
): Map<string, YahooQuoteSnapshot> {
  const out = new Map<string, YahooQuoteSnapshot>();
  const root = data as {
    quoteResponse?: {
      result?: Array<{
        symbol?: string;
        regularMarketPrice?: number;
        currency?: string;
        longName?: string;
        shortName?: string;
      }>;
    };
  };
  for (const row of root.quoteResponse?.result ?? []) {
    const sym = (row.symbol || "").toUpperCase();
    const price = Number(row.regularMarketPrice);
    if (!sym || !Number.isFinite(price)) continue;
    out.set(sym, {
      symbol: sym,
      price,
      currency: row.currency ?? null,
      name: row.longName || row.shortName || null,
    });
  }
  return out;
}

export type YahooImportKind = "chart" | "spark" | "quote";

/**
 * Auto-detect chart / spark / quote payload and normalise to bars + quotes.
 * Used by manual paste import when Yahoo is cool-downed in Node.
 */
export function parseYahooManualPayload(
  data: unknown,
  symbolHint?: string,
): {
  kind: YahooImportKind;
  barsBySymbol: Map<string, PriceBar[]>;
  quotes: Map<string, YahooQuoteSnapshot>;
} {
  const barsBySymbol = new Map<string, PriceBar[]>();
  const quotes = new Map<string, YahooQuoteSnapshot>();

  const asObj = data as Record<string, unknown> | null;
  if (asObj && typeof asObj === "object") {
    if (asObj.chart) {
      const parsed = parseYahooChartPayload(data, symbolHint);
      if (parsed) {
        barsBySymbol.set(parsed.symbol, parsed.bars);
        const last = parsed.bars[parsed.bars.length - 1];
        if (last) {
          quotes.set(parsed.symbol, {
            symbol: parsed.symbol,
            price: last.close,
            currency: null,
          });
        }
        return { kind: "chart", barsBySymbol, quotes };
      }
    }
    if (asObj.spark) {
      const spark = parseYahooSparkPayload(data);
      for (const [sym, bars] of spark) {
        barsBySymbol.set(sym, bars);
        const last = bars[bars.length - 1];
        if (last) {
          quotes.set(sym, {
            symbol: sym,
            price: last.close,
            currency: null,
          });
        }
      }
      return { kind: "spark", barsBySymbol, quotes };
    }
    if (asObj.quoteResponse) {
      const q = parseYahooQuotePayload(data);
      for (const [sym, snap] of q) quotes.set(sym, snap);
      return { kind: "quote", barsBySymbol, quotes };
    }
  }
  throw new Error(
    "Unrecognised Yahoo JSON — paste full body from chart, spark, or quote URL (must include chart / spark / quoteResponse).",
  );
}

export function isYahooHttpError(e: unknown): e is YahooHttpError {
  if (e instanceof YahooHttpError) return true;
  // Cross-bundle instanceof can fail; duck-type
  return (
    typeof e === "object" &&
    e != null &&
    (e as { name?: string }).name === "YahooHttpError" &&
    typeof (e as { status?: unknown }).status === "number"
  );
}

function parseRetryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const asInt = Number(raw);
  if (Number.isFinite(asInt) && asInt >= 0) {
    return Math.min(Math.floor(asInt), 24 * 3600);
  }
  const when = Date.parse(raw);
  if (!Number.isNaN(when)) {
    const sec = Math.ceil((when - Date.now()) / 1000);
    return sec > 0 ? Math.min(sec, 24 * 3600) : null;
  }
  return null;
}

/**
 * Yahoo's unofficial APIs rate-limit aggressively (429). Prefer **bulk**
 * multi-symbol endpoints; use crumb session when available; few retries.
 * Callers must prefer DB cache and stop on cool-down.
 */
async function yahooFetchJson(
  buildUrls: (session: YahooSession | null) => string[],
  label: string,
  fetchImpl: typeof fetch,
  opts: { useSession?: boolean } = {},
): Promise<unknown> {
  let lastStatus = 0;
  let lastBody = "";
  let lastRetryAfter: number | null = null;
  let lastUrl: string | null = null;
  /** At most 2 attempts — more retries worsen bans. */
  const maxAttempts = 2;
  const useSession = opts.useSession !== false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // Only short blip wait; long bans are handled by app cool-down
      await sleep(
        lastRetryAfter != null && lastRetryAfter > 0 && lastRetryAfter < 15
          ? lastRetryAfter * 1000
          : 1500,
      );
      if (lastStatus === 401 || lastStatus === 403) {
        clearYahooSession();
      }
    }

    const session = useSession
      ? await ensureYahooSession(fetchImpl)
      : null;
    const urls = buildUrls(session);
    const headers = authHeaders(session);

    for (const url of urls) {
      lastUrl = stripYahooCrumb(url);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          headers,
          redirect: "follow",
        });
      } catch (e) {
        lastBody = e instanceof Error ? e.message : String(e);
        lastStatus = 0;
        continue;
      }
      lastStatus = res.status;
      if (res.ok) {
        return await res.json();
      }
      const ra = parseRetryAfterSeconds(res);
      if (ra != null) lastRetryAfter = ra;
      lastBody = (await res.text().catch(() => "")).slice(0, 200);
      // Invalid cookie/crumb — refresh session next attempt
      if (
        (res.status === 401 || res.status === 403) &&
        /crumb|cookie/i.test(lastBody)
      ) {
        clearYahooSession();
      }
      if (![401, 403, 429].includes(res.status)) {
        break;
      }
    }

    if (lastStatus !== 429 && lastStatus !== 401 && lastStatus !== 403) {
      break;
    }
  }

  const urlNote = lastUrl ? ` URL: ${lastUrl}` : "";
  if (lastStatus === 401 || lastStatus === 403) {
    throw new YahooHttpError(
      `Yahoo blocked the request for ${label} (HTTP ${lastStatus}). Wait out cool-down; use cached prices. Import dividends/DRP from broker if needed.${urlNote}`,
      {
        status: lastStatus,
        symbol: label,
        // Long default — IP bans are often hours
        retryAfterSeconds: lastRetryAfter ?? 60 * 60,
        url: lastUrl,
      },
    );
  }
  if (lastStatus === 429) {
    throw new YahooHttpError(
      `Yahoo rate-limited ${label} (HTTP 429). Cool-down active — do not force-refresh. Holdings keep using quote_cache.${urlNote}`,
      {
        status: 429,
        symbol: label,
        retryAfterSeconds: lastRetryAfter ?? 60 * 60,
        url: lastUrl,
      },
    );
  }
  throw new YahooHttpError(
    `Yahoo request failed for ${label}: HTTP ${lastStatus}${lastBody ? ` — ${lastBody}` : ""}${urlNote}`,
    {
      status: lastStatus || 0,
      symbol: label,
      retryAfterSeconds: lastRetryAfter,
      url: lastUrl,
    },
  );
}

async function fetchChartJson(
  symbol: string,
  period1: Date,
  period2: Date,
  fetchImpl: typeof fetch,
): Promise<YahooChartResult> {
  return (await yahooFetchJson(
    (session) =>
      [YAHOO_CHART, YAHOO_CHART_QUERY2].map((base) => {
        const url = new URL(`${base}/${encodeURIComponent(symbol)}`);
        url.searchParams.set("interval", "1d");
        url.searchParams.set(
          "period1",
          String(Math.floor(period1.getTime() / 1000)),
        );
        url.searchParams.set(
          "period2",
          String(Math.floor(period2.getTime() / 1000)),
        );
        url.searchParams.set("events", "div|split");
        url.searchParams.set("includePrePost", "false");
        if (session?.crumb) url.searchParams.set("crumb", session.crumb);
        return url.toString();
      }),
    symbol,
    fetchImpl,
  )) as YahooChartResult;
}

/**
 * Bulk latest quotes for many Yahoo symbols (one HTTP call per chunk).
 * Prefer this over N× single chart/quote calls. Uses crumb session.
 */
export async function fetchYahooQuotesBulk(
  symbols: string[],
  options: { fetchImpl?: typeof fetch; chunkSize?: number } = {},
): Promise<Map<string, YahooQuoteSnapshot>> {
  const fetchImpl = options.fetchImpl ?? yahooDefaultFetch;
  const out = new Map<string, YahooQuoteSnapshot>();
  const chunks = chunkSymbols(symbols, options.chunkSize ?? YAHOO_BULK_CHUNK);
  if (!chunks.length) return out;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    if (i > 0) await sleep(500);
    const joined = chunk.join(",");
    const data = await yahooFetchJson(
      (session) =>
        [YAHOO_QUOTE, YAHOO_QUOTE_Q2].map((base) => {
          const url = new URL(base);
          url.searchParams.set("symbols", joined);
          url.searchParams.set(
            "fields",
            "regularMarketPrice,currency,symbol,longName,shortName",
          );
          if (session?.crumb) url.searchParams.set("crumb", session.crumb);
          return url.toString();
        }),
      `bulk-quote(${chunk.length})`,
      fetchImpl,
    );
    for (const [sym, snap] of parseYahooQuotePayload(data)) {
      out.set(sym, snap);
    }
  }
  return out;
}

/**
 * Bulk daily close history via spark API (one HTTP call per chunk).
 * Returns simplified bars (close only; OHLC filled with close).
 * Heavy — only call when history is needed (performance chart), not every price refresh.
 */
export async function fetchYahooSparkHistoryBulk(
  symbols: string[],
  options: {
    /** Yahoo spark range, e.g. 1y, 2y, 5y */
    range?: string;
    fetchImpl?: typeof fetch;
    chunkSize?: number;
  } = {},
): Promise<Map<string, PriceBar[]>> {
  const fetchImpl = options.fetchImpl ?? yahooDefaultFetch;
  const range = options.range ?? "1y";
  const out = new Map<string, PriceBar[]>();
  const chunks = chunkSymbols(symbols, options.chunkSize ?? YAHOO_BULK_CHUNK);
  if (!chunks.length) return out;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    if (i > 0) await sleep(500);
    const joined = chunk.join(",");
    const data = await yahooFetchJson(
      (session) =>
        [YAHOO_SPARK, YAHOO_SPARK_Q2].map((base) => {
          const url = new URL(base);
          url.searchParams.set("symbols", joined);
          url.searchParams.set("range", range);
          url.searchParams.set("interval", "1d");
          if (session?.crumb) url.searchParams.set("crumb", session.crumb);
          return url.toString();
        }),
      `bulk-spark(${chunk.length})`,
      fetchImpl,
    );
    for (const [sym, bars] of parseYahooSparkPayload(data)) {
      out.set(sym, bars);
    }
  }
  return out;
}

/**
 * Fetch daily OHLCV history from Yahoo chart API.
 * Free / unofficial — cache aggressively in the app DB.
 */
export async function fetchYahooHistory(
  ticker: string,
  options: {
    exchange?: string;
    period1?: Date;
    period2?: Date;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<PriceBar[]> {
  const fetchImpl = options.fetchImpl ?? yahooDefaultFetch;
  const symbol = toYahooSymbol(ticker, options.exchange ?? "ASX");
  const period2 = options.period2 ?? new Date();
  const period1 =
    options.period1 ??
    new Date(period2.getTime() - 1000 * 60 * 60 * 24 * 365 * 10);

  const data = await fetchChartJson(symbol, period1, period2, fetchImpl);
  if (data.chart?.error) {
    throw new Error(
      `Yahoo history error for ${symbol}: ${data.chart.error.description ?? "unknown"}`,
    );
  }
  const parsed = parseYahooChartPayload(data, symbol);
  return parsed?.bars ?? [];
}

export async function fetchYahooQuote(
  ticker: string,
  options: { exchange?: string; fetchImpl?: typeof fetch } = {},
): Promise<number | null> {
  const symbol = toYahooSymbol(ticker, options.exchange ?? "ASX");
  // Always prefer the multi-symbol quote endpoint (even for one symbol).
  const map = await fetchYahooQuotesBulk([symbol], {
    fetchImpl: options.fetchImpl,
  });
  const hit = map.get(symbol.toUpperCase());
  if (hit) return hit.price;
  // Fallback: short chart history
  const bars = await fetchYahooHistory(ticker, {
    ...options,
    period1: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14),
  });
  if (!bars.length) return null;
  return bars[bars.length - 1]!.close;
}

/** Latest FX rate for converting `currency` → AUD (Yahoo AUDUSD=X style). */
export async function fetchFxToAud(
  currency: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<{ pair: string; rate: number } | null> {
  const pair = fxYahooSymbol(currency);
  if (!pair) return null;
  const map = await fetchYahooQuotesBulk([pair], {
    fetchImpl: options.fetchImpl,
  });
  const hit = map.get(pair.toUpperCase());
  if (hit) return { pair, rate: hit.price };
  return null;
}

/**
 * Bulk FX pairs for several currencies → AUD (one quote call when possible).
 */
export async function fetchFxToAudBulk(
  currencies: string[],
  options: { fetchImpl?: typeof fetch } = {},
): Promise<Map<string, { pair: string; rate: number }>> {
  const pairs: string[] = [];
  for (const c of currencies) {
    const p = fxYahooSymbol(c);
    if (p) pairs.push(p);
  }
  const map = await fetchYahooQuotesBulk(pairs, {
    fetchImpl: options.fetchImpl,
  });
  const out = new Map<string, { pair: string; rate: number }>();
  for (const [sym, snap] of map) {
    out.set(sym, { pair: sym, rate: snap.price });
  }
  return out;
}

/**
 * Dividend cash amounts via chart API events (not the CSV download endpoint).
 * The v7 /download path often returns HTTP 401 without crumb cookies.
 * Does NOT include franking.
 */
export async function fetchYahooDividends(
  ticker: string,
  options: {
    exchange?: string;
    period1?: Date;
    period2?: Date;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<DividendEvent[]> {
  const fetchImpl = options.fetchImpl ?? yahooDefaultFetch;
  const symbol = toYahooSymbol(ticker, options.exchange ?? "ASX");
  const period2 = options.period2 ?? new Date();
  const period1 =
    options.period1 ??
    new Date(period2.getTime() - 1000 * 60 * 60 * 24 * 365 * 15);

  const data = await fetchChartJson(symbol, period1, period2, fetchImpl);
  if (data.chart?.error) {
    throw new Error(
      `Yahoo dividends error for ${symbol}: ${data.chart.error.description ?? "unknown"}`,
    );
  }

  const result = data.chart?.result?.[0];
  const divMap = result?.events?.dividends;
  if (!divMap || typeof divMap !== "object") return [];

  const out: DividendEvent[] = [];
  for (const ev of Object.values(divMap)) {
    if (ev == null) continue;
    const amount = Number(ev.amount);
    const ts = Number(ev.date);
    if (Number.isNaN(amount) || Number.isNaN(ts)) continue;
    out.push({
      date: new Date(ts * 1000).toISOString().slice(0, 10),
      amount,
      frankingPercent: null,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
