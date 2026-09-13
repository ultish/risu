/**
 * TaxSettingsPanel — you / partner marginal rates + Medicare levy.
 * Used by the planner (and any restored income estimates).
 * GET/PUT /api/settings/tax-profiles
 */
import { useCallback, useEffect, useState } from "react";
import {
  fetchSettings,
  fetchTaxProfiles,
  putSettings,
  putTaxProfiles,
  type TaxProfileDto,
} from "./api";
import { Disclaimer } from "./Disclaimer";

type DraftProfile = {
  key: string;
  id?: number;
  label: string;
  /** percent 0–100 for UI */
  marginalRatePct: string;
  medicareLevyPct: string;
  isDefault: boolean;
};

function toDraft(p: TaxProfileDto): DraftProfile {
  return {
    key: `id-${p.id}`,
    id: p.id,
    label: p.label,
    marginalRatePct: String(round1(p.marginalRate * 100)),
    medicareLevyPct: String(round1(p.medicareLevy * 100)),
    isDefault: p.isDefault,
  };
}

const PLATFORM_FIFO_BROKERS: Array<{ id: string; label: string }> = [
  { id: "betashares_direct", label: "Betashares Direct" },
  { id: "stake", label: "Stake" },
  { id: "commsec", label: "CommSec" },
  { id: "pocket", label: "Pocket" },
  { id: "selfwealth", label: "Selfwealth" },
  { id: "other", label: "Other" },
];

const DEFAULT_PLATFORM_FIFO = ["betashares_direct"];

function parseBrokerList(raw: string | undefined): string[] {
  if (raw == null || raw.trim() === "") return [...DEFAULT_PLATFORM_FIFO];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [...DEFAULT_PLATFORM_FIFO];
    return v.map((x) => String(x));
  } catch {
    return [...DEFAULT_PLATFORM_FIFO];
  }
}

function emptyDraft(): DraftProfile {
  return {
    key: `new-${Date.now()}`,
    label: "",
    marginalRatePct: "37",
    medicareLevyPct: "2",
    isDefault: false,
  };
}

export function TaxSettingsPanel() {
  const [drafts, setDrafts] = useState<DraftProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [fifoBrokers, setFifoBrokers] = useState<string[]>([
    ...DEFAULT_PLATFORM_FIFO,
  ]);
  const [fifoSaved, setFifoSaved] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [rows, settings] = await Promise.all([
        fetchTaxProfiles(),
        fetchSettings().catch(() => null),
      ]);
      setDrafts(rows.map(toDraft));
      if (settings) {
        setFifoBrokers(parseBrokerList(settings.settings.platform_fifo_brokers));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function update(key: string, patch: Partial<DraftProfile>) {
    setSaved(false);
    setDrafts((list) =>
      list.map((d) => {
        if (d.key !== key) {
          if (patch.isDefault) return { ...d, isDefault: false };
          return d;
        }
        return { ...d, ...patch };
      }),
    );
  }

  function addRow() {
    setSaved(false);
    setDrafts((list) => [...list, emptyDraft()]);
  }

  function removeRow(key: string) {
    setSaved(false);
    setDrafts((list) => {
      const next = list.filter((d) => d.key !== key);
      if (next.length && !next.some((d) => d.isDefault)) {
        next[0] = { ...next[0]!, isDefault: true };
      }
      return next;
    });
  }

  async function onSave() {
    if (!drafts.length) {
      setError("At least one tax profile is required");
      return;
    }
    for (const d of drafts) {
      if (!d.label.trim()) {
        setError("Every profile needs a label");
        return;
      }
      const mtr = Number(d.marginalRatePct);
      const med = Number(d.medicareLevyPct);
      if (Number.isNaN(mtr) || mtr < 0 || mtr > 100) {
        setError(`Invalid marginal rate for ${d.label}`);
        return;
      }
      if (Number.isNaN(med) || med < 0 || med > 100) {
        setError(`Invalid Medicare levy for ${d.label}`);
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      const savedRows = await putTaxProfiles(
        drafts.map((d) => ({
          id: d.id,
          label: d.label.trim(),
          marginalRate: Number(d.marginalRatePct) / 100,
          medicareLevy: Number(d.medicareLevyPct) / 100,
          isDefault: d.isDefault,
        })),
      );
      setDrafts(savedRows.map(toDraft));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleFifoBroker(id: string) {
    setFifoSaved(false);
    setFifoBrokers((list) =>
      list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
    );
  }

  async function onSaveFifoBrokers() {
    setBusy(true);
    setError(null);
    setFifoSaved(false);
    try {
      await putSettings({
        platform_fifo_brokers: JSON.stringify(fifoBrokers),
      });
      setFifoSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-gray-800 bg-gray-900/40 p-5 shadow-xl shadow-black/20">
      <h2 className="mb-1 text-lg font-medium text-gray-100">Tax settings</h2>
      <p className="mb-4 text-sm text-gray-400">
        Marginal rates for you and a partner (or other books). Used by the
        planner and future FY income / CGT estimates. Rates are decimals under
        the hood (enter percent here).
      </p>

      {error && (
        <div className="mb-3 rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {drafts.map((d) => (
          <div
            key={d.key}
            className="grid gap-2 rounded-xl border border-gray-800 bg-gray-950/40 p-3 sm:grid-cols-12 sm:items-end"
          >
            <label className="block text-sm sm:col-span-3">
              <span className="mb-1 block text-xs text-gray-500">Label</span>
              <input
                className="field"
                value={d.label}
                onChange={(e) => update(d.key, { label: e.target.value })}
                placeholder="Me / Partner"
              />
            </label>
            <label className="block text-sm sm:col-span-2">
              <span className="mb-1 block text-xs text-gray-500">
                Marginal %
              </span>
              <input
                className="field"
                inputMode="decimal"
                value={d.marginalRatePct}
                onChange={(e) =>
                  update(d.key, { marginalRatePct: e.target.value })
                }
              />
            </label>
            <label className="block text-sm sm:col-span-2">
              <span className="mb-1 block text-xs text-gray-500">
                Medicare %
              </span>
              <input
                className="field"
                inputMode="decimal"
                value={d.medicareLevyPct}
                onChange={(e) =>
                  update(d.key, { medicareLevyPct: e.target.value })
                }
              />
            </label>
            <label className="flex items-center gap-2 text-sm sm:col-span-3 sm:pb-2">
              <input
                type="radio"
                name="default-tax-profile"
                checked={d.isDefault}
                onChange={() => update(d.key, { isDefault: true })}
              />
              <span className="text-gray-300">Default for planner</span>
            </label>
            <div className="sm:col-span-2 sm:pb-1">
              <button
                type="button"
                disabled={drafts.length <= 1 || busy}
                onClick={() => removeRow(d.key)}
                className="text-xs text-red-300/90 underline disabled:opacity-40"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={addRow}
          className="rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-sm hover:bg-gray-700 disabled:opacity-50"
        >
          Add profile
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onSave()}
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-gray-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save tax profiles"}
        </button>
        {saved && (
          <span className="text-xs text-emerald-300">Saved</span>
        )}
      </div>

      <div className="mt-4 rounded-lg border border-gray-800 bg-gray-950/30 p-3 text-xs text-gray-500">
        <p className="mb-1 font-medium text-gray-400">CGT modelling notes</p>
        <ul className="list-inside list-disc space-y-1">
          <li>Average cost method (not FIFO parcel matching).</li>
          <li>
            Pre 1 Jul 2027 style: 50% discount when held ≥ 365 days (when
            eligible).
          </li>
          <li>
            Post 1 Jul 2027 simplified model: long-term effective rate floored
            at 30% of the gain.
          </li>
          <li>
            Planner CGT (post–Jul 2027): indexed cost base; rate =
            max(this combined rate, 30%) on the indexed gain — no 50% discount.
          </li>
        </ul>
      </div>

      <div className="mt-6 border-t border-gray-800 pt-5">
        <h3 className="mb-1 text-sm font-medium text-gray-100">
          Brokers that report their own CGT (FIFO lock)
        </h3>
        <p className="mb-3 text-sm text-gray-400">
          Imported statement sells from these brokers stay FIFO on the Tax
          tab, even when Auto (minimize CGT) is on — they issue their own
          tax report that way (Betashares Direct auto-rebalance is the
          usual case). Untick a broker if you want minimize-CGT to apply
          to its imported sells. Add trade and ticker “Confirm sale” are
          never locked.
        </p>
        <div className="space-y-2">
          {PLATFORM_FIFO_BROKERS.map((b) => (
            <label
              key={b.id}
              className="flex items-center gap-2 text-sm text-gray-300"
            >
              <input
                type="checkbox"
                checked={fifoBrokers.includes(b.id)}
                disabled={busy}
                onChange={() => toggleFifoBroker(b.id)}
              />
              {b.label}
            </label>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void onSaveFifoBrokers()}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-gray-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save broker FIFO lock"}
          </button>
          {fifoSaved && (
            <span className="text-xs text-emerald-300">Saved</span>
          )}
        </div>
      </div>

      <div className="mt-4">
        <Disclaimer />
      </div>

      <style>{`
        .field {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid #374151;
          background-color: #111827;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          color: #f3f4f6;
        }
      `}</style>
    </section>
  );
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}
