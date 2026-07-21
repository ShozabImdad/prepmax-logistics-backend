import type { CarrierAdapter, NormalizedTracking, TrackingEvent, ShipmentStatus } from "./types.js";

// Pakistan Post (ep.gov.pk) — server-rendered ASP result, no auth/cookies.
//
// The public tracking page https://ep.gov.pk/track.asp is just a search box. On
// submit it embeds an <iframe> whose src is the REAL result endpoint:
//   https://ep.gov.pk/emtts/EPTrack_Live.aspx?ArticleIDz=<trackingNo>
// A plain GET to that iframe URL returns the fully server-rendered result HTML
// (the "Result of your query" table + the "Article Track Detail" event table),
// so we hit it directly — no browser, no POST, no cookies. Verified live
// against CC002712851PK (2026-07): origin Pakistan → destination Iraq.
//
// The event table is a flat list of <tr> rows in #TrackDetailDiv, in two kinds:
//   • date-heading row: <tr><td colspan='4'><div class='date-heading'> May 21, 2026</div></td></tr>
//   • event row:        <tr><td>&nbsp;</td><td class='time'><div>5:05 PM</div></td>
//                           <td><b>Sahiwal</b></td><td>Booked at Sahiwal GPO</td></tr>
// A date-heading sets the "current date"; each following event row carries it
// forward (same day-grouping trick as the SkyNet adapter). Rows come
// OLDEST-first; we reverse to newest-first per the CarrierAdapter contract.
//
// Timezone: Pakistan Post gives a local wall-clock date + time with NO timezone.
// Like the DPD/APX/SkyNet adapters we surface the local instant WITHOUT a Z/
// offset suffix rather than falsely stamping it UTC.

const RESULT_URL = "https://ep.gov.pk/emtts/EPTrack_Live.aspx";

function mapStatus(statusText: string): ShipmentStatus {
  const t = statusText.toLowerCase();
  // Order matters: "Deliver item ... in destination country" is the delivered
  // signal. "office of exchange"/"customs"/"airline"/"flight" are all transit.
  if (t.includes("deliver item") || (t.includes("delivered") && !t.includes("out for delivery"))) {
    return "delivered";
  }
  if (t.includes("out for delivery") || t.includes("with delivery")) return "out_for_delivery";
  if (
    t.includes("office of exchange") ||
    t.includes("customs") ||
    t.includes("airline") ||
    t.includes("flight") ||
    t.includes("send item") ||
    t.includes("receive item") ||
    t.includes("in transit") ||
    t.includes("transit") ||
    t.includes("dispatch") ||
    t.includes("arrival") ||
    t.includes("departure") ||
    t.includes("handed over") ||
    t.includes("handedover") ||
    t.includes("domestic location")
  ) {
    return "in_transit";
  }
  if (t.includes("booked") || t.includes("information received") || t.includes("item received")) {
    return "info_received";
  }
  if (
    t.includes("return item") ||
    t.includes("retention") ||
    t.includes("held") ||
    t.includes("failed") ||
    t.includes("exception") ||
    t.includes("undelivered") ||
    t.includes("redirect")
  ) {
    return "exception";
  }
  console.warn(`Pakistan Post: unmapped status "${statusText}"`);
  return "unknown";
}

// Pull the text inside <span id="..."> ... </span> for a given element id.
function spanText(html: string, id: string): string | null {
  const re = new RegExp(`id="${id}"[^>]*>([^<]*)</span>`, "i");
  const m = re.exec(html);
  return m ? m[1]!.trim() || null : null;
}

// Strip tags + collapse whitespace + decode the couple of entities that appear.
function clean(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Parse "May 21, 2026" + "5:05 PM" into a local ISO string (no Z, since the
// source carries a timezone-less local wall-clock). Falls back to the raw
// "date time" string if the pieces don't parse.
function toLocalIso(dateHeading: string, time: string): string {
  const raw = `${dateHeading} ${time}`.trim();
  const d = new Date(raw); // "May 21, 2026 5:05 PM" is a valid Date input
  if (!isNaN(d.getTime())) {
    // Build "YYYY-MM-DDTHH:mm:ss" from the parsed local components (no offset).
    const p = (n: number) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
      `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    );
  }
  return raw || new Date().toISOString();
}

interface ParsedRow {
  date: string;
  time: string;
  location: string | null;
  description: string;
}

// Walk the #TrackDetailDiv event rows, carrying the current date-heading
// forward. Returns rows in source order (oldest-first).
function parseEvents(html: string): ParsedRow[] {
  // Narrow to the detail div so we don't accidentally match the header table.
  const divStart = html.indexOf('id="TrackDetailDiv"');
  const region = divStart === -1 ? html : html.slice(divStart);

  const rows: ParsedRow[] = [];
  let currentDate = "";

  // Match every <tr>…</tr> in order.
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(region)) !== null) {
    const tr = m[1]!;

    // Date-heading row?
    const dateM = /class=['"]date-heading['"][^>]*>([^<]*)</i.exec(tr);
    if (dateM) {
      currentDate = clean(dateM[1]!);
      continue;
    }

    // Event row: has a <td class="time"><div>TIME</div></td>.
    const timeM = /class=['"]time['"][^>]*>\s*<div[^>]*>([^<]*)<\/div>/i.exec(tr);
    if (!timeM) continue;
    const time = clean(timeM[1]!);

    // The remaining <td> cells after the time cell: [location(bold)], [description].
    const tds = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1]!);
    // Cells are: [0]=spacer(&nbsp;), [1]=time, [2]=location, [3]=description.
    const location = tds[2] != null ? clean(tds[2]) || null : null;
    const description = tds[3] != null ? clean(tds[3]) : "";
    if (!description && !location) continue;

    rows.push({ date: currentDate, time, location, description });
  }
  return rows;
}

export const pakpostAdapter: CarrierAdapter = {
  carrierName: "pakpost",

  async track(trackingNumber: string): Promise<NormalizedTracking | null> {
    const res = await fetch(`${RESULT_URL}?ArticleIDz=${encodeURIComponent(trackingNumber)}`, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) throw new Error(`Pakistan Post: request failed (${res.status})`);
    const html = await res.text();

    const parsed = parseEvents(html);
    // "Not found" detection: for a bogus article number the page STILL renders
    // (echoing the queried number in LblArticleTrackingNo) but the
    // #TrackDetailDiv contains only the empty "Article Track Detail" heading —
    // no date-heading rows, no event rows. So an empty event list is the only
    // trustworthy "not found" signal (verified live with a bogus number).
    if (parsed.length === 0) return null;

    // Source is oldest-first; contract wants newest-first.
    const ordered = [...parsed].reverse();

    const events: TrackingEvent[] = ordered.map((r) => ({
      timestamp: toLocalIso(r.date, r.time),
      location: r.location,
      description: r.description || "Shipment update",
    }));

    const originCountry = spanText(html, "LblBookingOffice");
    const destinationCountry = spanText(html, "LblDeliveryOffice");
    const echoedNo = spanText(html, "LblArticleTrackingNo");

    const latest = ordered[0]!;
    const latestDesc = latest.description || "";

    return {
      carrier: "pakpost",
      trackingNumber: echoedNo || trackingNumber,
      status: mapStatus(latestDesc),
      statusText: latestDesc || "No status available",
      // Pakistan Post doesn't provide a structured ETA.
      estimatedDelivery: null,
      events,
      raw: { originCountry, destinationCountry, events: ordered },
      fetchedAt: new Date().toISOString(),
    };
  },
};
