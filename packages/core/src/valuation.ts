import { computeHoldings } from "./holdings.js";
import { computeLots, type ComputeLotsOptions } from "./lots.js";
import { fxYahooSymbol, holdingPriceKey } from "./market.js";
import {
  buildLastFxIndex,
  buildLastPriceIndex,
  fxAsOf,
  fxBarAsOf,
  priceBarAsOf,
  pricesAsOf,
  type FxInput,
  type PriceSeriesMap,
} from "./performance.js";
import { inferSplitEvents } from "./splits.js";
import type { ParsedTransaction } from "./types.js";

/** A close more than this many days before the valuation date is flagged as stale. */
export const STALE_PRICE_DAYS = 5;

export type ValuationFlag =
  /** No cached close on or before the date — no market value. */
  | "no_price"
  /** The close used is more than STALE_PRICE_DAYS older than the date. */
  | "stale_price"
  /** A foreign-currency holding with no FX rate at all. */
  | "no_fx"
  /** Only today's cached FX rate was available, not one from the date. */
  | "fx_not_historical"
  /**
   * Units held with no parcel behind them — a buy whose AUD cost couldn't
   * be worked out (no FX rate for it). Transfers aren't counted in
   * holdings at all, so they never cause this.
   */
  | "untracked_units";

export type ValuationParcel = {
  acquiredDate: string;
  quantity: number;
  costBaseAud: number;
  marketValueAud: number | null;
};

export type ValuationLine = {
  ticker: string;
  exchange: string;
  currency: string;
  quantity: number;
  /** Cost of the parcels behind these units, AUD. Untracked units add nothing. */
  costBaseAud: number;
  /** Value per unit in the trading currency, as used for the valuation. */
  unitValue: number | null;
  /** Date of the close used. */
  priceDate: string | null;
  /** Price-cache symbol the close came from. */
  priceSymbol: string | null;
  /** Foreign units per 1 AUD (Yahoo AUDUSD=X style); null for AUD. */
  fxRate: number | null;
  /** Date of the FX rate; null when AUD, or only a latest rate was cached. */
  fxDate: string | null;
  marketValueAud: number | null;
  parcels: ValuationParcel[];
  untrackedQuantity: number;
  flags: ValuationFlag[];
};

export type ValuationBroker = {
  broker: string;
  lines: ValuationLine[];
  costBaseAud: number;
  /** Sum of the lines that could be valued. */
  marketValueAud: number;
  /** Lines with no market value (see their flags). */
  unvalued: number;
};

export type Valuation = {
  asOf: string;
  brokers: ValuationBroker[];
  costBaseAud: number;
  marketValueAud: number;
  unvalued: number;
};

export type ValuationOptions = {
  asOf: string;
  priceSeries?: PriceSeriesMap;
  fx?: FxInput;
  lotOptions?: ComputeLotsOptions;
};

/** Custody a transaction sits in; transactions with neither field share one bucket. */
export function brokerOf(t: ParsedTransaction): string {
  return (t.broker || t.custody || "").trim() || "unspecified";
}

function groupByBroker(transactions: ParsedTransaction[]): Map<string, ParsedTransaction[]> {
  const groups = new Map<string, ParsedTransaction[]>();
  for (const t of transactions) {
    const key = brokerOf(t);
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }
  return groups;
}

/**
 * A split is a corporate action on the stock, not on one account — but a
 * hand-entered split row often names no broker. Share each such row out to
 * the brokers holding the stock just before it, in proportion to their
 * units, so each broker's parcels are split too. Split rows that do name a
 * broker are left with it. With no holder at the time, the row is kept as
 * is (and values nothing).
 */
function assignBrokerlessSplits(transactions: ParsedTransaction[]): ParsedTransaction[] {
  const floating = (t: ParsedTransaction) =>
    t.type === "split" && !(t.broker || t.custody || "").trim();
  const out = transactions.filter((t) => !floating(t));
  const splits = transactions
    .filter(floating)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.id ?? 0) - (b.id ?? 0));
  for (const s of splits) {
    const key = holdingPriceKey((s.exchange || "ASX").toUpperCase(), s.ticker.toUpperCase());
    const held = new Map<string, number>();
    for (const [broker, txs] of groupByBroker(out)) {
      // Same-day trades count before the split, as inferSplitEvents orders them.
      const before = txs.filter(
        (t) => t.date < s.date || (t.date === s.date && t.type !== "split"),
      );
      const h = computeHoldings(before, { prices: {} }).find(
        (x) => holdingPriceKey(x.exchange, x.ticker) === key,
      );
      if (h && h.quantity > 1e-9) held.set(broker, h.quantity);
    }
    const total = [...held.values()].reduce((a, b) => a + b, 0);
    if (!(total > 0)) {
      out.push(s);
      continue;
    }
    for (const [broker, units] of held) {
      out.push({ ...s, broker, custody: broker, quantity: s.quantity * (units / total) });
    }
  }
  return out;
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * What every holding was worth on `asOf`, broker by broker and stock by
 * stock, down to the parcel — the record to keep for a date like
 * 30 June 2027, when the CGT rules split every gain at the market value.
 *
 * Parcels are worked out per broker: a sell at one broker only ever
 * consumes that broker's parcels. Values reuse `computeHoldings`, so split
 * handling matches the Holdings screen; a parcel's share of a holding's
 * value is by quantity. Each line records which close (and FX rate) it used
 * and flags anything a tax record shouldn't silently rely on.
 */
export function valuationAsOf(
  transactions: ParsedTransaction[],
  opts: ValuationOptions,
): Valuation {
  const priceIndex = buildLastPriceIndex(opts.priceSeries ?? {});
  const fxIndex = buildLastFxIndex(opts.fx?.series ?? {});
  const flatFx = opts.fx?.rates ?? {};
  const fxRates = fxAsOf(opts.asOf, flatFx, fxIndex);

  const groups = groupByBroker(assignBrokerlessSplits(transactions));

  const brokers: ValuationBroker[] = [];
  for (const [broker, all] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...all].sort((a, b) => {
      const d = a.date.localeCompare(b.date);
      return d !== 0 ? d : (a.id ?? 0) - (b.id ?? 0);
    });
    const toDate = sorted.filter((t) => t.date <= opts.asOf);
    if (!toDate.length) continue;

    const { openLots } = computeLots(toDate, fxRates, opts.lotOptions);
    const holdings = computeHoldings(toDate, {
      prices: pricesAsOf(toDate, opts.asOf, priceIndex),
      fxRates,
      valuationAsOf: opts.asOf,
      // Splits from the whole ledger, so early dates line up with
      // split-adjusted historical closes.
      splitEvents: inferSplitEvents(sorted),
    });

    const lines: ValuationLine[] = [];
    for (const h of holdings) {
      if (!(h.quantity > 1e-9)) continue;
      const key = holdingPriceKey(h.exchange, h.ticker);
      const lots = openLots.filter((l) => holdingPriceKey(l.exchange, l.ticker) === key);
      const perUnitAud =
        h.marketValueAud != null && h.quantity > 0 ? h.marketValueAud / h.quantity : null;
      const parcels = lots.map((l) => ({
        acquiredDate: l.acquiredDate,
        quantity: l.quantity,
        costBaseAud: l.costBaseAud,
        marketValueAud: perUnitAud != null ? round2(perUnitAud * l.quantity) : null,
      }));
      const inParcels = lots.reduce((s, l) => s + l.quantity, 0);
      const untrackedQuantity = Math.max(0, Math.round((h.quantity - inParcels) * 1e6) / 1e6);

      const flags: ValuationFlag[] = [];
      const bar = priceBarAsOf(h.ticker, h.exchange, opts.asOf, priceIndex);
      if (h.marketValueAud == null || !bar) flags.push("no_price");
      else if (daysBetween(bar.date, opts.asOf) > STALE_PRICE_DAYS) flags.push("stale_price");

      let fxRate: number | null = null;
      let fxDate: string | null = null;
      if (h.currency.toUpperCase() !== "AUD") {
        const pair = fxYahooSymbol(h.currency);
        const dated = pair ? fxBarAsOf(pair, opts.asOf, fxIndex) : null;
        if (dated) {
          fxRate = dated.rate;
          fxDate = dated.date;
        } else if (pair && flatFx[pair] != null) {
          fxRate = flatFx[pair] ?? null;
          flags.push("fx_not_historical");
        } else {
          flags.push("no_fx");
        }
      }
      if (untrackedQuantity > 1e-6) flags.push("untracked_units");

      lines.push({
        ticker: h.ticker,
        exchange: h.exchange,
        currency: h.currency,
        quantity: h.quantity,
        costBaseAud: round2(parcels.reduce((s, p) => s + p.costBaseAud, 0)),
        unitValue: h.marketValue != null && h.quantity > 0 ? h.marketValue / h.quantity : null,
        priceDate: bar?.date ?? null,
        priceSymbol: bar?.symbol ?? null,
        fxRate,
        fxDate,
        marketValueAud: h.marketValueAud != null ? round2(h.marketValueAud) : null,
        parcels,
        untrackedQuantity,
        flags,
      });
    }
    if (!lines.length) continue;
    lines.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.exchange.localeCompare(b.exchange));
    brokers.push({
      broker,
      lines,
      costBaseAud: round2(lines.reduce((s, l) => s + l.costBaseAud, 0)),
      marketValueAud: round2(lines.reduce((s, l) => s + (l.marketValueAud ?? 0), 0)),
      unvalued: lines.filter((l) => l.marketValueAud == null).length,
    });
  }

  return {
    asOf: opts.asOf,
    brokers,
    costBaseAud: round2(brokers.reduce((s, b) => s + b.costBaseAud, 0)),
    marketValueAud: round2(brokers.reduce((s, b) => s + b.marketValueAud, 0)),
    unvalued: brokers.reduce((s, b) => s + b.unvalued, 0),
  };
}

/** A saved-or-previewed report: one valuation per portfolio, plus totals. */
export type ValuationReport = {
  asOf: string;
  generatedAt: string;
  portfolios: Array<{ id: number; name: string; valuation: Valuation }>;
  costBaseAud: number;
  marketValueAud: number;
  unvalued: number;
};

export function combineValuations(
  asOf: string,
  generatedAt: string,
  portfolios: ValuationReport["portfolios"],
): ValuationReport {
  const withHoldings = portfolios.filter((p) => p.valuation.brokers.length > 0);
  return {
    asOf,
    generatedAt,
    portfolios: withHoldings,
    costBaseAud: round2(withHoldings.reduce((s, p) => s + p.valuation.costBaseAud, 0)),
    marketValueAud: round2(withHoldings.reduce((s, p) => s + p.valuation.marketValueAud, 0)),
    unvalued: withHoldings.reduce((s, p) => s + p.valuation.unvalued, 0),
  };
}

function csvCell(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * One row per parcel (and one for any untracked units), with the line's
 * price, FX and flags repeated — ready to hand to an accountant.
 */
export function valuationReportToCsv(r: ValuationReport): string {
  const head = [
    "as_of",
    "portfolio",
    "broker",
    "ticker",
    "exchange",
    "currency",
    "units_held",
    "price_date",
    "unit_value_native",
    "fx_rate_foreign_per_aud",
    "fx_date",
    "holding_value_aud",
    "parcel_acquired",
    "parcel_units",
    "parcel_cost_aud",
    "parcel_value_aud",
    "flags",
  ];
  const rows: string[] = [head.join(",")];
  for (const p of r.portfolios) {
    for (const b of p.valuation.brokers) {
      for (const l of b.lines) {
        const common = [
          r.asOf,
          p.name,
          b.broker,
          l.ticker,
          l.exchange,
          l.currency,
          l.quantity,
          l.priceDate,
          l.unitValue != null ? Math.round(l.unitValue * 10_000) / 10_000 : null,
          l.fxRate,
          l.fxDate,
          l.marketValueAud,
        ];
        const flags = l.flags.join(" ");
        for (const parcel of l.parcels) {
          rows.push(
            [...common, parcel.acquiredDate, parcel.quantity, parcel.costBaseAud, parcel.marketValueAud, flags]
              .map(csvCell)
              .join(","),
          );
        }
        if (l.untrackedQuantity > 0) {
          const unitAud =
            l.marketValueAud != null && l.quantity > 0 ? l.marketValueAud / l.quantity : null;
          rows.push(
            [
              ...common,
              "untracked",
              l.untrackedQuantity,
              null,
              unitAud != null ? round2(unitAud * l.untrackedQuantity) : null,
              flags,
            ]
              .map(csvCell)
              .join(","),
          );
        }
      }
    }
  }
  return `${rows.join("\n")}\n`;
}
