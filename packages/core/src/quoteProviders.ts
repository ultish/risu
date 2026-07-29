/**
 * Multi-provider last-price + FX fetch.
 *
 * Yahoo is preferred when available, but often rate-limits (429) for hours.
 * Fallbacks (no API key):
 * - ASX: asx.api.markitdigital.com company header
 * - US: api.nasdaq.com quote info
 * - FX: frankfurter.app / open.er-api.com (USD base cross rates)
 *
 * Always bulk where the provider allows; never hammer Yahoo on cool-down.
 */

import { fxYahooSymbol } from "./market.js";
import type { PriceBar } from "./types.js";
import {
  fetchYahooHistory,
  fetchYahooQuotesBulk,
  toYahooSymbol,
  type YahooQuoteSnapshot,
} from "./yahoo.js";

export type InstrumentRef = {
  ticker: string;
  exchange: string;
};

export type QuoteResult = YahooQuoteSnapshot & {
  source: "yahoo" | "asx" | "nasdaq" | "fx_fallback";
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseMoney(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const n = Number(String(raw).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** ASX last price via Markit Digital research API (no key). */
export async function fetchAsxQuote(
  ticker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<QuoteResult | null> {
  const t = ticker.trim().toUpperCase();
  if (!t) return null;
  const url = `https://asx.api.markitdigital.com/asx-research/1.0/companies/${encodeURIComponent(t)}/header`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Referer: "https://www.asx.com.au/",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: { priceLast?: number; symbol?: string };
    };
    const price = parseMoney(data.data?.priceLast);
    if (price == null) return null;
    return {
      symbol: toYahooSymbol(t, "ASX"),
      price,
      currency: "AUD",
      source: "asx",
    };
  } catch {
    return null;
  }
}

/** US last price via Nasdaq public quote API (no key; works for many US listings). */
export async function fetchNasdaqQuote(
  ticker: string,
  fetchImpl: typeof fetch = fetch,
): Promise<QuoteResult | null> {
  const t = ticker.trim().toUpperCase();
  if (!t) return null;
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(t)}/info?assetclass=stocks`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Referer: "https://www.nasdaq.com/",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: {
        primaryData?: { lastSalePrice?: string };
        symbol?: string;
      };
    };
    const price = parseMoney(data.data?.primaryData?.lastSalePrice);
    if (price == null) return null;
    return {
      symbol: toYahooSymbol(t, "US"),
      price,
      currency: "USD",
      source: "nasdaq",
    };
  } catch {
    return null;
  }
}

/**
 * FX: foreign units per 1 AUD (Yahoo AUDUSD=X style).
 * frankfurter returns AUD per 1 USD → invert for USD; other pairs via USD cross.
 */
export async function fetchFxFallbackBulk(
  currencies: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, { pair: string; rate: number; source: string }>> {
  const out = new Map<string, { pair: string; rate: number; source: string }>();
  const need = [
    ...new Set(
      currencies
        .map((c) => c.toUpperCase())
        .filter((c) => c && c !== "AUD"),
    ),
  ];
  if (!need.length) return out;

  // Prefer frankfurter (ECB) — free, no key
  try {
    const url = `https://api.frankfurter.app/latest?from=USD&to=${["AUD", ...need.filter((c) => c !== "USD")].join(",")}`;
    const res = await fetchImpl(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (res.ok) {
      const data = (await res.json()) as {
        rates?: Record<string, number>;
      };
      const rates = data.rates ?? {};
      const audPerUsd = rates.AUD;
      if (audPerUsd && audPerUsd > 0) {
        // AUDUSD=X = USD per 1 AUD = 1 / (AUD per USD)
        out.set("AUDUSD=X", {
          pair: "AUDUSD=X",
          rate: 1 / audPerUsd,
          source: "frankfurter",
        });
        for (const ccy of need) {
          if (ccy === "USD") continue;
          const foreignPerUsd = rates[ccy];
          if (foreignPerUsd == null || foreignPerUsd <= 0) continue;
          // AUD{CCY}=X = foreign per 1 AUD = foreignPerUsd / audPerUsd
          const pair = `AUD${ccy}=X`;
          out.set(pair, {
            pair,
            rate: foreignPerUsd / audPerUsd,
            source: "frankfurter",
          });
        }
      }
    }
  } catch {
    /* try open.er-api */
  }

  if (out.size) return out;

  try {
    const res = await fetchImpl("https://open.er-api.com/v6/latest/USD", {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) return out;
    const data = (await res.json()) as {
      rates?: Record<string, number>;
    };
    const rates = data.rates ?? {};
    const audPerUsd = rates.AUD;
    if (audPerUsd && audPerUsd > 0) {
      out.set("AUDUSD=X", {
        pair: "AUDUSD=X",
        rate: 1 / audPerUsd,
        source: "open.er-api",
      });
      for (const ccy of need) {
        if (ccy === "USD") continue;
        const foreignPerUsd = rates[ccy];
        if (foreignPerUsd == null || foreignPerUsd <= 0) continue;
        const pair = `AUD${ccy}=X`;
        out.set(pair, {
          pair,
          rate: foreignPerUsd / audPerUsd,
          source: "open.er-api",
        });
      }
    }
  } catch {
    /* empty */
  }

  return out;
}

export type MultiQuoteOptions = {
  fetchImpl?: typeof fetch;
  /** When false, skip Yahoo entirely (cool-down / known ban). Default true. */
  tryYahoo?: boolean;
};

/**
 * Fetch last prices for instruments: Yahoo bulk first (if allowed), then
 * ASX/Nasdaq fallbacks for gaps. Returns map keyed by Yahoo symbol.
 */
export async function fetchQuotesMulti(
  instruments: InstrumentRef[],
  options: MultiQuoteOptions = {},
): Promise<{
  quotes: Map<string, QuoteResult>;
  yahooError: string | null;
  sourcesUsed: string[];
}> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const tryYahoo = options.tryYahoo !== false;
  const quotes = new Map<string, QuoteResult>();
  const sourcesUsed = new Set<string>();
  let yahooError: string | null = null;

  const meta = instruments.map((i) => {
    const ticker = i.ticker.toUpperCase();
    const exchange = (i.exchange || "ASX").toUpperCase();
    const symbol = toYahooSymbol(ticker, exchange);
    return { ticker, exchange, symbol };
  });

  // 1) Yahoo bulk
  if (tryYahoo && meta.length) {
    try {
      const bulk = await fetchYahooQuotesBulk(
        meta.map((m) => m.symbol),
        { fetchImpl: options.fetchImpl },
      );
      for (const [sym, snap] of bulk) {
        quotes.set(sym, { ...snap, source: "yahoo" });
      }
      if (bulk.size) sourcesUsed.add("yahoo");
    } catch (e) {
      yahooError = e instanceof Error ? e.message : String(e);
    }
  }

  // 2) Fallbacks for missing
  const missing = meta.filter((m) => !quotes.has(m.symbol.toUpperCase()));
  // polite concurrency: small batches
  const batchSize = 6;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    if (i > 0) await sleep(200);
    await Promise.all(
      batch.map(async (m) => {
        const isAsx = m.exchange === "ASX" || m.exchange === "AU";
        const isUs =
          m.exchange === "US" ||
          m.exchange === "NASDAQ" ||
          m.exchange === "NYSE" ||
          m.exchange === "AMEX";

        let hit: QuoteResult | null = null;
        if (isAsx) {
          hit = await fetchAsxQuote(m.ticker, fetchImpl);
        } else if (isUs) {
          hit = await fetchNasdaqQuote(m.ticker, fetchImpl);
        } else if (m.exchange === "LSE" || m.exchange === "LON") {
          // no free LSE source wired — skip
          hit = null;
        } else {
          // try both
          hit =
            (await fetchAsxQuote(m.ticker, fetchImpl)) ??
            (await fetchNasdaqQuote(m.ticker, fetchImpl));
        }
        if (hit) {
          quotes.set(hit.symbol.toUpperCase(), hit);
          sourcesUsed.add(hit.source);
        }
      }),
    );
  }

  return {
    quotes,
    yahooError,
    sourcesUsed: [...sourcesUsed],
  };
}

function parseUsDate(mmddyyyy: string): string | null {
  // "07/24/2026" → "2026-07-24"
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(mmddyyyy.trim());
  if (!m) return null;
  const mm = m[1]!.padStart(2, "0");
  const dd = m[2]!.padStart(2, "0");
  const yyyy = m[3]!;
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * US daily history via Nasdaq public API (no key). Used when Yahoo history is banned.
 */
export async function fetchNasdaqHistory(
  ticker: string,
  options: {
    /** Inclusive from date yyyy-mm-dd; default ~1 year ago */
    fromDate?: string;
    /** Inclusive to date yyyy-mm-dd; default today */
    toDate?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<PriceBar[]> {
  const t = ticker.trim().toUpperCase();
  if (!t) return [];
  const fetchImpl = options.fetchImpl ?? fetch;
  const to = options.toDate ?? new Date().toISOString().slice(0, 10);
  const from =
    options.fromDate ??
    new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(t)}/historical?assetclass=stocks&fromdate=${from}&todate=${to}&limit=9999`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Referer: "https://www.nasdaq.com/",
      },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      data?: {
        tradesTable?: {
          rows?: Array<{
            date?: string;
            close?: string;
            open?: string;
            high?: string;
            low?: string;
            volume?: string;
          }>;
        };
      };
    };
    const rows = data.data?.tradesTable?.rows ?? [];
    const bars: PriceBar[] = [];
    for (const row of rows) {
      const date = row.date ? parseUsDate(row.date) : null;
      const close = parseMoney(row.close);
      if (!date || close == null) continue;
      const open = parseMoney(row.open) ?? close;
      const high = parseMoney(row.high) ?? close;
      const low = parseMoney(row.low) ?? close;
      const volRaw = row.volume
        ? Number(String(row.volume).replace(/,/g, ""))
        : 0;
      bars.push({
        date,
        open,
        high,
        low,
        close,
        adjClose: close,
        volume: Number.isFinite(volRaw) ? volRaw : 0,
      });
    }
    return bars.sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

export type FxHistoryPoint = { date: string; rate: number };

/**
 * Multi-year daily FX history for a Yahoo-style pair (e.g. AUDUSD=X = USD per 1 AUD).
 * Yahoo chart first; Frankfurter ECB series as fallback (USD and major CCY only).
 */
export async function fetchFxHistory(
  pair: string,
  options: {
    period1?: Date;
    period2?: Date;
    fetchImpl?: typeof fetch;
    tryYahoo?: boolean;
  } = {},
): Promise<{ points: FxHistoryPoint[]; source: string | null }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const tryYahoo = options.tryYahoo !== false;
  const period2 = options.period2 ?? new Date();
  const period1 =
    options.period1 ??
    new Date(period2.getTime() - 1000 * 60 * 60 * 24 * 365 * 10);
  const p = pair.toUpperCase();

  if (tryYahoo) {
    try {
      // Re-use equity chart client — FX pairs are first-class Yahoo symbols
      const bars = await fetchYahooHistory(p, {
        exchange: "FX",
        period1,
        period2,
        fetchImpl: options.fetchImpl,
      });
      const points = bars
        .filter((b) => b.close != null && b.close > 0 && !Number.isNaN(b.close))
        .map((b) => ({ date: b.date, rate: b.close }));
      if (points.length) return { points, source: "yahoo-chart" };
    } catch {
      /* fall through */
    }
  }

  // Frankfurter: pair AUDUSD=X → from USD to AUD, invert
  const frank = await fetchFrankfurterHistory(p, period1, period2, fetchImpl);
  if (frank.length) return { points: frank, source: "frankfurter-hist" };

  return { points: [], source: null };
}

/**
 * Frankfurter range API → Yahoo-style rates (foreign units per 1 AUD).
 * Supports AUDUSD=X, AUDGBP=X, AUDEUR=X etc. via USD cross when needed.
 */
async function fetchFrankfurterHistory(
  pair: string,
  period1: Date,
  period2: Date,
  fetchImpl: typeof fetch,
): Promise<FxHistoryPoint[]> {
  const m = /^AUD([A-Z]{3})=X$/.exec(pair.toUpperCase());
  if (!m) return [];
  const foreign = m[1]!; // USD, GBP, …

  const from = period1.toISOString().slice(0, 10);
  const to = period2.toISOString().slice(0, 10);

  try {
    // Get AUD and foreign per 1 USD, then foreign-per-AUD = foreignPerUsd / audPerUsd
    const toList =
      foreign === "USD" ? "AUD" : `AUD,${foreign}`;
    const url = `https://api.frankfurter.app/${from}..${to}?from=USD&to=${toList}`;
    const res = await fetchImpl(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      rates?: Record<string, Record<string, number>>;
    };
    const points: FxHistoryPoint[] = [];
    for (const [date, rates] of Object.entries(data.rates ?? {})) {
      const audPerUsd = rates.AUD;
      if (audPerUsd == null || audPerUsd <= 0) continue;
      if (foreign === "USD") {
        points.push({ date, rate: 1 / audPerUsd });
      } else {
        const foreignPerUsd = rates[foreign];
        if (foreignPerUsd == null || foreignPerUsd <= 0) continue;
        points.push({ date, rate: foreignPerUsd / audPerUsd });
      }
    }
    points.sort((a, b) => a.date.localeCompare(b.date));
    return points;
  } catch {
    return [];
  }
}

/**
 * Resolve FX pairs for currencies, Yahoo first then frankfurter/er-api.
 */
export async function fetchFxMulti(
  currencies: string[],
  options: MultiQuoteOptions = {},
): Promise<{
  rates: Map<string, { pair: string; rate: number; source: string }>;
  yahooError: string | null;
}> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const tryYahoo = options.tryYahoo !== false;
  const rates = new Map<string, { pair: string; rate: number; source: string }>();
  let yahooError: string | null = null;

  const pairs = currencies
    .map((c) => fxYahooSymbol(c))
    .filter((p): p is string => Boolean(p));

  if (tryYahoo && pairs.length) {
    try {
      const bulk = await fetchYahooQuotesBulk(pairs, {
        fetchImpl: options.fetchImpl,
      });
      for (const [sym, snap] of bulk) {
        rates.set(sym, {
          pair: sym,
          rate: snap.price,
          source: "yahoo",
        });
      }
    } catch (e) {
      yahooError = e instanceof Error ? e.message : String(e);
    }
  }

  const missingCcy = currencies.filter((c) => {
    const p = fxYahooSymbol(c);
    return p != null && !rates.has(p);
  });
  if (missingCcy.length) {
    const fb = await fetchFxFallbackBulk(missingCcy, fetchImpl);
    for (const [pair, row] of fb) {
      if (!rates.has(pair)) rates.set(pair, row);
    }
  }

  return { rates, yahooError };
}
