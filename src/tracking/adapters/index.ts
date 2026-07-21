import type { CarrierAdapter } from "./types.js";
import { dpdAdapter } from "./dpd.js";
import { apxAdapter } from "./apx.js";
import { skynetAdapter } from "./skynet.js";
import { dhlAdapter } from "./dhl.js";
import { upsAdapter } from "./ups.js";
import { fedexAdapter } from "./fedex.js";
import { pakpostAdapter } from "./pakpost.js";
import { emxAdapter } from "./emx.js";

// Registry keyed by the carrier value stored on shipment_legs.carrier.
export const adapters: Record<string, CarrierAdapter> = {
  dpd: dpdAdapter,
  "smartcargo-apx": apxAdapter,
  snwwe: skynetAdapter,
  dhl: dhlAdapter,
  ups: upsAdapter,
  fedex: fedexAdapter,
  pakpost: pakpostAdapter,
  emx: emxAdapter,
};

// Convenience aliases so the CLI accepts friendlier names too.
export const aliases: Record<string, string> = {
  apx: "smartcargo-apx",
  smartcargo: "smartcargo-apx",
  skynet: "snwwe",
  "pakistan-post": "pakpost",
  pakistanpost: "pakpost",
  "pak-post": "pakpost",
  "emirates-post": "emx",
  emiratespost: "emx",
  "emx-ae": "emx",
};

export function resolveAdapter(name: string): CarrierAdapter | null {
  const key = aliases[name] ?? name;
  return adapters[key] ?? null;
}
