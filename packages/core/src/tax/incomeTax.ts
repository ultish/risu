/**
 * Simplified tax on cash dividends for an Australian resident.
 *
 * ## AU franked dividends
 * Company tax rate assumed **30%** (not base-rate entity).
 * - frankingCredits = cash × (frankingPercent/100) × (0.30 / 0.70)
 * - assessableIncome = cash + frankingCredits
 * - tax = assessableIncome × (MTR + Medicare) − frankingCredits
 *   (refundable credit if negative is allowed as negative tax / refund)
 *
 * ## Unfranked / foreign
 * - frankingPercent = 0 (or omit)
 * - assessable = cash; tax = cash × (MTR + Medicare)
 * - Optional foreign withholding: use `applyForeignWithholding` then pass
 *   **gross** cash into `estimateDividendTax` for assessable income.
 *   This is **not** the ATO foreign income tax offset engine — estimate only.
 *
 * ## Ledger vs withholding
 * Broker imports often credit **net** cash after US withholding (e.g. 15%
 * under the AU–US treaty with W-8BEN). Toggle `ledgerIsNet` when grossing up.
 *
 * Estimates only — not a full ATO income schedule.
 */

import { combinedMarginalRate, type TaxProfile } from "./types.js";

/** Corporate tax rate used for franking gross-up (simplified). */
export const COMPANY_TAX_RATE = 0.3;

/**
 * Default US dividend withholding rate for an AU resident after W-8BEN
 * (AU–US treaty). Decimal 0–1. User-editable in the UI.
 */
export const DEFAULT_US_WITHHOLDING_RATE = 0.15;

/** Default franking % assumption for ASX cash dividends when unknown. */
export const DEFAULT_ASX_FRANKING_PERCENT = 70;

export type DividendTaxInput = {
  /** Cash dividend received (AUD) — prefer gross of foreign withholding */
  cashAud: number;
  /**
   * Franking percentage 0–100. 100 = fully franked at COMPANY_TAX_RATE.
   * Omit or 0 for unfranked / foreign.
   */
  frankingPercent?: number | null;
  profile: TaxProfile;
};

export type DividendTaxResult = {
  cashAud: number;
  frankingCredits: number;
  assessableIncome: number;
  /** Gross tax before franking offset */
  grossTax: number;
  /** Net tax after franking offset (can be negative = refund) */
  netTax: number;
  notes: string[];
};

export type ForeignWithholdingResult = {
  /** Gross dividend before withholding (AUD) */
  gross: number;
  /** Estimated amount withheld (AUD) */
  withheld: number;
  /** Net cash after withholding (AUD) */
  netCash: number;
  /** Rate applied (0–1) */
  rate: number;
};

/**
 * True when the line is treated as foreign for withholding purposes:
 * not ASX and not AUD-denominated.
 */
export function isForeignDividendLine(
  exchange: string,
  currency: string,
): boolean {
  const ex = (exchange || "").toUpperCase();
  const ccy = (currency || "").toUpperCase();
  return ex !== "ASX" && ccy !== "AUD";
}

/** True when franking may apply (ASX listings). */
export function isAsxDividendLine(exchange: string): boolean {
  return (exchange || "").toUpperCase() === "ASX";
}

/**
 * Apply or reverse a simple foreign withholding rate on cash (AUD).
 *
 * - `ledgerIsNet === true` (common for broker imports): `cashAud` is net →
 *   gross up: gross = net / (1 − r), withheld = gross − net.
 * - `ledgerIsNet === false`: `cashAud` is gross → withheld = gross × r,
 *   net = gross × (1 − r).
 *
 * Rate is a decimal 0–1 (e.g. 0.15 for 15%). Clamped to [0, 0.99] so
 * gross-up stays finite. Rate 0 or cash ≤ 0 → identity (gross = net = cash).
 *
 * Does **not** model treaty forms, QI brokers, or FITO credits.
 */
export function applyForeignWithholding(
  cashAud: number,
  withholdingRate: number,
  ledgerIsNet = false,
): ForeignWithholdingResult {
  const cash = Math.max(0, cashAud);
  const rate = clamp(withholdingRate, 0, 0.99);

  if (cash === 0 || rate === 0) {
    return { gross: round2(cash), withheld: 0, netCash: round2(cash), rate };
  }

  if (ledgerIsNet) {
    const gross = cash / (1 - rate);
    const withheld = gross - cash;
    return {
      gross: round2(gross),
      withheld: round2(withheld),
      netCash: round2(cash),
      rate,
    };
  }

  const withheld = cash * rate;
  const netCash = cash - withheld;
  return {
    gross: round2(cash),
    withheld: round2(withheld),
    netCash: round2(netCash),
    rate,
  };
}

/**
 * Estimate tax on a single cash dividend (or total cash for a period).
 */
export function estimateDividendTax(input: DividendTaxInput): DividendTaxResult {
  const cash = Math.max(0, input.cashAud);
  const frankingPct = clamp(
    input.frankingPercent == null ? 0 : input.frankingPercent,
    0,
    100,
  );
  const mtr = combinedMarginalRate(input.profile);
  const notes: string[] = ["Model estimate only — not ATO calculation."];

  let frankingCredits = 0;
  if (frankingPct > 0) {
    // Fully franked $1 cash → credit = 1 * 30/70; scale by franking %
    frankingCredits = round2(
      cash * (frankingPct / 100) * (COMPANY_TAX_RATE / (1 - COMPANY_TAX_RATE)),
    );
    notes.push(
      `Franking ${frankingPct}% at company tax ${(COMPANY_TAX_RATE * 100).toFixed(0)}%.`,
    );
  } else {
    notes.push("Unfranked / no franking credits.");
  }

  const assessableIncome = round2(cash + frankingCredits);
  const grossTax = round2(assessableIncome * mtr);
  const netTax = round2(grossTax - frankingCredits);

  return {
    cashAud: round2(cash),
    frankingCredits,
    assessableIncome,
    grossTax,
    netTax,
    notes,
  };
}

/**
 * Aggregate several cash dividend lines (e.g. FY summary).
 */
export function estimateDividendTaxBatch(
  lines: Array<{ cashAud: number; frankingPercent?: number | null }>,
  profile: TaxProfile,
): DividendTaxResult {
  let cashAud = 0;
  let frankingCredits = 0;
  for (const line of lines) {
    const r = estimateDividendTax({ ...line, profile });
    cashAud += r.cashAud;
    frankingCredits += r.frankingCredits;
  }
  const mtr = combinedMarginalRate(profile);
  cashAud = round2(cashAud);
  frankingCredits = round2(frankingCredits);
  const assessableIncome = round2(cashAud + frankingCredits);
  const grossTax = round2(assessableIncome * mtr);
  const netTax = round2(grossTax - frankingCredits);
  return {
    cashAud,
    frankingCredits,
    assessableIncome,
    grossTax,
    netTax,
    notes: [
      `Aggregated ${lines.length} dividend line(s). Model estimate only.`,
    ],
  };
}

// ─── FY rollup from income summary lines ────────────────────────────────────

export type FyDividendTaxLineInput = {
  financialYear: string;
  exchange: string;
  currency: string;
  /** Ledger cash in AUD (null if FX missing) */
  amountAud: number | null;
};

export type FyTaxEstimateOptions = {
  profile: TaxProfile;
  /**
   * Assumed franking % 0–100 for ASX lines only (default 70).
   * Foreign / non-ASX always 0.
   */
  asxFrankingPercent?: number;
  /**
   * Foreign withholding rate as decimal 0–1 (default 0.15).
   * Applied only to foreign (non-ASX, non-AUD) lines.
   */
  usWithholdingRate?: number;
  /**
   * When true (default), foreign ledger cash is treated as **net** of
   * withholding and is grossed up for assessable income.
   */
  ledgerIsNetOfWithholding?: boolean;
};

export type FyTaxEstimateRow = {
  financialYear: string;
  /** Sum of ledger cash AUD (as imported / converted) */
  cashAud: number;
  /**
   * Cash used for tax assessable base: ledger for domestic; gross of
   * withholding for foreign when derivable.
   */
  assessableCashAud: number;
  frankingCredits: number;
  assessableIncome: number;
  grossTax: number;
  /** Net tax after franking offset (can be negative) */
  netTax: number;
  /** Estimated foreign withholding (AUD) on foreign lines */
  withheldEstimate: number;
};

export type FyTaxEstimateSummary = {
  byFy: FyTaxEstimateRow[];
  totals: {
    cashAud: number;
    assessableCashAud: number;
    frankingCredits: number;
    assessableIncome: number;
    grossTax: number;
    netTax: number;
    withheldEstimate: number;
  };
  notes: string[];
};

/**
 * Estimate dividend income tax by Australian FY from income-summary lines.
 *
 * - ASX lines: franking at `asxFrankingPercent` (default 70%); no withholding.
 * - Foreign (non-ASX & non-AUD): franking 0; optional withholding gross-up so
 *   assessable cash is gross (ATO typically wants gross foreign dividends).
 * - Lines with null `amountAud` are skipped.
 *
 * Not a full tax return — no FITO, no other income, no offsets beyond franking.
 */
export function estimateFyDividendTax(
  lines: FyDividendTaxLineInput[],
  options: FyTaxEstimateOptions,
): FyTaxEstimateSummary {
  const asxFranking = clamp(
    options.asxFrankingPercent ?? DEFAULT_ASX_FRANKING_PERCENT,
    0,
    100,
  );
  const whRate =
    options.usWithholdingRate ?? DEFAULT_US_WITHHOLDING_RATE;
  const ledgerIsNet = options.ledgerIsNetOfWithholding !== false;
  const profile = options.profile;

  type Acc = {
    financialYear: string;
    cashAud: number;
    assessableCashAud: number;
    frankingCredits: number;
    withheldEstimate: number;
  };

  const fyMap = new Map<string, Acc>();

  for (const line of lines) {
    if (line.amountAud == null || !Number.isFinite(line.amountAud)) continue;
    const ledger = Math.max(0, line.amountAud);
    if (ledger === 0) continue;

    const fy = line.financialYear;
    const acc = fyMap.get(fy) ?? {
      financialYear: fy,
      cashAud: 0,
      assessableCashAud: 0,
      frankingCredits: 0,
      withheldEstimate: 0,
    };

    acc.cashAud += ledger;

    if (isForeignDividendLine(line.exchange, line.currency)) {
      const wh = applyForeignWithholding(ledger, whRate, ledgerIsNet);
      // ATO assessable base ≈ gross foreign dividend
      acc.assessableCashAud += wh.gross;
      acc.withheldEstimate += wh.withheld;
      // franking 0 — no credits added
    } else {
      const frankingPct = isAsxDividendLine(line.exchange) ? asxFranking : 0;
      const tax = estimateDividendTax({
        cashAud: ledger,
        frankingPercent: frankingPct,
        profile,
      });
      acc.assessableCashAud += tax.cashAud;
      acc.frankingCredits += tax.frankingCredits;
    }

    fyMap.set(fy, acc);
  }

  // Foreign lines need tax applied after aggregation (franking already rolled
  // for domestic; apply MTR on foreign assessable cash without franking).
  // Simpler: recompute net tax from totals per FY using batch on virtual lines.
  const byFy: FyTaxEstimateRow[] = [...fyMap.values()]
    .map((acc) => {
      // Reconstruct: domestic portion has franking credits already;
      // total assessable income = assessableCash + frankingCredits
      const cashAud = round2(acc.cashAud);
      const assessableCashAud = round2(acc.assessableCashAud);
      const frankingCredits = round2(acc.frankingCredits);
      const assessableIncome = round2(assessableCashAud + frankingCredits);
      const mtr = combinedMarginalRate(profile);
      const grossTax = round2(assessableIncome * mtr);
      const netTax = round2(grossTax - frankingCredits);
      return {
        financialYear: acc.financialYear,
        cashAud,
        assessableCashAud,
        frankingCredits,
        assessableIncome,
        grossTax,
        netTax,
        withheldEstimate: round2(acc.withheldEstimate),
      };
    })
    .sort((a, b) => b.financialYear.localeCompare(a.financialYear));

  const totals = {
    cashAud: 0,
    assessableCashAud: 0,
    frankingCredits: 0,
    assessableIncome: 0,
    grossTax: 0,
    netTax: 0,
    withheldEstimate: 0,
  };
  for (const row of byFy) {
    totals.cashAud += row.cashAud;
    totals.assessableCashAud += row.assessableCashAud;
    totals.frankingCredits += row.frankingCredits;
    totals.assessableIncome += row.assessableIncome;
    totals.grossTax += row.grossTax;
    totals.netTax += row.netTax;
    totals.withheldEstimate += row.withheldEstimate;
  }
  for (const k of Object.keys(totals) as Array<keyof typeof totals>) {
    totals[k] = round2(totals[k]);
  }

  const notes = [
    "Estimates only — not ATO software or a foreign income tax offset calculation.",
    `ASX franking assumption ${asxFranking}%; foreign franking 0%.`,
    `Foreign withholding assumption ${(clamp(whRate, 0, 0.99) * 100).toFixed(1)}%` +
      (ledgerIsNet
        ? " (ledger treated as net; grossed up for assessable)."
        : " (ledger treated as gross)."),
  ];

  return { byFy, totals, notes };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
