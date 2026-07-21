import { z } from "zod";

export const manifestStatusEnum = z.enum(["open", "closed", "dispatched"]);
export type ManifestStatus = z.infer<typeof manifestStatusEnum>;

export const createManifestSchema = z.object({
  branchPublicId: z.string().optional(),
 vendorPublicId: z.string().nullable().optional(),
  manifestDate: z.string().optional(),
  notes: z.string().optional(),
});
export type CreateManifestInput = z.infer<typeof createManifestSchema>;

export const updateManifestSchema = z.object({
  vendorPublicId: z.string().nullable().optional(),
  manifestDate: z.string().optional(),
  notes: z.string().optional(),
});
export type UpdateManifestInput = z.infer<typeof updateManifestSchema>;

export const addShipmentsSchema = z.object({
  orderPublicIds: z.array(z.string()).min(1, "At least one order is required"),
});
export type AddShipmentsInput = z.infer<typeof addShipmentsSchema>;

export const listManifestsQuerySchema = z.object({
  status: manifestStatusEnum.optional(),
  q: z.string().optional(),
  branchPublicId: z.string().optional(),
});
export type ListManifestsQuery = z.infer<typeof listManifestsQuerySchema>;