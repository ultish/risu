import {
  getStakeStatementPeriod,
  parseBrokerFile,
  readWorkbook,
  reconcileStakeActivity,
  type ReconcileLedgerRow,
} from "@risu/core";
import type { Context } from "hono";
import type Database from "better-sqlite3";

/**
 * POST /api/import/reconcile — read-only diff of a Stake Investment Activity
 * XLSX against ledger rows already in the DB (docs/import-layouts-plan.md §12).
 *
 * Thin plumbing only: read the upload, call the core parser + the pure
 * `reconcileStakeActivity` matcher, run one SELECT for candidate ledger rows.
 * NEVER writes to the DB.
 */
export function registerReconcileRoutes(
  app: {
    post: (
      path: string,
      handler: (c: Context) => Response | Promise<Response>,
    ) => unknown;
  },
  deps: { getDb: () => Database.Database },
) {
  app.post("/api/import/reconcile", async (c) => {
    const body = await c.req.parseBody();
    const file = body["file"];
    const portfolioId = Number(body["portfolioId"] || body["accountId"]);
    const tickerFilter = ((body["ticker"] as string | undefined) || "")
      .trim()
      .toUpperCase();
    const custody =
      ((body["custody"] as string | undefined) || "stake").trim() || "stake";

    if (!portfolioId || Number.isNaN(portfolioId)) {
      return c.json({ error: "portfolioId is required" }, 400);
    }
    if (!file || typeof file === "string") {
      return c.json({ error: "file is required" }, 400);
    }

    const portfolio = deps
      .getDb()
      .prepare("SELECT id, name FROM portfolios WHERE id = ?")
      .get(portfolioId) as { id: number; name: string } | undefined;
    if (!portfolio) return c.json({ error: "portfolio not found" }, 404);

    const filename = file.name || "upload.xlsx";
    if (!/\.(xlsx|xls)$/i.test(filename)) {
      return c.json(
        { error: "Reconcile currently supports Stake Investment Activity XLSX only" },
        400,
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());

    // Force the Stake parser — reconcile is XLSX-only and Stake-specific.
    const parsed = await parseBrokerFile({
      content: buf,
      filename,
      broker: "stake",
    });
    if (parsed.layoutId !== "stake.activity") {
      return c.json(
        {
          error:
            "Reconcile currently supports Stake Investment Activity XLSX only (this file did not parse as stake.activity)",
          layoutId: parsed.layoutId ?? null,
          warnings: parsed.warnings,
        },
        400,
      );
    }

    const workbook = readWorkbook(buf);
    const period = getStakeStatementPeriod(workbook);

    let transactions = parsed.transactions;
    if (tickerFilter) {
      transactions = transactions.filter(
        (t) => t.ticker.toUpperCase() === tickerFilter,
      );
    }

    let ledgerRows = deps
      .getDb()
      .prepare(
        `SELECT id, date, ticker, type, quantity, price, external_id
         FROM transactions
         WHERE portfolio_id = ?
           AND (broker = ? OR custody = ? OR broker = ? OR custody = ?)`,
      )
      .all(
        portfolioId,
        "stake",
        "stake",
        custody,
        custody,
      ) as ReconcileLedgerRow[];

    // Ticker filter applies to both sides — otherwise unrelated ledger rows
    // for other tickers would spuriously show up as ledgerOnly (the plan's
    // §12 pseudocode only filters the parsed side; we widen it here so a
    // ticker-scoped reconcile only reports on that ticker).
    if (tickerFilter) {
      ledgerRows = ledgerRows.filter(
        (l) => l.ticker.toUpperCase() === tickerFilter,
      );
    }

    const result = reconcileStakeActivity(transactions, ledgerRows, {
      period,
    });

    return c.json({
      ...result,
      warnings: parsed.warnings,
    });
  });
}
