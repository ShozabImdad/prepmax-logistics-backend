import type { CarrierAdapter, NormalizedTracking, TrackingEvent, ShipmentStatus } from "./types.js";

// DPD UK has no bot-protection on the tracking API itself, but it requires
// a session cookie that gets issued when you first hit the public tracking
// page. Flow: GET the tracking page -> capture Set-Cookie -> call the two
// JSON endpoints with that cookie attached.

const BASE_PAGE = "https://track.dpd.co.uk";
const API_BASE = "https://apis.track.dpd.co.uk/v1/parcels";
const REFERENCE_API = "https://apis.track.dpd.co.uk/v1/reference";

// DPD's parcel API only accepts a full "parcelCode": <digits>*<5 digits>,
// e.g. "15505502876195*21358" (the API literally validates against
// /^\d+\*\d{5}$/ and 400s anything else). But upstream carriers hand us the
// shorter DPD *consignment* / reference number instead - e.g. APX/SmartCargo's
// response gives DPD legs as "5502876195", which is DPD's consignmentNumber,
// NOT the parcelCode. The prefix ("1550") and the "*NNNNN" suffix are
// parcel-level values that do NOT appear in the consignment number and cannot
// be derived from it (verified: they're absent from APX's entire response, and
// the suffix even differs from the one embedded in DPD's own consignmentCode).
//
// DPD's own website resolves this via a reference-lookup endpoint, so we do the
// same: given a bare reference number, GET /v1/reference?referenceNumber=<n>
// and read back the full parcelCode, then track that normally.
const PARCEL_CODE_RE = /^\d+\*\d{5}$/;

interface DpdStatusResponse {
  data: {
    parcelCode: string;
    parcelNumber: string;
    trackingStatusCurrent: string;
    parcelStatusType: number;
    shipmentDate: string;
  };
}

interface DpdEventsResponse {
  data: Array<{
    eventDate: string;      // "2026-07-01 23:49:00" - no explicit TZ, treat as Europe/London
    eventLocation: string;
    eventText: string;
  }>;
}

// Best-effort session cookie. As of the last live test (2026-07) the DPD
// tracking API (apis.track.dpd.co.uk) responds fine with no cookie at all -
// the homepage is now a statically-cached page that issues no Set-Cookie.
// So we attach a cookie only if the site still hands one out, and otherwise
// proceed cookie-less rather than failing the whole lookup.
//
// Note: Node's native fetch (undici) exposes multiple Set-Cookie values only
// via headers.getSetCookie(); headers.get("set-cookie") can return null even
// when cookies are present. We read both to be safe.
async function getSessionCookie(): Promise<string | null> {
  try {
    const res = await fetch(`${BASE_PAGE}/`, {
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const single = res.headers.get("set-cookie");
    const all = setCookies.length ? setCookies : single ? [single] : [];
    if (all.length === 0) return null;
    // Each entry looks like "sessionId=s%3A...; Path=/; HttpOnly" - keep the
    // name=value pair from each and join into one Cookie header value.
    return all.map((c) => c.split(";")[0]).join("; ");
  } catch {
    return null; // homepage fetch failed - still try the API cookie-less
  }
}

interface DpdReferenceResponse {
  data: Array<{
    parcelCode: string;    // the full trackable code, e.g. "15505502876195*21358"
    parcelNumber: string;  // "1550 5502 876 195 D"
    parcelStatus: string;
  }>;
}

// Resolve a bare DPD reference/consignment number (e.g. "5502876195" as handed
// off by APX) into the full parcelCode the parcel API needs. Returns the
// parcelCode string, or null if DPD has no parcel for that reference.
async function resolveReferenceToParcelCode(
  referenceNumber: string,
  headers: Record<string, string>
): Promise<string | null> {
  const url = `${REFERENCE_API}?origin=PRTK&postcode=&referenceNumber=${encodeURIComponent(referenceNumber)}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`DPD reference lookup failed: ${res.status}`);
  const json = (await res.json()) as DpdReferenceResponse;
  const first = json.data?.[0];
  if (!first?.parcelCode) return null;
  // Guard: only accept a resolved value that is actually a parcelCode.
  return PARCEL_CODE_RE.test(first.parcelCode) ? first.parcelCode : null;
}

function mapStatus(statusText: string, parcelStatusType: number): ShipmentStatus {
  const t = statusText.toLowerCase();
  // Order matters: "will now be delivered on <date>" is a scheduled future ETA,
  // NOT a completed delivery - it must be matched before the bare "delivered"
  // check, otherwise a not-yet-delivered parcel gets mis-reported as delivered.
  // Treated as in_transit (parcel is moving toward a scheduled date); there is
  // no dedicated "scheduled" state in ShipmentStatus.
  if (t.includes("will now be delivered")) return "in_transit";
  if (t.includes("delivered")) return "delivered";
  if (t.includes("out for delivery")) return "out_for_delivery";
  if (t.includes("on its way") || t.includes("depot") || t.includes("in transit")) return "in_transit";
  if (t.includes("not yet received") || t.includes("received your order details")) return "info_received";
  if (t.includes("delay") || t.includes("issue") || t.includes("held")) return "exception";
  // parcelStatusType is DPD's own numeric code - we've only observed 0 so far.
  // Log unmapped statuses so you can extend this table as more examples come in.
  console.warn(`DPD: unmapped status "${statusText}" (type=${parcelStatusType})`);
  return "unknown";
}

export const dpdAdapter: CarrierAdapter = {
  carrierName: "dpd",

  async track(trackingNumber: string): Promise<NormalizedTracking | null> {
    const cookie = await getSessionCookie();
    const commonHeaders: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
      origin: BASE_PAGE,
      referer: `${BASE_PAGE}/`,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    };
    if (cookie) commonHeaders.cookie = cookie;

    // Accept either a full parcelCode ("15505502876195*21358") or a bare
    // reference/consignment number ("5502876195", as handed off by APX). If
    // it's not already a parcelCode, resolve it via DPD's reference lookup.
    // A reference that resolves to nothing means "not found" (null).
    let parcelCode = trackingNumber;
    if (!PARCEL_CODE_RE.test(trackingNumber)) {
      const resolved = await resolveReferenceToParcelCode(trackingNumber, commonHeaders);
      if (!resolved) return null;
      parcelCode = resolved;
    }

    const statusRes = await fetch(
      `${API_BASE}/${encodeURIComponent(parcelCode)}?_=${Date.now()}`,
      { headers: commonHeaders }
    );
    if (statusRes.status === 404) return null;
    if (!statusRes.ok) throw new Error(`DPD status call failed: ${statusRes.status}`);
    const statusJson = (await statusRes.json()) as DpdStatusResponse;

    const eventsRes = await fetch(`${API_BASE}/${encodeURIComponent(parcelCode)}/parcelevents`, {
      headers: commonHeaders,
    });
    if (!eventsRes.ok) throw new Error(`DPD events call failed: ${eventsRes.status}`);
    const eventsJson = (await eventsRes.json()) as DpdEventsResponse;

    const events: TrackingEvent[] = eventsJson.data.map((e) => ({
      timestamp: e.eventDate.replace(" ", "T"), // TODO: convert Europe/London -> UTC properly if you need exact timestamps
      location: e.eventLocation || null,
      description: e.eventText,
    }));

    return {
      carrier: "dpd",
      trackingNumber: statusJson.data.parcelCode,
      status: mapStatus(statusJson.data.trackingStatusCurrent, statusJson.data.parcelStatusType),
      statusText: statusJson.data.trackingStatusCurrent,
      estimatedDelivery: null, // DPD embeds ETA in free text rather than a structured field
      events,
      raw: { status: statusJson, events: eventsJson },
      fetchedAt: new Date().toISOString(),
    };
  },
};
