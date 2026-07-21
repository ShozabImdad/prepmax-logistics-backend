// Validation schemas for saved contacts (address book).
// The contact fields intentionally mirror orders/schema.ts's `contact` block
// exactly, so a saved contact can be spread straight into an order's
// sender/receiver payload with no field mapping needed.

import { z } from "zod";

export const contactKindSchema = z.enum(["sender", "receiver", "both"]);

export const createSavedContactSchema = z.object({
  branchPublicId: z.string().optional(),   // required for super_admin (staff route only)
  kind: contactKindSchema.default("both"),
  label: z.string().min(1, "Label is required").max(120),

  name: z.string().min(1, "Name is required"),
  company: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  cnic: z.string().optional(),
  ntn: z.string().optional(),
  address: z.string().optional(),
  address2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postcode: z.string().optional(),
});

export const updateSavedContactSchema = createSavedContactSchema.partial();

export type CreateSavedContactInput = z.infer<typeof createSavedContactSchema>;
export type UpdateSavedContactInput = z.infer<typeof updateSavedContactSchema>;
