# Yields — Product & Delivery Plan

Local investment app for an **Australian resident** with **AU and non-AU (e.g. US)** holdings: **track what you own** (broker imports, DRP lots, Yahoo prices) and **plan what to do next** (tax-aware scenarios post–CGT change). Personal tool, not financial advice.

**Markets in scope:** ASX (primary) + **US equities/ETFs** at minimum; other exchanges later if they appear in broker exports. Reporting currency: **AUD** (convert foreign prices/cash with FX).

---

## 1. Goals

### Primary

1. **Portfolio (now)** — Single place for holdings across CommSec, Pocket, Selfwealth, Stake, Betashares Direct — **including US (and other foreign) stocks**, not ASX-only.
2. **Import truth from brokers** — Buys, sells, and **DRP/reinvest allotments** from CSV/XLSX into a ledger (not reconstructed from market data).
3. **Planner** — For **new buys from ~1 Jul 2027 onwards**: compare growth vs dividend tax paths under the new CGT rules (not historical lot tracking).
4. **AU tax awareness** — Marginal rates (you vs spouse), dividend tax drag (franking on AU only), dual CGT regimes around the **1 July 2027** change; foreign assets still under AU CGT rules for a resident, with **AUD cost base / proceeds**.
5. **Long-lived local app** — SQLite file, optional Docker, minimal paid APIs.

### Non-goals (v1–v2)

- Live broker / CHESS / Computershare APIs (none available for retail DIY).
- Full ATO return, trusts, companies, SMSF engines.
- US tax forms (W-8BEN detail beyond notes), estate tax, state tax.
- Auto-rebuild DRP history from Yahoo (Yahoo has no reliable franking/DRP issue prices).
- Multi-user SaaS / cloud accounts.
- Crypto or property as first-class assets.

---

## 2. Product shape (two sections)

| Section | Answers | Data sources |
|--------|---------|--------------|
| **Portfolio** | What do I own? Cost base? Performance? Income? | Broker files → SQLite; Yahoo → prices |
| **Planner** | What should *new money after Jul 2027* buy — growth vs dividend after tax? | Ticker picks + assumed yields/growth; post‑2027 CGT model |

Shared: tax settings, instrument catalogue, disclaimer.

---

## 3. Architecture

```
apps/web          Vite + React + Tailwind (shadcn-style UI)
apps/api          Hono + better-sqlite3
packages/core     Parsers, holdings math, Yahoo client, (later) tax + planner engines
data/yields.db    SQLite (gitignored); override YIELDS_DB_PATH
Docker            Optional pinned Node runtime + volume for DB
```

### Principles

- **Ledger is source of truth** for units and cost base.
- **Market data is cacheable** — app works offline after sync.
- **Provider interface** for market data — Yahoo now; EODHD later if needed.
- **Broker parsers are golden-file tested** against anonymised fixtures.
- Domain logic lives in `@yields/core` with few dependencies (survives UI churn).

### Longevity

- Pin Node (`.nvmrc` / Docker `node:22`).
- Commit lockfile; Docker image freezes runtime.
- Backup = copy `yields.db`.
- Prefer pure TS for tax/parsers over heavy frameworks.

---

## 4. Data model (SQLite)

| Table | Purpose |
|-------|---------|
| `accounts` | **Portfolios / custody** (Stake, CommSec, …) — where you hold |
| `transactions.source` | Import provenance (`sharesight_paste`, `file:commsec`, `manual`) |
| `import_batches` | File name, broker, counts, warnings JSON |
| `transactions` | Normalised ledger: buy / sell / **drp** / dividend_cash / transfer_* / … — includes `exchange`, `currency` |
| `price_cache` | Yahoo daily bars (keyed by Yahoo symbol, e.g. `VAS.AX`, `AAPL`) |
| `quote_cache` | Latest price per symbol (native currency of listing) |
| *(later)* `fx_cache` | AUD cross rates (e.g. AUDUSD) by date for CGT / valuation |
| *(later)* `instruments` | MER, default yield/franking (AU) / withholding notes (US), exchange |
| *(later)* `scenarios` | Planner scenarios + contribution keyframes |
| *(later)* `settings` | Tax rates, spouse rates, CGT regime toggle, base currency AUD |

### Instrument identity

| Field | Example AU | Example US |
|-------|------------|------------|
| `ticker` | `VAS` | `AAPL` / `VOO` |
| `exchange` | `ASX` | `US` (or `NASDAQ`/`NYSE` if known) |
| `currency` | `AUD` | `USD` |
| Yahoo symbol | `VAS.AX` | `AAPL` (no suffix) |

Never assume every ticker is ASX. Parsers must set `exchange` + `currency` from file columns (market, currency) or heuristics (Stake US vs AU account, `$` vs `A$`, known US list).

### Transaction types (normalised)

| Type | Effect on holdings |
|------|-------------------|
| `buy`, `transfer_in` | +qty, +cost base |
| `drp` | +qty, +cost base (issue price × units or amount) |
| `sell`, `transfer_out` | −qty, −avg cost portion |
| `dividend_cash` | Income only (no unit change) |
| `split`, `fee`, `other` | As defined |

**Dedupe:** `external_id` or content fingerprint per account.

---

## 5. Integrations

### 5.1 Broker imports (required)

| Broker | Format | Notes |
|--------|--------|--------|
| CommSec | CSV confirmations | ASX; buys/sells; DRP if present |
| Pocket | CSV (CommSec family) | ASX ETFs; separate account |
| Selfwealth | CSV report | **ASX + international** — market column matters |
| Stake | CSV / **XLSX** activity | **AU and US** activity often separate or tagged; often per FY |
| Betashares Direct | CSV activity / cost base | ASX-focused; refine with real samples |
| Generic | Column heuristics | Fallback; require ticker + date + side/qty |

**Multi-market import rules:**

- Preserve **trade currency** (AUD/USD/…).
- Set **exchange** (`ASX` vs `US` / other) from broker market field when present.
- Same ticker text on different exchanges must not collapse (e.g. rare dual listings) — key is `(exchange, ticker)`.
- US **DRIP** (dividend reinvestment) maps to same `type=drp` as AU DRP when units appear on the row.

**DRP/DRIP rule:** Classify via side/description (`DRP`, `DRIP`, `reinvestment`, etc.) → `type=drp`. Units must appear on the row or they cannot be imported.

**Not available:** CHESS API, Computershare API, official retail broker sync APIs.

### 5.2 Market data — Yahoo (current)

| Need | ASX | US |
|------|-----|-----|
| Historical prices | `TICKER.AX` | `TICKER` |
| Performance (derive) | Yes | Yes |
| Cash dividends | Partial | Partial |
| Franking | No | N/A |
| DRP/DRIP issue price | No | No |
| MER / fees | No | No |
| FX (AUDUSD) | Use Yahoo `AUDUSD=X` (or similar) | same |

Use for: valuations, charts, optional trailing yield hints.  
**Do not** use to invent DRP/DRIP lots.

Holdings **market value in AUD** = foreign price × units × FX (spot for dashboard; historical FX on trade date for cost base in AUD when modelling CGT properly).

### 5.3 Market data — paid later (optional)

**EODHD** (~USD 20–100/mo depending on plan; All-in-One ~$100 for franking + history + fundamentals):

- ASX corporate actions: franking, DRP flags/prices  
- US/global EOD + fundamentals  
- Cleaner multi-exchange coverage  

Only if free path (Yahoo + presets + CSV) is painful.

### 5.4 Fund fees / income attributes without paid API

- Curated **instrument seed**:  
  - AU: VAS, VGS, VHY, A200, … — MER, typical franking, default growth/yield  
  - US: e.g. VOO, VTI, QQQ, AAPL, … — MER (if ETF), default yield, **no franking**, optional note on US withholding  
- Manual override on every assumption.
- User broker/tax statements for *actual* income and franking (AU only).

---

## 6. Feature backlog

### Phase 0 — Foundation *(done)*

- [x] Monorepo: web, api, core  
- [x] SQLite schema + default accounts  
- [x] Broker parse framework + CommSec sample + holdings engine  
- [x] Import API + holdings/transactions APIs  
- [x] Yahoo quote/history client + cache tables  
- [x] Basic UI: holdings, ledger, import  
- [x] README, Docker skeleton, this plan  

### Phase 1 — Portfolio solid

- [x] Import polish + **US/international fixtures** (Stake US, Selfwealth mixed)  
- [x] Correct `exchange` + `currency` on import paths (`inferExchangeAndCurrency`)  
- [x] Yahoo symbol mapping: ASX → `.AX`, US → bare ticker; mixed-book refresh  
- [x] **FX cache** (`fx_cache`) + portfolio totals **in AUD**  
- [x] Holdings UI: exchange badges (ASX vs US) + native + AUD columns  
- [x] Dedupe on re-import (`external_id` / fingerprint)  
- [x] Manual add + delete transaction (exchange + currency picker)  
- [x] Yahoo refresh per instrument with error surface  
- [x] Performance view (time-weighted or simple cost vs value over time, AUD)  
- [x] Export ledger CSV / backup DB button  
- [x] Multi-account rollup vs per-account  

### Phase 2 — Income & DRP/DRIP check (not rebuild)

- [x] Dividend cash rows in ledger + FY income summary (**AUD**, by market)  
- [x] **DRP/DRIP check:** expected reinvest if flag on — user confirms vs imported `drp` rows (AU and US)  
- [x] Per-holding “DRP/DRIP enabled from date” flag (`holding_flags`)  
- [x] No bulk synthetic DRP generation into ledger (suggestions only)  
- [x] Note US dividend withholding as optional simple % assumption (not full W-8BEN engine)  

### Phase 3 — Tax settings (portfolio + shared)

- [x] You / spouse marginal rates + Medicare levy option (`tax_profiles`, TaxSettingsPanel)  
- [x] FY summary: cash dividends (AU franked vs foreign), estimated tax on income (simplified) — helpers in `incomeTax.ts` + Income panel  
- [x] Realised CGT sketch — **average cost** documented in `tax/cgt.ts` (not FIFO)  
- [x] Dual CGT regime toggle: `discount_50` | `indexation_min30` | `auto_by_date` (1 Jul 2027)  
- [x] Disclaimer always visible (`Disclaimer.tsx` + footer)  

### Phase 4 — Planner

**Purpose:** allocate **new buys from ~1 Jul 2027** under the new CGT rules (growth vs dividend tax path). Not for historical lots — that is Holdings.

- [x] Scenario entity: horizon, tax profile, exit (sell all / hold / drawdown x%/yr)  
- [x] Ticker-based strategies: growth / dividend / hybrid (e.g. BGBL/A200, HYLD/VHY)  
- [x] Editable yield / growth / MER / franking / reinvest  
- [x] Fee model: MER drag + brokerage on contributions  
- [x] Tax-focused report: income tax path vs exit CGT, net gain, old vs new CGT  
- [x] Contribution path: flat monthly + keyframes / lump sums UI  
- [x] Year-by-year breakdown UI  
- [x] Optional seed from current portfolio (secondary)  
- [x] Switch-at-end income estimate (sell phase 1 → redeploy phase 2)  

### Phase 5 — Hardening & longevity

- [x] shadcn/ui fully wired (or keep polished Tailwind) — **deferred; Tailwind kept**  
- [x] Docker compose: API + static web + volume  
- [x] Automated tests: parser golden files, tax edge cases, planner keyframes (expand over time)  
- [x] Settings page: data path, Yahoo on/off pref, wipe cache, US withholding default  
- [ ] Optional EODHD provider behind same interface  
- [x] Yahoo resilience: cache-first dividends, backoff, bulk refresh circuit breaker  

---

## 7. Planner report (target output)

Side-by-side **Growth | Dividend | Hybrid** (and custom):

| Metric | |
|--------|--|
| Final portfolio value | |
| Total contributions | |
| Dividends received (cash) | |
| Taxes paid (income + CGT events) | |
| Fees paid (MER + brokerage) | |
| Net if sell all on last day | |
| Effective tax drag % | |
| Income in drawdown years | |

Assumptions panel always shown (rates, inflation, CGT regime, return inputs).

### Contribution UX

1. Default: constant $/month for duration.  
2. User adds keyframes (e.g. year 2 → $1,200/mo).  
3. Chart reflects piecewise path; table is authoritative if chart drag is hard.

### Exit strategies

- Liquidate 100% at end (CGT event).  
- Hold (unrealised only; optional “as if sold” column).  
- Drawdown x% of portfolio or of initial plan per year (partial CGT each year).

---

## 8. Tax modelling notes (implementation guide)

Keep **simplified and documented**; not ATO software. User is modelled as an **Australian tax resident** with **worldwide** portfolio.

1. **AU income:** cash distributions; franking credits when known (CSV/statements/presets).  
2. **Foreign (e.g. US) income:** cash dividends in foreign currency → AUD at payment FX; **no franking**; optional simple withholding assumption; assessable income still relevant at MTR (simplified).  
3. **CGT (AU + US + other):** for a resident, CGT can apply to foreign shares too.  
   - Cost base / proceeds in **AUD** (convert at acquisition / disposal FX).  
   - Holding period ≥12 months → discount or new regime.  
4. **From 1 Jul 2027 (as announced):** model gains accruing after cutoff under indexation + 30% floor; pre-cutoff portion under 50% discount where eligible — exact split method is a modelling choice (document in UI). Same engine for ASX and US lots once in AUD.  
5. **Spouse:** same scenario, different MTR / ownership split %.  
6. Always: “estimates only”.

---

## 9. Tech stack (locked for now)

| Piece | Choice |
|-------|--------|
| Language | TypeScript |
| UI | React + Vite + Tailwind |
| API | Hono on Node |
| DB | SQLite (`better-sqlite3`) |
| Market data | Yahoo (unofficial) |
| Package manager | pnpm workspaces |
| Runtime pin | Node 22, optional Docker |

**Not required:** Postgres, Redis, cloud auth.

---

## 10. Repo layout

```
yields/
  PLAN.md                 ← this file
  README.md
  package.json
  pnpm-workspace.yaml
  docker-compose.yml
  Dockerfile
  data/                   ← yields.db (local)
  fixtures/csv/           ← anonymised samples
  apps/web/
  apps/api/
  packages/core/
    src/parse/            ← broker parsers
    src/yahoo.ts
    src/holdings.ts
```

---

## 11. How to run

```bash
pnpm install
pnpm --filter @yields/core build
pnpm dev
```

- Web: http://localhost:5173  
- API: http://localhost:8787  
- Sample import: `fixtures/csv/commsec-sample.csv` → CommSec account  

---

## 12. Success criteria

### Portfolio MVP

- [ ] Import at least one real file from each broker you use without silent wrong quantities  
- [ ] **Mixed book:** ASX + US holdings display correctly with exchange badges and Yahoo prices for both  
- [ ] Portfolio totals make sense in **AUD** (FX applied)  
- [ ] DRP/DRIP rows increase units and cost base correctly  
- [ ] Holdings match broker (within known cash residual / rounding)  
- [ ] Re-import does not duplicate trades  

### Planner MVP

- [ ] Three templates comparable on one screen  
- [ ] Contribution keyframes change final value  
- [ ] Tax rate / spouse switch changes ranking  
- [ ] Exit strategy changes tax paid and net  
- [ ] Assumptions and disclaimer visible  

### Longevity

- [ ] Fresh machine: Docker or `pnpm i && pnpm dev` works  
- [ ] DB backup/restore documented  
- [ ] Core tests pass without network  

---

## 13. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Broker CSV formats change | Detector + per-broker fixtures; generic mapper |
| US vs ASX ticker confusion | Always store `exchange`; Yahoo map by exchange |
| FX missing / wrong dates | FX cache; fallback spot with warning on valuations |
| Yahoo breaks / rate limits | Cache; polite delays; provider interface |
| DRP/DRIP missing from export | Document; manual tx; later check only |
| Tax law complexity (esp. foreign) | Simplified engine + clear labels; no “ATO accurate” claim |
| Scope creep (Sharesight clone) | Phase gates; planner after portfolio trustworthy |

---

## 14. Suggested build order (next sessions)

1. **Multi-market foundation** — exchange/currency on import + Yahoo symbol map + AUD valuation via FX  
2. **Real CommSec/Pocket export** → fix ASX parser gaps  
3. **Stake / Selfwealth US (or intl) fixture** → prove non-AU path  
4. Manual transaction CRUD (with market picker)  
5. FY income summary (AU vs foreign)  
6. Tax profile settings  
7. Planner engine (no UI polish) — multi-market weights OK  
8. Planner UI + contribution keyframes  
9. CGT dual-regime + comparison report (AUD lots)  
10. Docker web+api polish  

---

## 15. Decisions log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Markets | **ASX + US (and other foreign as imported)** | User holds non-AU stocks (e.g. US), not ASX-only |
| Reporting currency | **AUD** | AU resident; FX for foreign prices and CGT |
| Market data v1 | Yahoo | Free; works for `.AX` and US tickers + FX |
| DRP/DRIP source | Broker CSV only | Accurate lots; no fake rebuild |
| DRP verify | Future “check” feature | Confirm expected vs imported |
| Database | SQLite file | No install; portable backup |
| Stack | TS monorepo | One language; shadcn-friendly UI |
| Paid API | Deferred | EODHD when franking automation worth ~$60–100/mo |
| CHESS/Computershare | No API integration | Retail access is portal/PDF only |
| CGT reform date | Model around 1 Jul 2027 | Per Budget announcements (confirm before relying); apply to modelled worldwide lots in AUD |

---

## 16. Implementation status

Phase 1 multi-market path is implemented:

- [x] `toYahooSymbol(ticker, exchange)` on refresh  
- [x] Parsers set `US` + `USD` from market/currency columns  
- [x] Holdings key `exchange:ticker`  
- [x] FX `AUDUSD=X` (etc.) → AUD valuations  
- [x] Fixtures: `fixtures/csv/commsec-sample.csv`, `stake-us-sample.csv`, `selfwealth-sample.csv`  

Phase 1 performance + export: `buildPerformanceSeries` / `transactionsToCsv` in
`@yields/core`, API `GET /api/performance`, `/api/export/transactions.csv`,
`/api/export/backup`, web modules `PerformanceChart.tsx` + `ExportBar.tsx`.

---

*Last updated: 2026-07-26 — Phases 2–5 largely complete; see CHANGELOG.md [0.1.0] / [Unreleased]. EODHD still optional. Agents: AGENTS.md (changelog + releases).*
