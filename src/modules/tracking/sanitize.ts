// Carrier-brand redaction for the PUBLIC tracking view.
//
// Prep Max re-brands third-party carriers (DPD, DHL, UPS, FedEx, APX/SmartCargo,
// SkyNet, ...) under its own name. Customers must never see which real carrier
// is behind a shipment, so before any event location/description is returned by
// the public tracking endpoint we strip carrier brand names out.
//
// The carriers' own APIs put their brand into the `eventLocation` field (e.g.
// DPD returns "DPD" as the location) and occasionally into free-text
// descriptions ("your DPD driver ..."). We handle both.

// All brand names + internal registry keys/aliases we might encounter, matched
// case-insensitively as whole words. Longer/multi-word names first so they are
// replaced before their shorter substrings.
const CARRIER_TERMS = [
  "smartcargo-apx",
  "smart cargo",
  "smartcargo",
  "sky net",
  "skynet",
  "snwwe",
  "fedex",
  "fed ex",
  "dpd",
  "dhl",
  "ups",
  "apx",
];

// A whole-word matcher for one term. \b doesn't play well with the hyphen in
// "smartcargo-apx", so we bound on non-alphanumeric (or string edges) instead.
function termRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])(${escaped})(?=[^a-z0-9]|$)`, "gi");
}

const MATCHERS = CARRIER_TERMS.map(termRegex);

/**
 * True when the whole string is essentially just a carrier brand (possibly with
 * punctuation/whitespace) — e.g. "DPD", "DHL Express". Such a location carries
 * no useful info for the customer once the brand is removed, so callers drop it.
 */
export function isCarrierOnly(value: string | null | undefined): boolean {
  if (!value) return false;
  let stripped = value;
  for (const re of MATCHERS) stripped = stripped.replace(re, "$1");
  // Remove common brand suffixes that are meaningless on their own.
  stripped = stripped.replace(/\b(express|ground|depot|hub|courier|logistics)\b/gi, "");
  return stripped.replace(/[^a-z0-9]/gi, "").length === 0;
}

/**
 * Remove carrier brand mentions from free text, collapsing the whitespace/commas
 * left behind. Returns null when nothing meaningful remains.
 */
export function redactCarrier(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  if (isCarrierOnly(value)) return null;
  let out = value;
  for (const re of MATCHERS) out = out.replace(re, "$1");
  // Tidy up artifacts: doubled spaces, stray leading/trailing separators.
  out = out.replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
  out = out.replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, "").trim();
  return out.length === 0 ? null : out;
}

// ── Customer-facing operational-detail cleanup ──────────────────────────────
// Separate from carrier-brand redaction: this strips internal logistics noise
// the customer shouldn't need to see — flight numbers/routes, aircraft linehaul
// blocks, bag/piece/weight annotations — and normalizes Pakistan Post's postal
// facility abbreviations. Applied at READ time to every stored event on the
// public + customer surfaces, so it fixes historical events too (no re-sync or
// data migration needed). Rules are derived from real SkyNet + Pakistan Post
// event text captured live (2026-07):
//   SkyNet:  "Linehaul Arrival - TG0346, 22 JUL 2026, ATD 00:18, LHE-BKK,
//             ATA - 22 JUL 2026 - 03:56 1 Pcs 645.0 Kgs"
//            "Sorted to Destination - Bagged for DXB, Item 01 Bag 13"
//            "Arrived Hub - Arrived Lahore Piece: 1 Weight: 0.1 Kgs"
//   PakPost: "Handedover to airline flight no:PK 0279 / QR 1014, Destination
//             IQBGWA"  ·  "Booked at Sahiwal GPO"  ·  location "IMO Lahore"
//
// SkyNet stores its event as "<clean event name> - <operational detail>". The
// operational detail (flight code, ATD/ATA, airport pair, bag/piece/weight) is
// exactly what we drop, so we keep only the clean event name before the first
// " - ". Pakistan Post has no " - " split, so for it we surgically cut the
// "flight no ..." tail and a trailing "GPO".

/**
 * Clean an event DESCRIPTION for customer display. Removes flight/linehaul and
 * bag/piece/weight detail. Never returns null (an event always keeps a label);
 * callers already fall back to "Shipment update" if this yields empty.
 */
export function cleanEventText(value: string | null | undefined): string {
  if (!value) return "";
  let out = value;

  // SkyNet: keep only the clean event name before the first " - " separator.
  // ("Linehaul Arrival - TG0346, ...645.0 Kgs" -> "Linehaul Arrival";
  //  "Sorted to Destination - Bagged for DXB..." -> "Sorted to Destination").
  const dash = out.indexOf(" - ");
  if (dash !== -1) out = out.slice(0, dash);

  // Pakistan Post (no " - " split): cut the flight-number tail
  // ("Handedover to airline flight no:PK 0279 / QR 1014, ..." ->
  //  "Handedover to airline") and drop a trailing "GPO"
  // ("Booked at Sahiwal GPO" -> "Booked at Sahiwal").
  out = out.replace(/\s*flight\s*no\b.*$/i, "");
  out = out.replace(/\s+GPO\b\.?$/i, "");

  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * Clean an event LOCATION for customer display. Strips Pakistan Post's postal
 * facility abbreviations (IMO = International Mail Office, GPO = General Post
 * Office) as leading/trailing whole words, and drops the literal "-" placeholder
 * PakPost uses for location-less rows. Capitalization is left untouched
 * (e.g. "BAGHDAD" stays as-is). Returns null when nothing meaningful remains.
 */
export function cleanEventLocation(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  let out = value.trim();
  if (!out || out === "-") return null;
  out = out
    .replace(/^(?:IMO|GPO)\s+/i, "")
    .replace(/\s+(?:IMO|GPO)$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return out.length === 0 ? null : out;
}
