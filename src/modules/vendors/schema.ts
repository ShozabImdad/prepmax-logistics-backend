// Vendor (AP partner/carrier) input validation.

import { z } from "zod";

export const vendorTypes = ["carrier", "local", "other"] as const;

export const createVendorSchema = z.object({
  branchPublicId: z.string().optional(), // required when creator is super_admin (branchId null)
  name: z.string().min(1).max(200),
  code: z.string().max(100).optional(),
  vendorType: z.enum(vendorTypes).default("other"),
  contactName: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().max(500).optional(),
  openingBalance: z.number().nonnegative().default(0),
});
export type CreateVendorInput = z.infer<typeof createVendorSchema>;

// Edit: everything optional (partial update). isActive lets staff
// deactivate/reactivate a vendor without a hard delete.
export const updateVendorSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  code: z.string().max(100).optional(),
  vendorType: z.enum(vendorTypes).optional(),
  contactName: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().max(500).optional(),
  openingBalance: z.number().nonnegative().optional(),
  isActive: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field to update" });
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;

export const listVendorsQuerySchema = z.object({
  vendorType: z.enum(vendorTypes).optional(),
  isActive: z.enum(["true", "false"]).optional(),
  q: z.string().max(200).optional(), // free-text search on name
});
export type ListVendorsQuery = z.infer<typeof listVendorsQuerySchema>;
