import { chromium, type Browser, type BrowserContext } from "playwright";

/**
 * Yahoo's unofficial endpoints block plain Node/curl HTTP clients at the
 * TLS/handshake level — even with browser-identical headers — while a real
 * browser succeeds every time. This drives Yahoo requests through a real
 * headless Chromium instance instead of Node's fetch, so the app gets the
 * same access a manually-opened browser tab does.
 *
 * One browser + one persistent context is kept warm for the process
 * lifetime: reusing pages is cheap, and a persistent context lets Chromium
 * carry real cookies across requests (the fc.yahoo.com / getcrumb session
 * dance in yahoo.ts then rides on genuine browser cookies, not a manually
 * reconstructed Cookie header).
 */

let browserPromise: Promise<Browser> | null = null;
let contextPromise: Promise<BrowserContext> | null = null;

async function getContext(): Promise<BrowserContext> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true });
  }
  if (!contextPromise) {
    contextPromise = browserPromise.then((browser) => browser.newContext());
  }
  return contextPromise;
}

const SKIP_HEADERS = new Set([
  "cookie",
  "user-agent",
  "accept-encoding",
  "host",
  "connection",
]);

/** Drop-in `fetch` replacement that navigates a real headless browser. */
export const yahooBrowserFetch: typeof fetch = async (
  input,
  init,
): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  const context = await getContext();
  const page = await context.newPage();
  try {
    const extraHeaders: Record<string, string> = {};
    const headerSource = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    if (headerSource) {
      const h = new Headers(headerSource as HeadersInit);
      h.forEach((value, key) => {
        if (!SKIP_HEADERS.has(key.toLowerCase())) extraHeaders[key] = value;
      });
    }
    if (Object.keys(extraHeaders).length) {
      await page.setExtraHTTPHeaders(extraHeaders);
    }

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    if (!response) {
      throw new Error(`yahooBrowserFetch: no response for ${url}`);
    }

    const status = response.status();
    // Endpoints that redirect quickly (e.g. fc.yahoo.com) can navigate the
    // page away before Playwright's CDP snapshot of this response body is
    // read, throwing "response navigated away". Cookies are still captured
    // via context.cookies() below regardless, so degrade to an empty body.
    const body = await response.text().catch(() => "");
    const headers = new Headers();
    for (const [key, value] of Object.entries(await response.allHeaders())) {
      if (key.toLowerCase() === "set-cookie") continue; // synthesized below
      headers.set(key, value);
    }
    // page.goto()'s Response is the final document after redirects, so
    // Set-Cookie from an intermediate hop (e.g. fc.yahoo.com's 302) never
    // shows up in its headers — even though the browser's real cookie jar
    // already has it. Read the jar directly instead of relying on headers.
    for (const cookie of await context.cookies(url)) {
      headers.append("set-cookie", `${cookie.name}=${cookie.value}`);
    }
    return new Response(body, { status, headers });
  } finally {
    await page.close();
  }
};

/** Call on process shutdown so tsx-watch restarts / SIGTERM don't leak Chromium. */
export async function closeYahooBrowser(): Promise<void> {
  const ctx = contextPromise ? await contextPromise.catch(() => null) : null;
  contextPromise = null;
  if (ctx) await ctx.close().catch(() => {});

  const browser = browserPromise ? await browserPromise.catch(() => null) : null;
  browserPromise = null;
  if (browser) await browser.close().catch(() => {});
}
