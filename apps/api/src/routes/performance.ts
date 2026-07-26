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
    db: Database.Database;
    loadTransactions: (filters: {
      portfolioId?: number;
      broker?: string;
      source?: string;
    }) => ParsedTransaction[];
  },
) {
  app.get("/api/performance", (c) => {
    const portfolioId = c.req.query("portfolioId") || c.req.query("accountId");
    const broker = c.req.query("broker") || undefined;
    const source = c.req.query("source") || undefined;

    const txs = deps.loadTransactions({
      portfolioId: portfolioId ? Number(portfolioId) : undefined,
      broker,
      source,
    });

    const priceSeries = loadPriceSeries(deps.db);
    const fxRates = loadFxRates(deps.db);

    const points = buildPerformanceSeries(txs, {
      priceSeries,
      fx: { rates: fxRates },
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

function loadPriceSeries(db: Database.Database): PriceSeriesMap {
  const rows = db
    .prepare(
      `SELECT symbol, date, close FROM price_cache ORDER BY symbol, date ASC`,
    )
    .all() as Array<{ symbol: string; date: string; close: number }>;

  const series: PriceSeriesMap = {};
  for (const r of rows) {
    if (!series[r.symbol]) series[r.symbol] = [];
    series[r.symbol]!.push({ date: r.date, close: r.close });

    // Also index by EXCHANGE:TICKER for holdings lookup
    if (r.symbol.endsWith(".AX")) {
      const bare = r.symbol.slice(0, -3);
      const key = holdingPriceKey("ASX", bare);
      if (!series[key]) series[key] = [];
      series[key]!.push({ date: r.date, close: r.close });
    } else if (!r.symbol.includes("=") && !r.symbol.includes(".")) {
      const key = holdingPriceKey("US", r.symbol);
      if (!series[key]) series[key] = [];
      series[key]!.push({ date: r.date, close: r.close });
    }
  }
  return series;
}

function loadFxRates(
  db: Database.Database,
): Record<string, number | null> {
  const fxRows = db
    .prepare("SELECT pair, rate FROM fx_cache")
    .all() as Array<{ pair: string; rate: number }>;
  const fxRates: Record<string, number | null> = {};
  for (const f of fxRows) fxRates[f.pair] = f.rate;
  return fxRates;
}

/** Re-export helper for tests / reuse */
export function yahooKey(ticker: string, exchange: string) {
  return toYahooSymbol(ticker, exchange);
}
