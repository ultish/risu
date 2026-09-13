/**
 * Disclaimer — always-visible estimates notice (Phase 3/4).
 *
 * Wire-up in App.tsx:
 *
 *   import { Disclaimer } from "./Disclaimer";
 *
 *   // near footer / below planner & tax panels:
 *   <Disclaimer />
 *   // or compact:
 *   <Disclaimer compact />
 */

const DEFAULT_TEXT =
  "Estimates only — not financial, tax, or investment advice. CGT uses per-parcel cost base and simplified pre/post 1 Jul 2027 regimes. Not ATO software. You remain responsible for your own tax and investment decisions.";

export type DisclaimerProps = {
  /** Shorter one-line style */
  compact?: boolean;
  /** Override default copy */
  text?: string;
  className?: string;
};

export function Disclaimer({
  compact = false,
  text = DEFAULT_TEXT,
  className = "",
}: DisclaimerProps) {
  if (compact) {
    return (
      <p
        className={`text-center text-xs text-amber-200/80 ${className}`.trim()}
        role="note"
      >
        {text}
      </p>
    );
  }

  return (
    <aside
      className={`rounded-xl border border-amber-900/40 bg-amber-950/25 px-4 py-3 text-xs leading-relaxed text-amber-100/90 ${className}`.trim()}
      role="note"
    >
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-400/90">
        Disclaimer
      </p>
      <p>{text}</p>
    </aside>
  );
}

export const DISCLAIMER_TEXT = DEFAULT_TEXT;
