import { chromium, type Browser } from "patchright";

// A single shared Chromium is reused across PDF renders (launching is the
// expensive part). But that cached instance can die out from under us — a
// crash, an OOM kill on the small VPS, or the process being torn down — after
// which every `browser.newContext()` throws "Target page, context or browser
// has been closed" *forever*, because the dead promise stays cached. That was
// the root cause of all AWB/Receipt/Shipping-Label/manifest PDFs 500ing until
// a manual restart. getBrowser() is therefore self-healing: it validates the
// cached browser is still connected and relaunches if not, and never caches a
// failed launch.
let browserPromise: Promise<Browser> | null = null;

async function launchBrowser(): Promise<Browser> {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  // If this browser ever disconnects (crash/OOM/close), drop the cached
  // promise so the next getBrowser() relaunches a fresh one instead of
  // handing back a dead instance.
  browser.on("disconnected", () => {
    if (browserPromise) {
      // Only clear if the promise still resolves to THIS browser, so we don't
      // clobber a newer instance that may have already replaced it.
      browserPromise
        .then((b) => {
          if (b === browser) browserPromise = null;
        })
        .catch(() => {
          browserPromise = null;
        });
    }
  });
  return browser;
}

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    try {
      const existing = await browserPromise;
      if (existing.isConnected()) return existing;
    } catch {
      // fall through to relaunch
    }
    browserPromise = null;
  }
  // Launch, but do NOT cache a rejected promise — a failed launch must not
  // poison every future call.
  const p = launchBrowser();
  browserPromise = p;
  try {
    return await p;
  } catch (e) {
    if (browserPromise === p) browserPromise = null;
    throw e;
  }
}

/**
 * PDF page-size options.
 * - `{ format: "A4" }` — used for the AWB and Receipt (full-page documents).
 * - `{ width, height }` — used for the Shipping Bill (fixed-size courier label).
 */
export type PdfPageSize = { format: "A4" } | { width: string; height: string };

// Errors that mean "the shared browser died" — worth relaunching + retrying
// once, rather than surfacing a 500 to the user for a transient crash.
function isBrowserGoneError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    msg.includes("has been closed") ||
    msg.includes("Target closed") ||
    msg.includes("Target page, context or browser has been closed") ||
    msg.includes("browser has disconnected") ||
    msg.includes("Browser closed") ||
    msg.includes("Connection closed")
  );
}

async function renderOnce(html: string, pageSize: PdfPageSize): Promise<Buffer> {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdf = await page.pdf({
      ...("format" in pageSize
        ? { format: pageSize.format }
        : { width: pageSize.width, height: pageSize.height }),
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
    return Buffer.from(pdf);
  } finally {
    await context.close().catch(() => {});
  }
}

/** Render a full HTML document string to a PDF buffer at the given page size. */
export async function htmlToPdf(
  html: string,
  pageSize: PdfPageSize = { format: "A4" },
): Promise<Buffer> {
  try {
    return await renderOnce(html, pageSize);
  } catch (e) {
    // If the shared browser died (crash/OOM/close), force a fresh launch and
    // retry exactly once. getBrowser() will relaunch because the disconnected
    // instance was cleared.
    if (isBrowserGoneError(e)) {
      try {
        const dead = browserPromise;
        if (dead) {
          browserPromise = null;
          await dead.then((b) => b.close()).catch(() => {});
        }
      } catch {
        /* ignore cleanup errors */
      }
      return await renderOnce(html, pageSize);
    }
    throw e;
  }
}

export async function closePdfBrowser(): Promise<void> {
  const p = browserPromise;
  browserPromise = null;
  if (p) {
    await p.then((b) => b.close()).catch(() => {});
  }
}