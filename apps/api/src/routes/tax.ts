import {
  computeHoldings,
  computeLots,
  estimateFyTax,
  estimateHypotheticalSale,
  holdingPriceKey,
  type CgtRegime,
  type LotMatchingMethod,
  type ParsedTransaction,
  type RecordedParcelTake,
} from "@risu/core";
import type { Context } from "hono";
import type Database from "better-sqlite3";
import { loadCutoverValues } from "./valuations.js";

type TaxProfileRow = {
  id: number;
  label: string;
  marginal_rate: number;
  medicare_levy: number;
  is_default: number;
};

const VALID_REGIMES: CgtRegime[] = [
  "discount_50",
  "indexation_min30",
  "auto_by_date",
];

const VALID_MATCHING: LotMatchingMethod[] = ["fifo", "min_cgt"];

/**
 * GET /api/tax/fy-estimate — roughly how much tax is owed for a financial
 * year: dividend income tax + realised CGT on actual sells (per-parcel
 * cost base, FIFO or min-CGT matching, see @risu/core `computeLots` /
 * `estimateRealisedCgtForLedger`), combined the same way the planner
 * combines them for a hypothetical scenario, but against the real ledger.
 *
 * Query: portfolioId?, broker?, source?, taxProfileId? (default profile if
 * omitted), regime? (default auto_by_date), lotMatching? (fifo | min_cgt,
 * default fifo), inflationRate? (decimal, post-2027 CPI indexation),
 * asxFrankingPercent?, usWithholdingRate? (decimal 0-1). Thin plumbing
 * only — all math lives in @risu/core.
 *
 * GET /api/tax/sell-estimate — hypothetical CGT if you sold N units of a
 * ticker today (or on disposedDate), picking parcels FIFO or to minimise
 * CGT. Uses remaining FIFO-reconstructed lots + cached market price.
 */
export function registerTaxRoutes(
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
    priceMapsFromCache: () => {
      prices: Record<string, number | null>;
      fxRates: Record<string, number | null>;
    };
    loadParcelTakes: () => RecordedParcelTake[];
    loadPlatformFifoBrokers: () => string[];
  },
) {
  app.get("/api/tax/fy-estimate", (c) => {
    const portfolioId = c.req.query("portfolioId") || c.req.query("accountId");
    const broker = c.req.query("broker") || undefined;
    const source = c.req.query("source") || undefined;
    const taxProfileId = c.req.query("taxProfileId");
    const regimeParam = c.req.query("regime") || "auto_by_date";
    const matchingParam = (c.req.query("lotMatching") || "fifo") as LotMatchingMethod;
    const inflationRateParam = c.req.query("inflationRate");
    const asxFrankingParam = c.req.query("asxFrankingPercent");
    const usWithholdingParam = c.req.query("usWithholdingRate");

    if (!VALID_REGIMES.includes(regimeParam as CgtRegime)) {
      return c.json(
        { error: `regime must be one of ${VALID_REGIMES.join(", ")}` },
        400,
      );
    }
    if (!VALID_MATCHING.includes(matchingParam)) {
      return c.json(
        { error: `lotMatching must be one of ${VALID_MATCHING.join(", ")}` },
        400,
      );
    }

    const db = deps.getDb();
    const loaded = loadProfile(db, taxProfileId);
    if ("error" in loaded) return c.json({ error: loaded.error }, 400);
    const { profileRow, profile } = loaded;

    const txs = deps.loadTransactions({
      portfolioId: portfolioId ? Number(portfolioId) : undefined,
      broker,
      source,
    });
    const maps = deps.priceMapsFromCache();

    const report = estimateFyTax(txs, maps.fxRates, {
      profile,
      cgtRegime: regimeParam as CgtRegime,
      lotMatching: matchingParam,
      recordedTakes: deps.loadParcelTakes(),
      platformFifoBrokers: deps.loadPlatformFifoBrokers(),
      cgtInflationRate: inflationRateParam ? Number(inflationRateParam) : undefined,
      asxFrankingPercent: asxFrankingParam ? Number(asxFrankingParam) : undefined,
      usWithholdingRate: usWithholdingParam ? Number(usWithholdingParam) : undefined,
      cgtCutover: loadCutoverValues(db, txs),
    });

    return c.json({
      ...report,
      taxProfile: { id: profileRow.id, ...profile },
      regime: regimeParam,
      lotMatching: matchingParam,
      filters: {
        portfolioId: portfolioId ? Number(portfolioId) : null,
        broker: broker ?? null,
        source: source ?? null,
      },
    });
  });

  app.get("/api/tax/sell-estimate", (c) => {
    const ticker = (c.req.query("ticker") || "").trim().toUpperCase();
    const exchange = (c.req.query("exchange") || "").trim().toUpperCase();
    const quantityParam = c.req.query("quantity");
    const quantity = quantityParam != null ? Number(quantityParam) : NaN;
    const matchingParam = (c.req.query("lotMatching") || "fifo") as LotMatchingMethod;
    const regimeParam = (c.req.query("regime") || "auto_by_date") as CgtRegime;
    const inflationRateParam = c.req.query("inflationRate");
    const disposedDate =
      c.req.query("disposedDate") || new Date().toISOString().slice(0, 10);
    const taxProfileId = c.req.query("taxProfileId");
    const portfolioId = c.req.query("portfolioId") || c.req.query("accountId");
    const broker = c.req.query("broker") || undefined;
    const source = c.req.query("source") || undefined;

    if (!ticker) return c.json({ error: "ticker is required" }, 400);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return c.json({ error: "quantity must be a positive number" }, 400);
    }
    if (!VALID_REGIMES.includes(regimeParam)) {
      return c.json(
        { error: `regime must be one of ${VALID_REGIMES.join(", ")}` },
        400,
      );
    }
    if (!VALID_MATCHING.includes(matchingParam)) {
      return c.json(
        { error: `lotMatching must be one of ${VALID_MATCHING.join(", ")}` },
        400,
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(disposedDate)) {
      return c.json({ error: "disposedDate must be yyyy-mm-dd" }, 400);
    }

    const db = deps.getDb();
    const loaded = loadProfile(db, taxProfileId);
    if ("error" in loaded) return c.json({ error: loaded.error }, 400);
    const { profileRow, profile } = loaded;

    const txs = deps.loadTransactions({
      portfolioId: portfolioId ? Number(portfolioId) : undefined,
      broker,
      source,
      ticker,
      exchange: exchange || undefined,
    });
    const maps = deps.priceMapsFromCache();

    const { openLots } = computeLots(txs, maps.fxRates, {
      recordedTakes: deps.loadParcelTakes(),
      platformFifoBrokers: deps.loadPlatformFifoBrokers(),
    });
    const lots = openLots.filter((l) => {
      if (l.ticker !== ticker) return false;
      if (exchange && l.exchange !== exchange) return false;
      return true;
    });

    const holdings = computeHoldings(txs, maps);
    const holding = holdings.find((h) => {
      if (h.ticker !== ticker) return false;
      if (exchange && h.exchange !== exchange) return false;
      return true;
    });

    const proceedsPerUnitAud =
      holding?.marketValueAud != null && holding.quantity > 0
        ? holding.marketValueAud / holding.quantity
        : null;
    if (proceedsPerUnitAud == null) {
      return c.json(
        {
          error:
            "no AUD market price for this ticker — refresh prices on Holdings first",
        },
        400,
      );
    }

    const inflationRate = inflationRateParam
      ? Number(inflationRateParam)
      : undefined;
    const estimate = estimateHypotheticalSale({
      openLots: lots,
      quantity,
      proceedsPerUnitAud,
      disposedDate,
      matching: matchingParam,
      regime: regimeParam,
      profile,
      annualInflationRate: inflationRate,
      cutover: loadCutoverValues(deps.getDb(), txs),
    });

    return c.json({
      ...estimate,
      ticker,
      exchange: exchange || lots[0]?.exchange || holding?.exchange || null,
      priceKey: holding
        ? holdingPriceKey(holding.exchange, holding.ticker)
        : null,
      marketPrice: holding?.marketPrice ?? null,
      currency: holding?.currency ?? lots[0]?.currency ?? null,
      unitsHeld: lots.reduce((s, l) => s + l.quantity, 0),
      openLots: lots.map((l) => ({
        acquiredDate: l.acquiredDate,
        quantity: l.quantity,
        costBaseAud: l.costBaseAud,
        unitCostAud: l.quantity > 0 ? l.costBaseAud / l.quantity : 0,
        sourceTxId: l.sourceTxId ?? null,
      })),
      taxProfile: { id: profileRow.id, ...profile },
      regime: regimeParam,
      lotMatching: matchingParam,
      inflationRate: inflationRate ?? null,
      filters: {
        portfolioId: portfolioId ? Number(portfolioId) : null,
        broker: broker ?? null,
        source: source ?? null,
        ticker,
        exchange: exchange || null,
      },
    });
  });
}

function loadProfile(
  db: Database.Database,
  taxProfileId: string | undefined,
):
  | { error: string }
  | {
      profileRow: TaxProfileRow;
      profile: {
        label: string;
        marginalRate: number;
        medicareLevy: number;
      };
    } {
  const profileRow = taxProfileId
    ? (db
        .prepare(
          `SELECT id, label, marginal_rate, medicare_levy, is_default
           FROM tax_profiles WHERE id = ?`,
        )
        .get(Number(taxProfileId)) as TaxProfileRow | undefined)
    : (db
        .prepare(
          `SELECT id, label, marginal_rate, medicare_levy, is_default
           FROM tax_profiles ORDER BY is_default DESC, id ASC LIMIT 1`,
        )
        .get() as TaxProfileRow | undefined);

  if (!profileRow) {
    return { error: "no tax profile found — set one up in Settings" };
  }

  return {
    profileRow,
    profile: {
      label: profileRow.label,
      marginalRate: profileRow.marginal_rate,
      medicareLevy: profileRow.medicare_levy,
    },
  };
}
