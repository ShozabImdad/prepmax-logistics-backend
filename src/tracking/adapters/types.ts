// Shared shape every carrier adapter must return.
// Keeps your DB/API/frontend carrier-agnostic — only these files know
// about DPD, UPS, FedEx, DHL, SmartCargo, SkyNet etc. Everything else
// just consumes this.

export type ShipmentStatus =
  | "info_received"   // carrier has data but hasn't scanned parcel yet
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "exception"        // delay, failed attempt, held at customs, etc.
  | "unknown";          // couldn't confidently map carrier's raw status

export interface TrackingEvent {
  timestamp: string;    // ISO 8601, always UTC-normalized
  location: string | null;
  description: string;
}

export interface NormalizedTracking {
  carrier: string;              // "dpd" | "ups" | "fedex" | "dhl" | "smartcargo" | "snwwe"
  trackingNumber: string;       // the number as given to the carrier
  status: ShipmentStatus;
  statusText: string;           // human-readable, carrier's own wording (for display)
  estimatedDelivery: string | null; // ISO date if the carrier gives one
  events: TrackingEvent[];      // newest first
  // Proof-of-delivery photo when the carrier provides one (currently FedEx's
  // ppodImage). A data: URI ready to drop into an <img src>, or null. Kept as
  // its own field rather than inside `raw` so consumers (customer portal,
  // demo) can display it without depending on carrier-specific raw shapes.
  proofOfDeliveryImage?: string | null;
  raw?: unknown;                // original carrier response, kept for debugging
  fetchedAt: string;            // ISO timestamp of when we scraped this
}

export interface CarrierAdapter {
  carrierName: string;
  // Returns null if the tracking number wasn't found / carrier returned no data.
  // Throws only on network/unexpected errors (so callers can distinguish
  // "not found" from "something broke").
  track(trackingNumber: string): Promise<NormalizedTracking | null>;
}
