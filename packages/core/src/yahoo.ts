import { fxYahooSymbol } from "./market.js";
import type { DividendEvent, PriceBar } from "./types.js";

const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_CHART_QUERY2 = "https://query2.finance.yahoo.com/v8/finance/chart";

/** Browser-like headers — Yahoo often 401s scrapers / bare clients. */
const YAHOO_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "application/json,text/plain,*/*",
  "Accept-Language": "en-AU,en;q=0.9",
};

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

  constructor(
    message: string,
    opts: {
      status: number;
      symbol: string;
      retryAfterSeconds?: number | null;
    },
  ) {
    super(message);
    this.name = "YahooHttpError";
    this.status = opts.status;
    this.symbol = opts.symbol;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
  }
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
 * Yahoo's unofficial chart API rate-limits aggressively (429) and sometimes
 * keeps blocking the same IP for many minutes/hours — “wait 30s” is often wrong.
 * We retry with backoff across hosts; callers should prefer DB cache.
 */
async function fetchChartJson(
  symbol: string,
  period1: Date,
  period2: Date,
  fetchImpl: typeof fetch,
): Promise<YahooChartResult> {
  const bases = [YAHOO_CHART, YAHOO_CHART_QUERY2];
  let lastStatus = 0;
  let lastBody = "";
  let lastRetryAfter: number | null = null;
  /** Up to 3 attempts with growing delay (helps brief 429 blips only). */
  const maxAttempts = 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // ~2s, ~6s — still won't beat a multi-hour ban
      const wait =
        lastRetryAfter != null && lastRetryAfter > 0 && lastRetryAfter < 30
          ? lastRetryAfter * 1000
          : 2000 * Math.pow(3, attempt - 1);
      await sleep(wait);
    }

    for (const base of bases) {
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

      let res: Response;
      try {
        res = await fetchImpl(url.toString(), {
          headers: YAHOO_HEADERS,
          redirect: "follow",
        });
      } catch (e) {
        lastBody = e instanceof Error ? e.message : String(e);
        lastStatus = 0;
        continue;
      }
      lastStatus = res.status;
      if (res.ok) {
        return (await res.json()) as YahooChartResult;
      }
      const ra = parseRetryAfterSeconds(res);
      if (ra != null) lastRetryAfter = ra;
      lastBody = (await res.text().catch(() => "")).slice(0, 200);
      // try next host on soft blocks
      if (![401, 403, 429].includes(res.status)) {
        break;
      }
    }

    // Only retry on rate limit / auth blips
    if (lastStatus !== 429 && lastStatus !== 401 && lastStatus !== 403) {
      break;
    }
  }

  if (lastStatus === 401 || lastStatus === 403) {
    throw new YahooHttpError(
      `Yahoo blocked the request for ${symbol} (HTTP ${lastStatus}). This can last a long time. Prefer imported dividend/DRP rows from Sharesight/broker; Yahoo is optional for DRP check.`,
      { status: lastStatus, symbol, retryAfterSeconds: lastRetryAfter },
    );
  }
  if (lastStatus === 429) {
    throw new YahooHttpError(
      `Yahoo rate-limited ${symbol} (HTTP 429). Bans often last much longer than a minute (sometimes hours). Stop bulk “Refresh”, use cached data if any, or import cash dividends / DRP from Sharesight or your broker instead of Yahoo.`,
      { status: 429, symbol, retryAfterSeconds: lastRetryAfter },
    );
  }
  throw new YahooHttpError(
    `Yahoo chart failed for ${symbol}: HTTP ${lastStatus}${lastBody ? ` — ${lastBody}` : ""}`,
    { status: lastStatus || 0, symbol, retryAfterSeconds: lastRetryAfter },
  );
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
  const fetchImpl = options.fetchImpl ?? fetch;
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

  const result = data.chart?.result?.[0];
  if (!result?.timestamp?.length) return [];

  const quote = result.indicators?.quote?.[0];
  const adj = result.indicators?.adjclose?.[0]?.adjclose;

  const bars: PriceBar[] = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const close = quote?.close?.[i];
    if (close == null || Number.isNaN(close)) continue;
    const d = new Date(result.timestamp[i]! * 1000);
    bars.push({
      date: d.toISOString().slice(0, 10),
      open: quote?.open?.[i] ?? close,
      high: quote?.high?.[i] ?? close,
      low: quote?.low?.[i] ?? close,
      close,
      adjClose: adj?.[i] ?? close,
      volume: quote?.volume?.[i] ?? 0,
    });
  }
  return bars;
}

export async function fetchYahooQuote(
  ticker: string,
  options: { exchange?: string; fetchImpl?: typeof fetch } = {},
): Promise<number | null> {
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
  const rate = await fetchYahooQuote(pair, {
    exchange: "FX",
    fetchImpl: options.fetchImpl,
  });
  if (rate == null) return null;
  return { pair, rate };
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
  const fetchImpl = options.fetchImpl ?? fetch;
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
