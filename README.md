<p align="center">
  <img src="assets/risu-icon.png" alt="Risu" width="128" height="128" />
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
- **Import from real exports** — see [supported import formats](#supported-import-formats) below
- **Add a trade by hand** when a file doesn’t cover it
- **Holdings at a glance** — units, cost base, last price, unrealised gain/loss in **AUD**; click a row for a **per-ticker detail page** (same click-through from the transactions ledger)
- **Full trade history** — search-friendly ledger; click a ticker for its page; export to CSV when you need a copy
- **Performance over time** — cost base vs market value chart; hover for any month, zoom the range you care about
- **Allocation, gains, and income charts** — where your value sits by ticker, realised vs unrealised gain by financial year, and dividend income by financial year
- **One-click backup** of your whole local database (dated file you can stash offline)

### Prices without the noise

- **You decide when to refresh** — by default, opening the app never hits market sites; an optional auto-refresh (Settings, throttled with a cool-down) can check on page load if you want it
- **ASX and US prices** from free public sources (Yahoo when it works; other sources when it doesn’t)
- **US holdings converted to AUD** using historical exchange rates, so old months aren’t valued with today’s dollar
- **Stock splits handled sensibly** so long-term value doesn’t look broken after a 5-for-1
- If markets block automated refresh, you can still **paste a price history from your browser**

### Tax sketches & planning (not a tax return)

- **Tax profiles** — set rough marginal rate and Medicare for illustrations
- **FY tax estimate (Tax tab)** — roughly how much tax you owe for a financial year: dividend income tax plus realised CGT on your actual sells, combined. Capital gains use real **per-parcel cost base** (not average cost), so each sold parcel's own acquisition date decides whether the pre- or post–1 Jul 2027 CGT rules apply — per disposal, not per holding. Match parcels **FIFO** (oldest first) or **minimize CGT** (pick lots that reduce estimated tax, except **Betashares Direct statement sells**, which stay FIFO to match that platform’s own tax report). The 50% discount and indexed options remain as reference. Expandable rows show every underlying parcel: acquired/disposed dates, proceeds, cost base, gain, and tax
- **Ticker “if you sell” estimate** — on a stock's page, see estimated CGT for selling N units under FIFO or minimize-CGT parcel picking, including the 1 Jul 2027 cutoff. **Confirm the sale** to write it to the ledger with which parcels were sold or partially sold; the transactions list then shows that status. You still place the trade with your broker.
- **Stake DRP check** — Stake’s Activity export never lists reinvestment as a buy; this Import sub-page finds missing DRP lots from Activity + Income (+ optional Valuation) files. Analyze first, then confirm to insert. It won’t invent lots for unexplained unit jumps. Files you run through it are listed on that page (separate from regular Import file history).
- **New-money planner** — compare growth vs income-style portfolios for **future** contributions under a **post–Jul 2027 CGT-style** framing (indexed cost idea, no 50% discount in the main path). Built for “what if I put new capital here?” — not rewriting the past

### Private by design

- Data lives **only on your machine**
- No account, no ads, no syncing your holdings to a SaaS
- You export or back up when **you** want a copy

---

## Supported import formats

| Broker / source | Format |
|---|---|
| **Sharesight** | All Trades Report (file export or paste — the free-plan-friendly path is per-holding "All trades & adjustments" → copy → Paste Sharesight tab) |
| **CommSec** | Confirmations CSV |
| **Selfwealth** | Report CSV, or Annual Statement PDF (AU domestic + International/USA) |
| **Stake** | Investment Activity / Investment Income XLSX (per FY, under Tax & Documents) — no Stake PDF support |
| **Betashares Direct** | Annual Statement PDF |
| **Computershare** (Vanguard VGS, iShares IOZ, …) | Annual Statement PDF — set custody per file, it isn't auto-detected |
| **Link/MUFG** (Betashares NDQ, …) | Annual Statement PDF — set custody per file, it isn't auto-detected |
| Anything else | Add trades by hand, or paste a CSV that matches the generic column layout |

Multi-file drag-drop with auto-detect and per-file overrides lives under Import → Import file. Issuer PDFs never fabricate a cost base — if the statement doesn't disclose a price, the row imports as a transfer with a warning instead of a guessed value.

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
pnpm --filter @risu/core build
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

### hana-server (Podman + Caddy)

crypto-tax already uses **:8787** on that box, so Risu listens on **localhost :8788**. The browser URL is **http://risu.hana-server/** (Caddy on :80).

```bash
./scripts/deploy-hana.sh
```

SQLite: `~/risu-data/risu.db` on hana. Daily backups: `~/Documents/Finances/risu-backups`.

Full runbook (Caddy, DNS, UFW, next app): [docs/hana-server.md](docs/hana-server.md).

### Local deploy scripts

Outside this repo, `<your prod folder>/` holds two helper scripts for running Risu as a standalone Docker container (separate from `docker compose up`):

| Script | What |
|--------|------|
| `build.sh` | Builds the `risu:latest` image from this repo (`docker build`), saves it to `risu-latest.tar`, and gzips a dated backup into `image-backups/`. Run after pulling/making changes you want reflected in `run.sh`. |
| `run.sh` | Starts (or resumes) the `risu` container from the `risu:latest` image, loading it from `risu-latest.tar` first if the image isn't already in Docker. Serves at `http://localhost:8787` (override with `PORT`); DB persisted to `./db`. |

```bash
<your prod folder>/build.sh   # rebuild image + tarball after source changes
<your prod folder>/run.sh     # start the container
```

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
assets/           App icon
```

Domain logic lives in **`@risu/core`**. Keep the API thin; UI talks to `/api` or pure helpers.

### Commands

| Command | What |
|---------|------|
| `pnpm dev` | API + web in parallel |
| `pnpm dev:api` / `pnpm dev:web` | One side only |
| `pnpm --filter @risu/core build` | Compile core (`tsc` → dist) — **required** after core changes the API imports |
| `pnpm --filter @risu/core test` | Vitest (parsers, tax, splits, planner, …) |
| `pnpm build` | Build all workspace packages |
| `pnpm typecheck` | Typecheck all packages |

### Workflow tips

1. Change **`packages/core`** → `pnpm --filter @risu/core build` (or `cd packages/core && npm run build`) before relying on the API.
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
