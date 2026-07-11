import type { CarrierAdapter, NormalizedTracking, TrackingEvent, ShipmentStatus } from "./types.js";

// APX Logistics runs on Laravel. Laravel issues a CSRF token per session that
// must be sent back as `_token` in the POST body. The token lives in the
// page HTML (meta tag or hidden input) and is bound to the laravel_session
// cookie - you can't reuse a token from a different session.
//
// NOTE: this domain isn't reachable from Claude's sandboxed environment
// (non-standard port, not on the network allowlist), so this adapter is
// written from the Laravel CSRF pattern + your captured request, but it
// has NOT been run end-to-end by Claude. Test it directly and report back
// if something doesn't line up - especially the CSRF token extraction,
// since the exact HTML location is a best guess based on Laravel's usual
// conventions, not something confirmed from your capture.

const BASE = "https://smartcargo-apx.pk:8080";

interface ApxTrackingEvent {
  statusDate: string; // "2026-06-22"
  statusTime: string; // "19:52"
  status: string;
  location: string;
}

interface ApxResponse {
  success: boolean;
  responseCode: number;
  data: {
    cnNo: number;
    trackingNo: string;
    origin: string;
    destination: string;
    delivered: string;      // non-empty string when delivered
    deliveredDate: string;
    trackingStatus: ApxTrackingEvent[];
  };
}

interface Session {
  cookies: string;   // combined Cookie header value
  csrfToken: string;
}

/**
 * Build a valid ISO-ish local timestamp from APX's separate date + time fields.
 * `statusTime` can be "19:52", "19:52:33", or empty. Empty → midnight so the
 * result stays a valid date (parseable, sortable) instead of "2026-07-10T:00".
 */
function buildApxTimestamp(statusDate: string, statusTime: string): string {
  const date = (statusDate ?? "").trim();
  const time = (statusTime ?? "").trim();
  if (!date) return date; // nothing usable; leave as-is for the sync layer
  if (!time) return `${date}T00:00:00`;
  // Ensure HH:MM:SS (append :00 seconds only when just HH:MM was given).
  const parts = time.split(":");
  const withSeconds = parts.length >= 3 ? time : `${time}:00`;
  return `${date}T${withSeconds}`;
}

async function getSession(): Promise<Session> {
  const res = await fetch(`${BASE}/`, {
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!res.ok) throw new Error(`APX: failed to load tracking page (${res.status})`);

  // fetch() merges multiple Set-Cookie headers into one string in some
  // runtimes and not others - if this comes back empty on your platform,
  // switch to a client that exposes raw headers (e.g. undici with
  // res.headers.getSetCookie(), or axios with a cookie jar).
  const setCookie = res.headers.get("set-cookie") ?? "";
  const laravelSession = setCookie.match(/laravel_session=([^;]+)/)?.[1];
  const xsrfCookie = setCookie.match(/XSRF-TOKEN=([^;]+)/)?.[1];
  if (!laravelSession || !xsrfCookie) {
    throw new Error("APX: session cookies not found - page structure may have changed");
  }

  const html = await res.text();
  // Try the two most common Laravel patterns for exposing the token to JS/forms.
  const csrfToken =
    html.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1] ??
    html.match(/name="_token"\s+value="([^"]+)"/)?.[1];
  if (!csrfToken) {
    throw new Error("APX: could not find CSRF token in page HTML - inspect the page source and adjust the regex above");
  }

  return {
    cookies: `XSRF-TOKEN=${xsrfCookie}; laravel_session=${laravelSession}`,
    csrfToken,
  };
}

function mapStatus(statusText: string, delivered: string): ShipmentStatus {
  if (delivered && delivered.trim() !== "") return "delivered";
  const t = statusText.toLowerCase();
  if (t.includes("delivered")) return "delivered";
  if (t.includes("out for delivery")) return "out_for_delivery";
  if (
    t.includes("transit") ||
    t.includes("departed") ||
    t.includes("arrived") ||
    t.includes("picked up") ||
    t.includes("processed") ||
    t.includes("processing") ||
    t.includes("manifested") ||
    t.includes("custom")
  ) {
    return "in_transit";
  }
  if (t.includes("booked")) return "info_received";
  if (t.includes("held") || t.includes("delay") || t.includes("exception")) return "exception";
  console.warn(`APX: unmapped status "${statusText}"`);
  return "unknown";
}

export const apxAdapter: CarrierAdapter = {
  carrierName: "smartcargo-apx",

  async track(trackingNumber: string): Promise<NormalizedTracking | null> {
    const session = await getSession();

    // NOTE (confirmed with client): `refno` maps to APX's internal CN
    // number (e.g. 1350228267), NOT the DPD-style tracking number format
    // seen elsewhere in their responses. The internal `shipment_legs.
    // carrier_tracking_number` you store for APX legs should be this CN
    // number format.
    const body = new URLSearchParams({ _token: session.csrfToken, refno: trackingNumber });
    const res = await fetch(`${BASE}/gettracking`, {
      method: "POST",
      headers: {
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        cookie: session.cookies,
        origin: BASE,
        referer: `${BASE}/`,
        "x-requested-with": "XMLHttpRequest",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      body: body.toString(),
    });

    if (!res.ok) throw new Error(`APX: tracking request failed (${res.status})`);
    const json = (await res.json()) as ApxResponse;
    if (!json.success || !json.data) return null;

    // De-duplicate consecutive identical events - the sample response had
    // the same "Shipment booked" event twice in a row.
    const seen = new Set<string>();
    const events: TrackingEvent[] = json.data.trackingStatus
      .filter((e) => {
        const key = `${e.statusDate}${e.statusTime}${e.status}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((e) => ({
        // No timezone given - treat as Pakistan local time. Some milestone
        // events (e.g. SHIPMENT DEPARTED / ARRIVED) carry a date but an EMPTY
        // statusTime; building `${date}T${time}:00` then yields an invalid
        // "2026-07-10T:00". Fall back to midnight so the timestamp stays valid
        // (and sorts by date) instead of becoming NULL/"Invalid Date".
        timestamp: buildApxTimestamp(e.statusDate, e.statusTime),
        location: e.location?.trim() || null,
        description: e.status.replace(/`/g, "").trim(), // sample data had a stray backtick
      }))
      .reverse(); // API returns oldest-first; normalize to newest-first

    const latest = events[0];

    return {
      carrier: "smartcargo-apx",
      trackingNumber: json.data.trackingNo || String(json.data.cnNo),
      status: mapStatus(latest?.description ?? "", json.data.delivered),
      statusText: latest?.description ?? "No status available",
      estimatedDelivery: json.data.deliveredDate || null,
      events,
      raw: json,
      fetchedAt: new Date().toISOString(),
    };
  },
};
