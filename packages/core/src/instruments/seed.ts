/**
 * Curated issuer defaults for BetaShares + Vanguard AU ETFs commonly used
 * in the planner. Figures are indicative (PDS / product pages as of seed);
 * refresh via Yahoo trailing yield when the user clicks "Fetch".
 *
 * growthRate = capital growth assumption (not published by issuers as a forecast).
 * yieldRate  = typical / trailing-ish distribution yield (decimal).
 * mer        = management fee & costs style fee as decimal.
 * frankingPercent = typical franking on AU equity distributions when known.
 */

export type InstrumentSeed = {
  ticker: string;
  /** betashares | vanguard_au | other */
  issuer: "betashares" | "vanguard_au" | "other";
  name?: string;
  growthRate: number;
  yieldRate: number;
  mer: number;
  frankingPercent: number;
  /** Optional product page for manual check */
  productUrl?: string;
  /** ISO date when seed numbers were last hand-checked */
  asOf?: string;
};

const SEED: Record<string, InstrumentSeed> = {
  // ── BetaShares ─────────────────────────────────────────────
  A200: {
    ticker: "A200",
    issuer: "betashares",
    name: "Australia 200 ETF",
    growthRate: 0.07,
    yieldRate: 0.034,
    mer: 0.0004,
    frankingPercent: 70,
    productUrl: "https://www.betashares.com.au/fund/australia-200-etf/",
    asOf: "2026-07-01",
  },
  BGBL: {
    ticker: "BGBL",
    issuer: "betashares",
    name: "Global Shares ETF",
    growthRate: 0.08,
    yieldRate: 0.015,
    mer: 0.0016,
    frankingPercent: 0,
    productUrl: "https://www.betashares.com.au/fund/global-shares-etf/",
    asOf: "2026-07-01",
  },
  HYLD: {
    ticker: "HYLD",
    issuer: "betashares",
    name: "S&P Australian Shares High Yield ETF",
    growthRate: 0.03,
    yieldRate: 0.055,
    mer: 0.0025,
    frankingPercent: 50,
    productUrl:
      "https://www.betashares.com.au/fund/australian-shares-high-yield-etf/",
    asOf: "2026-07-01",
  },
  HVST: {
    ticker: "HVST",
    issuer: "betashares",
    name: "Australian Dividend Harvester Active ETF",
    growthRate: 0.03,
    yieldRate: 0.058,
    mer: 0.0072,
    frankingPercent: 60,
    asOf: "2026-07-01",
  },
  EXUS: {
    ticker: "EXUS",
    issuer: "betashares",
    name: "Global Shares Ex US ETF",
    growthRate: 0.07,
    yieldRate: 0.02,
    mer: 0.0014,
    frankingPercent: 0,
    asOf: "2026-07-01",
  },
  FAIR: {
    ticker: "FAIR",
    issuer: "betashares",
    name: "Australian Sustainability Leaders ETF",
    growthRate: 0.065,
    yieldRate: 0.03,
    mer: 0.0049,
    frankingPercent: 70,
    asOf: "2026-07-01",
  },
  QUS: {
    ticker: "QUS",
    issuer: "betashares",
    name: "S&P 500 Equal Weight ETF",
    growthRate: 0.08,
    yieldRate: 0.015,
    mer: 0.0029,
    frankingPercent: 0,
    asOf: "2026-07-01",
  },
  NDQ: {
    ticker: "NDQ",
    issuer: "betashares",
    name: "Nasdaq 100 ETF",
    growthRate: 0.09,
    yieldRate: 0.008,
    mer: 0.0048,
    frankingPercent: 0,
    productUrl: "https://www.betashares.com.au/fund/nasdaq-100-etf/",
    asOf: "2026-07-01",
  },
  /** Japan (AUD hedged) — user holding */
  HJPN: {
    ticker: "HJPN",
    issuer: "betashares",
    name: "Japan ETF - Currency Hedged",
    growthRate: 0.07,
    yieldRate: 0.005,
    mer: 0.0056,
    frankingPercent: 0,
    productUrl: "https://www.betashares.com.au/fund/japan-etf-currency-hedged/",
    asOf: "2026-07-01",
  },
  HETH: {
    ticker: "HETH",
    issuer: "betashares",
    name: "Global Sustainability Leaders ETF - Currency Hedged",
    growthRate: 0.07,
    yieldRate: 0.015,
    mer: 0.0059,
    frankingPercent: 0,
    asOf: "2026-07-01",
  },
  AGVT: {
    ticker: "AGVT",
    issuer: "betashares",
    name: "Australian Government Bond ETF",
    growthRate: 0.0,
    yieldRate: 0.039,
    mer: 0.0022,
    frankingPercent: 0,
    asOf: "2026-07-01",
  },

  // ── Vanguard AU ────────────────────────────────────────────
  /** User holding — broad AU equities */
  VAS: {
    ticker: "VAS",
    issuer: "vanguard_au",
    name: "Australian Shares Index ETF",
    growthRate: 0.07,
    yieldRate: 0.035,
    mer: 0.0007,
    frankingPercent: 70,
    productUrl:
      "https://www.vanguard.com.au/personal/invest-with-us/fund?portId=8205",
    asOf: "2026-07-01",
  },
  /** User holding — international equities (unhedged) */
  VGS: {
    ticker: "VGS",
    issuer: "vanguard_au",
    name: "International Shares Index ETF",
    growthRate: 0.08,
    yieldRate: 0.015,
    mer: 0.0018,
    frankingPercent: 0,
    productUrl:
      "https://www.vanguard.com.au/personal/invest-with-us/fund?portId=8145",
    asOf: "2026-07-01",
  },
  VHY: {
    ticker: "VHY",
    issuer: "vanguard_au",
    name: "Australian Shares High Yield ETF",
    growthRate: 0.035,
    yieldRate: 0.055,
    mer: 0.0025,
    frankingPercent: 80,
    asOf: "2026-07-01",
  },
  VDHG: {
    ticker: "VDHG",
    issuer: "vanguard_au",
    name: "Diversified High Growth Index ETF",
    growthRate: 0.065,
    yieldRate: 0.025,
    mer: 0.0027,
    frankingPercent: 30,
    asOf: "2026-07-01",
  },
  VTS: {
    ticker: "VTS",
    issuer: "vanguard_au",
    name: "US Total Market Shares Index ETF",
    growthRate: 0.08,
    yieldRate: 0.013,
    mer: 0.0003,
    frankingPercent: 0,
    asOf: "2026-07-01",
  },
  VEU: {
    ticker: "VEU",
    issuer: "vanguard_au",
    name: "All-World ex-US Shares Index ETF",
    growthRate: 0.07,
    yieldRate: 0.025,
    mer: 0.0007,
    frankingPercent: 0,
    asOf: "2026-07-01",
  },
  VGAD: {
    ticker: "VGAD",
    issuer: "vanguard_au",
    name: "International Shares Index ETF (Hedged)",
    growthRate: 0.075,
    yieldRate: 0.015,
    mer: 0.0021,
    frankingPercent: 0,
    asOf: "2026-07-01",
  },
  VAP: {
    ticker: "VAP",
    issuer: "vanguard_au",
    name: "Australian Property Securities Index ETF",
    growthRate: 0.04,
    yieldRate: 0.04,
    mer: 0.0023,
    frankingPercent: 0,
    asOf: "2026-07-01",
  },
  IOZ: {
    ticker: "IOZ",
    issuer: "other",
    name: "iShares Core S&P/ASX 200 (also common)",
    growthRate: 0.07,
    yieldRate: 0.035,
    mer: 0.0005,
    frankingPercent: 70,
    asOf: "2026-07-01",
  },
  IVV: {
    ticker: "IVV",
    issuer: "other",
    name: "iShares S&P 500",
    growthRate: 0.08,
    yieldRate: 0.013,
    mer: 0.0004,
    frankingPercent: 0,
    asOf: "2026-07-01",
  },
};

export function getInstrumentSeed(ticker: string): InstrumentSeed | null {
  const t = ticker.trim().toUpperCase().replace(/\.AX$/i, "");
  return SEED[t] ?? null;
}

export function listInstrumentSeeds(): InstrumentSeed[] {
  return Object.values(SEED).sort((a, b) => a.ticker.localeCompare(b.ticker));
}
