# Changelog

All notable changes to **Yields** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Planner instrument fill: BetaShares/Vanguard **seed** + optional manual **Refresh** (Yahoo trailing yield / hist. growth estimate); SQLite `instrument_cache` (once per click, not on page load)

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
