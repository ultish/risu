/**
 * GainsChart — realised vs unrealised gain per AU financial year (AUD).
 * Realised: proceeds − FIFO cost base on actual sells. Unrealised: current
 * mark-to-market − cost base at each FY's last available snapshot. Nominal,
 * tax-agnostic (see GainsByFy in @yields/core) — for "how much of my return
 * is locked in" at a glance, not a tax figure.
 *
 * Grouped (not stacked) bars: the two are different kinds of gain, not
 * parts of one whole. Dark-mode categorical slots 1/2 from the validated
 * default order (blue/orange) — see dataviz skill palette.md.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { type Filters, fetchGainsByFy, type GainsByFyRow } from "./api";

const COLOR_REALISED = "#3987e5"; // categorical slot 1 (blue, dark)
const COLOR_UNREALISED = "#d95926"; // categorical slot 2 (orange, dark)

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
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(0)}k`;
  return `${sign}${Math.round(abs)}`;
}

function GainsTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number | null }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const realised = payload.find((p) => p.dataKey === "realisedGainAud")?.value;
  const unrealised = payload.find((p) => p.dataKey === "unrealisedGainAud")?.value;
  return (
    <div className="rounded-lg border border-zinc-600 bg-zinc-900/95 px-3 py-2 text-xs shadow-lg">
      <div className="mb-1.5 font-medium text-zinc-100">{label}</div>
      <div className="space-y-0.5 text-zinc-300">
        <div className="flex justify-between gap-6">
          <span className="text-zinc-400">Realised gain</span>
          <span className="font-medium" style={{ color: COLOR_REALISED }}>
            {money(realised)}
          </span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="text-zinc-400">Unrealised gain</span>
          <span className="font-medium" style={{ color: COLOR_UNREALISED }}>
            {unrealised == null ? "—" : money(unrealised)}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function GainsChart({ filters = {}, className, reloadToken = 0 }: Props) {
  const [rows, setRows] = useState<GainsByFyRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchGainsByFy(filters)
      .then((res) => {
        if (!cancelled) setRows(res.byFy);
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

  const data = useMemo(() => [...rows].sort((a, b) => a.financialYear.localeCompare(b.financialYear)), [rows]);
  const hasAnyGain = data.some((r) => r.realisedGainAud !== 0 || r.unrealisedGainAud != null);

  return (
    <section
      className={
        className ??
        "rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
      }
    >
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
          Realised vs unrealised gain
        </h2>
        <p className="text-xs text-zinc-500">
          By financial year · realised = actual sells (FIFO cost base) ·
          unrealised = paper gain as at FY end (or now, for the current FY)
        </p>
      </div>

      {loading && <p className="text-xs text-zinc-500">Loading…</p>}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {!loading && !error && !hasAnyGain && (
        <p className="text-xs text-zinc-500">No gains to show yet.</p>
      )}

      {!loading && hasAnyGain && (
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
                width={52}
              />
              <ReferenceLine y={0} stroke="#52525b" strokeWidth={1} />
              <Tooltip content={<GainsTooltip />} cursor={{ fill: "#3f3f46", opacity: 0.15 }} />
              <Legend wrapperStyle={{ fontSize: 11, color: "#a1a1aa" }} iconType="square" />
              <Bar
                dataKey="realisedGainAud"
                name="Realised"
                fill={COLOR_REALISED}
                radius={[4, 4, 0, 0]}
                maxBarSize={24}
              />
              <Bar
                dataKey="unrealisedGainAud"
                name="Unrealised"
                fill={COLOR_UNREALISED}
                radius={[4, 4, 0, 0]}
                maxBarSize={24}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
