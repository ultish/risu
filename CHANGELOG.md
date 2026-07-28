# Changelog

All notable changes to **Risu** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Computershare + Link/MUFG issuer ETF annual statement PDF import (phase 4):** two more PDF layouts alongside Betashares Direct — `computershare.etf_annual` (Vanguard VGS, iShares IOZ) and `link_mufg.issuer_etf_annual` (Betashares NDQ; Link Market Services rebranded to MUFG Corporate Markets partway through, same layout family). Computershare statements are parsed by zipping the extracted date / description / unit-price / units-held column blocks; `Distribution Reinvested` only becomes a `drp` ledger row when the units-held delta is positive (0-unit reinvests warn, they don't import — see Appendix A.3). Link/MUFG statements glue adjacent numbers together in the raw text (e.g. `Opening Balance4444$37.38...`); rather than guessing a fixed digit split, a running balance is tracked from Opening Balance and the units/balance split for each `ALLOTMENT`/`Holding Net Movement (CHESS 510)` row is the one arithmetically consistent with that running balance. Both layouts follow the "never fabricate a cost base" rule (docs §15.5): issuer `Purchase`/`Sale` rows with no known market price, and Link/MUFG CHESS net movements, import as `transfer_in`/`transfer_out` with `price: null` plus a strong warning rather than as `buy` at $0 or NAV. Verified against the full real jimmy corpus (7 VGS years, 2 IOZ years, 6 NDQ years) with no parse errors, matching every documented scenario (VGS-2024's single qty-1 DRP, IOZ-2024's unknown-price Purchase → transfer_in, NDQ-2024's single DRP, NDQ-2023's DRP + CHESS movement).
- **Reconcile Stake XLSX ↔ ledger (phase 5, read-only):** `POST /api/import/reconcile` diffs a Stake Investment Activity XLSX against existing ledger rows for a portfolio — **no writes, ever**. Matches by `externalId` first, then `(date, ticker, type)` + qty/price tolerance (`ε_qty=1e-6`, `ε_price=0.015`); categorises `matched` / `fileOnly` / `ledgerOnly` (within the statement period only) / `conflicts` (which fields differ). Pure matcher lives in core as `reconcileStakeActivity` (`packages/core/src/reconcile.ts`), unit-tested against synthetic fixtures. Import tab shows a **"Reconcile with ledger"** button per queued Stake XLSX file with a small report (counts + the actual mismatched/unmatched rows).
- **Betashares Direct annual statement PDF import (phase 3):** first real PDF layout — `betashares_direct.platform_annual`. `extractPdf` (via `pdf-parse`) + a small layout registry (`packages/core/src/parse/pdf/`) fingerprint-detect the statement, then parse Buy/Sell/Fees/Distribution transaction-list rows (Deposits skipped, info warning). Fees import as `ticker: "FEE"` / `type: "fee"` / `quantity: 0` so auto-pilot fees stay visible in the ledger; issuer PDFs never fabricate a cost base. Import file UI now accepts `.pdf` and no longer pre-emptively blocks PDFs client-side — unsupported PDFs (e.g. Stake PDF, still XLSX-only) surface as a per-file import error instead. `parseBrokerFile`/`parseImportFile` are now `async` (PDF extraction is inherently async).
- **Multi-file import UI (phase 2):** drag-drop + multi-select file queue in Import → Import file; per-file parser/custody override and status (ready / needs custody / unsupported / error); "Auto-detect" is now the default parser; partial-batch failures are isolated (one bad file doesn't block the rest); import response now echoes `layoutId`/`confidence`.
- **Import foundations (phase 0):** `LayoutId` / detect types; `broker: "auto"`; PDF uploads return a clear “not implemented — use Stake XLSX” error (no crash); `parseImportFile` alias; fixture dirs `fixtures/xlsx/stake`, `fixtures/pdf`
- **Stake Tax & Documents multi-sheet XLSX**: Investment **Activity** merges Aus + Wall St equity sheets; Investment **Income** → `dividend_cash` (estimated). Detect via Summary “Report Type”. Trade Identifier → `externalId`; `Avg. Price` / `.ASX` ticker fixes. Empty FYs return 0 trades (info), not a hard error.
- Planner instrument fill: BetaShares/Vanguard **seed** + optional manual **Refresh** (Yahoo trailing yield / hist. growth estimate); SQLite `instrument_cache` (once per click, not on page load)
- **Manual Yahoo paste import**: when Node is 429’d, open browser URL → paste chart/spark/quote JSON via **Settings**, `POST /api/prices/import-yahoo`, or console `yields.importYahoo(json)` (also `yields.sparkUrl` / `yields.chartUrl`)
- Yahoo failures and refresh responses include **lastUrl** / **yahooBrowserUrls** (spark, chart, quote) so you can open the same request in a browser
- **Daily FX history cache** (`fx_history`): ~10y `AUDUSD=X` (etc.) from Yahoo chart or Frankfurter range; performance chart uses as-of rates; latest still in `fx_cache`; paste `AUDUSD=X` chart also fills history

### Changed
- **Planner rates** are **effective annual**: monthly step is \((1+r)^{1/12}-1\) (not \(r/12\)), so growth/yield/MER/CPI match the % you type over a year
- **README** rewritten (intro, features, install, dev) with Risu logo; **PLAN.md** removed
- **Nav URLs**: main tabs (and import/tax sub-modes) sync to query params — e.g. `?tab=planner`, `?tab=import&import=paste`, `?tab=tax&tax=drp` (copyable; browser back works)
- **Product name: Risu** (りす) — UI title, favicon/icon, console `risu.*` (legacy `yields.*` alias), backup `risu-YYYY-MM-DD.db`
- **Backup DB** download filename is `risu-YYYY-MM-DD.db` (UTC date)
- **Performance chart** uses **Recharts** (hover tooltips with cost / value / gap; brush to zoom time range) instead of static SVG
- **Holdings MTM currency**: market value uses **exchange quote currency** (US→USD) then FX to AUD; ledger `currency=AUD` only applies to cost (Sharesight stored AUD cost)
- **Split-adjusted MTM**: market value uses ledger qty × product of **later** Sharesight split ratios so Yahoo split-adjusted closes match (cost/qty display unchanged); fixes early performance green under cost
- **Price refresh works when Yahoo is banned**: cool-down only skips Yahoo; **ASX Markit** + **Nasdaq** quote fallbacks + **Frankfurter/open.er-api FX**; bulk Yahoo when available; longer cool-downs (1h→12h)
- **Performance chart history**: Holdings **Refresh** requests 1y history (`includeHistory`); Yahoo **spark** bulk then **chart** API per missing symbol (chart often works when spark/quote do not); still writes Nasdaq hist for US and “today” bar for ASX when Yahoo is unavailable
- **Performance chart + fallbacks**: refresh writes **price_cache** (US 1y from Nasdaq history; ASX “today” bar from last quote); performance API merges quote_cache; chart reloads after refresh
- **Planner / post–Jul 2027 CGT** (aligned with planning rules you care about):
  - **CPI-index cost base** each month (assumed inflation %, default 2.5% p.a., editable)
  - **No 50% CGT discount**
  - Tax rate on indexed gain = **max(MTR+Medicare, 30%)** (30% floor if MTR is low/zero; high MTR still pays full MTR, e.g. 47%)
  - Legacy 50% discount optional side-by-side only (off by default)
- **Planner results**: at-a-glance % cards (net return, approx. CAGR, wealth growth, tax/capital, tax take of gain, portfolio multiple); $ rows show “· +X%” vs capital in; year-by-year YoY portfolio value %
- **Switch at end**: both paths compared at **end of year N+1** (same year); Path A = N years source → sell → year N+1 on target (monthly engine); Path B = full N+1 year target sim; sale CGT once; phase‑2 cost base resets
- **Nav simplified** to 6 top tabs: Holdings · Transactions · Import · Tax · Planner · Settings. Import sub-modes (file / paste / manual); Tax sub-modes (profiles / DRP check); Portfolios moved under Settings
- **Assessable dividends** (core + `GET /api/income`): include DRP/reinvest amounts as taxable income; skip DRP only when a nearby equal cash dividend exists (avoids double-count; still counts partial DRP)
- **Planner DRP**: reinvests full gross yield into value and cost base; income tax settled outside the portfolio (was reinvest-net-of-tax, which understated compounding and cost base)
- **Planner franking**: keeps refundable franking credits (negative net tax) instead of clamping tax to zero
- **FY dividend tax estimate**: simple FITO proxy — residual tax reduced by min(withholding, foreign-attributable tax); still not ATO FITO software
- Planner “seed from holdings” copy: clarifies cost base is set to market (new-money model), not holdings historical cost
- DRP check requires a specific portfolio (no silent fallback to the first portfolio when “All” is selected)

### Removed
- **Income** tab (FY cash dividend summary + tax sketch) — not useful enough for now; core helpers and `GET /api/income` remain if we restore later

### Planned
- Optional EODHD (or other) market-data provider behind the same interface as Yahoo
- Full CPI-indexed CGT cost base (planner still uses simplified post‑2027 floor)
- Optional issuer HTML scrape to refresh seed MER/franking offline

---

## [0.1.0] — 2026-07-26

First usable local release: multi-broker ledger, income/DRP tools, tax-aware Jul‑2027 planner, Settings + Docker.

### Added

#### Portfolio & import
- Monorepo (`apps/web`, `apps/api`, `packages/core`) with SQLite (`data/yields.db`)
- Portfolios (e.g. you / partner), broker + import-source filters
- Brokers: CommSec, Pocket, Selfwealth, Stake (AU/US), Betashares Direct, Sharesight file + paste, generic CSV
- **CommSec Confirmations** CSV (`Buy/ Sell` B/S, Security, Units, Net Proceeds) + tab-separated paste
- Re-import **repairs** existing rows with `type=other` when confirmation numbers match
- Holdings in AUD (FX cache), exchange badges, manual transactions, delete multi-select
- Performance series + export ledger CSV / SQLite backup

#### Income & DRP
- FY cash dividend summary (AUD) by market
- DRP/DRIP check (suggestions only; no synthetic ledger writes)
- Per-holding DRP-from-date flags
- Optional **US withholding** assumption (default 15%, net-vs-gross toggle)
- FY **estimated income tax** on dividends (franking + tax profile)

#### Tax & planner
- Tax profiles (marginal rate + Medicare)
- Dual CGT regimes: old 50% discount vs post–Jul 2027 simplified min‑30% floor
- Planner: Growth / Dividend / Hybrid (editable yield, growth, MER, franking, reinvest)
- Flat monthly contributions + **keyframes** and **lump sums** UI
- Tax comparison table, old-vs-new CGT delta, **year-by-year** breakdown
- Seed starting value from holdings
- **Switch at end**: choose accumulate strategy → sell → put **all** proceeds into another strategy; year‑1 income vs Dividend path same-year cash
- Planner inputs + switch choices **persist in localStorage**

#### Reliability & ops
- Yahoo cool-down gate + UI badge/countdown (Retry-After when present; else 15m→1h→3h→6h)
- Cache-first dividends; bulk price refresh circuit breaker; no Yahoo on page load
- Settings: DB path, Yahoo preference, US withholding default, wipe quote/price/div/FX caches
- Docker: API serves built web (`SERVE_WEB`); volume for SQLite
- Core tests: parsers, CGT, income tax, planner keyframes

### Fixed
- Cash dividend yield no longer zeroed out of capital (CGT / wealth metrics)
- CommSec live Confirmations B/S → buy/sell (was stuck as `other`)
- Yahoo 429 messaging and hammering on bulk refresh / DRP re-check

### Notes
- Estimates only — not financial, tax, or investment advice; not ATO software
- Yahoo is unofficial and rate-limited; ledger imports remain source of truth for lots

---

## Version links

- [Unreleased]: compare when a remote `main` exists
- [0.1.0]: initial tagged release (this changelog entry)

<!--
When tagging:

  git tag -a v0.1.0 -m "v0.1.0"
  git push origin v0.1.0

Move [Unreleased] items into a new ## [x.y.z] — YYYY-MM-DD section,
then leave a fresh empty [Unreleased] at the top.
-->
