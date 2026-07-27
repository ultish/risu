/**
 * PerformanceChart — monthly cost vs market value (AUD) via Recharts.
 *
 * Wire into App.tsx:
 *   import PerformanceChart from "./PerformanceChart";
 *   <PerformanceChart filters={{ portfolioId, broker, source }} />
 */
import { useEffect, useMemo, useState } from "react";
import {
  Brush,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { type Filters, fetchPerformance, type PerformancePoint } from "./api";

type Props = {
  filters?: Filters;
  className?: string;
  /** Bump after price refresh so the chart reloads price_cache */
  reloadToken?: number | string;
};

type ChartRow = {
  date: string;
  label: string;
  cost: number | null;
  value: number | null;
  gap: number | null;
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

function toRows(points: PerformancePoint[]): ChartRow[] {
  return points.map((p) => {
    const cost = p.costBaseAud;
    const value = p.marketValueAud;
    return {
      date: p.date,
      label: p.date.slice(0, 7),
      cost: cost != null && !Number.isNaN(cost) ? cost : null,
      value: value != null && !Number.isNaN(value) ? value : null,
      gap:
        cost != null &&
        value != null &&
        !Number.isNaN(cost) &&
        !Number.isNaN(value)
          ? value - cost
          : null,
    };
  });
}

function PerformanceTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number | null; color?: string; name?: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0] as
    | { payload?: ChartRow }
    | undefined;
  const full = row?.payload;
  const cost = full?.cost ?? null;
  const value = full?.value ?? null;
  const gap = full?.gap ?? null;

  return (
    <div className="rounded-lg border border-zinc-600 bg-zinc-900/95 px-3 py-2 text-xs shadow-lg">
      <div className="mb-1.5 font-medium text-zinc-100">
        {full?.date ?? label}
      </div>
      <div className="space-y-0.5 text-zinc-300">
        <div className="flex justify-between gap-6">
          <span className="text-zinc-400">Cost base</span>
          <span className="font-medium text-zinc-100">{money(cost)}</span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="text-zinc-400">Market value</span>
          <span className="font-medium text-emerald-400">{money(value)}</span>
        </div>
        {gap != null && (
          <div className="flex justify-between gap-6 border-t border-zinc-700 pt-1 mt-1">
            <span className="text-zinc-400">Gap (value − cost)</span>
            <span
              className={
                gap >= 0
                  ? "font-medium text-emerald-300"
                  : "font-medium text-red-300"
              }
            >
              {gap >= 0 ? "+" : ""}
              {money(gap)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function PerformanceChart({
  filters = {},
  className,
  reloadToken = 0,
}: Props) {
  const [points, setPoints] = useState<PerformancePoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchPerformance(filters)
      .then((res) => {
        if (!cancelled) setPoints(res.points);
      })
      .catch((e) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    filters.portfolioId,
    filters.broker,
    filters.source,
    reloadToken,
  ]);

  const data = useMemo(() => toRows(points), [points]);
  const last = points.length ? points[points.length - 1] : null;

  const brushStart = data.length > 24 ? Math.max(0, data.length - 36) : 0;

  return (
    <section
      className={
        className ??
        "rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
      }
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
            Performance (AUD)
          </h2>
          <p className="text-xs text-zinc-500">
            Month-end cost base vs market value · hover for details · drag the
            brush to zoom
          </p>
        </div>
        {last && (
          <div className="flex gap-4 text-xs text-zinc-600 dark:text-zinc-300">
            <span>
              Cost{" "}
              <strong className="text-zinc-800 dark:text-zinc-100">
                {money(last.costBaseAud)}
              </strong>
            </span>
            <span>
              Value{" "}
              <strong className="text-emerald-700 dark:text-emerald-400">
                {money(last.marketValueAud)}
              </strong>
            </span>
          </div>
        )}
      </div>

      {loading && (
        <p className="text-xs text-zinc-500">Loading performance…</p>
      )}
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
      {!loading && !error && points.length === 0 && (
        <p className="text-xs text-zinc-500">
          No transactions yet — import a ledger to see cost vs value over time.
        </p>
      )}
      {!loading && !error && points.length > 0 && !last?.marketValueAud && (
        <p className="mb-2 text-xs text-amber-700 dark:text-amber-300/90">
          Cost base is available, but market value needs price history. Refresh
          prices again (US: Nasdaq history; ASX: latest quote as of today). Full
          multi-year ASX history still needs Yahoo when unbanned.
        </p>
      )}
      {!loading && data.length > 0 && (
        <div className="h-64 w-full min-h-[16rem]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{ top: 8, right: 12, left: 4, bottom: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="#3f3f46"
                opacity={0.5}
              />
              <XAxis
                dataKey="label"
                tick={{ fill: "#a1a1aa", fontSize: 10 }}
                tickLine={false}
                axisLine={{ stroke: "#52525b" }}
                minTickGap={28}
              />
              <YAxis
                tick={{ fill: "#a1a1aa", fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={compactMoney}
                width={48}
              />
              <Tooltip
                content={<PerformanceTooltip />}
                cursor={{ stroke: "#71717a", strokeDasharray: "4 4" }}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, color: "#a1a1aa" }}
                iconType="line"
              />
              <Line
                type="monotone"
                dataKey="cost"
                name="Cost base"
                stroke="#a1a1aa"
                strokeWidth={2}
                dot={false}
                connectNulls
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="value"
                name="Market value"
                stroke="#10b981"
                strokeWidth={2.5}
                dot={false}
                connectNulls={false}
                activeDot={{ r: 4, fill: "#34d399" }}
              />
              <Brush
                dataKey="label"
                height={28}
                stroke="#52525b"
                fill="#18181b"
                travellerWidth={8}
                startIndex={brushStart}
                endIndex={data.length - 1}
                tickFormatter={(v) => String(v)}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
