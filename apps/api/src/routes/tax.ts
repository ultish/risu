import { estimateFyTax, type CgtRegime, type ParsedTransaction } from "@yields/core";
import type { Context } from "hono";
import type Database from "better-sqlite3";

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

/**
 * GET /api/tax/fy-estimate — roughly how much tax is owed for a financial
 * year: dividend income tax + realised CGT on actual sells (FIFO per-parcel
 * cost base, see @yields/core `computeLots`/`estimateRealisedCgtForLedger`),
 * combined the same way the planner combines them for a hypothetical
 * scenario, but against the real ledger.
 *
 * Query: portfolioId?, broker?, source?, taxProfileId? (default profile if
 * omitted), regime? (default auto_by_date), inflationRate? (decimal,
 * post-2027 CPI indexation), asxFrankingPercent?, usWithholdingRate?
 * (decimal 0-1). Thin plumbing only — all math lives in @yields/core.
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
    }) => ParsedTransaction[];
    priceMapsFromCache: () => {
      prices: Record<string, number | null>;
      fxRates: Record<string, number | null>;
    };
  },
) {
  app.get("/api/tax/fy-estimate", (c) => {
    const portfolioId = c.req.query("portfolioId") || c.req.query("accountId");
    const broker = c.req.query("broker") || undefined;
    const source = c.req.query("source") || undefined;
    const taxProfileId = c.req.query("taxProfileId");
    const regimeParam = c.req.query("regime") || "auto_by_date";
    const inflationRateParam = c.req.query("inflationRate");
    const asxFrankingParam = c.req.query("asxFrankingPercent");
    const usWithholdingParam = c.req.query("usWithholdingRate");

    if (!VALID_REGIMES.includes(regimeParam as CgtRegime)) {
      return c.json(
        { error: `regime must be one of ${VALID_REGIMES.join(", ")}` },
        400,
      );
    }

    const db = deps.getDb();
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
      return c.json({ error: "no tax profile found — set one up in Settings" }, 400);
    }

    const profile = {
      label: profileRow.label,
      marginalRate: profileRow.marginal_rate,
      medicareLevy: profileRow.medicare_levy,
    };

    const txs = deps.loadTransactions({
      portfolioId: portfolioId ? Number(portfolioId) : undefined,
      broker,
      source,
    });
    const maps = deps.priceMapsFromCache();

    const report = estimateFyTax(txs, maps.fxRates, {
      profile,
      cgtRegime: regimeParam as CgtRegime,
      cgtInflationRate: inflationRateParam ? Number(inflationRateParam) : undefined,
      asxFrankingPercent: asxFrankingParam ? Number(asxFrankingParam) : undefined,
      usWithholdingRate: usWithholdingParam ? Number(usWithholdingParam) : undefined,
    });

    return c.json({
      ...report,
      taxProfile: { id: profileRow.id, ...profile },
      regime: regimeParam,
      filters: {
        portfolioId: portfolioId ? Number(portfolioId) : null,
        broker: broker ?? null,
        source: source ?? null,
      },
    });
  });
}
