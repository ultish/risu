import {
  CUTOVER_VALUATION_DATE,
  combineValuations,
  cutoverValuesFrom,
  valuationAsOf,
  valuationReportToCsv,
  type CutoverValues,
  type ParsedTransaction,
  type RecordedParcelTake,
  type ValuationReport,
} from "@risu/core";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { loadFxHistory, loadFxRates, loadPriceSeries } from "./performance.js";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

type SnapshotRow = {
  id: number;
  as_of: string;
  label: string;
  notes: string | null;
  portfolio_id: number | null;
  report_json: string;
  created_at: string;
};

/**
 * 30 June 2027 values for splitting disposals under the Act: cached prices,
 * overridden by any valuations saved for that date (newest last, so it wins
 * where they overlap). Read-only.
 */
export function loadCutoverValues(
  db: Database.Database,
  transactions: ParsedTransaction[],
): CutoverValues {
  const rows = db
    .prepare("SELECT report_json FROM valuation_snapshots WHERE as_of = ? ORDER BY id")
    .all(CUTOVER_VALUATION_DATE) as Array<{ report_json: string }>;
  const saved = rows.length
    ? combineValuations(
        CUTOVER_VALUATION_DATE,
        "",
        rows.flatMap((r) => (JSON.parse(r.report_json) as ValuationReport).portfolios),
      )
    : null;
  return cutoverValuesFrom(transactions, {
    priceSeries: loadPriceSeries(db),
    fx: { rates: loadFxRates(db), series: loadFxHistory(db) },
    saved,
  });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Valuations: what every holding was worth on a past date, per portfolio,
 * broker, stock and parcel — previewed, then saved as a fixed record.
 *
 * GET    /api/valuations/preview?asOf=&portfolioId=
 * POST   /api/valuations            { asOf, portfolioId?, label, notes? }
 * GET    /api/valuations            saved list (summaries)
 * GET    /api/valuations/:id        one saved report
 * GET    /api/valuations/:id/csv    one saved report, one row per parcel
 * DELETE /api/valuations/:id
 */
export function registerValuationRoutes(
  app: Hono,
  deps: {
    getDb: () => Database.Database;
    loadTransactions: (filters: { portfolioId?: number }) => ParsedTransaction[];
    loadParcelTakes: () => RecordedParcelTake[];
    loadPlatformFifoBrokers: () => string[];
  },
) {
  const build = (asOf: string, portfolioId: number | null): ValuationReport => {
    const db = deps.getDb();
    const portfolios = db
      .prepare("SELECT id, name FROM portfolios ORDER BY name")
      .all() as Array<{ id: number; name: string }>;
    const chosen = portfolioId == null ? portfolios : portfolios.filter((p) => p.id === portfolioId);
    const priceSeries = loadPriceSeries(db);
    const fx = { rates: loadFxRates(db), series: loadFxHistory(db) };
    const lotOptions = {
      recordedTakes: deps.loadParcelTakes(),
      platformFifoBrokers: deps.loadPlatformFifoBrokers(),
    };
    return combineValuations(
      asOf,
      new Date().toISOString(),
      chosen.map((p) => ({
        id: p.id,
        name: p.name,
        valuation: valuationAsOf(deps.loadTransactions({ portfolioId: p.id }), {
          asOf,
          priceSeries,
          fx,
          lotOptions,
        }),
      })),
    );
  };

  const parse = (asOf: unknown, portfolioId: unknown) => {
    if (typeof asOf !== "string" || !ISO.test(asOf)) return { error: "asOf must be yyyy-mm-dd" };
    if (asOf > todayIso()) return { error: "asOf can't be in the future" };
    const pid =
      portfolioId == null || portfolioId === "" || portfolioId === "all"
        ? null
        : Number(portfolioId);
    if (pid != null && !Number.isInteger(pid)) return { error: "portfolioId must be an id or 'all'" };
    return { asOf, pid };
  };

  const summary = (row: SnapshotRow) => {
    const r = JSON.parse(row.report_json) as ValuationReport;
    return {
      id: row.id,
      asOf: row.as_of,
      label: row.label,
      notes: row.notes,
      portfolioId: row.portfolio_id,
      createdAt: row.created_at,
      marketValueAud: r.marketValueAud,
      costBaseAud: r.costBaseAud,
      unvalued: r.unvalued,
    };
  };

  app.get("/api/valuations/preview", (c) => {
    const p = parse(c.req.query("asOf"), c.req.query("portfolioId"));
    if ("error" in p) return c.json({ error: p.error }, 400);
    return c.json(build(p.asOf, p.pid));
  });

  app.post("/api/valuations", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      asOf?: string;
      portfolioId?: number | "all" | null;
      label?: string;
      notes?: string;
    };
    const p = parse(body.asOf, body.portfolioId);
    if ("error" in p) return c.json({ error: p.error }, 400);
    // Recomputed here, not taken from the client: the saved record is what
    // the ledger and price cache said at the moment it was saved.
    const report = build(p.asOf, p.pid);
    const label = body.label?.trim() || `Valuation ${p.asOf}`;
    const info = deps
      .getDb()
      .prepare(
        `INSERT INTO valuation_snapshots (as_of, label, notes, portfolio_id, report_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(p.asOf, label, body.notes?.trim() || null, p.pid, JSON.stringify(report));
    const row = deps
      .getDb()
      .prepare("SELECT * FROM valuation_snapshots WHERE id = ?")
      .get(info.lastInsertRowid) as SnapshotRow;
    return c.json({ ...summary(row), report }, 201);
  });

  app.get("/api/valuations", (c) => {
    const rows = deps
      .getDb()
      .prepare("SELECT * FROM valuation_snapshots ORDER BY as_of DESC, id DESC")
      .all() as SnapshotRow[];
    return c.json(rows.map(summary));
  });

  const load = (id: string): SnapshotRow | undefined =>
    deps.getDb().prepare("SELECT * FROM valuation_snapshots WHERE id = ?").get(Number(id)) as
      | SnapshotRow
      | undefined;

  app.get("/api/valuations/:id", (c) => {
    const row = load(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ ...summary(row), report: JSON.parse(row.report_json) as ValuationReport });
  });

  app.get("/api/valuations/:id/csv", (c) => {
    const row = load(c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    const csv = valuationReportToCsv(JSON.parse(row.report_json) as ValuationReport);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="risu-valuation-${row.as_of}-${row.id}.csv"`,
      },
    });
  });

  app.delete("/api/valuations/:id", (c) => {
    const info = deps
      .getDb()
      .prepare("DELETE FROM valuation_snapshots WHERE id = ?")
      .run(Number(c.req.param("id")));
    if (info.changes === 0) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });
}
