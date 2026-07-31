import { analyzeStakeDrp } from "@yields/core";
import type { Context } from "hono";
import type Database from "better-sqlite3";

/**
 * POST /api/import/stake-drp — Stake DRP detection (see
 * packages/core/src/parse/stakeDrp.ts for the reconciliation approach and
 * the guardrail against misattributing non-DRP unit changes).
 *
 * Deliberately decoupled from the regular per-file Activity/Income import:
 * takes any mix of Activity/Income/Valuation workbooks (any years, any
 * order) as a single multipart upload, computes proposed `drp` transactions
 * + warnings purely from the uploaded files (no ledger dependency), and only
 * writes to the DB when `commit=true` is passed — otherwise it's a preview.
 *
 * Idempotent: inserts use INSERT OR IGNORE keyed on (portfolio_id,
 * external_id), so re-running with an overlapping or superset set of files
 * safely skips whatever was already inserted rather than duplicating it.
 */
export function registerStakeDrpRoutes(
  app: {
    post: (
      path: string,
      handler: (c: Context) => Response | Promise<Response>,
    ) => unknown;
  },
  deps: { getDb: () => Database.Database },
) {
  app.post("/api/import/stake-drp", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const portfolioId = Number(body["portfolioId"] || body["accountId"]);
    const commit = body["commit"] === "true";

    if (!portfolioId || Number.isNaN(portfolioId)) {
      return c.json({ error: "portfolioId is required" }, 400);
    }

    const db = deps.getDb();
    const portfolio = db
      .prepare("SELECT id, name FROM portfolios WHERE id = ?")
      .get(portfolioId) as { id: number; name: string } | undefined;
    if (!portfolio) return c.json({ error: "portfolio not found" }, 404);

    const filesField = body["files"];
    const fileList = (Array.isArray(filesField) ? filesField : filesField ? [filesField] : []).filter(
      (f): f is File => typeof f !== "string",
    );
    if (fileList.length === 0) {
      return c.json({ error: "at least one file is required" }, 400);
    }

    const files = await Promise.all(
      fileList.map(async (f) => ({
        filename: f.name || "upload.xlsx",
        content: Buffer.from(await f.arrayBuffer()),
      })),
    );

    const analysis = analyzeStakeDrp(files);

    if (!commit) {
      return c.json({
        proposed: analysis.proposed,
        warnings: analysis.warnings,
        unrecognizedFiles: analysis.unrecognizedFiles,
        committed: false,
      });
    }

    const insertTx = db.prepare(
      `INSERT OR IGNORE INTO transactions
        (portfolio_id, account_id, date, ticker, exchange, type, quantity, price, amount, brokerage, currency, external_id, notes, source, broker, custody)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let inserted = 0;
    const insertMany = db.transaction((rows: typeof analysis.proposed) => {
      for (const t of rows) {
        const info = insertTx.run(
          portfolioId,
          portfolioId, // legacy NOT NULL account_id
          t.date,
          t.ticker,
          t.exchange,
          t.type,
          t.quantity,
          t.price,
          t.amount,
          t.brokerage,
          t.currency,
          t.externalId,
          t.notes,
          "stake-drp-detect",
          "stake",
          "stake",
        );
        if (info.changes > 0) inserted++;
      }
    });
    insertMany(analysis.proposed);

    return c.json({
      proposed: analysis.proposed,
      warnings: analysis.warnings,
      unrecognizedFiles: analysis.unrecognizedFiles,
      committed: true,
      inserted,
      skippedExisting: analysis.proposed.length - inserted,
    });
  });
}
