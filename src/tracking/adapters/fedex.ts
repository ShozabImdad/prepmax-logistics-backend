import { chromium, type Browser } from "patchright";
import type { CarrierAdapter, NormalizedTracking, TrackingEvent, ShipmentStatus } from "./types.js";

// FedEx's guest tracking data comes from https://api.fedex.com/track/v2/shipments,
// called by www.fedex.com/wtrk/track/?trknbr=<num> (x-clientid: WTRK - this is
// the public website's internal tracking API, not FedEx's official developer
// Track API). Same Akamai family of protection as UPS/DHL: request carries
// ak_bmsc, bm_sz, bm_mi, bm_sv, _abck cookies that only a real browser session
// can produce, so we drive Patchright to the real page and intercept the
// response instead of replicating the call with fetch().
//
// One difference from UPS/DHL worth noting: the "authorization: Bearer <token>"
// header in the capture is a short, non-JWT-looking string (no header.payload.
// signature dot structure) - reads as a fixed guest token baked into FedEx's JS
// bundle rather than a per-session credential. We don't need to reconstruct or
// reuse it directly either way, since letting the page fire its own request
// means the page supplies whatever auth it wants automatically.
//
// Confirmed from your capture (fedex_curl.txt / fedex_response.txt):
//   - POST https://api.fedex.com/track/v2/shipments
//   - response.output.packages[0] has keyStatusCD / lastScanStatus /
//     lastScanDateTime (ISO w/ offset, e.g. "2026-07-01T14:08:41-04:00") and
//     scanEventList (full event history, newest first, each with separate
//     date/time/gmtOffset fields that concatenate directly into valid ISO 8601)
//   - ppodImage field is a large base64 proof-of-delivery photo - stripped out
//     before storing raw, since it's large and not needed for tracking display

// IMPORTANT: FedEx must run HEADED (headless: false). Verified live 2026-07-02:
// in headless mode Akamai blocks the /track/v2/shipments POST outright - the
// request fails with net::ERR_FAILED and the page redirects to
// /fedextrack/system-error, so no data is ever returned. The exact same code +
// tracking number in headed mode returns HTTP 200 with the real data. (DHL and
// UPS both work headless; FedEx's Akamai config is stricter.)
//
// On a headless server (Linux VPS) this requires a virtual display - run under
// Xvfb (e.g. `xvfb-run node ...`). On a desktop OS it works as-is. If a fully
// headless setup is required later, the fallback is a managed anti-bot API
// (ZenRows/Scrapfly/Scrapeless) - see CLAUDE.md section 3.
let browserPromise: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: false, channel: "chrome" });
  }
  return browserPromise;
}

// Call this on process shutdown to release the shared browser instance.
export async function closeFedexBrowser(): Promise<void> {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
  }
}

interface FedexScanEvent {
  date: string;        // "2026-07-01"
  time: string;         // "14:08:41"
  gmtOffset: string;    // "-04:00"
  status: string;
  statusCD: string;
  scanLocation: string;
  scanDetails: string;
  exception: boolean;
}

interface FedexPackage {
  trackingNbr: string;
  keyStatus: string;
  keyStatusCD: string;
  lastScanStatus: string;
  lastScanDateTime: string;
  estDeliveryDt: string;
  actDeliveryDt: string;
  scanEventList: FedexScanEvent[];
  ppodImage?: string;
  notFound?: boolean;
  invalid?: boolean;
}

interface FedexTrackResponse {
  transactionId: string;
  output: { packages: FedexPackage[] };
}

// FedEx's statusCD short codes (from keyStatusCD and scanEventList[].statusCD).
// Only DL, OD, AR, DP, PU, OC confirmed directly from your sample - the rest
// of this table is FedEx's documented set. Falls back to keyword matching on
// the human-readable status text, then logs anything still unmapped.
const STATUS_CD_MAP: Record<string, ShipmentStatus> = {
  DL: "delivered",
  OD: "out_for_delivery",
  AR: "in_transit",
  DP: "in_transit",
  PU: "in_transit",
  OC: "info_received",
  CA: "exception",   // cancelled
  SE: "exception",   // shipment exception
};

function mapStatus(pkg: FedexPackage): ShipmentStatus {
  const byCode = STATUS_CD_MAP[pkg.keyStatusCD];
  if (byCode) return byCode;

  const t = (pkg.keyStatus || "").toLowerCase();
  if (t.includes("delivered")) return "delivered";
  if (t.includes("out for delivery") || t.includes("on fedex vehicle")) return "out_for_delivery";
  if (t.includes("transit") || t.includes("departed") || t.includes("arrived") || t.includes("picked up")) return "in_transit";
  if (t.includes("information sent") || t.includes("label")) return "info_received";
  if (t.includes("exception") || t.includes("delay") || t.includes("held") || t.includes("cancel")) return "exception";

  console.warn(`FedEx: unmapped keyStatusCD "${pkg.keyStatusCD}" / keyStatus "${pkg.keyStatus}" - extend STATUS_CD_MAP`);
  return "unknown";
}

export const fedexAdapter: CarrierAdapter = {
  carrierName: "fedex",

  async track(trackingNumber: string): Promise<NormalizedTracking | null> {
    const browser = await getBrowser();
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    try {
      // Wait for the SUCCESSFUL shipments POST. Guarding on res.ok() means we
      // skip any Akamai challenge/interstitial and wait for the real data.
      const responsePromise = page.waitForResponse(
        (res) =>
          res.url().includes("/track/v2/shipments") &&
          res.request().method() === "POST" &&
          res.ok(),
        { timeout: 30000 },
      );

      await page.goto(
        `https://www.fedex.com/wtrk/track/?trknbr=${encodeURIComponent(trackingNumber)}`,
        { waitUntil: "domcontentloaded", timeout: 30000 },
      );

      const response = await responsePromise;
      const data = (await response.json()) as FedexTrackResponse;

      const pkg = data.output?.packages?.[0];
      if (!pkg || pkg.notFound || pkg.invalid) {
        return null;
      }

      const events: TrackingEvent[] = (pkg.scanEventList || [])
        .map((e) => ({
          timestamp: `${e.date}T${e.time}${e.gmtOffset}`,
          location: e.scanLocation || null,
          description: [e.status, e.scanDetails].filter(Boolean).join(" - "),
        }))
        // scanEventList already comes back newest-first in the sample, but
        // sort defensively rather than trust ordering across all shipments.
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

      // Strip the ppodImage (proof-of-delivery photo, can be 30-50KB+) out of
      // `raw` before storing - it bloats whatever store this ends up in. But
      // surface it separately as a ready-to-display data URI on
      // proofOfDeliveryImage, since a POD photo is genuinely useful for the
      // customer portal.
      //
      // Format quirk (verified from a live response, NOT assumed): ppodImage is
      // base64-encoded base64-JPEG - i.e. double-encoded. Decoding it once
      // yields a base64 JPEG string beginning "/9j/" (decoding twice yields raw
      // JPEG bytes ff d8 ff). So we decode exactly once, then prefix the JPEG
      // data-URI header.
      const { ppodImage, ...pkgWithoutImage } = pkg;
      let proofOfDeliveryImage: string | null = null;
      if (ppodImage) {
        try {
          const innerB64 = Buffer.from(ppodImage, "base64").toString("utf8");
          if (innerB64.startsWith("/9j/")) {
            proofOfDeliveryImage = `data:image/jpeg;base64,${innerB64}`;
          }
        } catch {
          proofOfDeliveryImage = null; // malformed - just omit the photo
        }
      }

      const result: NormalizedTracking = {
        carrier: "fedex",
        trackingNumber: pkg.trackingNbr,
        status: mapStatus(pkg),
        statusText: pkg.keyStatus,
        estimatedDelivery: pkg.estDeliveryDt || null,
        events,
        proofOfDeliveryImage,
        raw: { ...data, output: { packages: [pkgWithoutImage] } },
        fetchedAt: new Date().toISOString(),
      };

      return result;
    } finally {
      await context.close();
    }
  },
};
