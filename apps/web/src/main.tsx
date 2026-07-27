import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { importYahooPayload } from "./api";
import "./index.css";

/**
 * Dev / cool-down helper: open Yahoo URL in browser → copy JSON → paste here.
 *
 *   risu.help()
 *   risu.importYahoo(json)
 *   risu.importYahoo(json, "TSLA")
 *   risu.sparkUrl(["TSLA","AAPL"])
 *   risu.chartUrl("VAS.AX")
 *
 * Alias: window.yields === window.risu (legacy)
 */
const HELP_TEXT = `
%c[risu] Yahoo manual helpers (cool-down bypass)
%c
When Node gets HTTP 429 but your browser still works:

  1. Get a URL
       risu.sparkUrl("TSLA")              // bulk history (preferred)
       risu.sparkUrl(["TSLA","VAS.AX"])
       risu.chartUrl("TSLA")              // single-symbol history
       risu.chartUrl("VAS.AX", 365)

  2. Open that URL in a new tab → copy the full JSON body

  3. Import into the app (writes price_cache + quote_cache; FX pairs → fx_history)
       risu.importYahoo(json)
       risu.importYahoo(json, "TSLA")     // optional symbol hint for chart
       risu.chartUrl("AUDUSD=X", 10*365)  // ~10y FX history for AUD green line

  4. Reload Holdings / performance chart to see the series

Also: Settings → Manual Yahoo import (paste UI).
Re-print this: risu.help()
`.trim();

function printRisuHelp() {
  console.log(
    HELP_TEXT,
    "color:#34d399;font-weight:bold;font-size:12px",
    "color:inherit;font-family:ui-monospace,monospace;font-size:11px",
  );
}

const risuConsole = {
  help() {
    printRisuHelp();
  },
  async importYahoo(payload: unknown, symbol?: string) {
    const r = await importYahooPayload(payload, symbol);
    console.log("[risu] import-yahoo", r);
    return r;
  },
  sparkUrl(symbols: string | string[], range = "1y") {
    const list = (Array.isArray(symbols) ? symbols : [symbols])
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const u = new URL("https://query1.finance.yahoo.com/v8/finance/spark");
    u.searchParams.set("symbols", list.join(","));
    u.searchParams.set("range", range);
    u.searchParams.set("interval", "1d");
    const url = u.toString();
    console.log(
      "[risu] spark URL — open in browser, copy JSON, then risu.importYahoo(json)\n",
      url,
    );
    return url;
  },
  chartUrl(symbol: string, rangeDays = 365) {
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = period2 - rangeDays * 24 * 3600;
    const u = new URL(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
    );
    u.searchParams.set("interval", "1d");
    u.searchParams.set("period1", String(period1));
    u.searchParams.set("period2", String(period2));
    u.searchParams.set("events", "div|split");
    u.searchParams.set("includePrePost", "false");
    const url = u.toString();
    console.log(
      "[risu] chart URL — open in browser, copy JSON, then risu.importYahoo(json)\n",
      url,
    );
    return url;
  },
};

declare global {
  interface Window {
    risu: typeof risuConsole;
    /** @deprecated use risu */
    yields: typeof risuConsole;
  }
}
window.risu = risuConsole;
window.yields = risuConsole; // legacy alias
printRisuHelp();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
