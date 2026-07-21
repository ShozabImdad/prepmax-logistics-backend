import type { CarrierAdapter, NormalizedTracking, TrackingEvent, ShipmentStatus } from "./types.js";

// EMX (Emirates Post, UAE — emx.ae). Their tracking page is a Next.js app whose
// result comes from the `_next/data` JSON endpoint:
//   https://www.emx.ae/_next/data/<BUILD_ID>/en/all-services/track-a-package/step-two.json?q=<no>&slug=...
// The tracking payload lives at pageProps.pageContext.extraData — a clean,
// fully-structured JSON (status + result[].events[]), so no HTML parsing.
//
// The <BUILD_ID> in the URL is Next.js's per-deploy build hash and CHANGES every
// time EMX redeploys their site — hardcoding it would silently break the adapter
// on their next deploy. So we DISCOVER the current build id at request time by
// fetching the tracking page and reading `"buildId":"…"` from its embedded
// __NEXT_DATA__. A known-good id is kept only as a last-resort fallback, and the
// discovered id is memoised for the process lifetime.
//
// Verified live (2026-07) against 1000044378708: Delivered, Dubai, 5 events.

const ORIGIN = "https://www.emx.ae";
const TRACK_PAGE = `${ORIGIN}/all-services/track-a-package`;
// Fallback only — the live build id is discovered dynamically (see getBuildId).
const FALLBACK_BUILD_ID = "YAg_tyg2h-WnQlH_94XUj";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// ── EMX response shapes (only the fields we use) ────────────────────────────
interface EmxEvent {
  timeStamp: string; // "17/07/2026 11:20:10 AM" (UAE local, DD/MM/YYYY hh:mm:ss AM/PM)
  status: { code: string; descriptionEn: string; descriptionAr?: string };
  locationEn: string | null;
  locationAr?: string | null;
  url?: string;
}
interface EmxResult {
  trackingNumber: string;
  trackingReferenceNo?: string;
  sender?: { name?: string; contactNumber?: string };
  receiver?: { name?: string; contactNumber?: string };
  lastStatus?: { code: string; descriptionEn: string };
  events?: EmxEvent[] | null;
}
interface EmxExtraData {
  status?: string; // "success" | "not-found" | ...
  result?: EmxResult[] | null;
}

let cachedBuildId: string | null = null;

// Discover the current Next.js build id from the tracking page's __NEXT_DATA__.
// Memoised. Falls back to FALLBACK_BUILD_ID if discovery fails for any reason.
async function getBuildId(): Promise<string> {
  if (cachedBuildId) return cachedBuildId;
  try {
    const res = await fetch(TRACK_PAGE, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    });
    if (res.ok) {
      const html = await res.text();
      const m = /"buildId":"([^"]+)"/.exec(html);
      if (m?.[1]) {
        cachedBuildId = m[1];
        return cachedBuildId;
      }
    }
  } catch {
    // fall through to fallback
  }
  return FALLBACK_BUILD_ID;
}

function dataUrl(buildId: string, trackingNumber: string): string {
  const q = encodeURIComponent(trackingNumber);
  return (
    `${ORIGIN}/_next/data/${buildId}/en/all-services/track-a-package/step-two.json` +
    `?q=${q}&slug=all-services&slug=track-a-package&slug=step-two`
  );
}

function mapStatus(descriptionEn: string, code: string): ShipmentStatus {
  const t = (descriptionEn || "").toLowerCase();
  const c = (code || "").toUpperCase();
  // Delivered.
  if (c === "CLC12" || t.includes("delivered")) return "delivered";
  // Out for delivery.
  if (c === "CLC11" || t.includes("out for delivery")) return "out_for_delivery";
  // Terminal/exception-ish states.
  if (
    t.includes("returned") ||
    t.includes("undelivered") ||
    t.includes("failed") ||
    t.includes("terminated") ||
    t.includes("held") ||
    t.includes("customs hold") ||
    t.includes("exception") ||
    t.includes("redirect") ||
    t.includes("refused") ||
    t.includes("not delivered")
  ) {
    return "exception";
  }
  // Before it's physically received by EMX.
  if (c === "CLC0" || t.includes("yet to be received") || t.includes("information received") || t.includes("registered")) {
    return "info_received";
  }
  // Everything else that's a real scan = in transit.
  if (
    t.includes("received") ||
    t.includes("processing") ||
    t.includes("sorted") ||
    t.includes("in transit") ||
    t.includes("transit") ||
    t.includes("forwarded") ||
    t.includes("dispatch") ||
    t.includes("departed") ||
    t.includes("arrived") ||
    t.includes("customs") ||
    t.includes("export") ||
    t.includes("import") ||
    t.includes("facility") ||
    t.includes("hub")
  ) {
    return "in_transit";
  }
  console.warn(`EMX: unmapped status "${descriptionEn}" (code ${code})`);
  return "unknown";
}

// Parse "17/07/2026 11:20:10 AM" (DD/MM/YYYY hh:mm:ss AM/PM, UAE local) into a
// local ISO string WITHOUT a Z/offset — matching how the other timezone-less
// adapters (DPD/APX/SkyNet/Pakistan Post) represent local wall-clock times.
// Falls back to the raw string if it doesn't match the expected shape.
function toLocalIso(ts: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)?$/i.exec((ts || "").trim());
  if (!m) return ts || new Date().toISOString();
  const [, dd, mm, yyyy, hhRaw, min, sec, ap] = m;
  let hh = Number(hhRaw);
  if (ap) {
    const upper = ap.toUpperCase();
    if (upper === "PM" && hh !== 12) hh += 12;
    if (upper === "AM" && hh === 12) hh = 0;
  }
  return `${yyyy}-${mm}-${dd}T${String(hh).padStart(2, "0")}:${min}:${sec}`;
}

async function fetchTracking(buildId: string, trackingNumber: string): Promise<EmxExtraData | null> {
  const res = await fetch(dataUrl(buildId, trackingNumber), {
    headers: { "user-agent": UA, accept: "application/json" },
  });
  // A stale/invalid build id yields 404 — signal the caller to re-discover.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`EMX: request failed (${res.status})`);
  const json = (await res.json()) as {
    pageProps?: { pageContext?: { extraData?: EmxExtraData } };
  };
  return json.pageProps?.pageContext?.extraData ?? { status: "not-found", result: [] };
}

export const emxAdapter: CarrierAdapter = {
  carrierName: "emx",

  async track(trackingNumber: string): Promise<NormalizedTracking | null> {
    let buildId = await getBuildId();
    let data = await fetchTracking(buildId, trackingNumber);

    // If the memoised build id was stale (404), re-discover once and retry.
    if (data === null) {
      cachedBuildId = null;
      buildId = await getBuildId();
      data = await fetchTracking(buildId, trackingNumber);
      if (data === null) return null; // still 404 after refresh → give up
    }

    // Not-found: EMX returns status !== 'success', an empty result, or a result
    // with no events for a number it doesn't recognise (verified live: a
    // malformed query returns status 'not-found' with null events).
    if (!data || data.status !== "success") return null;
    const result = Array.isArray(data.result) ? data.result[0] : null;
    const rawEvents = result?.events;
    if (!result || !Array.isArray(rawEvents) || rawEvents.length === 0) return null;

    // EMX returns events newest-first already; keep that order (contract wants
    // newest-first). Map to normalized events.
    const events: TrackingEvent[] = rawEvents.map((e) => ({
      timestamp: toLocalIso(e.timeStamp),
      location: (e.locationEn ?? "").trim() || null,
      description: (e.status?.descriptionEn ?? "").trim() || "Shipment update",
    }));

    const latest = rawEvents[0];
    const latestDesc = latest?.status?.descriptionEn ?? result.lastStatus?.descriptionEn ?? "";
    const latestCode = latest?.status?.code ?? result.lastStatus?.code ?? "";

    return {
      carrier: "emx",
      trackingNumber: result.trackingNumber || trackingNumber,
      status: mapStatus(latestDesc, latestCode),
      statusText: latestDesc || "No status available",
      estimatedDelivery: null, // EMX doesn't provide a structured ETA here
      events,
      raw: data,
      fetchedAt: new Date().toISOString(),
    };
  },
};
