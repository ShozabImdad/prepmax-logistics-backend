// Validation schemas for the courier catalog (Direct / Via / By Sea service
// options). Mirrors the shape of couriers/queries.ts's CourierInput and the
// admin frontend's CourierFormModal.

import { z } from "zod";

export const courierCategorySchema = z.enum(["Direct", "Via", "By Sea"]);
export const courierLevelSchema = z.enum(["Standard", "Express", "Freight"]);

export const createCourierSchema = z
  .object({
    category: courierCategorySchema,
    name: z.string().min(1, "Name is required").max(200),
    level: courierLevelSchema,
    minDays: z.number().int().min(0, "Min days must be a non-negative number"),
    maxDays: z.number().int().min(0, "Max days must be a non-negative number"),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().default(0),
  })
  .refine((v) => v.maxDays >= v.minDays, {
    message: "Max days must be greater than or equal to min days",
    path: ["maxDays"],
  });

export const updateCourierSchema = z
  .object({
    category: courierCategorySchema.optional(),
    name: z.string().min(1).max(200).optional(),
    level: courierLevelSchema.optional(),
    minDays: z.number().int().min(0).optional(),
    maxDays: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .refine((v) => v.minDays === undefined || v.maxDays === undefined || v.maxDays >= v.minDays, {
    message: "Max days must be greater than or equal to min days",
    path: ["maxDays"],
  });

export type CreateCourierInput = z.infer<typeof createCourierSchema>;
export type UpdateCourierInput = z.infer<typeof updateCourierSchema>;
