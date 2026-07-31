import { transactionsToCsv } from "@yields/core";
import type { Context } from "hono";
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * GET /api/export/transactions.csv?portfolioId=&broker=&source=&ticker=
 * GET /api/export/backup — download risu-YYYY-MM-DD.db
 */
export function registerExportRoutes(
  app: {
    get: (
      path: string,
      handler: (c: Context) => Response | Promise<Response>,
    ) => unknown;
  },
  deps: {
    getDb: () => Database.Database;
    dbPath: string;
  },
) {
  app.get("/api/export/transactions.csv", (c) => {
    const portfolioId = c.req.query("portfolioId") || c.req.query("accountId");
    const broker = c.req.query("broker") || undefined;
    const source = c.req.query("source") || undefined;
    const ticker = c.req.query("ticker") || undefined;
    const exchange = c.req.query("exchange") || undefined;

    let sql = "SELECT * FROM transactions WHERE 1=1";
    const params: unknown[] = [];
    if (portfolioId) {
      sql += " AND portfolio_id = ?";
      params.push(Number(portfolioId));
    }
    if (broker) {
      sql += " AND (broker = ? OR custody = ?)";
      params.push(broker, broker);
    }
    if (source) {
      sql += " AND source = ?";
      params.push(source);
    }
    if (ticker) {
      sql += " AND ticker = ?";
      params.push(ticker.toUpperCase());
    }
    if (exchange) {
      sql += " AND exchange = ?";
      params.push(exchange.toUpperCase());
    }
    sql += " ORDER BY date ASC, id ASC";

    const rows = deps.getDb().prepare(sql).all(...params) as Array<{
      id: number;
      date: string;
      ticker: string;
      exchange: string;
      type: string;
      quantity: number;
      price: number | null;
      amount: number | null;
      brokerage: number;
      currency: string;
      broker: string | null;
      source: string | null;
      portfolio_id: number | null;
      notes: string | null;
      external_id: string | null;
    }>;

    const csv = transactionsToCsv(rows);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition":
          `attachment; filename="risu-transactions-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  });

  app.get("/api/export/backup", (c) => {
    const dbPath = resolveDbPath(deps.dbPath);
    if (!fs.existsSync(dbPath)) {
      return c.json({ error: `Database not found at ${dbPath}` }, 404);
    }

    // Checkpoint WAL so the main file is self-contained for download
    try {
      deps.getDb().pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      /* non-fatal */
    }

    const buf = fs.readFileSync(dbPath);
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const filename = `risu-${day}.db`;
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(buf.byteLength),
      },
    });
  });
}

function resolveDbPath(configured: string): string {
  if (process.env.YIELDS_DB_PATH) return process.env.YIELDS_DB_PATH;
  return configured;
}
