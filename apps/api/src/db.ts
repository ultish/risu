import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const defaultPath =
  process.env.YIELDS_DB_PATH ??
  path.resolve(process.cwd(), "../../data/yields.db");

/** Resolved SQLite path (YIELDS_DB_PATH or ../../data/yields.db from cwd). */
export function getDbPath(): string {
  return process.env.YIELDS_DB_PATH ?? defaultPath;
}

export function openDb(dbPath = getDbPath()): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/**
 * portfolios  = ownership buckets ("Me", "Wife")
 * transactions.broker = custody (stake, commsec, …)
 * transactions.source  = how data entered (sharesight_paste, file:…, manual)
 *
 * Migration is incremental: old DBs keep tables; we ADD COLUMN then indexes.
 */
function migrate(db: Database.Database) {
  // 1) Base tables — never change shape here once shipped; only CREATE IF NOT EXISTS
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      broker TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS portfolios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER,
      filename TEXT NOT NULL,
      broker TEXT,
      row_count INTEGER NOT NULL DEFAULT 0,
      imported_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      warnings_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER,
      import_batch_id INTEGER,
      date TEXT NOT NULL,
      ticker TEXT NOT NULL,
      exchange TEXT NOT NULL DEFAULT 'ASX',
      type TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      price REAL,
      amount REAL,
      brokerage REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'AUD',
      external_id TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS price_cache (
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL NOT NULL,
      adj_close REAL,
      volume REAL,
      PRIMARY KEY (symbol, date)
    );

    CREATE TABLE IF NOT EXISTS quote_cache (
      symbol TEXT PRIMARY KEY,
      price REAL NOT NULL,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fx_cache (
      pair TEXT PRIMARY KEY,
      rate REAL NOT NULL,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dividend_cache (
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (symbol, date)
    );

    CREATE TABLE IF NOT EXISTS holding_flags (
      portfolio_id INTEGER NOT NULL,
      ticker TEXT NOT NULL,
      exchange TEXT NOT NULL DEFAULT 'ASX',
      drp_enabled INTEGER NOT NULL DEFAULT 0,
      drp_from_date TEXT,
      PRIMARY KEY (portfolio_id, ticker, exchange)
    );

    CREATE TABLE IF NOT EXISTS tax_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      marginal_rate REAL NOT NULL,
      medicare_levy REAL NOT NULL DEFAULT 0.02,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scenarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      body_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    /** Planner instrument assumptions — filled on manual refresh only */
    CREATE TABLE IF NOT EXISTS instrument_cache (
      ticker TEXT NOT NULL,
      exchange TEXT NOT NULL DEFAULT 'ASX',
      growth_rate REAL NOT NULL,
      yield_rate REAL NOT NULL,
      mer REAL NOT NULL,
      franking_percent REAL NOT NULL DEFAULT 0,
      name TEXT,
      issuer TEXT,
      product_url TEXT,
      sources_json TEXT,
      notes_json TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (ticker, exchange)
    );
  `);

  // 2) Additive columns (safe on existing DBs)
  addColumnIfMissing(db, "quote_cache", "currency", "TEXT");
  addColumnIfMissing(db, "transactions", "portfolio_id", "INTEGER");
  addColumnIfMissing(db, "transactions", "source", "TEXT");
  addColumnIfMissing(db, "transactions", "broker", "TEXT");
  addColumnIfMissing(db, "transactions", "custody", "TEXT");
  addColumnIfMissing(db, "import_batches", "portfolio_id", "INTEGER");
  addColumnIfMissing(db, "import_batches", "source", "TEXT");

  // 3) Indexes after columns exist
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tx_account_date ON transactions(account_id, date);
    CREATE INDEX IF NOT EXISTS idx_tx_ticker ON transactions(ticker);
    CREATE INDEX IF NOT EXISTS idx_tx_exchange ON transactions(exchange);
  `);

  if (hasColumn(db, "transactions", "portfolio_id")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tx_portfolio_date ON transactions(portfolio_id, date);
    `);
  }
  if (hasColumn(db, "transactions", "broker")) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tx_broker ON transactions(broker);`);
  }
  if (hasColumn(db, "transactions", "source")) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tx_source ON transactions(source);`);
  }

  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_portfolio_external
      ON transactions(portfolio_id, external_id)
      WHERE external_id IS NOT NULL AND portfolio_id IS NOT NULL
    `);
  } catch {
    /* duplicate data or older SQLite — non-fatal */
  }

  seedAndMigratePortfolios(db);
  seedTaxProfiles(db);
  seedAppSettings(db);
}

/** Default app_settings keys (preference store; never overwrites existing). */
function seedAppSettings(db: Database.Database) {
  const defaults: Array<[string, string]> = [
    ["yahoo_refresh_enabled", "0"],
    ["us_withholding_pct", "15"],
  ];
  const ins = db.prepare(
    `INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)`,
  );
  for (const [k, v] of defaults) ins.run(k, v);
}

function seedTaxProfiles(db: Database.Database) {
  const count = db.prepare("SELECT COUNT(*) AS c FROM tax_profiles").get() as {
    c: number;
  };
  if (count.c > 0) return;
  const ins = db.prepare(
    `INSERT INTO tax_profiles (label, marginal_rate, medicare_levy, is_default)
     VALUES (?, ?, ?, ?)`,
  );
  // Common AU brackets (illustrative; user should set their own)
  ins.run("Me", 0.37, 0.02, 1);
  ins.run("Partner", 0.32, 0.02, 0);
}

function seedAndMigratePortfolios(db: Database.Database) {
  const pCount = db.prepare("SELECT COUNT(*) AS c FROM portfolios").get() as {
    c: number;
  };

  if (pCount.c === 0) {
    const ins = db.prepare(
      "INSERT INTO portfolios (name, notes) VALUES (?, ?)",
    );
    ins.run("My portfolio", "Default — holds from any broker");
    ins.run("Partner portfolio", "e.g. spouse — separate tax profile later");
  }

  const my = db
    .prepare("SELECT id FROM portfolios WHERE name = ?")
    .get("My portfolio") as { id: number } | undefined;
  if (!my) return;

  // Backfill portfolio_id from legacy account_id / nulls
  if (!hasColumn(db, "transactions", "portfolio_id")) return;

  const legacy = db
    .prepare(
      `SELECT t.id, t.account_id, a.broker AS account_broker
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.portfolio_id IS NULL`,
    )
    .all() as Array<{
    id: number;
    account_id: number | null;
    account_broker: string | null;
  }>;

  const upd = db.prepare(
    `UPDATE transactions
     SET portfolio_id = ?,
         broker = COALESCE(broker, custody, ?)
     WHERE id = ?`,
  );
  for (const row of legacy) {
    upd.run(my.id, row.account_broker || null, row.id);
  }

  if (hasColumn(db, "import_batches", "portfolio_id")) {
    db.prepare(
      `UPDATE import_batches SET portfolio_id = ?
       WHERE portfolio_id IS NULL`,
    ).run(my.id);
  }
}

function hasColumn(
  db: Database.Database,
  table: string,
  column: string,
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return cols.some((c) => c.name === column);
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  type: string,
) {
  if (hasColumn(db, table, column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (e) {
    console.warn(`migrate: could not add ${table}.${column}:`, e);
  }
}
