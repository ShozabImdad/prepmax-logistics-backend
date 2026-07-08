import type { NormalizedTracking } from "./types.js";

// Multi-carrier handoff detection.
//
// APX/SmartCargo carries a parcel out of Pakistan and then hands it to a
// last-mile carrier (DPD UK confirmed; others like UPS expected). APX's raw
// response names the handoff carrier and gives its tracking number:
//   serviceCode: "DPDUKRSTCCP"              (machine code, prefixed by carrier)
//   serviceName: "Main UK DD CCP VIA DPD UK" (human label, "... VIA <carrier>")
//   trackingNo:  "5502876195"                (the handoff number)
//
// This helper inspects an APX NormalizedTracking and, if a handoff to a carrier
// we support is detected, returns the next leg to track: { carrier, number }.
// It returns null when there's no handoff or the target carrier isn't supported
// yet. Carrier keys match the adapter registry in ./index.ts.
//
// NOTE: only APX->DPD is verified against real data. When APX hands off to
// other carriers, add their detection + number field here (see "still open"
// in CLAUDE.md §9).

export interface NextLeg {
  carrier: string;       // adapter registry key, e.g. "dpd"
  trackingNumber: string;
  detectedFrom: string;  // the APX text we matched, for display/audit
}

// Shape of the bits of APX's raw response we care about here.
interface ApxRawData {
  data?: {
    serviceCode?: string;
    serviceName?: string;
    trackingNo?: string;
  };
}

export function detectHandoff(apxResult: NormalizedTracking): NextLeg | null {
  if (apxResult.carrier !== "smartcargo-apx") return null;

  const data = (apxResult.raw as ApxRawData | undefined)?.data;
  if (!data) return null;

  const code = (data.serviceCode ?? "").toUpperCase();
  const name = (data.serviceName ?? "").toUpperCase();
  const handoffNumber = (data.trackingNo ?? "").trim();
  if (!handoffNumber) return null;

  // DPD UK — verified. serviceCode like "DPDUKRSTCCP", serviceName "... VIA DPD UK".
  if (code.startsWith("DPD") || name.includes("DPD")) {
    return {
      carrier: "dpd",
      trackingNumber: handoffNumber,
      detectedFrom: data.serviceName || data.serviceCode || "DPD",
    };
  }

  // Other last-mile carriers (UPS, etc.) are not yet verified - deliberately
  // NOT guessed here. Add them once we have a real example shipment so the
  // number-format handling can be confirmed rather than assumed.
  return null;
}
