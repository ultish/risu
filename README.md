<p align="center">
  <img src="docs/risu-icon.png" alt="Risu" width="128" height="128" />
</p>

# Risu

**Risu** (りす — squirrel) helps you see **what you already own** and **what you might buy next** — built for an **Australian resident** with a mix of **ASX and US** shares (including things like Betashares Japan ETFs that trade in AUD).

Everything stays **on your computer**. No sign-up, no uploading your broker history to someone else’s cloud, and **not financial advice** — just a clear private picture of your book.

---

## Why Risu?

Broker apps show today’s balance. Spreadsheets go stale and break. Paid trackers often cap portfolios, tickers, or history — or lock your data in their cloud.

Risu is **free and open source**. Your book lives in a **local SQLite file on your machine**: one portable database you can **back up, copy, and restore** (dated backups in a click). Move machines, keep archives, own the file — no subscription gate on “export.”

- **No artificial limits** — as many portfolios, transactions, and stocks as you need (disk space is the practical ceiling)
- **Private by default** — no account, no uploading your history to a third-party SaaS
- **AUD-first view** of ASX and overseas holdings (cost vs market value over time)
- **Planning mode built around Australian tax framing** — especially **new money** after the **Jul 2027 CGT** changes (indexed cost-style thinking, estimates only — not a tax return)

Import your trades, refresh prices when you choose, and run “what if?” scenarios with assumptions you control.

---

## Features

### See your portfolio clearly

- **Separate portfolios** — e.g. yours and a partner’s — each with its own trades
- **Import from real exports** — CommSec, Pocket, Selfwealth, Stake, Betashares Direct, or Sharesight (file or paste). Details: [import guide](./docs/import-sources.md)
- **Add a trade by hand** when a file doesn’t cover it
- **Holdings at a glance** — units, cost base, last price, unrealised gain/loss in **AUD**
- **Full trade history** — search-friendly ledger; export to CSV when you need a copy
- **Performance over time** — cost base vs market value chart; hover for any month, zoom the range you care about
- **One-click backup** of your whole local database (dated file you can stash offline)

### Prices without the noise

- **You decide when to refresh** — opening the app never hammers market sites
- **ASX and US prices** from free public sources (Yahoo when it works; other sources when it doesn’t)
- **US holdings converted to AUD** using historical exchange rates, so old months aren’t valued with today’s dollar
- **Stock splits handled sensibly** so long-term value doesn’t look broken after a 5-for-1
- If markets block automated refresh, you can still **paste a price history from your browser**

### Tax sketches & planning (not a tax return)

- **Tax profiles** — set rough marginal rate and Medicare for illustrations
- **DRP check** — spot possible missing reinvestment lots (suggestions only; it won’t invent history)
- **New-money planner** — compare growth vs income-style portfolios for **future** contributions under a **post–Jul 2027 CGT-style** framing (indexed cost idea, no 50% discount in the main path). Built for “what if I put new capital here?” — not rewriting the past

### Private by design

- Data lives **only on your machine**
- No account, no ads, no syncing your holdings to a SaaS
- You export or back up when **you** want a copy

---

## Install

### Requirements

- **Node.js 20+**
- **pnpm** 9 (repo pins `packageManager`)

```bash
# Enable pnpm if needed (Corepack ships with Node)
corepack enable
```

### Clone and install

```bash
git clone https://github.com/ultish/risu.git
cd risu
pnpm install
pnpm --filter @yields/core build
```

### Run (dev)

```bash
pnpm dev
```

| Service | URL |
|--------|-----|
| Web (Vite) | http://localhost:5173 |
| API | http://localhost:8787 |

Vite proxies `/api` to the API. SQLite is created at **`data/yields.db`** on first run (gitignored).

**Smoke test:** Import → CommSec parser → `fixtures/csv/commsec-sample.csv`.

### Docker (optional)

API + built UI in one container:

```bash
docker compose up --build
```

Open **http://localhost:8787**. DB on volume `yields-data` (`YIELDS_DB_PATH=/data/yields.db`).

### Environment

| Variable | Meaning |
|----------|---------|
| `YIELDS_DB_PATH` | Absolute path to SQLite file (default: `data/yields.db` relative to API cwd) |
| `PORT` | API port (default `8787`) |

---

## Development

### Layout

```
apps/web          React UI (Vite + Tailwind)
apps/api          Hono + better-sqlite3 + static serve of web dist
packages/core     Parsers, holdings, performance, tax, planner, Yahoo/FX clients
fixtures/csv      Sample broker files
docs/             Import guides + app icon
```

Domain logic lives in **`@yields/core`**. Keep the API thin; UI talks to `/api` or pure helpers.

### Commands

| Command | What |
|---------|------|
| `pnpm dev` | API + web in parallel |
| `pnpm dev:api` / `pnpm dev:web` | One side only |
| `pnpm --filter @yields/core build` | Compile core (`tsc` → dist) — **required** after core changes the API imports |
| `pnpm --filter @yields/core test` | Vitest (parsers, tax, splits, planner, …) |
| `pnpm build` | Build all workspace packages |
| `pnpm typecheck` | Typecheck all packages |

### Workflow tips

1. Change **`packages/core`** → `pnpm --filter @yields/core build` (or `cd packages/core && npm run build`) before relying on the API.
2. After user-visible changes, update **[CHANGELOG.md](./CHANGELOG.md)** under `[Unreleased]`.
3. Agent/repo conventions: **[AGENTS.md](./AGENTS.md)**.
4. Do not commit `data/yields.db` or personal broker dumps.

### Console helpers (browser)

With the app open, DevTools:

```js
risu.help()
risu.sparkUrl(["TSLA", "VAS.AX"])
risu.chartUrl("AUDUSD=X", 10 * 365)
risu.importYahoo(json)   // paste Yahoo chart/spark/quote body
```

(`yields` is still an alias of `risu`.)

---

## Disclaimer

Estimates only. Not tax, legal, or investment advice. Yahoo/Nasdaq/ASX endpoints are unofficial and rate-limited; the ledger remains authoritative for lots and cost base.
