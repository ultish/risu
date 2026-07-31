/**
 * AllocationChart — where your portfolio's value sits, ranked by ticker.
 * Horizontal bar (not a pie): a pie/donut is explicitly the wrong form once
 * there are more than a handful of similar-sized slices (dataviz skill,
 * choosing-a-form.md / anti-patterns.md), and a real portfolio easily has
 * 10+ holdings. Magnitude comparison → one hue, bar length carries the
 * value; the long tail folds into "Other" rather than adding more colors.
 */
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Holding } from "./api";

const COLOR_BAR = "#3987e5"; // sequential/single default hue (blue, dark)
const COLOR_OTHER = "#71717a"; // zinc-500 — de-emphasised, not an identity color

const MAX_ROWS = 10;

type Row = {
  label: string;
  valueAud: number;
  pct: number;
  isOther: boolean;
};

function money(n: number) {
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

function AllocationTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: Row }>;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="rounded-lg border border-zinc-600 bg-zinc-900/95 px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium text-zinc-100">{row.label}</div>
      <div className="flex justify-between gap-6 text-zinc-300">
        <span className="text-zinc-400">Value</span>
        <span className="font-medium text-zinc-100">{money(row.valueAud)}</span>
      </div>
      <div className="flex justify-between gap-6 text-zinc-300">
        <span className="text-zinc-400">% of portfolio</span>
        <span className="font-medium text-zinc-100">{row.pct.toFixed(1)}%</span>
      </div>
    </div>
  );
}

export default function AllocationChart({
  holdings,
  className,
}: {
  holdings: Holding[];
  className?: string;
}) {
  const { rows, total } = useMemo(() => {
    const priced = holdings
      .map((h) => ({
        label: h.ticker,
        valueAud: h.marketValueAud ?? h.costBaseAud ?? 0,
      }))
      .filter((h) => h.valueAud > 0)
      .sort((a, b) => b.valueAud - a.valueAud);

    const total = priced.reduce((s, h) => s + h.valueAud, 0);
    if (total <= 0) return { rows: [] as Row[], total: 0 };

    const top = priced.slice(0, MAX_ROWS);
    const rest = priced.slice(MAX_ROWS);
    const restTotal = rest.reduce((s, h) => s + h.valueAud, 0);

    const rows: Row[] = top.map((h) => ({
      label: h.label,
      valueAud: h.valueAud,
      pct: (h.valueAud / total) * 100,
      isOther: false,
    }));
    if (restTotal > 0) {
      rows.push({
        label: `Other (${rest.length})`,
        valueAud: restTotal,
        pct: (restTotal / total) * 100,
        isOther: true,
      });
    }
    // Recharts renders a vertical category axis top-to-bottom in array
    // order, so the already-descending-by-value order puts the largest
    // holding at the top as-is.
    return { rows, total };
  }, [holdings]);

  const rowHeight = 28;
  const chartHeight = Math.max(120, rows.length * rowHeight + 24);

  return (
    <section
      className={
        className ??
        "rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
      }
    >
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
          Allocation
        </h2>
        <p className="text-xs text-zinc-500">
          Market value by ticker (AUD) · top {MAX_ROWS}, rest folded into
          “Other”
        </p>
      </div>

      {rows.length === 0 && (
        <p className="text-xs text-zinc-500">No priced holdings yet.</p>
      )}

      {rows.length > 0 && (
        <div style={{ height: chartHeight }} className="w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={rows}
              layout="vertical"
              margin={{ top: 4, right: 48, left: 4, bottom: 0 }}
              barCategoryGap={6}
            >
              <CartesianGrid strokeDasharray="none" stroke="#3f3f46" opacity={0.4} horizontal={false} />
              <XAxis
                type="number"
                tick={{ fill: "#a1a1aa", fontSize: 10 }}
                tickLine={false}
                axisLine={{ stroke: "#52525b" }}
                tickFormatter={compactMoney}
              />
              <YAxis
                type="category"
                dataKey="label"
                tick={{ fill: "#d4d4d8", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={80}
              />
              <Tooltip content={<AllocationTooltip />} cursor={{ fill: "#3f3f46", opacity: 0.15 }} />
              <Bar dataKey="valueAud" radius={[0, 4, 4, 0]} maxBarSize={20}>
                {rows.map((r) => (
                  <Cell key={r.label} fill={r.isOther ? COLOR_OTHER : COLOR_BAR} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {total > 0 && (
        <p className="mt-2 text-xs text-zinc-500">
          Total priced value: <span className="text-zinc-300">{money(total)}</span>
        </p>
      )}
    </section>
  );
}
