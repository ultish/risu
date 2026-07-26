/**
 * Resolve planner assumptions for a ticker: curated seed first, optional
 * Yahoo trailing yield + rough historical growth when refreshLive=true.
 */

import type { AssetAssumption } from "../planner/types.js";
import { fetchYahooDividends, fetchYahooHistory } from "../yahoo.js";
import { getInstrumentSeed, type InstrumentSeed } from "./seed.js";

export type InstrumentAssumptions = {
  ticker: string;
  exchange: string;
  growthRate: number;
  yieldRate: number;
  mer: number;
  frankingPercent: number;
  name?: string;
  issuer?: InstrumentSeed["issuer"];
  productUrl?: string;
  /** Where numbers came from */
  sources: string[];
  /** ISO timestamp of this resolution */
  resolvedAt: string;
  /** Cache age hint for UI */
  notes: string[];
};

export type ResolveInstrumentOptions = {
  exchange?: string;
  /**
   * When true, call Yahoo for trailing yield + hist. growth estimate.
   * Respect cool-down at the API layer before setting this.
   */
  refreshLive?: boolean;
  fetchImpl?: typeof fetch;
};

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function round4(n: number) {
  return Math.round(n * 10000) / 10000;
}

/**
 * Static + seed resolution (no network).
 */
export function resolveInstrumentFromSeed(
  ticker: string,
  exchange = "ASX",
): InstrumentAssumptions {
  const t = ticker.trim().toUpperCase().replace(/\.AX$/i, "");
  const seed = getInstrumentSeed(t);
  const sources: string[] = [];
  const notes: string[] = [];

  if (seed) {
    sources.push(`seed:${seed.issuer}`);
    if (seed.asOf) notes.push(`Issuer seed as of ${seed.asOf} (indicative).`);
    notes.push(
      "Growth is an assumption, not published by the issuer as a forecast.",
    );
    return {
      ticker: t,
      exchange: exchange.toUpperCase(),
      growthRate: seed.growthRate,
      yieldRate: seed.yieldRate,
      mer: seed.mer,
      frankingPercent: seed.frankingPercent,
      name: seed.name,
      issuer: seed.issuer,
      productUrl: seed.productUrl,
      sources,
      resolvedAt: new Date().toISOString(),
      notes,
    };
  }

  sources.push("fallback");
  notes.push(
    "Unknown ticker — generic defaults. Add to seed or set fields manually.",
  );
  return {
    ticker: t,
    exchange: exchange.toUpperCase(),
    growthRate: 0.06,
    yieldRate: 0.03,
    mer: 0.002,
    frankingPercent: 0,
    sources,
    resolvedAt: new Date().toISOString(),
    notes,
  };
}

/**
 * Optionally enrich with Yahoo trailing 12m yield and rough price CAGR growth.
 */
export async function resolveInstrumentAssumptions(
  ticker: string,
  options: ResolveInstrumentOptions = {},
): Promise<InstrumentAssumptions> {
  const exchange = options.exchange ?? "ASX";
  const base = resolveInstrumentFromSeed(ticker, exchange);
  if (!options.refreshLive) return base;

  const notes = [...base.notes];
  const sources = [...base.sources];
  let yieldRate = base.yieldRate;
  let growthRate = base.growthRate;

  try {
    const period2 = new Date();
    const period1 = new Date();
    period1.setFullYear(period1.getFullYear() - 5);

    const [divs, bars] = await Promise.all([
      fetchYahooDividends(ticker, {
        exchange,
        period1: new Date(Date.now() - 400 * 24 * 3600 * 1000),
        period2,
        fetchImpl: options.fetchImpl,
      }),
      fetchYahooHistory(ticker, {
        exchange,
        period1,
        period2,
        fetchImpl: options.fetchImpl,
      }),
    ]);

    const lastPrice = bars.length ? bars[bars.length - 1]!.close : null;
    if (lastPrice && lastPrice > 0 && divs.length) {
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 1);
      const cutoffIso = cutoff.toISOString().slice(0, 10);
      const trailing = divs
        .filter((d) => d.date >= cutoffIso)
        .reduce((s, d) => s + d.amount, 0);
      if (trailing > 0) {
        yieldRate = round4(clamp(trailing / lastPrice, 0, 0.2));
        sources.push("yahoo:trailing_yield");
        notes.push(
          `Yahoo trailing ~12m yield ${ (yieldRate * 100).toFixed(2) }% (divs/price).`,
        );
      }
    }

    if (bars.length >= 100 && lastPrice && lastPrice > 0) {
      const first = bars[0]!;
      const years =
        (new Date(bars[bars.length - 1]!.date).getTime() -
          new Date(first.date).getTime()) /
        (365.25 * 24 * 3600 * 1000);
      if (years >= 1 && first.close > 0) {
        const totalCagr = Math.pow(lastPrice / first.close, 1 / years) - 1;
        // Capital growth ≈ total price CAGR (price path already drops for divs on non-adj;
        // we use close; rough only)
        const g = totalCagr - yieldRate;
        growthRate = round4(clamp(g, -0.05, 0.2));
        sources.push("yahoo:hist_growth_est");
        notes.push(
          `Rough hist. capital growth ~${(growthRate * 100).toFixed(1)}% p.a. (price CAGR − yield; not a forecast).`,
        );
      }
    }
  } catch (e) {
    notes.push(
      `Live Yahoo refresh failed: ${e instanceof Error ? e.message : String(e)}. Using seed/fallback.`,
    );
  }

  return {
    ...base,
    growthRate,
    yieldRate,
    sources,
    notes,
    resolvedAt: new Date().toISOString(),
  };
}

/** Map resolved assumptions into a planner AssetAssumption partial. */
export function toPlannerAssetFields(
  inst: InstrumentAssumptions,
): Pick<
  AssetAssumption,
  "growthRate" | "yieldRate" | "mer" | "frankingPercent" | "ticker" | "label"
> {
  return {
    ticker: inst.ticker,
    label: inst.name ?? inst.ticker,
    growthRate: inst.growthRate,
    yieldRate: inst.yieldRate,
    mer: inst.mer,
    frankingPercent: inst.frankingPercent,
  };
}
