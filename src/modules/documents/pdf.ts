import { chromium, type Browser } from "patchright";

let browserPromise: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true, channel: "chrome" });
  }
  return browserPromise;
}

/**
 * PDF page-size options.
 * - `{ format: "A4" }` — used for the AWB and Receipt (full-page documents).
 * - `{ width, height }` — used for the Shipping Bill (fixed-size courier label).
 */
export type PdfPageSize = { format: "A4" } | { width: string; height: string };

/** Render a full HTML document string to a PDF buffer at the given page size. */
export async function htmlToPdf(
  html: string,
  pageSize: PdfPageSize = { format: "A4" },
): Promise<Buffer> {
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