# Agent guide — Risu

Instructions for AI coding agents (and humans) working in this repository.

## Project snapshot

- **Product name:** **Risu** (りす — squirrel; same animal-name style as other personal tools).
- **What:** Local AU-resident portfolio tracker + **new-money planner** (post–Jul 2027 CGT framing).
- **Stack:** TypeScript monorepo — `apps/web` (Vite/React), `apps/api` (Hono + better-sqlite3), `packages/core` (parsers, tax, planner, Yahoo client).
- **DB:** SQLite file (`YIELDS_DB_PATH` or `data/yields.db`). Not Dexie.
- **Not goals:** Live broker APIs, full ATO software, SaaS multi-user.

### Operator book (currency / markets)

Primary holdings for this install (do not simplify the codebase down to only these):

| Market | How held | Quote / trade currency |
|--------|----------|-------------------------|
| **Australia** | ASX equities/ETFs | **AUD** |
| **United States** | US equities (e.g. TSLA) | **USD** prices; cost often AUD via Sharesight trade FX |
| **Japan exposure** | Via **Betashares** (AU product on ASX), not TSE/JPY | **AUD** — treat as ASX, never invent JPY FX for these |

- Operator does **not** trade GBP/EUR/other books day-to-day; **keep** multi-currency helpers (LSE, EUR, generic `AUD{CCY}=X`, Frankfurter, etc.) for future-proofing and tests — do **not** delete them.
- For performance MTM: ASX/Betashares → AUD (no FX); US → USD price × `AUDUSD` history → AUD. Cost from ledger currency as stored.
- FX history cache priority in practice: **AUDUSD** (and any other pair only if a foreign quote currency appears).

Read **PLAN.md** for phased scope. Read **README.md** for run instructions. Read **docs/import-sources.md** for broker/Sharesight import reality.

## Working rules

1. **Domain logic lives in `@yields/core`** — keep API thin; UI calls API or pure helpers.
2. **Ledger is source of truth** for units/cost base. Yahoo is optional cache for prices/dividends.
3. **Do not invent DRP lots** from market data — DRP check is suggestions only.
4. Prefer small, reversible local edits. Confirm before destructive git or shared remotes unless the user asked.
5. After material behaviour change: update **CHANGELOG.md** under `[Unreleased]` (see below). Rebuild core (`packages/core` → `tsc`) when API depends on dist.
6. Run relevant tests: `cd packages/core && npx vitest run` (or package script).

## Changelog (required for notable work)

File: **[CHANGELOG.md](./CHANGELOG.md)** — [Keep a Changelog](https://keepachangelog.com/) style.

### When to update

| Change | Update changelog? |
|--------|-------------------|
| User-visible feature, fix, or breaking behaviour | **Yes** — `[Unreleased]` |
| Docs-only, formatting, comments | Optional |
| Dependency bump with no user impact | Optional (note if security-related) |
| WIP mid-task | Prefer one entry when the slice is coherent |

### How to write entries

1. Put new items under **`## [Unreleased]`** at the top (create the section if missing).
2. Use categories: **Added**, **Changed**, **Fixed**, **Deprecated**, **Removed**, **Security**.
3. Write for the **user/operator**, not a file dump: what changed and why it matters.
4. Group related bullets; avoid PR numbers unless the project uses them consistently.
5. Do **not** invent a version number until release time.

Example:

```markdown
## [Unreleased]

### Added
- Planner inputs persist to localStorage across browser refreshes

### Fixed
- CommSec Confirmations B/S maps to buy/sell instead of `other`
```

### Do not

- Rewrite historical released sections except to correct factual errors.
- Leave `[Unreleased]` empty forever after a tagged release — either empty intentionally or cut a release.

## Releases

### Versioning

- **SemVer** for tags and root `package.json` / workspace packages when bumped together:
  - **MAJOR** — breaking import formats, DB migrations that need user action, removed features
  - **MINOR** — new features, backward-compatible
  - **PATCH** — bugfixes, small hardening
- Pre-1.0 (`0.x`): MINOR may still include sharp edges; document breaks under **Changed** / **Fixed**.

### Release checklist (agent or human)

1. **Tests / typecheck** — core tests green; web + api typecheck if touched.
2. **CHANGELOG.md**
   - Move all `[Unreleased]` items into a new section:  
     `## [X.Y.Z] — YYYY-MM-DD`
   - Leave a fresh empty `## [Unreleased]` (optional Planned subsection).
   - Update “Version links” footer if used.
3. **Version bump** — set `version` in root `package.json` (and package versions if this repo publishes them) to `X.Y.Z`.
4. **Commit** — e.g. `chore(release): vX.Y.Z` including changelog + version only (or with the last feature commit if the user prefers one commit).
5. **Tag** — annotated tag:  
   `git tag -a vX.Y.Z -m "vX.Y.Z"`  
   Push when the user asks: `git push origin main` and `git push origin vX.Y.Z`.
6. **GitHub Release** (optional) — paste the changelog section body; do not invent release notes that are not in CHANGELOG.

### First release

This repo’s first documented release is **0.1.0** (see CHANGELOG). Subsequent work accumulates under `[Unreleased]` until the next tag.

## Layout (quick)

```
apps/web          UI (Planner, holdings, settings, …)
apps/api          Hono routes, SQLite, Yahoo gate, static serve
packages/core     parsers, holdings, tax, planner engine, Yahoo client
fixtures/csv      sample broker files
docs/             import guides
PLAN.md           product backlog / phases
CHANGELOG.md      user-facing history
AGENTS.md         this file
```

## Safety / product constraints

- Always surface **estimates only / not advice** for tax and planner outputs.
- Never commit secrets, full personal broker dumps, or `data/yields.db`.
- Prefer cache-first Yahoo; respect cool-down; do not auto-hit Yahoo on every page load.
