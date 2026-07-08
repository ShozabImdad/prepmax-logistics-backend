import { chromium, type Browser } from "patchright";
import type { CarrierAdapter, NormalizedTracking, TrackingEvent, ShipmentStatus } from "./types.js";

// UPS's tracking data comes from https://webapis.ups.com/track/api/Track/GetStatus,
// which sits behind Akamai Bot Manager - same family of protection as DHL.
// The request needs a matched CSRF pair (X-XSRF-TOKEN-ST cookie <-> x-xsrf-token
// header, both the same value) plus Akamai sensor cookies (ak_bmsc, bm_sz, bm_so,
// bm_ss, _abck). Those Akamai cookies are produced by a JS sensor script that
// fingerprints a real browser session - they can't be faked with a plain fetch(),
// so like DHL we drive a real (headless) browser to the actual tracking page and
// let the page's own JS fire the request naturally, then intercept the response.
//
// Confirmed from your capture (ups_curl.txt / ups_reponse.txt):
//   - POST https://webapis.ups.com/track/api/Track/GetStatus?loc=en_PK
//   - body: { Locale, TrackingNumber: [num], isBarcodeScanned: false,
//             Requester: "st", ClientUrl }
//   - response.trackDetails[0] has packageStatus / packageStatusType /
//     shipmentProgressActivities (full event history) / milestones (summary
//     checkpoints only - fewer entries than shipmentProgressActivities)
//   - each event carries gmtDate ("20260626") + gmtTime ("14:25:00"), which
//     is already a UTC instant (verified: local "26/06/2026 10:25" at
//     offset -04:00 = 14:25 UTC) - much cleaner to build ISO timestamps from
//     than the localized date/time fields.

let browserPromise: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true, channel: "chrome" });
  }
  return browserPromise;
}

interface UpsActivity {
  gmtDate: string;   // "20260626"
  gmtTime: string;   // "14:25:00"
  location: string;
  activityScan: string;
  actCode: string;
}

interface UpsTrackDetail {
  requestedTrackingNumber: string;
  errorCode: string | null;
  errorText: string | null;
  packageStatus: string;        // "Delivered", "In Transit", etc. (display text)
  packageStatusType: string;    // "D", "I", "O", ... (short code, more stable to match on)
  scheduledDeliveryDayCMSKey?: string;
  shipmentProgressActivities: UpsActivity[];
}

interface UpsGetStatusResponse {
  statusCode: string;
  trackDetails: UpsTrackDetail[];
}

// UPS's packageStatusType codes observed/documented. We've only directly seen
// "D" (Delivered) so far - the rest are UPS's known short-code set. If a
// tracking response comes back with a code not in this table, we fall back to
// keyword-matching packageStatus (the human-readable text) and log it so the
// table can be extended.
const STATUS_TYPE_MAP: Record<string, ShipmentStatus> = {
  D: "delivered",
  I: "in_transit",
  O: "out_for_delivery",
  M: "info_received",  // "Manifest" / label created, not yet picked up
  X: "exception",
  P: "exception",       // returned to shipper
};

function mapStatus(detail: UpsTrackDetail): ShipmentStatus {
  const byCode = STATUS_TYPE_MAP[detail.packageStatusType];
  if (byCode) return byCode;

  const t = (detail.packageStatus || "").toLowerCase();
  if (t.includes("delivered")) return "delivered";
  if (t.includes("out for delivery")) return "out_for_delivery";
  if (t.includes("transit") || t.includes("on the way") || t.includes("departed") || t.includes("arrived")) return "in_transit";
  if (t.includes("label") || t.includes("order received") || t.includes("not received")) return "info_received";
  if (t.includes("exception") || t.includes("delay") || t.includes("held") || t.includes("returned")) return "exception";

  console.warn(`UPS: unmapped packageStatusType "${detail.packageStatusType}" / packageStatus "${detail.packageStatus}" - extend STATUS_TYPE_MAP`);
  return "unknown";
}

function toIsoUtc(gmtDate: string, gmtTime: string): string {
  // gmtDate "20260626" -> "2026-06-26", gmtTime "14:25:00" already UTC.
  const y = gmtDate.slice(0, 4);
  const m = gmtDate.slice(4, 6);
  const d = gmtDate.slice(6, 8);
  return `${y}-${m}-${d}T${gmtTime}Z`;
}

// Sentinel thrown by a single attempt when Akamai transiently blocks the
// GetStatus POST (net::ERR_FAILED) or the response never arrives (timeout).
// This is distinct from a genuine "not found" (which returns null) - a block
// is retryable with a fresh browser context, a not-found is not.
class UpsBlockedError extends Error {}

// One attempt in a fresh context. Returns NormalizedTracking on success, null
// on genuine not-found, or throws UpsBlockedError if Akamai blocked this
// session (caller should retry with a new context).
async function attempt(browser: Browser, trackingNumber: string): Promise<NormalizedTracking | null> {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    // Match the SUCCESSFUL GetStatus POST. Akamai can serve a 428 proof-of-work
    // challenge on the first call (confirmed on DHL's equivalent endpoint); the
    // page solves it and retries. Guarding on res.ok() means we wait for the
    // real data response rather than latching onto a challenge/interstitial.
    const responsePromise = page.waitForResponse(
      (res) =>
        res.url().includes("/track/api/Track/GetStatus") &&
        res.request().method() === "POST" &&
        res.ok(),
      // 20s not 30s: a real success arrives in <12s, and a blocked session
      // usually fails fast with ERR_FAILED. The shorter cap keeps the total
      // retry budget reasonable when a session hangs instead of failing.
      { timeout: 20000 },
    );

    await page.goto(
      `https://www.ups.com/track?loc=en_PK&tracknum=${encodeURIComponent(trackingNumber)}&requester=ST/trackdetails`,
      { waitUntil: "domcontentloaded", timeout: 30000 },
    );

    const response = await responsePromise;
    const data = (await response.json()) as UpsGetStatusResponse;

    const detail = data.trackDetails?.[0];
    if (!detail || detail.errorCode) {
      return null; // genuine not-found - do NOT retry
    }

    const events: TrackingEvent[] = (detail.shipmentProgressActivities || [])
      .map((a) => ({
        timestamp: toIsoUtc(a.gmtDate, a.gmtTime),
        location: a.location || null,
        description: a.activityScan?.trim() || "",
      }))
      // API already returns newest-first based on the sample - keep as-is, but
      // sort defensively in case that's not guaranteed for every shipment.
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

    return {
      carrier: "ups",
      trackingNumber: detail.requestedTrackingNumber,
      status: mapStatus(detail),
      statusText: detail.packageStatus,
      estimatedDelivery: null, // not present on this delivered sample - populate once we see an in-transit response with scheduledDeliveryDateDetail
      events,
      raw: data,
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // net::ERR_FAILED (Akamai hard-blocks the POST) and waitForResponse
    // timeouts (the ok() response never came) are both transient blocks -
    // signal the caller to retry with a fresh context.
    if (msg.includes("ERR_FAILED") || msg.includes("Timeout") || msg.includes("net::")) {
      throw new UpsBlockedError(msg);
    }
    throw err;
  } finally {
    await context.close();
  }
}

export const upsAdapter: CarrierAdapter = {
  carrierName: "ups",

  async track(trackingNumber: string): Promise<NormalizedTracking | null> {
    const browser = await getBrowser();
    // UPS's Akamai blocks the GetStatus POST on a subset of sessions
    // (net::ERR_FAILED), intermittently - measured ~1 in 3 fails, and a fresh
    // context usually succeeds. Retry the block up to 3 times before giving up.
    const MAX_ATTEMPTS = 4;
    let lastBlock: unknown;
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      try {
        return await attempt(browser, trackingNumber);
      } catch (err) {
        if (err instanceof UpsBlockedError) {
          lastBlock = err;
          console.warn(`UPS: Akamai blocked attempt ${i}/${MAX_ATTEMPTS} for ${trackingNumber}${i < MAX_ATTEMPTS ? " - retrying with a fresh context" : ""}`);
          continue;
        }
        throw err; // real error - don't retry
      }
    }
    throw new Error(
      `UPS: Akamai blocked all ${MAX_ATTEMPTS} attempts for ${trackingNumber} (last: ${lastBlock instanceof Error ? lastBlock.message : String(lastBlock)}). ` +
        `Try again, or see CLAUDE.md §8 (datacenter-IP mitigations / official UPS API).`,
    );
  },
};
