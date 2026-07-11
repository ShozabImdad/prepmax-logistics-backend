// HTML -> A4 PDF via headless Chromium (Patchright — already a dependency for
// the tracking adapters, so no new package). One shared browser instance is
// reused across renders since launching Chromium is the expensive part.

import { chromium, type Browser } from "patchright";

let browserPromise: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    // Use the system Chrome (channel: "chrome") like the tracking adapters, so
    // we reuse the installed browser instead of Patchright's separate bundled
    // Chromium download (which isn't installed on the server).
    browserPromise = chromium.launch({ headless: true, channel: "chrome" });
  }
  return browserPromise;
}

/** Render a full HTML document string to an A4 PDF buffer. */
export async function htmlToPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" }, // templates own their margins
    });
    return Buffer.from(pdf);
  } finally {
    await context.close();
  }
}

export async function closePdfBrowser(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close();
    browserPromise = null;
  }
}
