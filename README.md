# Risu

**Risu** (りす — squirrel) — local investment **portfolio tracker** for an AU resident (+ planner) — **ASX and non-AU (e.g. US)** holdings.

> Package paths may still say `@yields/*` / `yields.db` until a full monorepo rename.

- **Broker CSV/XLSX import** — CommSec, Pocket, Selfwealth, Stake, Betashares Direct  
- **DRP/DRIP rows** from those files become portfolio lots (`type=drp`)  
- **Yahoo Finance** — prices for `.AX` and US tickers (free, unofficial; cached in SQLite)  
- **Reporting in AUD** — FX for foreign holdings (planned; scaffold still ASX-heavy)  
- **SQLite** — single file DB, no separate database install  
- Optional **Docker** for a pinned long-term runtime  

See **[PLAN.md](./PLAN.md)** for full scope.  
**Changelog / releases:** **[CHANGELOG.md](./CHANGELOG.md)** · agent conventions in **[AGENTS.md](./AGENTS.md)**.  
**Planner** = what to **buy from ~Jul 2027 onwards** (growth vs dividend under new CGT) — not your historical holdings.  
**Holdings** = existing book. See **[docs/import-sources.md](./docs/import-sources.md)** for Sharesight/Stake import.

Not financial advice.

## Quick start (local)

```bash
pnpm install
pnpm --filter @yields/core build
pnpm dev
```

- Web: http://localhost:5173  
- API: http://localhost:8787  

Import `fixtures/csv/commsec-sample.csv` (broker = CommSec) to smoke-test.

## Design notes

| Concern | Approach |
|--------|----------|
| Buys / sells / **DRP** | Parsed from **your broker exports** → ledger |
| Market prices | **Yahoo** → `quote_cache` / `price_cache` |
| Franking / fund MER | Not from Yahoo; planner presets later / optional paid API |
| DRP “check” (expected vs actual) | Future; not auto-rebuild |

## Brokers

Pick the matching parser on import. Formats vary — if a real export fails, open an issue with **headers only** (no personal data).

## Data location

Default DB: `data/yields.db` (gitignored). Override with `YIELDS_DB_PATH`.

## Scripts

| Command | What |
|--------|------|
| `pnpm dev` | API + web |
| `pnpm --filter @yields/core test` | Parser / holdings tests |
| `pnpm build` | Build all packages |

## Docker

```bash
docker compose up --build
```

Single container on **http://localhost:8787** — API + built web UI (`SERVE_WEB=1`).  
SQLite lives on the `yields-data` volume (`YIELDS_DB_PATH=/data/yields.db`).

Local day-to-day dev is still `pnpm dev` (Vite :5173 → proxies `/api` to :8787).
