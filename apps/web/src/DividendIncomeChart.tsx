/**
 * DividendIncomeChart — total assessable dividend income per AU financial
 * year (AUD). A cash-vs-DRP split was considered, but most real DRP rows
 * (SelfWealth/Stake-style imports) carry no disclosed reinvestment amount —
 * `price`/`amount` are null by design (the paired dividend_cash row is the
 * real income source) — so a $ split reads as "always ~$0 DRP" regardless
 * of the ledger. Single series: one hue, no legend needed.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { type Filters, fetchIncome, type IncomeFyTotal } from "./api";

const COLOR_BAR = "#3987e5"; // sequential/single default hue (blue, dark)

type Props = {
  filters?: Filters;
  className?: string;
  reloadToken?: number | string;
};

function money(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  });
}

function compactMoney(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.round(n));
}

function IncomeTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number | null }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const total = payload.find((p) => p.dataKey === "amountAud")?.value;
  return (
    <div className="rounded-lg border border-zinc-600 bg-zinc-900/95 px-3 py-2 text-xs shadow-lg">
      <div className="mb-1.5 font-medium text-zinc-100">{label}</div>
      <div className="flex justify-between gap-6 text-zinc-300">
        <span className="text-zinc-400">Dividend income</span>
        <span className="font-medium text-zinc-100">{money(total)}</span>
      </div>
    </div>
  );
}

export default function DividendIncomeChart({ filters = {}, className, reloadToken = 0 }: Props) {
  const [rows, setRows] = useState<IncomeFyTotal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchIncome(filters)
      .then((res) => {
        if (!cancelled) setRows(res.fyTotals);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters.portfolioId, filters.broker, filters.source, reloadToken]);

  const data = useMemo(
    () =>
      [...rows]
        .sort((a, b) => a.financialYear.localeCompare(b.financialYear))
        .map((r) => ({
          financialYear: r.financialYear,
          amountAud: r.amountAud ?? 0,
        })),
    [rows],
  );
  const hasData = data.some((r) => r.amountAud > 0);

  return (
    <section
      className={
        className ??
        "rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
      }
    >
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
          Dividend income
        </h2>
        <p className="text-xs text-zinc-500">
          Total assessable dividend income (cash + DRP) by financial year
        </p>
      </div>

      {loading && <p className="text-xs text-zinc-500">Loading…</p>}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {!loading && !error && !hasData && (
        <p className="text-xs text-zinc-500">No dividend income yet.</p>
      )}

      {!loading && hasData && (
        <div className="h-64 w-full min-h-[16rem]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="none" stroke="#3f3f46" opacity={0.5} vertical={false} />
              <XAxis
                dataKey="financialYear"
                tick={{ fill: "#a1a1aa", fontSize: 10 }}
                tickLine={false}
                axisLine={{ stroke: "#52525b" }}
              />
              <YAxis
                tick={{ fill: "#a1a1aa", fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={compactMoney}
                width={48}
              />
              <Tooltip content={<IncomeTooltip />} cursor={{ fill: "#3f3f46", opacity: 0.15 }} />
              <Bar
                dataKey="amountAud"
                name="Dividend income"
                fill={COLOR_BAR}
                radius={[4, 4, 0, 0]}
                maxBarSize={32}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
