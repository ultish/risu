/**
 * PerformanceChart — monthly cost vs market value (AUD).
 *
 * Wire into App.tsx:
 *   import PerformanceChart from "./PerformanceChart";
 *   // in holdings tab / filters:
 *   <PerformanceChart filters={{ portfolioId, broker, source }} />
 */
import { useEffect, useMemo, useState } from "react";
import { type Filters, fetchPerformance, type PerformancePoint } from "./api";

type Props = {
  filters?: Filters;
  className?: string;
};

function money(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  });
}

export default function PerformanceChart({ filters = {}, className }: Props) {
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
  ]);

  const chart = useMemo(() => buildSvg(points), [points]);

  const last = points.length ? points[points.length - 1] : null;

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
            Month-end cost base vs market value
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
      {!loading && points.length > 0 && (
        <div className="w-full overflow-x-auto">
          <svg
            viewBox={`0 0 ${chart.width} ${chart.height}`}
            className="h-48 w-full max-w-full"
            role="img"
            aria-label="Portfolio cost base and market value over time"
          >
            {/* grid */}
            {chart.gridYs.map((y, i) => (
              <line
                key={`g${i}`}
                x1={chart.padL}
                x2={chart.width - chart.padR}
                y1={y}
                y2={y}
                stroke="currentColor"
                className="text-zinc-200 dark:text-zinc-700"
                strokeWidth={1}
              />
            ))}
            {/* cost base */}
            <polyline
              fill="none"
              stroke="#71717a"
              strokeWidth={2}
              points={chart.costLine}
            />
            {/* market value */}
            <polyline
              fill="none"
              stroke="#059669"
              strokeWidth={2.5}
              points={chart.valueLine}
            />
            {/* y labels */}
            {chart.yLabels.map((l, i) => (
              <text
                key={`yl${i}`}
                x={chart.padL - 6}
                y={l.y + 3}
                textAnchor="end"
                className="fill-zinc-400"
                fontSize={9}
              >
                {l.text}
              </text>
            ))}
            {/* x labels */}
            {chart.xLabels.map((l, i) => (
              <text
                key={`xl${i}`}
                x={l.x}
                y={chart.height - 8}
                textAnchor="middle"
                className="fill-zinc-400"
                fontSize={9}
              >
                {l.text}
              </text>
            ))}
          </svg>
          <div className="mt-1 flex gap-4 text-[10px] text-zinc-500">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-0.5 w-3 bg-zinc-500" /> Cost base
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-0.5 w-3 bg-emerald-600" /> Market
              value
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

function buildSvg(points: PerformancePoint[]) {
  const width = 640;
  const height = 192;
  const padL = 52;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const values = points.flatMap((p) =>
    [p.costBaseAud, p.marketValueAud].filter(
      (v): v is number => v != null && !Number.isNaN(v),
    ),
  );
  const minV = 0;
  const maxV = values.length ? Math.max(...values, 1) * 1.05 : 1;

  const xAt = (i: number) =>
    padL + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const yAt = (v: number | null) => {
    if (v == null) return padT + innerH;
    const t = (v - minV) / (maxV - minV || 1);
    return padT + innerH - t * innerH;
  };

  const costPts: string[] = [];
  const valuePts: string[] = [];
  points.forEach((p, i) => {
    if (p.costBaseAud != null) costPts.push(`${xAt(i)},${yAt(p.costBaseAud)}`);
    if (p.marketValueAud != null)
      valuePts.push(`${xAt(i)},${yAt(p.marketValueAud)}`);
  });

  const gridN = 4;
  const gridYs = Array.from({ length: gridN + 1 }, (_, i) => {
    return padT + (innerH * i) / gridN;
  });
  const yLabels = gridYs.map((y, i) => {
    const v = maxV - (maxV - minV) * (i / gridN);
    return { y, text: compactMoney(v) };
  });

  const xStep = Math.max(1, Math.floor(points.length / 6));
  const xLabels = points
    .map((p, i) => ({ i, p }))
    .filter(({ i }) => i === 0 || i === points.length - 1 || i % xStep === 0)
    .map(({ i, p }) => ({
      x: xAt(i),
      text: p.date.slice(0, 7),
    }));

  return {
    width,
    height,
    padL,
    padR,
    costLine: costPts.join(" "),
    valueLine: valuePts.join(" "),
    gridYs,
    yLabels,
    xLabels,
  };
}

function compactMoney(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.round(n));
}
