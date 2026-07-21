// Delivery-time lookup for computing an order's estimated delivery window.
// Mirrors the Direct / Via / By Sea courier lists in the admin frontend's
// OrderForm.tsx (kept as the single source of truth for min/max working
// days — the frontend only needs display strings, this file needs numbers).
//
// `orders.service_type` is stored as "<Category> — <Option>" (see
// encodeServiceType() in OrderForm.tsx), e.g. "Direct — Skynet".

export interface DeliveryRange {
  minDays: number;
  maxDays: number;
}

const DIRECT: Record<string, DeliveryRange> = {
  "Skynet": { minDays: 5, maxDays: 7 },
  "UPS": { minDays: 4, maxDays: 6 },
  "DHL": { minDays: 3, maxDays: 5 },
  "Fedex": { minDays: 5, maxDays: 6 },
  "DPEX": { minDays: 5, maxDays: 7 },
  "Aramex": { minDays: 6, maxDays: 8 },
};

// Every "Via" option shares the same 8–10 working day window.
const VIA_RANGE: DeliveryRange = { minDays: 8, maxDays: 10 };
const VIA_OPTIONS = [
  "Skynet Via DHL", "Skynet Via Aramex", "Skynet Via UPS", "Skynet Via DPEX",
  "Via UK DPD (CCP)", "Via UK DPD (CC)", "Via UK UPS", "Via UK DHL", "Via UK FedEx",
  "Via Dubai DHL", "Via Dubai UPS", "Via Dubai Fedex", "Via Dubai Aramex", "Via Dubai Local",
  "Via Singapore DHL", "Via Singapore UPS", "Via Singapore FedEx",
  "Direct JFK(USA-CCP)", "Direct JFK(USA-CC)", "Post Office",
];
const VIA: Record<string, DeliveryRange> = Object.fromEntries(
  VIA_OPTIONS.map((name) => [name, VIA_RANGE]),
);

const BY_SEA: Record<string, DeliveryRange> = {
  "UK": { minDays: 45, maxDays: 60 },
  "USA": { minDays: 50, maxDays: 65 },
  "UAE": { minDays: 30, maxDays: 40 },
  "Canada": { minDays: 50, maxDays: 65 },
};

const BY_CATEGORY: Record<string, Record<string, DeliveryRange>> = {
  "Direct": DIRECT,
  "Via": VIA,
  "By Sea": BY_SEA,
};

/**
 * Decode a stored `service_type` string ("Direct — Skynet") and look up its
 * delivery range. Returns null if the string doesn't match a known
 * category/option (e.g. legacy free-text values, or unset).
 */
export function lookupDeliveryRange(serviceType: string | null | undefined): DeliveryRange | null {
  if (!serviceType) return null;
  const [category, option] = serviceType.split(" — ");
  if (!category || !option) return null;
  const table = BY_CATEGORY[category];
  if (!table) return null;
  return table[option] ?? null;
}
