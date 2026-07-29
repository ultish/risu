/** Infer exchange + quote currency from broker fields and ticker shape. */

const US_HINT =
  /\b(us|usa|nasdaq|nyse|amex|nyse arca|bats|united states|us equit|us market|america)\b/i;
const ASX_HINT = /\b(asx|au|australia|australian|chi-?x|cxa)\b/i;

export function inferExchangeAndCurrency(input: {
  market?: string;
  currency?: string;
  ticker?: string;
  exchange?: string;
}): { exchange: string; currency: string } {
  const market = (input.market ?? input.exchange ?? "").trim();
  const currencyRaw = (input.currency ?? "").trim().toUpperCase();
  const ticker = (input.ticker ?? "").trim().toUpperCase();

  if (currencyRaw === "USD" || currencyRaw === "US$") {
    return { exchange: normaliseExchange(market) || "US", currency: "USD" };
  }
  if (currencyRaw === "AUD" || currencyRaw === "A$" || currencyRaw === "AU$") {
    return { exchange: normaliseExchange(market) || "ASX", currency: "AUD" };
  }
  if (currencyRaw && currencyRaw.length === 3) {
    const ex = normaliseExchange(market);
    if (ex) return { exchange: ex, currency: currencyRaw };
    if (currencyRaw === "GBP") return { exchange: "LSE", currency: "GBP" };
    if (currencyRaw === "EUR") return { exchange: "EU", currency: "EUR" };
  }

  if (US_HINT.test(market)) return { exchange: "US", currency: "USD" };
  if (ASX_HINT.test(market)) return { exchange: "ASX", currency: "AUD" };

  if (ticker.endsWith(".US") || ticker.endsWith(".O") || ticker.endsWith(".N")) {
    return { exchange: "US", currency: "USD" };
  }
  if (ticker.endsWith(".AX") || ticker.endsWith(".AU")) {
    return { exchange: "ASX", currency: "AUD" };
  }

  const ex = normaliseExchange(market);
  if (ex === "US") return { exchange: "US", currency: "USD" };
  if (ex === "ASX") return { exchange: "ASX", currency: "AUD" };
  if (ex) {
    return {
      exchange: ex,
      currency: currencyRaw || defaultCurrencyForExchange(ex),
    };
  }

  // Default AU-resident book for short bare codes (CommSec samples)
  if (looksAsxTicker(ticker)) return { exchange: "ASX", currency: "AUD" };
  return { exchange: "ASX", currency: "AUD" };
}

export function normaliseExchange(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (!s) return "";
  if (US_HINT.test(s) || s === "NASDAQ" || s === "NYSE" || s === "AMEX") {
    return "US";
  }
  if (ASX_HINT.test(s) || s === "AX") return "ASX";
  if (s === "LSE" || s === "LON") return "LSE";
  return s.slice(0, 12);
}

/**
 * Quote currency for market prices by exchange.
 * Operator book is mainly ASX (AUD) + US (USD). Japan exposure is via
 * Betashares ASX products (AUD), not TSE/JPY — those tickers stay ASX/AUD.
 * LSE/EUR/etc. kept for generality; do not remove.
 */
export function defaultCurrencyForExchange(exchange: string): string {
  const e = exchange.toUpperCase();
  if (e === "ASX" || e === "AU") return "AUD";
  if (e === "US" || e === "NASDAQ" || e === "NYSE") return "USD";
  if (e === "LSE") return "GBP";
  return "AUD";
}

function looksAsxTicker(ticker: string): boolean {
  return /^[A-Z0-9]{2,5}$/.test(ticker) && !ticker.includes(".");
}

/**
 * Yahoo FX pair for converting foreign currency → AUD.
 * Day-to-day need is AUDUSD only; GBP/EUR/generic kept for other books.
 */
export function fxYahooSymbol(currency: string): string | null {
  const c = currency.toUpperCase();
  if (c === "AUD") return null;
  if (c === "USD") return "AUDUSD=X";
  if (c === "GBP") return "AUDGBP=X";
  if (c === "EUR") return "AUDEUR=X";
  return `AUD${c}=X`;
}

/**
 * Convert amount in `currency` to AUD.
 * Yahoo AUDUSD=X ≈ USD per 1 AUD, so AUD = foreign / rate.
 */
export function toAud(
  amount: number,
  currency: string,
  fxRates: Record<string, number | null | undefined>,
): number | null {
  const c = currency.toUpperCase();
  if (c === "AUD") return amount;
  const pair = fxYahooSymbol(c);
  if (!pair) return null;
  const rate = fxRates[pair] ?? fxRates[c];
  if (rate == null || rate === 0) return null;
  return amount / rate;
}

/**
 * Convert an amount between two currencies via AUD as pivot (same Yahoo-style
 * fxRates map `toAud` uses). Returns null only if a needed rate is missing —
 * callers should fall back to the unconverted amount rather than drop data.
 */
export function convertCurrency(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  fxRates: Record<string, number | null | undefined>,
): number | null {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  if (from === to) return amount;
  const aud = toAud(amount, from, fxRates);
  if (aud == null) return null;
  if (to === "AUD") return aud;
  const pair = fxYahooSymbol(to);
  if (!pair) return null;
  const rate = fxRates[pair] ?? fxRates[to];
  if (rate == null || rate === 0) return null;
  return aud * rate;
}

export function holdingPriceKey(exchange: string, ticker: string): string {
  return `${exchange.toUpperCase()}:${ticker.toUpperCase()}`;
}
