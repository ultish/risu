/**
 * Nominal (tax-agnostic) realised + unrealised gains by AU financial year —
 * for the "how has my gain trended" chart. Unlike `tax/realisedCgt.ts` this
 * has no regime/indexation/tax-profile dependency: just proceeds − cost base
 * per disposal, and mark-to-market − cost base at each FY's last available
 * snapshot.
 */
import { auFinancialYear } from "./income.js";
import { computeLots, type RecordedParcelTake } from "./lots.js";
import type { PerformancePoint } from "./performance.js";
import type { ParsedTransaction } from "./types.js";

export type RealisedGainFyTotal = {
  financialYear: string;
  capitalGain: number;
  disposalCount: number;
};

/** Sum of (proceeds − cost base) across FIFO-matched disposals, by FY. */
export function summarizeRealisedGains(
  transactions: ParsedTransaction[],
  fxRates: Record<string, number | null | undefined> = {},
  opts?: {
    recordedTakes?: RecordedParcelTake[];
    platformFifoBrokers?: string[];
  },
): RealisedGainFyTotal[] {
  const { disposals } = computeLots(transactions, fxRates, {
    recordedTakes: opts?.recordedTakes,
    platformFifoBrokers: opts?.platformFifoBrokers,
  });
  const byFy = new Map<string, RealisedGainFyTotal>();
  for (const d of disposals) {
    const fy = auFinancialYear(d.disposedDate);
    const cur = byFy.get(fy) ?? { financialYear: fy, capitalGain: 0, disposalCount: 0 };
    cur.capitalGain += d.proceedsAud - d.costBaseAud;
    cur.disposalCount += 1;
    byFy.set(fy, cur);
  }
  return [...byFy.values()]
    .map((t) => ({ ...t, capitalGain: round2(t.capitalGain) }))
    .sort((a, b) => a.financialYear.localeCompare(b.financialYear));
}

export type FyEndSnapshot = {
  financialYear: string;
  /** Date of the latest performance point within this FY (FY-end once the FY has closed; "as of now" for the current FY). */
  asOfDate: string;
  costBaseAud: number | null;
  marketValueAud: number | null;
  unrealisedGainAud: number | null;
};

/**
 * The last performance point dated within each FY — FY-end mark-to-market
 * for a closed FY, or "as of now" for the FY still in progress. No `today`
 * parameter needed: the data's own dates determine which FY is still open.
 */
export function summarizeFyEndSnapshots(
  points: PerformancePoint[],
): FyEndSnapshot[] {
  const byFy = new Map<string, PerformancePoint>();
  for (const p of points) {
    const fy = auFinancialYear(p.date);
    const existing = byFy.get(fy);
    if (!existing || p.date > existing.date) byFy.set(fy, p);
  }
  return [...byFy.entries()]
    .map(([fy, p]) => ({
      financialYear: fy,
      asOfDate: p.date,
      costBaseAud: p.costBaseAud,
      marketValueAud: p.marketValueAud,
      unrealisedGainAud:
        p.costBaseAud != null && p.marketValueAud != null
          ? round2(p.marketValueAud - p.costBaseAud)
          : null,
    }))
    .sort((a, b) => a.financialYear.localeCompare(b.financialYear));
}

export type GainsByFy = {
  financialYear: string;
  realisedGainAud: number;
  unrealisedGainAud: number | null;
};

/** Zip realised + FY-end-snapshot rows into one series for a combined chart. */
export function combineGainsByFy(
  realised: RealisedGainFyTotal[],
  snapshots: FyEndSnapshot[],
): GainsByFy[] {
  const fys = new Set<string>();
  for (const r of realised) fys.add(r.financialYear);
  for (const s of snapshots) fys.add(s.financialYear);
  return [...fys]
    .map((fy) => ({
      financialYear: fy,
      realisedGainAud: realised.find((r) => r.financialYear === fy)?.capitalGain ?? 0,
      unrealisedGainAud:
        snapshots.find((s) => s.financialYear === fy)?.unrealisedGainAud ?? null,
    }))
    .sort((a, b) => a.financialYear.localeCompare(b.financialYear));
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
