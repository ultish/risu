/** Parse AU/US-ish dates into yyyy-mm-dd */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  // ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // dd/mm/yyyy or d/m/yyyy (AU)
  const au = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (au) {
    const d = Number(au[1]);
    const m = Number(au[2]);
    const y = Number(au[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${pad(m)}-${pad(d)}`;
    }
  }

  // mm/dd/yyyy (US — Selfwealth Excel risk)
  // Only use if first number > 12 would fail AU — ambiguous left as AU-first above.

  // Excel serial (rare in CSV text)
  const serial = Number(s);
  if (!Number.isNaN(serial) && serial > 20000 && serial < 60000) {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    epoch.setUTCDate(epoch.getUTCDate() + serial);
    return epoch.toISOString().slice(0, 10);
  }

  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}

export function parseNumber(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number" && !Number.isNaN(raw)) return raw;
  let s = String(raw).trim();
  if (!s) return null;
  // (1,234.56) accounting negative
  const neg = /^\(.*\)$/.test(s);
  s = s.replace(/[(),$AUD\s]/gi, "").replace(/,/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return neg ? -Math.abs(n) : n;
}

export function normaliseTicker(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/^ASX:/i, "")
    .replace(/^US:/i, "")
    .replace(/\.ASX$/i, "")
    .replace(/\.AX$/i, "")
    .replace(/\.AU$/i, "")
    .replace(/\.US$/i, "")
    .replace(/\.O$/i, "")
    .replace(/\.N$/i, "");
}

export function pad(n: number) {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Normalise CSV header keys so "Buy/ Sell", "Buy / Sell", "BUY/SELL" all
 * become stable forms we can match.
 */
export function normaliseHeaderKey(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    // collapse spaces around slash: "buy/ sell" → "buy/sell"
    .replace(/\s*\/\s*/g, "/")
    // "Avg. Price" → "avg price" (Stake / broker headers with mid-dot abbreviations)
    .replace(/\./g, " ")
    // collapse remaining whitespace
    .replace(/\s+/g, " ")
    .trim()
    // drop trailing punctuation noise
    .replace(/\s*\.\s*$/g, "");
}

export function lowerKeys<T extends Record<string, unknown>>(
  row: T,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    const key = normaliseHeaderKey(k);
    if (!key) continue;
    // Prefer first non-empty if duplicates after normalise
    const val = v == null ? "" : String(v).trim();
    if (out[key] == null || out[key] === "") out[key] = val;
  }
  return out;
}

export function getField(
  row: Record<string, string>,
  ...candidates: string[]
): string {
  for (const c of candidates) {
    const nk = normaliseHeaderKey(c);
    const v = row[nk];
    if (v != null && v !== "") return v;
  }
  // partial match on normalised keys
  for (const c of candidates) {
    const needle = normaliseHeaderKey(c);
    if (!needle) continue;
    const key = Object.keys(row).find(
      (k) => k === needle || k.includes(needle) || needle.includes(k),
    );
    if (key && row[key]) return row[key]!;
  }
  return "";
}

/**
 * CommSec Confirmations use B/S; also accept Buy/Sell words and 1/2 style codes.
 */
export function parseBuySellToken(raw: string): "buy" | "sell" | null {
  const t = raw.trim().toUpperCase().replace(/\s+/g, " ");
  if (!t) return null;
  if (
    t === "B" ||
    t === "BUY" ||
    t === "BOUGHT" ||
    t === "PURCHASE" ||
    t === "P" ||
    t === "1"
  ) {
    return "buy";
  }
  if (
    t === "S" ||
    t === "SELL" ||
    t === "SOLD" ||
    t === "SALE" ||
    t === "2"
  ) {
    return "sell";
  }
  // "B - Buy" / "S - Sell" etc.
  if (/^B\b/.test(t) && !/\bSELL\b/.test(t)) return "buy";
  if (/^S\b/.test(t) && !/\bBUY\b/.test(t)) return "sell";
  return null;
}

/** Map free-text side / activity to transaction type */
export function classifyType(
  sideOrType: string,
  details = "",
): "buy" | "sell" | "drp" | "dividend_cash" | "transfer_in" | "transfer_out" | "fee" | "other" {
  const s = `${sideOrType} ${details}`.toLowerCase();

  if (
    /\bdrp\b/.test(s) ||
    /\bdrip\b/.test(s) ||
    /dividend reinvest/.test(s) ||
    /reinvestment/.test(s) ||
    /re-?invest/.test(s) ||
    /\bdri\b/.test(s)
  ) {
    return "drp";
  }
  if (/dividend|distribution|div\b/.test(s) && !/reinvest/.test(s)) {
    return "dividend_cash";
  }
  if (/\bbuy\b|\bpurchase\b|\bbought\b|\blong\b/.test(s)) return "buy";
  if (/\bsell\b|\bsale\b|\bsold\b|\bshort\b/.test(s)) return "sell";
  if (/transfer\s*in|in(?:ward)?\s*transfer|received/.test(s)) return "transfer_in";
  if (/transfer\s*out|out(?:ward)?\s*transfer|delivered/.test(s)) return "transfer_out";
  if (/brokerage|fee|gst|commission/.test(s)) return "fee";
  const bs = parseBuySellToken(sideOrType);
  if (bs) return bs;
  const bsDetails = parseBuySellToken(details);
  if (bsDetails) return bsDetails;
  return "other";
}
