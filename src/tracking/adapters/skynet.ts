import type { CarrierAdapter, NormalizedTracking, TrackingEvent, ShipmentStatus } from "./types.js";

// SkyNet's tracking page (snwwe.com, ASP.NET MVC) does NOT server-render the
// visible tracking DOM. A plain GET returns the page with the tracking result
// embedded as a JavaScript object literal - `var data = { ... };` - inside a
// <script> block; jQuery then populates #dvTrack / #pShipmentNumber /
// #dvCreateTrackingHistory client-side on load. So scraping those DOM nodes
// with a non-JS HTTP client sees them EMPTY (they only fill once the browser
// runs the page's JS). We parse the embedded `data` object directly instead -
// it's a clean, fully-structured source with real timestamps and needs no
// browser. (The previous cheerio-based version was written against a rendered
// snapshot and returned null on the live page for this reason.)
//
// No auth, no cookies, no session handshake - a single GET.

const TRACK_URL = "https://snwwe.com/pk-en/track-shipment";

// Shape of each entry in the embedded data.tracksHistory array.
interface SkynetTrack {
  TracksEventName: string;      // "Out for Delivery"
  TracksEventTypeCode: string;  // "Case 4.2"
  TrackDateTime: string;        // ASP.NET "/Date(1782971100000)/" (local wall-clock, see note below)
  TrackDate: string;            // "Thursday, 2 July 2026"
  AmPmTime: string;             // "05:45 AM"
  TrackDetails: string;         // "Out for Delivery"
  TrackDetails1: string | null; // "Out with driver Nofil."
  CountryName: string | null;
  TrackCityName: string | null;
  TrackGeoLocation: string | null;
}

interface SkynetData {
  ShipmentNumber: string | null;
  Reference: string | null;
  Service: string | null;
  Destination: string | null;
  EstimatedTransitTime: string | null;
  IsPODAvailable: unknown;
  tracksHistory: SkynetTrack[];
}

function mapStatus(statusText: string): ShipmentStatus {
  const t = statusText.toLowerCase();
  if (t.includes("delivered") && !t.includes("out for delivery")) return "delivered";
  if (t.includes("out for delivery")) return "out_for_delivery";
  if (
    t.includes("transit") ||
    t.includes("hub") ||
    t.includes("sorted") ||
    t.includes("customs") ||
    t.includes("collection") ||
    t.includes("departed") ||
    t.includes("arrived") ||
    t.includes("received by")
  ) {
    return "in_transit";
  }
  if (t.includes("information received") || t.includes("booked") || t.includes("shipment created")) {
    return "info_received";
  }
  if (t.includes("exception") || t.includes("failed") || t.includes("held") || t.includes("delay")) {
    return "exception";
  }
  console.warn(`SkyNet: unmapped status "${statusText}"`);
  return "unknown";
}

// Extract the `var data = { ... };` object literal from the page HTML by
// brace-matching (the object contains nested arrays/objects, so a regex won't
// do). Returns null if the marker isn't present.
function extractDataObject(html: string): SkynetData | null {
  const marker = html.indexOf("var data=");
  const markerLoose = marker === -1 ? html.indexOf("var data =") : marker;
  if (markerLoose === -1) return null;

  const braceStart = html.indexOf("{", markerLoose);
  if (braceStart === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = braceStart; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) return null;

  try {
    return JSON.parse(html.slice(braceStart, end)) as SkynetData;
  } catch {
    return null;
  }
}

// SkyNet serializes each event time as an ASP.NET "/Date(<epochMillis>)/"
// string. Cross-checked against the displayed local time (e.g. epoch
// 1782971100000 -> 2026-07-02T05:45:00 UTC, shown as "05:45 AM" in Dubai):
// the epoch encodes the LOCAL wall-clock instant as-if-UTC, not a true UTC
// instant. So we surface the local wall-clock time WITHOUT a Z/offset suffix -
// matching how the DPD/APX adapters represent timezone-less local timestamps -
// rather than falsely stamping it as UTC. Falls back to the raw TrackDate +
// AmPmTime string if the epoch can't be parsed.
function toLocalIso(track: SkynetTrack): string {
  const m = /\/Date\((\d+)\)\//.exec(track.TrackDateTime || "");
  if (m) {
    const d = new Date(Number(m[1]));
    if (!isNaN(d.getTime())) {
      // Build "YYYY-MM-DDTHH:mm:ss" from the UTC components (no Z), since the
      // epoch already carries the local wall-clock time in its UTC fields.
      return d.toISOString().replace(/\.\d{3}Z$/, "");
    }
  }
  const fallback = `${track.TrackDate ?? ""} ${track.AmPmTime ?? ""}`.trim();
  return fallback || new Date().toISOString();
}

export const skynetAdapter: CarrierAdapter = {
  carrierName: "snwwe",

  async track(trackingNumber: string): Promise<NormalizedTracking | null> {
    const res = await fetch(`${TRACK_URL}?AWB=${encodeURIComponent(trackingNumber)}`, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`SkyNet: request failed (${res.status})`);
    const html = await res.text();

    const data = extractDataObject(html);
    if (!data) return null;

    // "Not found" detection: SkyNet is deceptive here. For an unknown/invalid
    // AWB it STILL returns a populated data object - ShipmentNumber is echoed
    // back as whatever was queried, and Destination/Reference can even contain
    // stale-looking values. Verified live: querying a bogus "000000000000"
    // returns ShipmentNumber="000000000000", a real-looking Destination, and
    // an EMPTY tracksHistory. So the only trustworthy signal that the shipment
    // actually exists is a non-empty tracksHistory - not the presence of a
    // ShipmentNumber.
    const history = Array.isArray(data.tracksHistory) ? data.tracksHistory : [];
    if (history.length === 0) return null;

    // Confirmed ordering: tracksHistory comes back newest-first (index 0 is the
    // most recent event), so no re-sorting is needed.
    const events: TrackingEvent[] = history.map((h) => {
      const description = [h.TrackDetails, h.TrackDetails1]
        .map((s) => (s ?? "").trim())
        .filter(Boolean)
        // De-dupe when TrackDetails and TrackDetails1 are identical.
        .filter((s, i, arr) => arr.indexOf(s) === i)
        .join(" - ");
      const location = [h.TrackCityName, h.CountryName]
        .map((s) => (s ?? "").trim())
        .filter(Boolean)
        .join(", ");
      return {
        timestamp: toLocalIso(h),
        location: location || null,
        description: description || h.TracksEventName || "",
      };
    });

    const latest = events[0];
    const latestName = history[0]?.TracksEventName ?? latest?.description ?? "";

    return {
      carrier: "snwwe",
      trackingNumber: data.ShipmentNumber ?? trackingNumber,
      status: mapStatus(latestName),
      statusText: latestName || "No status available",
      estimatedDelivery: data.EstimatedTransitTime || null,
      events,
      raw: data,
      fetchedAt: new Date().toISOString(),
    };
  },
};
