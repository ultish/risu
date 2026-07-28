import "./env.js";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  buildDrpCheck,
  computeHoldings,
  defaultAllocationTemplates,
  defaultCurrencyForExchange,
  fetchFxHistory,
  fetchFxMulti,
  fetchNasdaqHistory,
  fetchQuotesMulti,
  buildYahooChartHistoryUrl,
  buildYahooQuoteUrl,
  buildYahooSparkHistoryUrl,
  fetchYahooDividends,
  fetchYahooHistory,
  fetchYahooSparkHistoryBulk,
  fetchYahooQuote,
  holdingPriceKey,
  listInstrumentSeeds,
  parseBrokerFile,
  resolveForcedBroker,
  parseSharesightPaste,
  parseYahooManualPayload,
  resolveInstrumentAssumptions,
  resolveInstrumentFromSeed,
  runScenario,
  summarizeDividendIncome,
  toYahooSymbol,
  type BrokerId,
  type InstrumentAssumptions,
  type ParsedTransaction,
  type Scenario,
  type TransactionType,
} from "@yields/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import fs from "node:fs";
import path from "node:path";
import { getDbPath, openDb } from "./db.js";
import { registerExportRoutes } from "./routes/export.js";
import { registerPerformanceRoutes } from "./routes/performance.js";
import { registerReconcileRoutes } from "./routes/reconcile.js";
import {
  assertYahooAllowed,
  clearYahooCooldown,
  getYahooStatus,
  recordYahooFailure,
  recordYahooRefreshStarted,
  recordYahooSuccess,
} from "./yahooGate.js";

const db = openDb();
const app = new Hono();

/** Absolute path to built web UI (apps/web/dist), if present. */
function resolveWebDistAbs(): string | null {
  const candidates = [
    process.env.WEB_DIST_PATH,
    path.resolve(process.cwd(), "../web/dist"),
    path.resolve(process.cwd(), "../../apps/web/dist"),
    path.resolve(process.cwd(), "apps/web/dist"),
  ].filter((p): p is string => Boolean(p));

  for (const p of candidates) {
    try {
      if (fs.existsSync(path.join(p, "index.html"))) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const webDistAbs = resolveWebDistAbs();
/**
 * Serve SPA when dist exists (SERVE_WEB=1 or auto).
 * SERVE_WEB=0 disables even if dist is present (keeps Vite-only dev clean if needed).
 */
const serveWeb = process.env.SERVE_WEB !== "0" && webDistAbs != null;

app.use(
  "*",
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  }),
);

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    service: "yields-api",
    dbPath: getDbPath(),
    serveWeb,
    yahoo: getYahooStatus(db),
  }),
);

/** Yahoo cool-down / rate-limit status for the UI badge (no network call). */
app.get("/api/yahoo/status", (c) => c.json(getYahooStatus(db)));

/** Clear cool-down timer (does not call Yahoo). */
app.post("/api/yahoo/clear-cooldown", (c) => {
  clearYahooCooldown(db);
  return c.json(getYahooStatus(db));
});

// ─── Portfolios (Me / Partner / custom) ─────────────────────────────────────

app.get("/api/portfolios", (c) => {
  const rows = db
    .prepare(
      "SELECT id, name, notes, created_at FROM portfolios ORDER BY name",
    )
    .all();
  return c.json(rows);
});

app.post("/api/portfolios", async (c) => {
  const body = await c.req.json<{ name: string; notes?: string }>();
  if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
  try {
    const info = db
      .prepare("INSERT INTO portfolios (name, notes) VALUES (?, ?)")
      .run(body.name.trim(), body.notes ?? null);
    return c.json(
      {
        id: Number(info.lastInsertRowid),
        name: body.name.trim(),
        notes: body.notes ?? null,
      },
      201,
    );
  } catch (e) {
    return c.json(
      {
        error:
          e instanceof Error && e.message.includes("UNIQUE")
            ? "Portfolio name already exists"
            : String(e),
      },
      400,
    );
  }
});

app.patch("/api/portfolios/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ name?: string; notes?: string | null }>();
  const existing = db
    .prepare("SELECT * FROM portfolios WHERE id = ?")
    .get(id) as { id: number; name: string; notes: string | null } | undefined;
  if (!existing) return c.json({ error: "not found" }, 404);
  db.prepare("UPDATE portfolios SET name = ?, notes = ? WHERE id = ?").run(
    body.name?.trim() || existing.name,
    body.notes !== undefined ? body.notes : existing.notes,
    id,
  );
  return c.json(db.prepare("SELECT * FROM portfolios WHERE id = ?").get(id));
});

app.delete("/api/portfolios/:id", (c) => {
  const id = Number(c.req.param("id"));
  const n = db
    .prepare("SELECT COUNT(*) AS c FROM transactions WHERE portfolio_id = ?")
    .get(id) as { c: number };
  if (n.c > 0) {
    return c.json(
      { error: "Portfolio has transactions — move or delete them first" },
      400,
    );
  }
  const info = db.prepare("DELETE FROM portfolios WHERE id = ?").run(id);
  if (info.changes === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

/** @deprecated use /api/portfolios */
app.get("/api/accounts", (c) => {
  const rows = db
    .prepare(
      "SELECT id, name, '' AS broker, created_at FROM portfolios ORDER BY name",
    )
    .all();
  return c.json(rows);
});

// ─── Filter helpers ─────────────────────────────────────────────────────────

function loadTransactions(filters: {
  portfolioId?: number;
  broker?: string;
  source?: string;
}): ParsedTransaction[] {
  let sql = "SELECT * FROM transactions WHERE 1=1";
  const params: unknown[] = [];
  if (filters.portfolioId != null) {
    sql += " AND portfolio_id = ?";
    params.push(filters.portfolioId);
  }
  if (filters.broker) {
    sql += " AND (broker = ? OR custody = ?)";
    params.push(filters.broker, filters.broker);
  }
  if (filters.source) {
    sql += " AND source = ?";
    params.push(filters.source);
  }
  sql += " ORDER BY date ASC, id ASC";
  const rows = db.prepare(sql).all(...params) as Array<{
    date: string;
    ticker: string;
    exchange: string;
    type: string;
    quantity: number;
    price: number | null;
    amount: number | null;
    brokerage: number;
    currency: string;
    external_id: string | null;
    notes: string | null;
  }>;

  return rows.map((r) => ({
    date: r.date,
    ticker: r.ticker,
    exchange: r.exchange,
    type: r.type as TransactionType,
    quantity: r.quantity,
    price: r.price,
    amount: r.amount,
    brokerage: r.brokerage,
    currency: r.currency,
    externalId: r.external_id,
    notes: r.notes,
  }));
}

function priceMapsFromCache(): {
  prices: Record<string, number | null>;
  fxRates: Record<string, number | null>;
} {
  const quotes = db
    .prepare("SELECT symbol, price FROM quote_cache")
    .all() as Array<{ symbol: string; price: number }>;
  const prices: Record<string, number | null> = {};
  for (const q of quotes) {
    prices[q.symbol] = q.price;
    if (q.symbol.endsWith(".AX")) {
      const bare = q.symbol.slice(0, -3);
      prices[holdingPriceKey("ASX", bare)] = q.price;
      prices[bare] = q.price;
    } else if (!q.symbol.includes("=") && !q.symbol.includes(".")) {
      prices[holdingPriceKey("US", q.symbol)] = q.price;
      prices[q.symbol] = q.price;
    }
  }
  const fxRows = db
    .prepare("SELECT pair, rate FROM fx_cache")
    .all() as Array<{ pair: string; rate: number }>;
  const fxRates: Record<string, number | null> = {};
  for (const f of fxRows) fxRates[f.pair] = f.rate;
  return { prices, fxRates };
}

registerPerformanceRoutes(app, { db, loadTransactions });
registerExportRoutes(app, { db, dbPath: getDbPath() });
registerReconcileRoutes(app, { db });

// ─── Transactions ───────────────────────────────────────────────────────────

app.get("/api/transactions", (c) => {
  const portfolioId = c.req.query("portfolioId") || c.req.query("accountId");
  const broker = c.req.query("broker") || undefined;
  const source = c.req.query("source") || undefined;
  const ticker = c.req.query("ticker");

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
  const exchange = c.req.query("exchange");
  if (exchange) {
    sql += " AND exchange = ?";
    params.push(exchange.toUpperCase());
  }
  sql += " ORDER BY date DESC, id DESC";
  return c.json(db.prepare(sql).all(...params));
});

app.get("/api/meta/filters", (c) => {
  const brokers = db
    .prepare(
      `SELECT DISTINCT COALESCE(broker, custody) AS broker FROM transactions
       WHERE COALESCE(broker, custody) IS NOT NULL AND COALESCE(broker, custody) != ''
       ORDER BY 1`,
    )
    .all() as Array<{ broker: string }>;
  const sources = db
    .prepare(
      `SELECT DISTINCT source FROM transactions
       WHERE source IS NOT NULL AND source != ''
       ORDER BY 1`,
    )
    .all() as Array<{ source: string }>;
  return c.json({
    brokers: brokers.map((b) => b.broker),
    sources: sources.map((s) => s.source),
    knownBrokers: [
      "commsec",
      "pocket",
      "selfwealth",
      "stake",
      "betashares_direct",
      "other",
    ],
    knownSources: [
      "sharesight_paste",
      "file:commsec",
      "file:stake",
      "file:selfwealth",
      "file:pocket",
      "file:betashares_direct",
      "file:sharesight",
      "file:generic",
      "manual",
    ],
  });
});

app.post("/api/transactions", async (c) => {
  const body = await c.req.json<{
    portfolioId?: number;
    accountId?: number;
    date: string;
    ticker: string;
    exchange?: string;
    type: TransactionType;
    quantity: number;
    price?: number | null;
    amount?: number | null;
    brokerage?: number;
    currency?: string;
    notes?: string | null;
    broker?: string;
    source?: string;
  }>();

  const portfolioId = body.portfolioId ?? body.accountId;
  if (!portfolioId || !body.date || !body.ticker || !body.type) {
    return c.json(
      { error: "portfolioId, date, ticker, type required" },
      400,
    );
  }

  const exchange = (body.exchange || "ASX").toUpperCase();
  const currency = (
    body.currency || defaultCurrencyForExchange(exchange)
  ).toUpperCase();
  const broker = body.broker || null;
  const source = body.source || "manual";
  const externalId = `manual|${body.date}|${exchange}|${body.ticker}|${body.type}|${body.quantity}|${body.price ?? ""}|${Date.now()}`;

  const info = db
    .prepare(
      `INSERT INTO transactions
        (portfolio_id, account_id, import_batch_id, date, ticker, exchange, type, quantity, price, amount, brokerage, currency, external_id, notes, source, broker, custody)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      portfolioId,
      portfolioId, // legacy NOT NULL account_id — dual-write portfolio id
      body.date,
      body.ticker.toUpperCase(),
      exchange,
      body.type,
      body.quantity ?? 0,
      body.price ?? null,
      body.amount ?? null,
      body.brokerage ?? 0,
      currency,
      externalId,
      body.notes ?? null,
      source,
      broker,
      broker,
    );

  return c.json(
    db.prepare("SELECT * FROM transactions WHERE id = ?").get(info.lastInsertRowid),
    201,
  );
});

app.patch("/api/transactions/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const existing = db
    .prepare("SELECT * FROM transactions WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!existing) return c.json({ error: "not found" }, 404);

  const body = await c.req.json<Partial<{
    date: string;
    ticker: string;
    exchange: string;
    type: string;
    quantity: number;
    price: number | null;
    amount: number | null;
    brokerage: number;
    currency: string;
    notes: string | null;
    broker: string | null;
    source: string | null;
    portfolioId: number;
  }>>();

  db.prepare(
    `UPDATE transactions SET
      date=?, ticker=?, exchange=?, type=?, quantity=?, price=?, amount=?, brokerage=?, currency=?, notes=?,
      broker=?, custody=?, source=?, portfolio_id=?
     WHERE id=?`,
  ).run(
    body.date ?? existing.date,
    (body.ticker ?? (existing.ticker as string)).toString().toUpperCase(),
    (body.exchange ?? (existing.exchange as string)).toString().toUpperCase(),
    body.type ?? existing.type,
    body.quantity ?? existing.quantity,
    body.price !== undefined ? body.price : existing.price,
    body.amount !== undefined ? body.amount : existing.amount,
    body.brokerage ?? existing.brokerage,
    (body.currency ?? (existing.currency as string)).toString().toUpperCase(),
    body.notes !== undefined ? body.notes : existing.notes,
    body.broker !== undefined ? body.broker : existing.broker,
    body.broker !== undefined ? body.broker : existing.custody,
    body.source !== undefined ? body.source : existing.source,
    body.portfolioId ?? existing.portfolio_id,
    id,
  );

  return c.json(db.prepare("SELECT * FROM transactions WHERE id = ?").get(id));
});

app.delete("/api/transactions/:id", (c) => {
  const id = Number(c.req.param("id"));
  const info = db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
  if (info.changes === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, id });
});

/** Bulk delete: { ids: number[] } */
app.post("/api/transactions/delete", async (c) => {
  const body = await c.req.json<{ ids?: number[] }>();
  const ids = (body.ids ?? []).map(Number).filter((n) => !Number.isNaN(n));
  if (!ids.length) return c.json({ error: "ids required" }, 400);
  const del = db.prepare("DELETE FROM transactions WHERE id = ?");
  const run = db.transaction((list: number[]) => {
    let n = 0;
    for (const id of list) n += del.run(id).changes;
    return n;
  });
  const deleted = run(ids);
  return c.json({ ok: true, deleted });
});

app.get("/api/holdings", (c) => {
  const portfolioId = c.req.query("portfolioId") || c.req.query("accountId");
  const broker = c.req.query("broker") || undefined;
  const source = c.req.query("source") || undefined;

  const txs = loadTransactions({
    portfolioId: portfolioId ? Number(portfolioId) : undefined,
    broker,
    source,
  });
  const maps = priceMapsFromCache();
  const holdings = computeHoldings(txs, maps);

  const totalCostAud = holdings.reduce((s, h) => {
    if (h.costBaseAud != null) return s + h.costBaseAud;
    if (h.currency === "AUD") return s + h.costBase;
    return s;
  }, 0);
  const pricedAud = holdings.filter((h) => h.marketValueAud != null);
  const totalValueAud = pricedAud.reduce(
    (s, h) => s + (h.marketValueAud ?? 0),
    0,
  );
  const costOfPricedAud = pricedAud.reduce((s, h) => {
    if (h.costBaseAud != null) return s + h.costBaseAud;
    if (h.currency === "AUD") return s + h.costBase;
    return s;
  }, 0);

  return c.json({
    holdings,
    totals: {
      costBaseAud: round2(totalCostAud),
      marketValueAud: pricedAud.length ? round2(totalValueAud) : null,
      unrealisedAud: pricedAud.length
        ? round2(totalValueAud - costOfPricedAud)
        : null,
      costBase: round2(totalCostAud),
      marketValue: pricedAud.length ? round2(totalValueAud) : null,
      unrealised: pricedAud.length
        ? round2(totalValueAud - costOfPricedAud)
        : null,
    },
    fx: maps.fxRates,
    filters: {
      portfolioId: portfolioId ? Number(portfolioId) : null,
      broker: broker ?? null,
      source: source ?? null,
    },
  });
});

// ─── Income (assessable dividends by AU FY; cash + DRP, de-duped) ───────────
// UI tab removed for now; endpoint kept for restore / tooling.

app.get("/api/income", (c) => {
  const portfolioId = c.req.query("portfolioId") || c.req.query("accountId");
  const broker = c.req.query("broker") || undefined;
  const source = c.req.query("source") || undefined;

  const txs = loadTransactions({
    portfolioId: portfolioId ? Number(portfolioId) : undefined,
    broker,
    source,
  });
  const maps = priceMapsFromCache();
  const summary = summarizeDividendIncome(txs, maps.fxRates);

  return c.json({
    ...summary,
    filters: {
      portfolioId: portfolioId ? Number(portfolioId) : null,
      broker: broker ?? null,
      source: source ?? null,
    },
    fx: maps.fxRates,
  });
});

// ─── Holding flags (DRP/DRIP enabled) ───────────────────────────────────────

app.get("/api/holdings/flags", (c) => {
  const portfolioId = c.req.query("portfolioId") || c.req.query("accountId");
  if (!portfolioId) {
    return c.json({ error: "portfolioId is required" }, 400);
  }
  const rows = db
    .prepare(
      `SELECT portfolio_id, ticker, exchange, drp_enabled, drp_from_date
       FROM holding_flags
       WHERE portfolio_id = ?
       ORDER BY exchange, ticker`,
    )
    .all(Number(portfolioId)) as Array<{
    portfolio_id: number;
    ticker: string;
    exchange: string;
    drp_enabled: number;
    drp_from_date: string | null;
  }>;

  return c.json({
    portfolioId: Number(portfolioId),
    flags: rows.map((r) => ({
      portfolioId: r.portfolio_id,
      ticker: r.ticker,
      exchange: r.exchange,
      drpEnabled: Boolean(r.drp_enabled),
      drpFromDate: r.drp_from_date,
    })),
  });
});

app.put("/api/holdings/flags", async (c) => {
  const body = await c.req.json<{
    portfolioId?: number;
    accountId?: number;
    ticker: string;
    exchange?: string;
    drpEnabled: boolean;
    drpFromDate?: string | null;
  }>();

  const portfolioId = body.portfolioId ?? body.accountId;
  if (!portfolioId || !body.ticker?.trim()) {
    return c.json({ error: "portfolioId and ticker required" }, 400);
  }

  const portfolio = db
    .prepare("SELECT id FROM portfolios WHERE id = ?")
    .get(portfolioId) as { id: number } | undefined;
  if (!portfolio) return c.json({ error: "portfolio not found" }, 404);

  const ticker = body.ticker.trim().toUpperCase();
  const exchange = (body.exchange || "ASX").toUpperCase();
  const drpEnabled = body.drpEnabled ? 1 : 0;
  const drpFromDate =
    body.drpFromDate && body.drpFromDate.trim()
      ? body.drpFromDate.trim().slice(0, 10)
      : null;

  db.prepare(
    `INSERT INTO holding_flags (portfolio_id, ticker, exchange, drp_enabled, drp_from_date)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(portfolio_id, ticker, exchange) DO UPDATE SET
       drp_enabled = excluded.drp_enabled,
       drp_from_date = excluded.drp_from_date`,
  ).run(portfolioId, ticker, exchange, drpEnabled, drpFromDate);

  const row = db
    .prepare(
      `SELECT portfolio_id, ticker, exchange, drp_enabled, drp_from_date
       FROM holding_flags
       WHERE portfolio_id = ? AND ticker = ? AND exchange = ?`,
    )
    .get(portfolioId, ticker, exchange) as {
    portfolio_id: number;
    ticker: string;
    exchange: string;
    drp_enabled: number;
    drp_from_date: string | null;
  };

  return c.json({
    portfolioId: row.portfolio_id,
    ticker: row.ticker,
    exchange: row.exchange,
    drpEnabled: Boolean(row.drp_enabled),
    drpFromDate: row.drp_from_date,
  });
});

// ─── DRP/DRIP check (suggestions only — never writes ledger) ────────────────

app.get("/api/drp-check", async (c) => {
  const portfolioId = c.req.query("portfolioId") || c.req.query("accountId");
  const ticker = (c.req.query("ticker") || "").toUpperCase();
  const exchange = (c.req.query("exchange") || "ASX").toUpperCase();

  if (!portfolioId || !ticker) {
    return c.json(
      { error: "portfolioId and ticker are required" },
      400,
    );
  }

  const pid = Number(portfolioId);
  const flagRow = db
    .prepare(
      `SELECT ticker, exchange, drp_enabled, drp_from_date
       FROM holding_flags
       WHERE portfolio_id = ? AND ticker = ? AND exchange = ?`,
    )
    .get(pid, ticker, exchange) as
    | {
        ticker: string;
        exchange: string;
        drp_enabled: number;
        drp_from_date: string | null;
      }
    | undefined;

  const txs = loadTransactions({ portfolioId: pid }).filter(
    (t) =>
      t.ticker.toUpperCase() === ticker &&
      (t.exchange || "ASX").toUpperCase() === exchange,
  );

  const symbol = toYahooSymbol(ticker, exchange);
  let dividends: Awaited<ReturnType<typeof fetchYahooDividends>> = [];
  let yahooError: string | null = null;
  let yahooSource: "cache" | "yahoo" | "none" = "none";

  // force=1 always hits Yahoo; otherwise skip live call when cache is fresh
  const forceYahoo =
    c.req.query("force") === "1" || c.req.query("refresh") === "1";
  /** Default 7 days — dividends don't change every click */
  const cacheMaxAgeHours = Number(c.req.query("cacheHours") || 168);

  const cachedMeta = db
    .prepare(
      `SELECT MAX(fetched_at) AS fetched_at, COUNT(*) AS n
       FROM dividend_cache WHERE symbol = ?`,
    )
    .get(symbol) as { fetched_at: string | null; n: number } | undefined;

  const cachedDivs = db
    .prepare(
      `SELECT date, amount FROM dividend_cache WHERE symbol = ? ORDER BY date`,
    )
    .all(symbol) as Array<{ date: string; amount: number }>;
  if (cachedDivs.length) {
    dividends = cachedDivs.map((d) => ({
      date: d.date,
      amount: d.amount,
      frankingPercent: null,
    }));
    yahooSource = "cache";
  }

  const cacheAgeMs = cachedMeta?.fetched_at
    ? Date.now() - new Date(cachedMeta.fetched_at + "Z").getTime()
    : Infinity;
  // SQLite datetime is UTC-ish without Z; if parse fails, treat as stale
  const cacheFresh =
    cachedDivs.length > 0 &&
    Number.isFinite(cacheAgeMs) &&
    cacheAgeMs < cacheMaxAgeHours * 3600 * 1000;

  // Only hit Yahoo when forced or cache stale — never on mere page load.
  // Respect cool-down unless force=1 (UI should still warn).
  let shouldHitYahoo = forceYahoo || !cacheFresh;
  if (shouldHitYahoo) {
    try {
      assertYahooAllowed(db, { force: forceYahoo });
    } catch (e) {
      shouldHitYahoo = false;
      const msg = e instanceof Error ? e.message : String(e);
      if (dividends.length) {
        yahooError = `${msg} — using ${dividends.length} cached dividend(s).`;
      } else {
        yahooError = msg;
      }
    }
  }

  if (shouldHitYahoo) {
    try {
      const fresh = await fetchYahooDividends(ticker, { exchange });
      if (fresh.length) {
        dividends = fresh;
        yahooSource = "yahoo";
        recordYahooSuccess(db);
        const upsert = db.prepare(
          `INSERT INTO dividend_cache (symbol, date, amount, fetched_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(symbol, date) DO UPDATE SET
             amount = excluded.amount,
             fetched_at = excluded.fetched_at`,
        );
        const write = db.transaction((rows: typeof fresh) => {
          for (const d of rows) upsert.run(symbol, d.date, d.amount);
        });
        write(fresh);
      } else if (!dividends.length) {
        yahooError =
          "Yahoo returned no dividend events for this symbol (or blocked the request). Import cash dividends / DRP from your broker or Sharesight instead.";
      } else {
        recordYahooSuccess(db);
      }
    } catch (e) {
      recordYahooFailure(db, e);
      const msg = e instanceof Error ? e.message : String(e);
      if (dividends.length) {
        yahooError = `${msg} — using ${dividends.length} cached dividend(s).`;
      } else {
        yahooError = `${msg} Tip: import dividend_cash / DRP rows from Sharesight or your broker — DRP check does not need live Yahoo.`;
      }
    }
  } else if (dividends.length && !yahooError) {
    yahooError = null; // quiet success from cache
  }

  const result = buildDrpCheck({
    ticker,
    exchange,
    flag: flagRow
      ? {
          ticker: flagRow.ticker,
          exchange: flagRow.exchange,
          drpEnabled: Boolean(flagRow.drp_enabled),
          drpFromDate: flagRow.drp_from_date,
        }
      : {
          ticker,
          exchange,
          drpEnabled: false,
          drpFromDate: null,
        },
    dividends,
    transactions: txs,
  });

  return c.json({
    ...result,
    portfolioId: pid,
    yahooDividendCount: dividends.length,
    yahooError,
    yahooSource,
    yahooCacheFresh: cacheFresh,
  });
});

// ─── Import file ────────────────────────────────────────────────────────────

app.post("/api/import", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];
  const portfolioId = Number(body["portfolioId"] || body["accountId"]);
  // Form field "broker" is the *parser* (or "auto"). Custody is separate.
  const parserField = (body["broker"] as string | undefined) || "auto";
  const custodyBroker =
    (body["custody"] as string | undefined) ||
    (body["sourceBroker"] as string | undefined) ||
    null;
  const sourceOverride = (body["source"] as string | undefined) || null;

  if (!portfolioId || Number.isNaN(portfolioId)) {
    return c.json({ error: "portfolioId is required" }, 400);
  }
  if (!file || typeof file === "string") {
    return c.json({ error: "file is required" }, 400);
  }

  const portfolio = db
    .prepare("SELECT id, name FROM portfolios WHERE id = ?")
    .get(portfolioId) as { id: number; name: string } | undefined;
  if (!portfolio) return c.json({ error: "portfolio not found" }, 404);

  const ab = await file.arrayBuffer();
  const filename = file.name || "upload.csv";
  const forced = resolveForcedBroker(
    parserField as BrokerId | "auto" | "" | null,
  );
  const parsed = await parseBrokerFile({
    content: Buffer.from(ab),
    filename,
    broker: forced ?? "auto",
  });

  // PDF / empty unsupported: surface as 400 so UI shows the message clearly
  if (
    filename.toLowerCase().endsWith(".pdf") &&
    parsed.transactions.length === 0 &&
    parsed.warnings.some((w) => w.severity === "error")
  ) {
    return c.json(
      {
        error: parsed.warnings.find((w) => w.severity === "error")?.message,
        warnings: parsed.warnings,
        layoutId: parsed.layoutId,
        parsed: 0,
        imported: 0,
      },
      400,
    );
  }

  const source = sourceOverride || `file:${parsed.broker}`;
  const broker = custodyBroker || inferCustodyFromParser(parsed.broker);

  const insertBatch = db.prepare(
    `INSERT INTO import_batches (portfolio_id, account_id, filename, broker, source, row_count, imported_count, skipped_count, warnings_json)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  );
  const batchInfo = insertBatch.run(
    portfolioId,
    portfolioId, // legacy NOT NULL account_id
    filename,
    parsed.broker || "generic",
    source,
    parsed.transactions.length,
    parsed.skippedRows,
    JSON.stringify(parsed.warnings),
  );
  const batchId = Number(batchInfo.lastInsertRowid);

  const insertTx = db.prepare(
    `INSERT OR IGNORE INTO transactions
      (portfolio_id, account_id, import_batch_id, date, ticker, exchange, type, quantity, price, amount, brokerage, currency, external_id, notes, source, broker, custody)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  /**
   * Re-import of same confirmation numbers used to INSERT OR IGNORE and leave
   * bad type=other rows forever. Repair when existing type is other/empty or
   * differs from a real buy/sell/drp parse.
   */
  const updateTx = db.prepare(
    `UPDATE transactions SET
       type = ?,
       quantity = ?,
       price = ?,
       amount = ?,
       brokerage = ?,
       notes = COALESCE(?, notes),
       import_batch_id = ?,
       source = ?,
       broker = ?,
       custody = ?
     WHERE portfolio_id = ?
       AND external_id = ?
       AND (
         type = 'other'
         OR type IS NULL
         OR type = ''
         OR type != ?
       )`,
  );

  const fingerprint = (t: ParsedTransaction) =>
    t.externalId ||
    `${t.date}|${t.exchange}|${t.ticker}|${t.type}|${t.quantity}|${t.price ?? ""}|${t.amount ?? ""}|${t.currency}`;

  let imported = 0;
  let updated = 0;
  const insertMany = db.transaction((txs: ParsedTransaction[]) => {
    for (const t of txs) {
      const ext = fingerprint(t);
      const info = insertTx.run(
        portfolioId,
        portfolioId, // legacy NOT NULL account_id
        batchId,
        t.date,
        t.ticker.toUpperCase(),
        t.exchange,
        t.type,
        t.quantity,
        t.price,
        t.amount,
        t.brokerage,
        t.currency,
        ext,
        t.notes,
        source,
        broker,
        broker,
      );
      if (info.changes > 0) {
        imported++;
        continue;
      }
      // Already present — fix type/fields if needed (esp. type=other from old parser)
      if (t.type && t.type !== "other") {
        const u = updateTx.run(
          t.type,
          t.quantity,
          t.price,
          t.amount,
          t.brokerage,
          t.notes,
          batchId,
          source,
          broker,
          broker,
          portfolioId,
          ext,
          t.type,
        );
        if (u.changes > 0) updated++;
      }
    }
  });
  insertMany(parsed.transactions);

  db.prepare(
    "UPDATE import_batches SET imported_count = ? WHERE id = ?",
  ).run(imported + updated, batchId);

  return c.json({
    batchId,
    portfolioId,
    portfolioName: portfolio.name,
    source,
    broker,
    parser: parsed.broker,
    parsed: parsed.transactions.length,
    imported,
    updated,
    skipped: parsed.skippedRows,
    duplicatesSkipped: Math.max(
      0,
      parsed.transactions.length - imported - updated,
    ),
    warnings: parsed.warnings,
    preview: parsed.transactions.slice(0, 20),
    layoutId: parsed.layoutId ?? null,
    confidence: parsed.confidence ?? null,
  });
});

// ─── Paste Sharesight ───────────────────────────────────────────────────────

app.post("/api/import/paste", async (c) => {
  try {
  const body = await c.req.json<{
    portfolioId?: number;
    accountId?: number;
    ticker: string;
    exchange?: string;
    text: string;
    /** Custody broker where the stock is held (stake, commsec, …) */
    broker?: string;
    source?: string;
  }>();

  const portfolioId = body.portfolioId ?? body.accountId;
  if (!portfolioId || !body.ticker || !body.text?.trim()) {
    return c.json(
      {
        error:
          "portfolioId, ticker, and text required. Pick portfolio (e.g. My / Partner) and broker (e.g. stake).",
      },
      400,
    );
  }

  const portfolio = db
    .prepare("SELECT id, name FROM portfolios WHERE id = ?")
    .get(portfolioId) as { id: number; name: string } | undefined;
  if (!portfolio) return c.json({ error: "portfolio not found" }, 404);

  const broker = (body.broker || "stake").toLowerCase();
  const source = body.source || "sharesight_paste";

  const parsed = parseSharesightPaste(body.text, {
    ticker: body.ticker,
    exchange: body.exchange || "US",
  });

  const insertBatch = db.prepare(
    `INSERT INTO import_batches (portfolio_id, account_id, filename, broker, source, row_count, imported_count, skipped_count, warnings_json)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  );
  const batchInfo = insertBatch.run(
    portfolioId,
    portfolioId, // legacy NOT NULL account_id
    `paste:${body.ticker.toUpperCase()}`,
    broker || "stake",
    source,
    parsed.transactions.length,
    parsed.skippedRows,
    JSON.stringify(parsed.warnings),
  );
  const batchId = Number(batchInfo.lastInsertRowid);

  const insertTx = db.prepare(
    `INSERT OR IGNORE INTO transactions
      (portfolio_id, account_id, import_batch_id, date, ticker, exchange, type, quantity, price, amount, brokerage, currency, external_id, notes, source, broker, custody)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let imported = 0;
  const insertMany = db.transaction((txs: ParsedTransaction[]) => {
    for (const t of txs) {
      const info = insertTx.run(
        portfolioId,
        portfolioId, // legacy NOT NULL account_id
        batchId,
        t.date,
        t.ticker.toUpperCase(),
        t.exchange,
        t.type,
        t.quantity,
        t.price,
        t.amount,
        t.brokerage,
        t.currency,
        t.externalId,
        t.notes,
        source,
        broker,
        broker,
      );
      if (info.changes > 0) imported++;
    }
  });
  insertMany(parsed.transactions);

  db.prepare(
    "UPDATE import_batches SET imported_count = ? WHERE id = ?",
  ).run(imported, batchId);

  return c.json({
    batchId,
    portfolioId,
    portfolioName: portfolio.name,
    broker,
    source,
    ticker: body.ticker.toUpperCase(),
    exchange: body.exchange || "US",
    parsed: parsed.transactions.length,
    imported,
    duplicatesSkipped: parsed.transactions.length - imported,
    warnings: parsed.warnings,
    preview: parsed.transactions,
  });
  } catch (e) {
    console.error("import/paste failed", e);
    return c.json(
      {
        error: e instanceof Error ? e.message : String(e),
      },
      500,
    );
  }
});

// ─── Prices ─────────────────────────────────────────────────────────────────

app.post("/api/prices/refresh", async (c) => {
  const body = await c.req
    .json<{
      instruments?: Array<{ ticker: string; exchange: string }>;
      /** Bypass cool-down (UI should confirm). Still records new 429s. */
      force?: boolean;
      /**
       * Also fetch 1y spark history for performance chart.
       * Default false — quotes-only is much lighter while banned/fragile.
       */
      includeHistory?: boolean;
    }>()
    .catch(
      () =>
        ({} as {
          instruments?: Array<{ ticker: string; exchange: string }>;
          force?: boolean;
          includeHistory?: boolean;
        }),
    );

  const force = body.force === true;
  const includeHistory = body.includeHistory === true;
  // Cool-down gates Yahoo only — we still refresh via ASX/Nasdaq/FX fallbacks
  const yahooStatusBefore = getYahooStatus(db);
  const yahooAllowed =
    force || yahooStatusBefore.waitSeconds <= 0;
  if (!yahooAllowed) {
    // soft note only; continue with fallbacks
  }

  recordYahooRefreshStarted(db);

  let instruments = body.instruments;
  if (!instruments?.length) {
    instruments = db
      .prepare("SELECT DISTINCT ticker, exchange FROM transactions")
      .all() as Array<{ ticker: string; exchange: string }>;
  }

  const results: Array<{
    ticker: string;
    exchange: string;
    symbol: string;
    price: number | null;
    source?: string;
    error?: string;
  }> = [];

  const upsertQuote = db.prepare(
    `INSERT INTO quote_cache (symbol, price, currency, fetched_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(symbol) DO UPDATE SET price = excluded.price, currency = excluded.currency, fetched_at = excluded.fetched_at`,
  );
  const upsertBar = db.prepare(
    `INSERT INTO price_cache (symbol, date, open, high, low, close, adj_close, volume)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, date) DO UPDATE SET
       open=excluded.open, high=excluded.high, low=excluded.low,
       close=excluded.close, adj_close=excluded.adj_close, volume=excluded.volume`,
  );
  const upsertFx = db.prepare(
    `INSERT INTO fx_cache (pair, rate, fetched_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(pair) DO UPDATE SET rate = excluded.rate, fetched_at = excluded.fetched_at`,
  );

  const currencies = db
    .prepare("SELECT DISTINCT currency FROM transactions")
    .all() as Array<{ currency: string }>;

  let yahooCircuitOpen = !yahooAllowed;
  let anyLiveSuccess = false;
  const sourcesUsed: string[] = [];
  const equitySymbols: string[] = [];
  const instrumentMeta: Array<{
    ticker: string;
    exchange: string;
    symbol: string;
  }> = [];

  for (const inst of instruments) {
    const exchange = (inst.exchange || "ASX").toUpperCase();
    const ticker = inst.ticker.toUpperCase();
    const symbol = toYahooSymbol(ticker, exchange);
    instrumentMeta.push({ ticker, exchange, symbol });
    equitySymbols.push(symbol);
  }

  const ccyList = [
    ...new Set([
      ...currencies.map((r) => (r.currency || "").toUpperCase()),
      "USD",
    ]),
  ].filter((c) => c && c !== "AUD");

  // ── Equity quotes: Yahoo (if allowed) + ASX/Nasdaq fallbacks ──
  let quoteMap = new Map<
    string,
    {
      symbol: string;
      price: number;
      currency: string | null;
      source?: string;
    }
  >();
  try {
    const multi = await fetchQuotesMulti(instrumentMeta, {
      tryYahoo: yahooAllowed,
    });
    for (const [sym, snap] of multi.quotes) {
      quoteMap.set(sym.toUpperCase(), snap);
    }
    sourcesUsed.push(...multi.sourcesUsed);
    if (multi.quotes.size) anyLiveSuccess = true;
    if (multi.yahooError) {
      recordYahooFailure(db, new Error(multi.yahooError));
      yahooCircuitOpen = true;
    } else if (yahooAllowed && multi.sourcesUsed.includes("yahoo")) {
      // Yahoo portion worked
    }
  } catch (e) {
    recordYahooFailure(db, e);
    const msg = e instanceof Error ? e.message : String(e);
    if (/429|rate-limit|blocked|HTTP 401|HTTP 403/i.test(msg)) {
      yahooCircuitOpen = true;
    }
  }

  // ── FX: latest + multi-year daily history (performance chart) ──
  const upsertFxHist = db.prepare(
    `INSERT INTO fx_history (pair, date, rate) VALUES (?, ?, ?)
     ON CONFLICT(pair, date) DO UPDATE SET rate = excluded.rate`,
  );
  try {
    const fx = await fetchFxMulti(ccyList, { tryYahoo: yahooAllowed });
    for (const { pair, rate, source } of fx.rates.values()) {
      upsertFx.run(pair, rate);
      // Seed today's rate into history so as-of always has a point
      upsertFxHist.run(
        pair,
        new Date().toISOString().slice(0, 10),
        rate,
      );
      if (!sourcesUsed.includes(source)) sourcesUsed.push(source);
    }
    if (fx.rates.size) anyLiveSuccess = true;
    if (fx.yahooError) {
      recordYahooFailure(db, new Error(fx.yahooError));
      yahooCircuitOpen = true;
    }
  } catch (e) {
    recordYahooFailure(db, e);
  }

  // Daily FX history (default ~10y) when history requested or cache is empty
  const needFxHist =
    includeHistory ||
    (
      db.prepare("SELECT COUNT(*) AS c FROM fx_history").get() as { c: number }
    ).c < 30;
  if (needFxHist && ccyList.length) {
    const pairs = [
      ...new Set(
        ccyList
          .map((c) => {
            const u = c.toUpperCase();
            if (u === "USD") return "AUDUSD=X";
            if (u === "GBP") return "AUDGBP=X";
            if (u === "EUR") return "AUDEUR=X";
            return u.length === 3 ? `AUD${u}=X` : null;
          })
          .filter((p): p is string => Boolean(p)),
      ),
    ];
    // Always ensure AUDUSD when any non-AUD book exists
    if (!pairs.includes("AUDUSD=X") && ccyList.some((c) => c !== "AUD")) {
      pairs.push("AUDUSD=X");
    }
    const period2 = new Date();
    const period1 = new Date(
      period2.getTime() - 1000 * 60 * 60 * 24 * 365 * 10,
    );
    for (const pair of pairs) {
      try {
        const hist = await fetchFxHistory(pair, {
          period1,
          period2,
          tryYahoo: yahooAllowed && !yahooCircuitOpen,
        });
        if (!hist.points.length) continue;
        const writeFx = db.transaction(() => {
          for (const pt of hist.points) {
            upsertFxHist.run(pair, pt.date, pt.rate);
          }
          const last = hist.points[hist.points.length - 1]!;
          upsertFx.run(pair, last.rate);
        });
        writeFx();
        anyLiveSuccess = true;
        if (hist.source && !sourcesUsed.includes(hist.source)) {
          sourcesUsed.push(hist.source);
        }
      } catch (e) {
        recordYahooFailure(db, e);
        const msg = e instanceof Error ? e.message : String(e);
        if (/429|rate-limit|blocked|HTTP 401|HTTP 403/i.test(msg)) {
          yahooCircuitOpen = true;
        }
      }
    }
  }

  // ── Optional Yahoo 1y history (performance chart → price_cache) ──
  // Spark bulk first; chart API per symbol for any gaps (chart is often less blocked).
  let historyMap = new Map<
    string,
    Array<{
      date: string;
      open: number;
      high: number;
      low: number;
      close: number;
      adjClose: number;
      volume: number;
    }>
  >();
  if (yahooAllowed && includeHistory && equitySymbols.length) {
    // Spark bulk (when available) — skip if circuit already open from quotes
    if (!yahooCircuitOpen) {
      try {
        historyMap = await fetchYahooSparkHistoryBulk(equitySymbols, {
          range: "1y",
        });
        if (historyMap.size) {
          anyLiveSuccess = true;
          if (!sourcesUsed.includes("yahoo")) sourcesUsed.push("yahoo");
        }
      } catch (e) {
        recordYahooFailure(db, e);
        const msg = e instanceof Error ? e.message : String(e);
        if (/429|rate-limit|blocked|HTTP 401|HTTP 403/i.test(msg)) {
          yahooCircuitOpen = true;
        }
      }
    }

    // Chart API per missing symbol — often works in browser when spark/quote fail
    const needChart = instrumentMeta.filter((m) => {
      const bars = historyMap.get(m.symbol.toUpperCase());
      return !bars?.length;
    });
    const batchSize = 4;
    const period2 = new Date();
    const period1 = new Date(period2.getTime() - 1000 * 60 * 60 * 24 * 365);
    let chartStopped = false;
    for (let i = 0; i < needChart.length && !chartStopped; i += batchSize) {
      const batch = needChart.slice(i, i + batchSize);
      if (i > 0) await new Promise((r) => setTimeout(r, 300));
      const outcomes = await Promise.all(
        batch.map(async (m) => {
          try {
            const bars = await fetchYahooHistory(m.ticker, {
              exchange: m.exchange,
              period1,
              period2,
            });
            return { m, bars, error: null as Error | null };
          } catch (e) {
            return {
              m,
              bars: [] as Awaited<ReturnType<typeof fetchYahooHistory>>,
              error: e instanceof Error ? e : new Error(String(e)),
            };
          }
        }),
      );
      for (const { m, bars, error } of outcomes) {
        if (bars.length) {
          historyMap.set(m.symbol.toUpperCase(), bars);
          anyLiveSuccess = true;
          if (!sourcesUsed.includes("yahoo-chart")) {
            sourcesUsed.push("yahoo-chart");
          }
          // Chart worked — clear soft circuit from earlier quote/spark noise
          yahooCircuitOpen = false;
        } else if (error) {
          recordYahooFailure(db, error);
          const msg = error.message;
          if (/429|rate-limit|blocked|HTTP 401|HTTP 403/i.test(msg)) {
            yahooCircuitOpen = true;
            chartStopped = true;
          }
        }
      }
    }
  }

  // Clear Yahoo cool-down only if Yahoo itself succeeded (not just fallbacks)
  const yahooLive =
    sourcesUsed.includes("yahoo") || sourcesUsed.includes("yahoo-chart");
  if (anyLiveSuccess && yahooLive && !yahooCircuitOpen) {
    recordYahooSuccess(db);
  }

  // ── Fallback history for performance chart (price_cache) ──
  // Chart reads price_cache daily bars — last-price quote_cache alone is not enough.
  const usForHist = instrumentMeta.filter((m) => {
    const isUs =
      m.exchange === "US" ||
      m.exchange === "NASDAQ" ||
      m.exchange === "NYSE" ||
      m.exchange === "AMEX";
    return isUs && !historyMap.has(m.symbol.toUpperCase());
  });
  if (usForHist.length) {
    const batchSize = 4;
    for (let i = 0; i < usForHist.length; i += batchSize) {
      const batch = usForHist.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (m) => {
          const bars = await fetchNasdaqHistory(m.ticker);
          if (bars.length) {
            historyMap.set(m.symbol.toUpperCase(), bars);
            if (!sourcesUsed.includes("nasdaq-hist")) {
              sourcesUsed.push("nasdaq-hist");
            }
          }
        }),
      );
    }
  }

  // ── Write caches + build per-instrument results ──
  const insertBars = db.transaction(
    (
      symbol: string,
      bars: Array<{
        date: string;
        open: number;
        high: number;
        low: number;
        close: number;
        adjClose: number;
        volume: number;
      }>,
    ) => {
      for (const b of bars) {
        upsertBar.run(
          symbol,
          b.date,
          b.open,
          b.high,
          b.low,
          b.close,
          b.adjClose,
          b.volume,
        );
      }
    },
  );

  const todayIso = new Date().toISOString().slice(0, 10);

  for (const { ticker, exchange, symbol } of instrumentMeta) {
    const currency = defaultCurrencyForExchange(exchange);
    const q = quoteMap.get(symbol.toUpperCase());
    let history = historyMap.get(symbol.toUpperCase()) ?? [];
    let price =
      q?.price ??
      (history.length > 0 ? history[history.length - 1]!.close : null);
    const source = q?.source ?? (history.length ? "yahoo" : undefined);

    if (price != null) {
      upsertQuote.run(symbol, price, q?.currency ?? currency);
      // Seed / refresh today's bar so the performance chart can mark-to-market
      // (ASX fallbacks only have a last price — no multi-year free history).
      if (!history.length) {
        history = [
          {
            date: todayIso,
            open: price,
            high: price,
            low: price,
            close: price,
            adjClose: price,
            volume: 0,
          },
        ];
      } else {
        const last = history[history.length - 1]!;
        if (last.date < todayIso) {
          history = [
            ...history,
            {
              date: todayIso,
              open: price,
              high: price,
              low: price,
              close: price,
              adjClose: price,
              volume: 0,
            },
          ];
        } else if (last.date === todayIso && q?.price != null) {
          history = [
            ...history.slice(0, -1),
            { ...last, close: price, adjClose: price },
          ];
        }
      }
    }
    if (history.length) {
      insertBars(symbol, history);
      if (price == null) price = history[history.length - 1]!.close;
    }

    results.push({
      ticker,
      exchange,
      symbol,
      price,
      source,
      error:
        price == null
          ? "No quote from Yahoo or fallbacks (ASX Markit / Nasdaq)"
          : undefined,
    });
  }

  const okCount = results.filter((r) => r.price != null).length;
  const srcLabel = sourcesUsed.length
    ? sourcesUsed.join("+")
    : "none";

  const yahooBrowserUrls = {
    spark: equitySymbols.length
      ? buildYahooSparkHistoryUrl(equitySymbols, "1y")
      : null,
    chart:
      equitySymbols.length === 1
        ? buildYahooChartHistoryUrl(equitySymbols[0]!)
        : equitySymbols[0]
          ? buildYahooChartHistoryUrl(equitySymbols[0]!)
          : null,
    quote: equitySymbols.length
      ? buildYahooQuoteUrl(equitySymbols)
      : null,
  };

  return c.json({
    refreshed: results.length,
    ok: okCount,
    results,
    yahooCircuitOpen,
    yahoo: getYahooStatus(db),
    yahooSkipped: !yahooAllowed,
    sources: sourcesUsed,
    mode: includeHistory ? "quotes+history" : "quotes",
    includeHistory,
    /** Open these in a browser when Node is 429'd; paste JSON via POST /api/prices/import-yahoo */
    yahooBrowserUrls,
    note: !anyLiveSuccess
      ? "No live quotes. Yahoo may be banned; fallbacks also failed. Cache unchanged."
      : yahooCircuitOpen || !yahooAllowed
        ? `Refreshed ${okCount}/${results.length} via ${srcLabel}` +
          (yahooAllowed
            ? " (Yahoo blocked — used fallbacks where possible). Performance chart uses price history when available."
            : " (Yahoo cool-down — fallbacks). Re-open Holdings to refresh the chart.") +
          " Open yahooBrowserUrls.spark in a browser and paste JSON via Settings / risu.importYahoo."
        : `Refreshed ${okCount}/${results.length} via ${srcLabel}` +
          (includeHistory ? " + 1y Yahoo history" : ""),
  });
});

/**
 * Manually import Yahoo chart / spark / quote JSON (paste from browser).
 * Bypasses cool-down — used when Node gets 429 but the browser still works.
 *
 * Body: { payload: object|string, symbol?: string }
 * Console: risu.importYahoo(json) or risu.importYahoo(json, "TSLA")
 */
app.post("/api/prices/import-yahoo", async (c) => {
  const body = await c.req
    .json<{ payload?: unknown; json?: unknown; symbol?: string }>()
    .catch(() => ({} as { payload?: unknown; json?: unknown; symbol?: string }));

  let raw = body.payload ?? body.json;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return c.json({ error: "payload string is not valid JSON" }, 400);
    }
  }
  if (raw == null || typeof raw !== "object") {
    return c.json(
      {
        error:
          "Body must include payload (Yahoo chart/spark/quote JSON object or string).",
      },
      400,
    );
  }

  let parsed: ReturnType<typeof parseYahooManualPayload>;
  try {
    parsed = parseYahooManualPayload(raw, body.symbol);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      400,
    );
  }

  const upsertQuote = db.prepare(
    `INSERT INTO quote_cache (symbol, price, currency, fetched_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(symbol) DO UPDATE SET price = excluded.price, currency = excluded.currency, fetched_at = excluded.fetched_at`,
  );
  const upsertBar = db.prepare(
    `INSERT INTO price_cache (symbol, date, open, high, low, close, adj_close, volume)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, date) DO UPDATE SET
       open=excluded.open, high=excluded.high, low=excluded.low,
       close=excluded.close, adj_close=excluded.adj_close, volume=excluded.volume`,
  );
  const upsertFx = db.prepare(
    `INSERT INTO fx_cache (pair, rate, fetched_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(pair) DO UPDATE SET rate = excluded.rate, fetched_at = excluded.fetched_at`,
  );
  const upsertFxHist = db.prepare(
    `INSERT INTO fx_history (pair, date, rate) VALUES (?, ?, ?)
     ON CONFLICT(pair, date) DO UPDATE SET rate = excluded.rate`,
  );

  let barCount = 0;
  let quoteCount = 0;
  let fxDays = 0;
  const symbols: string[] = [];

  const write = db.transaction(() => {
    for (const [symbol, bars] of parsed.barsBySymbol) {
      symbols.push(symbol);
      const isFx = symbol.includes("=X") || symbol.includes("=x");
      for (const b of bars) {
        upsertBar.run(
          symbol,
          b.date,
          b.open,
          b.high,
          b.low,
          b.close,
          b.adjClose,
          b.volume,
        );
        barCount++;
        if (isFx && b.close > 0) {
          upsertFxHist.run(symbol.toUpperCase(), b.date, b.close);
          fxDays++;
        }
      }
      if (isFx && bars.length) {
        const last = bars[bars.length - 1]!;
        upsertFx.run(symbol.toUpperCase(), last.close);
      }
    }
    for (const [symbol, q] of parsed.quotes) {
      if (!symbols.includes(symbol)) symbols.push(symbol);
      upsertQuote.run(symbol, q.price, q.currency);
      quoteCount++;
      if (symbol.includes("=X") || symbol.includes("=x")) {
        upsertFx.run(symbol.toUpperCase(), q.price);
        upsertFxHist.run(
          symbol.toUpperCase(),
          new Date().toISOString().slice(0, 10),
          q.price,
        );
        fxDays++;
      }
      // Seed a single bar if quote-only paste
      if (!parsed.barsBySymbol.get(symbol)?.length) {
        const today = new Date().toISOString().slice(0, 10);
        upsertBar.run(
          symbol,
          today,
          q.price,
          q.price,
          q.price,
          q.price,
          q.price,
          0,
        );
        barCount++;
      }
    }
  });
  write();

  return c.json({
    ok: true,
    kind: parsed.kind,
    symbols,
    barsWritten: barCount,
    quotesWritten: quoteCount,
    fxHistoryDays: fxDays,
    note:
      "Imported into price_cache / quote_cache" +
      (fxDays ? " / fx_history" : "") +
      ". Re-open Holdings or bump the performance chart to reload.",
  });
});

app.get("/api/prices/:ticker", async (c) => {
  const ticker = c.req.param("ticker").toUpperCase();
  const exchange = (c.req.query("exchange") || "ASX").toUpperCase();
  const symbol = toYahooSymbol(ticker, exchange);
  const cached = db
    .prepare(
      "SELECT price, fetched_at, currency FROM quote_cache WHERE symbol = ?",
    )
    .get(symbol) as
    | { price: number; fetched_at: string; currency: string | null }
    | undefined;

  // Always prefer cache — never call Yahoo just because the UI loaded.
  if (cached) {
    return c.json({ ticker, exchange, symbol, ...cached, source: "cache" });
  }

  // No cache: only fetch if cool-down allows and ?live=1 (explicit)
  const live = c.req.query("live") === "1";
  if (!live) {
    return c.json({
      ticker,
      exchange,
      symbol,
      price: null,
      source: "none",
      note: "No cached quote. Click Refresh Yahoo prices (does not run on page load).",
      yahoo: getYahooStatus(db),
    });
  }

  try {
    assertYahooAllowed(db);
    const price = await fetchYahooQuote(ticker, { exchange });
    if (price != null) {
      db.prepare(
        `INSERT INTO quote_cache (symbol, price, currency, fetched_at) VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(symbol) DO UPDATE SET price = excluded.price, currency = excluded.currency, fetched_at = excluded.fetched_at`,
      ).run(symbol, price, defaultCurrencyForExchange(exchange));
      recordYahooSuccess(db);
    }
    return c.json({ ticker, exchange, symbol, price, source: "yahoo" });
  } catch (e) {
    recordYahooFailure(db, e);
    return c.json(
      {
        error: e instanceof Error ? e.message : String(e),
        ticker,
        exchange,
        yahoo: getYahooStatus(db),
      },
      502,
    );
  }
});

// ─── App settings (Phase 5) ─────────────────────────────────────────────────

const SETTINGS_DEFAULTS: Record<string, string> = {
  yahoo_refresh_enabled: "0",
  us_withholding_pct: "15",
};

function loadAppSettings(): Record<string, string> {
  const settings: Record<string, string> = { ...SETTINGS_DEFAULTS };
  const rows = db
    .prepare("SELECT key, value FROM app_settings")
    .all() as Array<{ key: string; value: string }>;
  for (const r of rows) settings[r.key] = r.value;
  return settings;
}

app.get("/api/settings", (c) => {
  return c.json({
    settings: loadAppSettings(),
    dbPath: getDbPath(),
  });
});

app.put("/api/settings", async (c) => {
  const body = await c.req.json<{
    settings?: Record<string, string | number | boolean | null>;
    yahoo_refresh_enabled?: string | number | boolean;
    us_withholding_pct?: string | number;
  }>();

  const incoming: Record<string, string | number | boolean | null | undefined> =
    body.settings
      ? { ...body.settings }
      : {
          yahoo_refresh_enabled: body.yahoo_refresh_enabled,
          us_withholding_pct: body.us_withholding_pct,
        };

  const upsert = db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  const allowed = new Set([
    "yahoo_refresh_enabled",
    "us_withholding_pct",
  ]);

  for (const [key, raw] of Object.entries(incoming)) {
    if (!allowed.has(key) || raw === undefined) continue;
    let value: string;
    if (key === "yahoo_refresh_enabled") {
      const on =
        raw === true ||
        raw === 1 ||
        raw === "1" ||
        raw === "true" ||
        raw === "on";
      value = on ? "1" : "0";
    } else if (key === "us_withholding_pct") {
      const n = Number(raw);
      if (Number.isNaN(n) || n < 0 || n > 100) {
        return c.json(
          { error: "us_withholding_pct must be 0–100" },
          400,
        );
      }
      value = String(n);
    } else {
      value = String(raw);
    }
    upsert.run(key, value);
  }

  return c.json({
    settings: loadAppSettings(),
    dbPath: getDbPath(),
  });
});

/** Wipe quote / price / dividend / FX caches only — never transactions. */
app.delete("/api/settings/caches", (c) => {
  const deleted = {
    quote_cache: db.prepare("DELETE FROM quote_cache").run().changes,
    price_cache: db.prepare("DELETE FROM price_cache").run().changes,
    dividend_cache: db.prepare("DELETE FROM dividend_cache").run().changes,
    fx_cache: db.prepare("DELETE FROM fx_cache").run().changes,
    fx_history: db.prepare("DELETE FROM fx_history").run().changes,
  };
  return c.json({ ok: true, deleted });
});

// ─── Tax profiles (Phase 3) ─────────────────────────────────────────────────

type TaxProfileRow = {
  id: number;
  label: string;
  marginal_rate: number;
  medicare_levy: number;
  is_default: number;
  created_at: string;
  updated_at: string;
};

function mapTaxProfile(r: TaxProfileRow) {
  return {
    id: r.id,
    label: r.label,
    marginalRate: r.marginal_rate,
    medicareLevy: r.medicare_levy,
    isDefault: !!r.is_default,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

app.get("/api/settings/tax-profiles", (c) => {
  const rows = db
    .prepare(
      `SELECT id, label, marginal_rate, medicare_levy, is_default, created_at, updated_at
       FROM tax_profiles ORDER BY is_default DESC, id ASC`,
    )
    .all() as TaxProfileRow[];
  return c.json(rows.map(mapTaxProfile));
});

/** Replace all tax profiles with the provided list (id optional for new rows). */
app.put("/api/settings/tax-profiles", async (c) => {
  const body = await c.req.json<{
    profiles: Array<{
      id?: number;
      label: string;
      marginalRate: number;
      medicareLevy: number;
      isDefault?: boolean;
    }>;
  }>();

  const profiles = body.profiles ?? [];
  if (!Array.isArray(profiles) || profiles.length === 0) {
    return c.json({ error: "profiles array required (at least one)" }, 400);
  }

  for (const p of profiles) {
    if (!p.label?.trim()) {
      return c.json({ error: "each profile needs a label" }, 400);
    }
    if (
      typeof p.marginalRate !== "number" ||
      p.marginalRate < 0 ||
      p.marginalRate > 1
    ) {
      return c.json(
        { error: "marginalRate must be a decimal between 0 and 1" },
        400,
      );
    }
    if (
      typeof p.medicareLevy !== "number" ||
      p.medicareLevy < 0 ||
      p.medicareLevy > 1
    ) {
      return c.json(
        { error: "medicareLevy must be a decimal between 0 and 1" },
        400,
      );
    }
  }

  const run = db.transaction(() => {
    db.prepare("DELETE FROM tax_profiles").run();
    const ins = db.prepare(
      `INSERT INTO tax_profiles (label, marginal_rate, medicare_levy, is_default)
       VALUES (?, ?, ?, ?)`,
    );
    let sawDefault = false;
    for (const p of profiles) {
      const isDef = p.isDefault && !sawDefault ? 1 : 0;
      if (isDef) sawDefault = true;
      ins.run(
        p.label.trim(),
        p.marginalRate,
        p.medicareLevy,
        isDef,
      );
    }
    if (!sawDefault) {
      db.prepare(
        "UPDATE tax_profiles SET is_default = 1 WHERE id = (SELECT MIN(id) FROM tax_profiles)",
      ).run();
    }
  });
  run();

  const rows = db
    .prepare(
      `SELECT id, label, marginal_rate, medicare_levy, is_default, created_at, updated_at
       FROM tax_profiles ORDER BY is_default DESC, id ASC`,
    )
    .all() as TaxProfileRow[];
  return c.json(rows.map(mapTaxProfile));
});

// ─── Scenarios + planner (Phase 4) ──────────────────────────────────────────

type ScenarioRow = {
  id: number;
  name: string;
  body_json: string;
  created_at: string;
  updated_at: string;
};

function mapScenario(r: ScenarioRow) {
  let body: unknown = {};
  try {
    body = JSON.parse(r.body_json);
  } catch {
    body = {};
  }
  return {
    id: r.id,
    name: r.name,
    body,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

app.get("/api/scenarios", (c) => {
  const rows = db
    .prepare(
      "SELECT id, name, body_json, created_at, updated_at FROM scenarios ORDER BY updated_at DESC",
    )
    .all() as ScenarioRow[];
  return c.json(rows.map(mapScenario));
});

app.get("/api/scenarios/:id", (c) => {
  const id = Number(c.req.param("id"));
  const row = db
    .prepare(
      "SELECT id, name, body_json, created_at, updated_at FROM scenarios WHERE id = ?",
    )
    .get(id) as ScenarioRow | undefined;
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(mapScenario(row));
});

app.post("/api/scenarios", async (c) => {
  const body = await c.req.json<{ name?: string; body?: Scenario | object }>();
  const name = body.name?.trim() || "Untitled scenario";
  const scenarioBody = body.body ?? {};
  const info = db
    .prepare(
      `INSERT INTO scenarios (name, body_json) VALUES (?, ?)`,
    )
    .run(name, JSON.stringify(scenarioBody));
  const id = Number(info.lastInsertRowid);
  const row = db
    .prepare(
      "SELECT id, name, body_json, created_at, updated_at FROM scenarios WHERE id = ?",
    )
    .get(id) as ScenarioRow;
  return c.json(mapScenario(row), 201);
});

app.put("/api/scenarios/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const existing = db
    .prepare("SELECT * FROM scenarios WHERE id = ?")
    .get(id) as ScenarioRow | undefined;
  if (!existing) return c.json({ error: "not found" }, 404);

  const body = await c.req.json<{ name?: string; body?: Scenario | object }>();
  const name = body.name?.trim() || existing.name;
  const scenarioBody =
    body.body !== undefined ? body.body : JSON.parse(existing.body_json);

  db.prepare(
    `UPDATE scenarios SET name = ?, body_json = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(name, JSON.stringify(scenarioBody), id);

  const row = db
    .prepare(
      "SELECT id, name, body_json, created_at, updated_at FROM scenarios WHERE id = ?",
    )
    .get(id) as ScenarioRow;
  return c.json(mapScenario(row));
});

app.delete("/api/scenarios/:id", (c) => {
  const id = Number(c.req.param("id"));
  const info = db.prepare("DELETE FROM scenarios WHERE id = ?").run(id);
  if (info.changes === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, id });
});

/** Run a saved scenario (body overrides optional). */
app.post("/api/scenarios/:id/run", async (c) => {
  const id = Number(c.req.param("id"));
  const row = db
    .prepare(
      "SELECT id, name, body_json, created_at, updated_at FROM scenarios WHERE id = ?",
    )
    .get(id) as ScenarioRow | undefined;
  if (!row) return c.json({ error: "not found" }, 404);

  let scenario: Scenario;
  try {
    scenario = JSON.parse(row.body_json) as Scenario;
  } catch {
    return c.json({ error: "invalid scenario body_json" }, 500);
  }

  const overrides: Partial<Scenario> = await c.req
    .json<Partial<Scenario>>()
    .catch(() => ({}) as Partial<Scenario>);
  const merged: Scenario = {
    ...scenario,
    ...overrides,
    name: overrides.name ?? scenario.name ?? row.name,
    allocations:
      overrides.allocations ??
      scenario.allocations ??
      defaultAllocationTemplates(),
    taxProfile: overrides.taxProfile ?? scenario.taxProfile,
    cgtRegime: overrides.cgtRegime ?? scenario.cgtRegime ?? "auto_by_date",
    exit: overrides.exit ?? scenario.exit ?? { type: "liquidate" },
    horizonYears: overrides.horizonYears ?? scenario.horizonYears ?? 10,
  };

  if (!merged.taxProfile) {
    return c.json({ error: "scenario missing taxProfile" }, 400);
  }

  const report = runScenario(merged);
  return c.json(report);
});

/** Ad-hoc planner run (no persistence) — compare 1–3 allocations. */
app.post("/api/planner/run", async (c) => {
  const body = await c.req.json<Partial<Scenario> & { name?: string }>();

  const taxProfile = body.taxProfile ?? {
    label: "Me",
    marginalRate: 0.37,
    medicareLevy: 0.02,
  };

  const scenario: Scenario = {
    name: body.name ?? "Compare",
    horizonYears: body.horizonYears ?? 10,
    startDate: body.startDate,
    initialValueAud: body.initialValueAud ?? 0,
    initialCostBaseAud: body.initialCostBaseAud,
    inflationRateAnnual: body.inflationRateAnnual,
    taxProfile,
    cgtRegime: body.cgtRegime ?? "indexation_min30",
    monthlyContributionAud: body.monthlyContributionAud ?? 0,
    contributionKeyframes: body.contributionKeyframes,
    lumpSums: body.lumpSums,
    brokeragePerContribution: body.brokeragePerContribution,
    exit: body.exit ?? { type: "liquidate" },
    allocations:
      body.allocations && body.allocations.length > 0
        ? body.allocations.slice(0, 3)
        : defaultAllocationTemplates(),
  };

  const report = runScenario(scenario);
  return c.json(report);
});

app.get("/api/planner/templates", (c) => {
  return c.json(defaultAllocationTemplates());
});

// ─── Instrument assumptions (planner fill — cache + manual refresh) ─────────

function readInstrumentCache(
  ticker: string,
  exchange: string,
): InstrumentAssumptions | null {
  const row = db
    .prepare(
      `SELECT ticker, exchange, growth_rate, yield_rate, mer, franking_percent,
              name, issuer, product_url, sources_json, notes_json, fetched_at
       FROM instrument_cache WHERE ticker = ? AND exchange = ?`,
    )
    .get(ticker, exchange) as
    | {
        ticker: string;
        exchange: string;
        growth_rate: number;
        yield_rate: number;
        mer: number;
        franking_percent: number;
        name: string | null;
        issuer: string | null;
        product_url: string | null;
        sources_json: string | null;
        notes_json: string | null;
        fetched_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    ticker: row.ticker,
    exchange: row.exchange,
    growthRate: row.growth_rate,
    yieldRate: row.yield_rate,
    mer: row.mer,
    frankingPercent: row.franking_percent,
    name: row.name ?? undefined,
    issuer: (row.issuer as InstrumentAssumptions["issuer"]) ?? undefined,
    productUrl: row.product_url ?? undefined,
    sources: row.sources_json ? JSON.parse(row.sources_json) : ["cache"],
    notes: [
      ...(row.notes_json ? (JSON.parse(row.notes_json) as string[]) : []),
      `Cached ${row.fetched_at}.`,
    ],
    resolvedAt: row.fetched_at.includes("T")
      ? row.fetched_at
      : `${row.fetched_at.replace(" ", "T")}Z`,
  };
}

function writeInstrumentCache(inst: InstrumentAssumptions) {
  db.prepare(
    `INSERT INTO instrument_cache (
       ticker, exchange, growth_rate, yield_rate, mer, franking_percent,
       name, issuer, product_url, sources_json, notes_json, fetched_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(ticker, exchange) DO UPDATE SET
       growth_rate = excluded.growth_rate,
       yield_rate = excluded.yield_rate,
       mer = excluded.mer,
       franking_percent = excluded.franking_percent,
       name = excluded.name,
       issuer = excluded.issuer,
       product_url = excluded.product_url,
       sources_json = excluded.sources_json,
       notes_json = excluded.notes_json,
       fetched_at = excluded.fetched_at`,
  ).run(
    inst.ticker,
    inst.exchange,
    inst.growthRate,
    inst.yieldRate,
    inst.mer,
    inst.frankingPercent,
    inst.name ?? null,
    inst.issuer ?? null,
    inst.productUrl ?? null,
    JSON.stringify(inst.sources),
    JSON.stringify(inst.notes),
  );
}

/** List curated BetaShares / Vanguard seeds (no network). */
app.get("/api/instruments/seeds", (c) => c.json(listInstrumentSeeds()));

/**
 * GET assumptions for a ticker.
 * - Default: cache → seed (no Yahoo)
 * - ?refresh=1: live Yahoo enrich (respects cool-down unless force=1)
 */
app.get("/api/instruments/:ticker", async (c) => {
  const ticker = c.req.param("ticker").toUpperCase().replace(/\.AX$/i, "");
  const exchange = (c.req.query("exchange") || "ASX").toUpperCase();
  const refresh = c.req.query("refresh") === "1";
  const force = c.req.query("force") === "1";

  if (!refresh) {
    const cached = readInstrumentCache(ticker, exchange);
    if (cached) {
      return c.json({ ...cached, fromCache: true });
    }
    const seed = resolveInstrumentFromSeed(ticker, exchange);
    return c.json({ ...seed, fromCache: false });
  }

  // Manual refresh — may hit Yahoo
  try {
    assertYahooAllowed(db, { force });
  } catch (e) {
    // Still return seed/cache with cool-down message
    const cached = readInstrumentCache(ticker, exchange);
    const base = cached ?? resolveInstrumentFromSeed(ticker, exchange);
    return c.json(
      {
        ...base,
        fromCache: Boolean(cached),
        yahoo: getYahooStatus(db),
        error: e instanceof Error ? e.message : String(e),
        notes: [
          ...base.notes,
          e instanceof Error ? e.message : String(e),
        ],
      },
      200,
    );
  }

  try {
    const inst = await resolveInstrumentAssumptions(ticker, {
      exchange,
      refreshLive: true,
    });
    if (inst.sources.some((s) => s.startsWith("yahoo"))) {
      recordYahooSuccess(db);
    }
    writeInstrumentCache(inst);
    return c.json({
      ...inst,
      fromCache: false,
      yahoo: getYahooStatus(db),
    });
  } catch (e) {
    recordYahooFailure(db, e);
    const seed = resolveInstrumentFromSeed(ticker, exchange);
    return c.json(
      {
        ...seed,
        fromCache: false,
        error: e instanceof Error ? e.message : String(e),
        yahoo: getYahooStatus(db),
        notes: [
          ...seed.notes,
          `Refresh failed: ${e instanceof Error ? e.message : String(e)}`,
        ],
      },
      200,
    );
  }
});

// ─── Production: serve built web SPA (Vite dist) ────────────────────────────
// Registered after /api/* so API routes win. Dev uses Vite on :5173 proxying /api.
if (serveWeb && webDistAbs) {
  // @hono/node-server serveStatic root is relative to process.cwd()
  const webRoot = path.relative(process.cwd(), webDistAbs) || ".";
  console.log(`serving web static from ${webDistAbs} (root=${webRoot})`);
  app.use("/*", serveStatic({ root: webRoot }));
  // SPA fallback for client routes (index.html)
  app.get("*", serveStatic({ root: webRoot, path: "index.html" }));
}

const port = Number(process.env.PORT ?? 8787);
console.log(`yields api listening on http://localhost:${port}`);
serve({ fetch: app.fetch, port });

function inferCustodyFromParser(parser: string): string | null {
  if (parser === "sharesight" || parser === "generic") return null;
  return parser;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
