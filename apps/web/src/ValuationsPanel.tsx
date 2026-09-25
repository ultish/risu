/**
 * ValuationsPanel — what every holding was worth at the close on a past
 * date, per portfolio, broker and stock, down to each parcel. Preview any
 * date up to today, then save it as a fixed record (e.g. 30 June 2027, the
 * market value the new CGT rules split every gain at). Saved records never
 * change when prices are refreshed or trades edited.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import {
  type Portfolio,
  type SavedValuation,
  type ValuationFlag,
  type ValuationLineDto,
  type ValuationReportDto,
  deleteSavedValuation,
  fetchSavedValuation,
  fetchSavedValuations,
  previewValuation,
  saveValuation,
  savedValuationCsvUrl,
} from "./api";
import { Empty, Panel, money } from "./App";

const FLAG_TEXT: Record<ValuationFlag, { label: string; hint: string }> = {
  no_price: {
    label: "No price",
    hint: "No close cached on or before this date, so it has no value here. Refresh prices (or paste a history) and value again.",
  },
  stale_price: {
    label: "Old price",
    hint: "The last cached close is more than 5 days before this date. Refresh prices to fill the gap if the market was open.",
  },
  no_fx: {
    label: "No FX",
    hint: "No exchange rate cached for this currency, so it couldn't be converted to AUD.",
  },
  fx_not_historical: {
    label: "Today's FX",
    hint: "Only the latest exchange rate is cached, not one from this date. Backfill FX history (Settings) and value again.",
  },
  untracked_units: {
    label: "Units without cost",
    hint: "Some units have no parcel behind them — a buy whose AUD cost couldn't be worked out. They're valued, but have no cost base.",
  },
};

/** The most recent 30 June on or before today — the date most people want. */
function lastThirtyJune(): string {
  const now = new Date();
  const y = now.getMonth() >= 5 && !(now.getMonth() === 5 && now.getDate() < 30)
    ? now.getFullYear()
    : now.getFullYear() - 1;
  return `${y}-06-30`;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** SQLite's datetime('now') is UTC "yyyy-mm-dd hh:mm:ss" — show it as a local date. */
function savedOn(createdAt: string): string {
  return new Date(`${createdAt.replace(" ", "T")}Z`).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function units(n: number): string {
  return n.toLocaleString("en-AU", { maximumFractionDigits: 6 });
}

export function ValuationsPanel({ portfolios }: { portfolios: Portfolio[] }) {
  const [asOf, setAsOf] = useState(lastThirtyJune);
  const [portfolioId, setPortfolioId] = useState<number | "all">("all");
  const [preview, setPreview] = useState<ValuationReportDto | null>(null);
  const [opened, setOpened] = useState<(SavedValuation & { report: ValuationReportDto }) | null>(null);
  const [saved, setSaved] = useState<SavedValuation[]>([]);
  const [label, setLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const reloadSaved = useCallback(async () => {
    setSaved(await fetchSavedValuations());
  }, []);

  useEffect(() => {
    void reloadSaved().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [reloadSaved]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const portfolioName = (id: number | null) =>
    id == null ? "All portfolios" : (portfolios.find((p) => p.id === id)?.name ?? `Portfolio ${id}`);

  return (
    <div className="space-y-4">
      <Panel title="Value holdings on a date">
        <p className="mb-4 text-sm text-gray-400">
          What everything was worth at the close on a date — per portfolio,
          broker and stock, down to each parcel. Save it to keep a fixed
          record: <strong className="text-gray-300">30 June 2027</strong> is
          the one that matters for the new CGT rules, which split every gain at
          each parcel&apos;s market value just before 1 July 2027. Prices and
          FX are the last cached ones on or before the date; anything doubtful
          is flagged.
        </p>
        <div className="mb-4 grid gap-2 sm:grid-cols-4">
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-gray-500">Date</span>
            <input
              type="date"
              className="field"
              value={asOf}
              max={todayIso()}
              onChange={(e) => setAsOf(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-gray-500">Portfolio</span>
            <select
              className="field"
              value={portfolioId === "all" ? "all" : String(portfolioId)}
              onChange={(e) => setPortfolioId(e.target.value === "all" ? "all" : Number(e.target.value))}
            >
              <option value="all">All portfolios</option>
              {portfolios.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <button
              type="button"
              disabled={busy || !asOf}
              onClick={() =>
                run(async () => {
                  const r = await previewValuation(asOf, portfolioId);
                  setPreview(r);
                  setOpened(null);
                  setLabel(`Valuation ${asOf}`);
                  setNotes("");
                })
              }
              className="w-full rounded-lg border border-emerald-700/60 bg-emerald-500/15 px-3 py-2 text-sm text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
            >
              {busy && !preview ? "Valuing…" : "Value holdings"}
            </button>
          </div>
        </div>
        {error && (
          <div className="mb-3 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        {preview && !opened && (
          <>
            <ReportView report={preview} />
            <div className="mt-4 rounded-xl border border-gray-800 bg-gray-950/40 p-3">
              <p className="mb-2 text-xs text-gray-500">
                Saving recomputes this from the ledger and prices as they are now, and
                stores it unchanged from then on.
              </p>
              <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
                <input
                  className="field"
                  aria-label="Label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Label"
                />
                <input
                  className="field"
                  aria-label="Notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Notes (optional)"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const s = await saveValuation({ asOf: preview.asOf, portfolioId, label, notes });
                      await reloadSaved();
                      setOpened(s);
                    })
                  }
                  className="rounded-lg border border-emerald-700/60 bg-emerald-500/15 px-4 py-2 text-sm text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
                >
                  Save valuation
                </button>
              </div>
            </div>
          </>
        )}

        {opened && (
          <>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-emerald-900/50 bg-emerald-950/20 px-3 py-2 text-sm">
              <span className="text-emerald-200">
                Saved record: <strong>{opened.label}</strong> · {portfolioName(opened.portfolioId)} ·
                saved {savedOn(opened.createdAt)}
                {opened.notes ? ` · ${opened.notes}` : ""}
              </span>
              <a
                href={savedValuationCsvUrl(opened.id)}
                className="text-xs text-emerald-300 underline hover:text-emerald-200"
              >
                Download CSV
              </a>
            </div>
            <ReportView report={opened.report} />
          </>
        )}
      </Panel>

      <Panel title="Saved valuations">
        {saved.length === 0 ? (
          <Empty hint="Nothing saved yet. Value a date above and save it." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Label</th>
                  <th className="py-2 pr-4">Portfolio</th>
                  <th className="py-2 pr-4 text-right">Value</th>
                  <th className="py-2 pr-4">Saved</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {saved.map((s) => (
                  <tr
                    key={s.id}
                    className={`border-b border-gray-800/60 ${opened?.id === s.id ? "bg-emerald-500/5" : ""}`}
                  >
                    <td className="py-2 pr-4 text-gray-200">{longDate(s.asOf)}</td>
                    <td className="py-2 pr-4 text-gray-300">
                      {s.label}
                      {s.unvalued > 0 && (
                        <span className="ml-2 text-xs text-amber-300">{s.unvalued} unvalued</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-gray-400">{portfolioName(s.portfolioId)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-gray-100">
                      {money(s.marketValueAud)}
                    </td>
                    <td className="py-2 pr-4 text-xs text-gray-500">{savedOn(s.createdAt)}</td>
                    <td className="py-2 pr-4 text-right text-xs whitespace-nowrap">
                      <button
                        type="button"
                        className="mr-3 text-emerald-300 hover:text-emerald-200"
                        onClick={() =>
                          run(async () => {
                            setOpened(await fetchSavedValuation(s.id));
                            setPreview(null);
                          })
                        }
                      >
                        Open
                      </button>
                      <a className="mr-3 text-gray-400 hover:text-gray-200" href={savedValuationCsvUrl(s.id)}>
                        CSV
                      </a>
                      {confirmDelete === s.id ? (
                        <>
                          <button
                            type="button"
                            className="mr-2 text-red-300 hover:text-red-200"
                            onClick={() =>
                              run(async () => {
                                await deleteSavedValuation(s.id);
                                setConfirmDelete(null);
                                if (opened?.id === s.id) setOpened(null);
                                await reloadSaved();
                              })
                            }
                          >
                            Delete it
                          </button>
                          <button
                            type="button"
                            className="text-gray-500 hover:text-gray-300"
                            onClick={() => setConfirmDelete(null)}
                          >
                            Keep
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="text-gray-500 hover:text-red-300"
                          onClick={() => setConfirmDelete(s.id)}
                        >
                          Delete…
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function FlagChips({ flags }: { flags: ValuationFlag[] }) {
  if (!flags.length) return null;
  return (
    <>
      {flags.map((f) => (
        <span
          key={f}
          title={FLAG_TEXT[f].hint}
          className="ml-2 inline-block rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300"
        >
          {FLAG_TEXT[f].label}
        </span>
      ))}
    </>
  );
}

function ReportView({ report }: { report: ValuationReportDto }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!report.portfolios.length) {
    return <Empty hint={`Nothing held on ${longDate(report.asOf)}.`} />;
  }
  const flagged = report.portfolios.flatMap((p) =>
    p.valuation.brokers.flatMap((b) => b.lines.filter((l) => l.flags.length).map((l) => ({ p, b, l }))),
  );
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={`Value at close, ${longDate(report.asOf)}`} value={money(report.marketValueAud)} />
        <Stat label="Cost base of those parcels" value={money(report.costBaseAud)} />
        <Stat
          label="Needs a look"
          value={flagged.length ? `${flagged.length} line${flagged.length === 1 ? "" : "s"}` : "None"}
          warn={flagged.length > 0}
        />
      </div>
      {flagged.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
          {flagged.map(({ p, b, l }) => (
            <li key={`${p.id}-${b.broker}-${l.exchange}-${l.ticker}`}>
              <strong>{l.ticker}</strong> ({p.name}, {b.broker}):{" "}
              {l.flags.map((f) => FLAG_TEXT[f].hint).join(" ")}
            </li>
          ))}
        </ul>
      )}
      {report.portfolios.map((p) => (
        <section key={p.id}>
          <div className="mb-2 flex items-baseline justify-between border-b border-gray-800 pb-1">
            <h3 className="text-base font-medium text-gray-100">{p.name}</h3>
            <span className="tabular-nums text-sm text-gray-300">{money(p.valuation.marketValueAud)}</span>
          </div>
          {p.valuation.brokers.map((b) => (
            <div key={b.broker} className="mb-4 overflow-x-auto">
              {/* Fixed widths so every broker's columns line up under each other. */}
              <table className="w-full min-w-[44rem] table-fixed text-sm">
                <colgroup>
                  <col className="w-[22%]" />
                  <col className="w-[11%]" />
                  <col className="w-[19%]" />
                  <col className="w-[12%]" />
                  <col className="w-[13%]" />
                  <col className="w-[13%]" />
                  <col className="w-[10%]" />
                </colgroup>
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                    <th className="py-1.5 pr-4 font-medium text-gray-400">{b.broker}</th>
                    <th className="py-1.5 pr-4 text-right">Units</th>
                    <th className="py-1.5 pr-4">Close used</th>
                    <th className="py-1.5 pr-4 text-right">Per unit</th>
                    <th className="py-1.5 pr-4 text-right">Value (AUD)</th>
                    <th className="py-1.5 pr-4 text-right">Cost base</th>
                    <th className="py-1.5 pr-4 text-right">Parcels</th>
                  </tr>
                </thead>
                <tbody>
                  {b.lines.map((l) => {
                    const key = `${p.id}|${b.broker}|${l.exchange}:${l.ticker}`;
                    const isOpen = open === key;
                    return (
                      <Fragment key={key}>
                        <tr
                          className="cursor-pointer border-t border-gray-800/60 hover:bg-gray-800/30"
                          onClick={() => setOpen(isOpen ? null : key)}
                        >
                          <td className="py-1.5 pr-4 text-gray-100">
                            {l.ticker}
                            <span className="ml-1 text-xs text-gray-500">{l.exchange}</span>
                            <FlagChips flags={l.flags} />
                          </td>
                          <td className="py-1.5 pr-4 text-right tabular-nums text-gray-300">{units(l.quantity)}</td>
                          <td className="py-1.5 pr-4 text-xs text-gray-400">
                            {l.priceDate ? longDate(l.priceDate) : "—"}
                            {l.fxDate && (
                              <span className="block text-[11px] text-gray-500">
                                FX {l.fxRate?.toFixed(4)} ({longDate(l.fxDate)})
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 pr-4 text-right tabular-nums text-gray-300">
                            {money(l.unitValue, l.currency, l.currency !== "AUD")}
                          </td>
                          <td className="py-1.5 pr-4 text-right tabular-nums text-gray-100">
                            {money(l.marketValueAud)}
                          </td>
                          <td className="py-1.5 pr-4 text-right tabular-nums text-gray-400">
                            {money(l.costBaseAud)}
                          </td>
                          <td className="py-1.5 pr-4 text-right text-xs text-gray-400">
                            {isOpen ? "▾" : "▸"} {l.parcels.length}
                          </td>
                        </tr>
                        {isOpen && <ParcelRows line={l} />}
                      </Fragment>
                    );
                  })}
                  <tr className="border-t border-gray-700 text-xs text-gray-400">
                    <td className="py-1.5 pr-4" colSpan={4}>
                      {b.broker} total
                    </td>
                    <td className="py-1.5 pr-4 text-right tabular-nums text-gray-200">{money(b.marketValueAud)}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{money(b.costBaseAud)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function ParcelRows({ line }: { line: ValuationLineDto }) {
  return (
    <tr>
      <td colSpan={7} className="bg-gray-950/40 px-3 py-2">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1 pr-3">Acquired</th>
              <th className="py-1 pr-3 text-right">Units</th>
              <th className="py-1 pr-3 text-right">Cost base (AUD)</th>
              <th className="py-1 pr-3 text-right">Value (AUD)</th>
            </tr>
          </thead>
          <tbody>
            {line.parcels.map((pc, i) => (
              <tr key={`${pc.acquiredDate}-${i}`} className="text-gray-300">
                <td className="py-0.5 pr-3">{longDate(pc.acquiredDate)}</td>
                <td className="py-0.5 pr-3 text-right tabular-nums">{units(pc.quantity)}</td>
                <td className="py-0.5 pr-3 text-right tabular-nums">{money(pc.costBaseAud)}</td>
                <td className="py-0.5 pr-3 text-right tabular-nums">{money(pc.marketValueAud)}</td>
              </tr>
            ))}
            {line.untrackedQuantity > 0 && (
              <tr className="text-amber-300">
                <td className="py-0.5 pr-3">No parcel</td>
                <td className="py-0.5 pr-3 text-right tabular-nums">{units(line.untrackedQuantity)}</td>
                <td className="py-0.5 pr-3 text-right">—</td>
                <td className="py-0.5 pr-3 text-right" />
              </tr>
            )}
          </tbody>
        </table>
      </td>
    </tr>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-950/40 px-3 py-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg tabular-nums ${warn ? "text-amber-300" : "text-gray-100"}`}>{value}</div>
    </div>
  );
}
