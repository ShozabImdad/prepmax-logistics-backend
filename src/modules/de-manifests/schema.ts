import { z } from "zod";

export const deManifestStatusEnum = z.enum(["open", "completed"]);
export type DeManifestStatus = z.infer<typeof deManifestStatusEnum>;

export const conditionEnum = z.enum(["good", "damaged", "missing", "open_package"]);
export type Condition = z.infer<typeof conditionEnum>;

export const reconciliationEnum = z.enum(["pending", "received", "missing", "extra", "hold"]);
export type Reconciliation = z.infer<typeof reconciliationEnum>;

export const createDeManifestSchema = z.object({
  branchPublicId: z.string().optional(),        // required when creator is super_admin
  sourceManifestPublicId: z.string().optional(), // optional link to an outbound manifest being reconciled
  vendorPublicId: z.string().optional(),
  courierName: z.string().max(200).optional(),   // free-text fallback when there's no vendor record
  deManifestDate: z.string().optional(),
  remarks: z.string().optional(),
});
export type CreateDeManifestInput = z.infer<typeof createDeManifestSchema>;

export const updateDeManifestSchema = z.object({
  // nullable: sending null clears the vendor (e.g. "— Not set —" in the UI).
  // omitting the key entirely leaves it untouched.
  vendorPublicId: z.string().nullable().optional(),
  courierName: z.string().max(200).optional(),
  deManifestDate: z.string().optional(),
  remarks: z.string().optional(),
});
export type UpdateDeManifestInput = z.infer<typeof updateDeManifestSchema>;

// Scan/add a shipment — trackingCode is looked up against orders; when it
// doesn't match anything, the row is still created with order_id NULL and
// reconciliation defaulted to 'extra' (see queries.ts).
export const scanShipmentSchema = z.object({
  trackingCode: z.string().min(1),
  condition: conditionEnum.optional(),
  remarks: z.string().optional(),
  // Manual fallback fields — only meaningful when trackingCode doesn't match
  // an order (order_id ends up NULL). Harmless to send even when it does.
  manualSenderName: z.string().max(200).optional(),
  manualReceiverName: z.string().max(200).optional(),
  manualDestination: z.string().max(200).optional(),
});
export type ScanShipmentInput = z.infer<typeof scanShipmentSchema>;

export const updateShipmentSchema = z.object({
  condition: conditionEnum.optional(),
  reconciliation: reconciliationEnum.optional(),
  remarks: z.string().optional(),
  manualSenderName: z.string().max(200).optional(),
  manualReceiverName: z.string().max(200).optional(),
  manualDestination: z.string().max(200).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update" });
export type UpdateShipmentInput = z.infer<typeof updateShipmentSchema>;

export const listDeManifestsQuerySchema = z.object({
  status: deManifestStatusEnum.optional(),
  q: z.string().optional(),
  branchPublicId: z.string().optional(),
});
export type ListDeManifestsQuery = z.infer<typeof listDeManifestsQuerySchema>;