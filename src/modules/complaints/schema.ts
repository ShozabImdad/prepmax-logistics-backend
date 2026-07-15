// Complaint input validation.

import { z } from "zod";

export const complaintCategories = [
  "Delayed shipment",
  "Damaged package",
  "Missing items",
  "Wrong delivery address",
  "Billing / pricing issue",
  "Poor customer service",
  "Other",
] as const;

export const createComplaintSchema = z.object({
  orderPublicId: z.string().min(1),
  category: z.enum(complaintCategories),
  message: z.string().min(10).max(3000),
});
export type CreateComplaintInput = z.infer<typeof createComplaintSchema>;

// STAFF: update status and/or add a response.
export const updateComplaintSchema = z.object({
  status: z.enum(["open", "in_review", "resolved", "closed"]).optional(),
  response: z.string().max(3000).optional(),
}).refine((v) => v.status !== undefined || v.response !== undefined, {
  message: "Provide status and/or response",
});
export type UpdateComplaintInput = z.infer<typeof updateComplaintSchema>;
