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
