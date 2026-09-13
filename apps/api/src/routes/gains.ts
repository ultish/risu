import {
  buildPerformanceSeries,
  combineGainsByFy,
  summarizeFyEndSnapshots,
  summarizeRealisedGains,
  type ParsedTransaction,
  type RecordedParcelTake,
} from "@risu/core";
import type { Context } from "hono";
import type Database from "better-sqlite3";
import { loadFxHistory, loadPriceSeries } from "./performance.js";

/**
 * GET /api/gains/by-fy — nominal (tax-agnostic) realised + unrealised gain
 * per AU financial year, for the "realised vs unrealised" chart. Unlike
 * /api/tax/fy-estimate this has no tax-profile/regime dependency: realised
 * is plain proceeds − FIFO cost base per disposal; unrealised is
 * mark-to-market − cost base at each FY's last available performance point.
 */
export function registerGainsRoutes(
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
    }) => ParsedTransaction[];
    priceMapsFromCache: () => {
      prices: Record<string, number | null>;
      fxRates: Record<string, number | null>;
    };
    loadParcelTakes: () => RecordedParcelTake[];
    loadPlatformFifoBrokers: () => string[];
  },
) {
  app.get("/api/gains/by-fy", (c) => {
    const portfolioId = c.req.query("portfolioId") || c.req.query("accountId");
    const broker = c.req.query("broker") || undefined;
    const source = c.req.query("source") || undefined;

    const txs = deps.loadTransactions({
      portfolioId: portfolioId ? Number(portfolioId) : undefined,
      broker,
      source,
    });
    const maps = deps.priceMapsFromCache();
    const realised = summarizeRealisedGains(txs, maps.fxRates, {
      recordedTakes: deps.loadParcelTakes(),
      platformFifoBrokers: deps.loadPlatformFifoBrokers(),
    });

    const db = deps.getDb();
    const points = buildPerformanceSeries(txs, {
      priceSeries: loadPriceSeries(db),
      fx: { rates: maps.fxRates, series: loadFxHistory(db) },
    });
    const snapshots = summarizeFyEndSnapshots(points);

    return c.json({
      byFy: combineGainsByFy(realised, snapshots),
      filters: {
        portfolioId: portfolioId ? Number(portfolioId) : null,
        broker: broker ?? null,
        source: source ?? null,
      },
    });
  });
}
