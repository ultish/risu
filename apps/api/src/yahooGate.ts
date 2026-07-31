/**
 * Yahoo cool-down gate — stops hammering after 429/blocks and exposes
 * wait time for the UI. Yahoo rarely sends a reliable Retry-After; we use
 * it when present, otherwise escalate heuristics.
 */
import type Database from "better-sqlite3";
import { isYahooHttpError } from "@yields/core";

const KEY_BLOCKED_UNTIL = "yahoo_blocked_until";
const KEY_LAST_ERROR = "yahoo_last_error";
const KEY_LAST_URL = "yahoo_last_url";
const KEY_LAST_OK = "yahoo_last_ok_at";
const KEY_STREAK = "yahoo_429_streak";
const KEY_LAST_REFRESH = "yahoo_last_refresh_at";

export type YahooStatus = {
  /** ok = free to call; cooling = wait; disabled = settings off */
  state: "ok" | "cooling" | "disabled";
  /** Epoch ms when cool-down ends (null if ok) */
  blockedUntil: number | null;
  /** Seconds remaining (0 if ok) */
  waitSeconds: number;
  lastError: string | null;
  /** Last Yahoo URL that failed (open in browser; paste JSON via Settings / console) */
  lastUrl: string | null;
  lastOkAt: string | null;
  lastRefreshAt: string | null;
  streak429: number;
  /** Human label for badge */
  label: string;
  /** Yahoo almost never documents exact wait — note for UI */
  note: string;
};

function getSetting(db: Database.Database, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setSetting(db: Database.Database, key: string, value: string) {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function parseIsoMs(raw: string | null): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

/** Default cool-downs when Retry-After is missing (seconds). */
function heuristicCooldownSeconds(streak: number): number {
  // Long floors — short cooldowns cause thrashing while IP is still banned
  // escalate: 1h → 3h → 6h → 12h (cap)
  if (streak <= 1) return 60 * 60;
  if (streak === 2) return 3 * 60 * 60;
  if (streak === 3) return 6 * 60 * 60;
  return 12 * 60 * 60;
}

export function getYahooStatus(db: Database.Database): YahooStatus {
  const enabled =
    getSetting(db, "yahoo_refresh_enabled") === "1" ||
    getSetting(db, "yahoo_refresh_enabled") === "true";

  const blockedUntil = parseIsoMs(getSetting(db, KEY_BLOCKED_UNTIL));
  const now = Date.now();
  const waitSeconds =
    blockedUntil != null && blockedUntil > now
      ? Math.ceil((blockedUntil - now) / 1000)
      : 0;
  const cooling = waitSeconds > 0;
  const streak429 = Number(getSetting(db, KEY_STREAK) || "0") || 0;
  const lastError = getSetting(db, KEY_LAST_ERROR);
  const lastUrl = getSetting(db, KEY_LAST_URL);
  const lastOkAt = getSetting(db, KEY_LAST_OK);
  const lastRefreshAt = getSetting(db, KEY_LAST_REFRESH);

  if (!enabled && !cooling) {
    // Preference off does not block manual refresh; UI uses this as soft hint
  }

  let state: YahooStatus["state"] = "ok";
  let label = "Yahoo ready";
  let note =
    "Prices use cache on page load. Yahoo is only called when you click Refresh (or via auto-refresh, if enabled in Settings).";

  if (cooling) {
    state = "cooling";
    label = `Yahoo cool-down · ${formatWait(waitSeconds)}`;
    note =
      (lastError ? `${lastError} ` : "") +
      "Refresh still works via ASX/Nasdaq/FX fallbacks — only Yahoo is paused. " +
      "Open lastUrl in a browser, copy JSON, paste via Settings or risu.importYahoo(...).";
  } else if (!enabled) {
    state = "ok";
    label = "Yahoo manual only";
    note =
      "Settings: Yahoo auto-refresh preference is off. Page load never hits Yahoo; use Refresh button only.";
  }

  return {
    state,
    blockedUntil: cooling ? blockedUntil : null,
    waitSeconds,
    lastError,
    lastUrl,
    lastOkAt,
    lastRefreshAt,
    streak429,
    label,
    note,
  };
}

export function formatWait(seconds: number): string {
  if (seconds <= 0) return "ready";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

/**
 * Throws if still in cool-down (unless force=true).
 * force still allowed for debugging but UI should warn.
 */
export function assertYahooAllowed(
  db: Database.Database,
  opts: { force?: boolean } = {},
): void {
  const st = getYahooStatus(db);
  if (st.waitSeconds > 0 && !opts.force) {
    const err = new Error(
      `Yahoo cool-down active — wait ${formatWait(st.waitSeconds)} before calling Yahoo again. Holdings keep using cached prices.`,
    );
    (err as Error & { yahooStatus: YahooStatus }).yahooStatus = st;
    throw err;
  }
}

export function recordYahooSuccess(db: Database.Database) {
  setSetting(db, KEY_LAST_OK, new Date().toISOString());
  setSetting(db, KEY_STREAK, "0");
  // Clear cool-down on success
  setSetting(db, KEY_BLOCKED_UNTIL, "");
  setSetting(db, KEY_LAST_ERROR, "");
  setSetting(db, KEY_LAST_URL, "");
}

export function recordYahooRefreshStarted(db: Database.Database) {
  setSetting(db, KEY_LAST_REFRESH, new Date().toISOString());
}

export function recordYahooFailure(db: Database.Database, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  setSetting(db, KEY_LAST_ERROR, msg.slice(0, 800));
  if (isYahooHttpError(err) && err.url) {
    setSetting(db, KEY_LAST_URL, err.url.slice(0, 1000));
  } else {
    // Best-effort: scrape " URL: …" suffix from message
    const m = msg.match(/\bURL:\s*(\S+)/);
    if (m?.[1]) setSetting(db, KEY_LAST_URL, m[1].slice(0, 1000));
  }

  const is429 =
    isYahooHttpError(err)
      ? err.status === 429 || err.status === 401 || err.status === 403
      : /HTTP 429|rate-limit|rate limited|HTTP 401|HTTP 403/i.test(msg);

  if (!is429) return;

  const prev = Number(getSetting(db, KEY_STREAK) || "0") || 0;
  const streak = prev + 1;
  setSetting(db, KEY_STREAK, String(streak));

  let seconds = heuristicCooldownSeconds(streak);
  if (isYahooHttpError(err) && err.retryAfterSeconds != null) {
    // Trust header but floor at 30 min — Yahoo bans are rarely short
    seconds = Math.max(err.retryAfterSeconds, 30 * 60);
  }
  // Never shorter than heuristic for this streak
  seconds = Math.max(seconds, heuristicCooldownSeconds(streak));

  const until = new Date(Date.now() + seconds * 1000).toISOString();
  setSetting(db, KEY_BLOCKED_UNTIL, until);
}

/** Clear cool-down manually from Settings / UI. */
export function clearYahooCooldown(db: Database.Database) {
  setSetting(db, KEY_BLOCKED_UNTIL, "");
  setSetting(db, KEY_STREAK, "0");
  setSetting(db, KEY_LAST_ERROR, "");
  setSetting(db, KEY_LAST_URL, "");
}
