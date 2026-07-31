# Changelog

All notable changes to **Risu** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **SelfWealth annual statement PDF import (AU domestic + International/USA):** two new PDF layouts, `selfwealth.annual` and `selfwealth.international_annual`. Real statements turned out to have three distinct column shapes across years/regions (2019 AU: Order ID + Contract Note, no Fees; 2020+ AU: Reference + Fees column; International: an entirely different `Contracts between …` trade table with no "Transaction Summary" section at all) — all three are handled. Buy/Sell quantities are resolved via the same arithmetic-consistency trick the Computershare/Link layouts use (try every split of the glued reference+quantity text, accept whichever makes `qty × price ≈ consideration`); dividend rows glue the per-unit rate directly onto a **non-integer** franking percentage (e.g. `$0.82136270.7%` → `$0.821362` @ `70.7%`) — `estDiv` alone can't disambiguate this (it barely moves between adjacent split points), so Franking Credit and Unfranked Amount are used as the real cross-check. `Security In`/`Security Out` transfer rows (DRP allotments, Share Purchase Plan top-ups, HIN registry conversions/transfers) carry **no price at all**, so their quantity is instead solved by reconciling each ticker's running unit balance across the year against Holdings Valuation (opening/closing) and Dividends-table (units-at-ex-div-date) checkpoints — verified against every row in a real 9-statement corpus, with exactly one row (a DRP immediately preceding its own ticker's full exit, no checkpoint in between) genuinely underdetermined and flagged with a warning + best-effort guess rather than silently trusted. Per product decision, `Security Out` rows (a full transfer to another broker) are **not recorded** as ledger transactions at all (info note only), and DRP rows carry `price: null, amount: null` since SelfWealth discloses no reinvestment rate — the paired `dividend_cash` row from the Estimated Dividends table is the sole income source for that period, so no pooling/dedup logic was needed here (unlike Computershare/Link's phase 6 fix). Both real statement families were found to duplicate their entire text content across every page (confirmed via pdf.js's own per-page `getTextContent`, not just the concatenated string) — parsing is dedup-safe regardless. **Known limitation:** AU ticker codes are split from the glued company name via a fixed 3-letter prefix (true for the whole real corpus this was verified against; a 4-letter code like VDHG/DHHF would currently mis-split — International statements aren't affected, since the instrument name there is Title Case and the split is unambiguous). SelfWealth's Corporate Action Cash Movement dividend table (International statements) isn't parsed yet — flagged with a warning when non-empty rather than dropped silently.
- **Fix pooled-DRP income double-counting (`income.ts`):** `summarizeDividendIncome`'s DRP/cash-dividend dedup previously only recognised a single nearby (±7 day, matching-amount) cash dividend as "the same event" — correct for Stake/Sharesight-style DRP (each period's reinvestment closely tracks that period's own distribution), but wrong for Computershare-style pooled DRP (phase 6), where a whole-unit purchase's cost is often the sum of *several* periods' accumulated residual and doesn't match any single nearby cash dividend. Confirmed live: importing `VGS-2024-annualstatement.pdf` and calling `GET /api/income` showed `FY2024: $224.52` (should be ≈$111.33, the four periods' actual distributions) — the `drp` row's $113.19 was being counted a second time on top of the `dividend_cash` rows that already captured it. Fix: when an instrument has genuine multi-period evidence (2+ `dividend_cash` rows for that ticker — a single nearby row that already failed the exact-match check is a *different*, unexplained distribution, not evidence to pool), a `drp` row now draws down a running per-instrument pool built chronologically from that instrument's own `dividend_cash` history dated on or before it; only the shortfall beyond what the pool can explain (e.g. residual carried in from an un-imported earlier statement year) counts as extra income. A single cash/DRP pair with unrelated amounts (fewer than 2 cash rows — e.g. a genuine partial reinvest) still falls through to the prior "count both in full" behaviour, since there's no multi-period evidence to pool from. All 5 pre-existing tests pass unchanged; 4 new tests lock in the pooling behaviour (fully-explained pool, partial shortfall, chronological ordering — a later cash dividend can't retroactively fund an earlier DRP — and the below-threshold fallback). Live-verified: re-importing VGS-2024 now shows `$146.29` (down from the buggy `$224.52`; the remaining gap over the ideal `$111.33` is the legitimate, expected shortfall from this single-year import not having the prior year's residual-contributing statement in the ledger).
- **Distribution Details income capture for issuer PDFs (phase 6):** Computershare (VGS, IOZ) and Link/MUFG (NDQ) annual statement PDFs no longer drop a distribution's income just because the reinvestment amount didn't stretch to a whole unit. Both layouts now parse a **second, separate section** of the statement — distinct from the `Transaction List`/`Transaction Details` table already parsed in phases 3/4 — and emit one `dividend_cash` row per distribution period for the **full gross amount paid**, alongside (not instead of) the existing `drp` row logic (unchanged: still only emitted when the unit-held delta is positive). Link/MUFG statements carry an explicit, labelled **"Distribution Details"** section (`Units`/`Distribution Rate`/`Distribution`/`Tax Withheld`/`Net Distribution` columns, glued the same way as Transaction Details but unambiguous since every field after the leading units count is `$`-prefixed) — `price` is set from the real, disclosed per-unit `Distribution Rate`. Computershare statements have **no** equivalent labelled section at all (confirmed empirically against the full real jimmy corpus, and iShares' own glossary text says as much); the only recoverable per-period figure is *derived* from the **"Distribution Reinvestment Cash Balance"** running-residual table via `grossDistribution[i] = (balance[i] − balance[i-1]) + delta_units[i] × price[i]` — so Computershare `dividend_cash` rows always carry `price: null` (no rate is ever disclosed). A statement-wide, non-zero `Cash Distribution Received` total (cash paid directly, not reinvested — seen once in the real corpus, VGS-2019) can't be attributed to a single period and produces a warning rather than a guess. Verified end-to-end against the full real jimmy corpus (7 VGS years, 2 IOZ years, 6 NDQ years): every previously "0-unit … not imported" period now has a `dividend_cash` row with a real amount, and every existing `drp` row is unchanged (byte-for-byte, diffed against the pre-phase-6 parser). (The pooled-DRP double-count this surfaced for Computershare is fixed separately — see the `income.ts` entry above.)
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
