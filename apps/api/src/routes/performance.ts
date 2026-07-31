import {
  buildPerformanceSeries,
  holdingPriceKey,
  toYahooSymbol,
  type ParsedTransaction,
  type PriceSeriesMap,
} from "@yields/core";
import type { Context } from "hono";
import type Database from "better-sqlite3";

/**
 * GET /api/performance?portfolioId=&broker=&source=
 * → { points: { date, costBaseAud, marketValueAud }[] }
 */
export function registerPerformanceRoutes(
  app: {
    get: (
      path: string,
      handler: (c: Context) => Response | Promise<Response>,
    ) => unknown;
  },
  deps: {
    getDb: () => Database.Database;
    loadTransactions: (filters: {
      portfolioId?: number;
      broker?: string;
      source?: string;
      ticker?: string;
      exchange?: string;
    }) => ParsedTransaction[];
  },
) {
  app.get("/api/performance", (c) => {
    const portfolioId = c.req.query("portfolioId") || c.req.query("accountId");
    const broker = c.req.query("broker") || undefined;
    const source = c.req.query("source") || undefined;
    const ticker = c.req.query("ticker") || undefined;
    const exchange = c.req.query("exchange") || undefined;

    const txs = deps.loadTransactions({
      portfolioId: portfolioId ? Number(portfolioId) : undefined,
      broker,
      source,
      ticker,
      exchange,
    });

    const db = deps.getDb();
    const priceSeries = loadPriceSeries(db);
    const fxRates = loadFxRates(db);
    const fxSeries = loadFxHistory(db);

    const points = buildPerformanceSeries(txs, {
      priceSeries,
      fx: { rates: fxRates, series: fxSeries },
    });

    return c.json({
      points,
      filters: {
        portfolioId: portfolioId ? Number(portfolioId) : null,
        broker: broker ?? null,
        source: source ?? null,
      },
    });
  });
}

export function loadPriceSeries(db: Database.Database): PriceSeriesMap {
  const rows = db
    .prepare(
      `SELECT symbol, date, close FROM price_cache ORDER BY symbol, date ASC`,
    )
    .all() as Array<{ symbol: string; date: string; close: number }>;

  const series: PriceSeriesMap = {};
  const pushBar = (symbol: string, date: string, close: number) => {
    if (!series[symbol]) series[symbol] = [];
    const list = series[symbol]!;
    const last = list[list.length - 1];
    if (last && last.date === date) {
      last.close = close;
      return;
    }
    // Keep sorted insert if needed
    if (last && last.date > date) {
      list.push({ date, close });
      list.sort((a, b) => a.date.localeCompare(b.date));
      return;
    }
    list.push({ date, close });
  };

  for (const r of rows) {
    pushBar(r.symbol, r.date, r.close);

    // Also index by EXCHANGE:TICKER for holdings lookup
    if (r.symbol.endsWith(".AX")) {
      const bare = r.symbol.slice(0, -3);
      const key = holdingPriceKey("ASX", bare);
      pushBar(key, r.date, r.close);
    } else if (!r.symbol.includes("=") && !r.symbol.includes(".")) {
      const key = holdingPriceKey("US", r.symbol);
      pushBar(key, r.date, r.close);
    }
  }

  // Merge latest quote_cache so a fallbacks-only refresh still marks to market
  // at least on/after the quote date (performance chart needs price_cache bars).
  const quotes = db
    .prepare(
      `SELECT symbol, price, fetched_at FROM quote_cache WHERE price IS NOT NULL`,
    )
    .all() as Array<{ symbol: string; price: number; fetched_at: string }>;
  for (const q of quotes) {
    const date =
      (q.fetched_at && q.fetched_at.slice(0, 10)) ||
      new Date().toISOString().slice(0, 10);
    pushBar(q.symbol, date, q.price);
    if (q.symbol.endsWith(".AX")) {
      const bare = q.symbol.slice(0, -3);
      pushBar(holdingPriceKey("ASX", bare), date, q.price);
    } else if (!q.symbol.includes("=") && !q.symbol.includes(".")) {
      pushBar(holdingPriceKey("US", q.symbol), date, q.price);
    }
  }

  return series;
}

export function loadFxRates(
  db: Database.Database,
): Record<string, number | null> {
  const fxRows = db
    .prepare("SELECT pair, rate FROM fx_cache")
    .all() as Array<{ pair: string; rate: number }>;
  const fxRates: Record<string, number | null> = {};
  for (const f of fxRows) fxRates[f.pair] = f.rate;
  return fxRates;
}

/** Daily FX history for as-of valuation (pair → sorted {date, rate}[]). */
export function loadFxHistory(
  db: Database.Database,
): Record<string, Array<{ date: string; rate: number }>> {
  const rows = db
    .prepare(
      `SELECT pair, date, rate FROM fx_history ORDER BY pair, date ASC`,
    )
    .all() as Array<{ pair: string; date: string; rate: number }>;
  const series: Record<string, Array<{ date: string; rate: number }>> = {};
  for (const r of rows) {
    if (!series[r.pair]) series[r.pair] = [];
    series[r.pair]!.push({ date: r.date, rate: r.rate });
  }
  return series;
}

/** Re-export helper for tests / reuse */
export function yahooKey(ticker: string, exchange: string) {
  return toYahooSymbol(ticker, exchange);
}
