// Validation schemas for order creation — every field from plan §5.

import { z } from "zod";

const contact = {
  name: z.string().min(1).optional(),
  company: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  postcode: z.string().optional(),
};

export const itemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().int().positive().default(1),
  unitValue: z.number().nonnegative().optional(),
  hsCode: z.string().optional(),
  countryOfOrigin: z.string().optional(),
});

export const boxSchema = z.object({
  label: z.string().optional(),
  weightKg: z.number().nonnegative().default(0),
  lengthCm: z.number().nonnegative().default(0),
  widthCm: z.number().nonnegative().default(0),
  heightCm: z.number().nonnegative().default(0),
  items: z.array(itemSchema).default([]),
});

// A carrier leg optionally supplied at creation time (plan §6: at creation OR later).
export const legSchema = z.object({
  carrier: z.string().min(1),           // adapter key: dpd, smartcargo-apx, ...
  trackingNumber: z.string().min(1),
});

export const createOrderSchema = z.object({
  // Which customer this order is for. Staff may specify; for customer-created
  // orders it's ignored (forced to the logged-in customer).
  customerPublicId: z.string().optional(),
  // Super-admin must name the branch; managers/customers use their own.
  branchPublicId: z.string().optional(),

  sender: z.object(contact).default({}),
  receiver: z.object(contact).default({}),

  serviceType: z.string().optional(),
  contentsNature: z.enum(["documents", "merchandise"]).optional(),
  declaredValue: z.number().nonnegative().optional(),
  currency: z.string().default("PKR"),
  duties: z.enum(["DTP", "DTU"]).optional(),
  handlingFlags: z.array(z.string()).default([]),
  notes: z.string().optional(),

  boxes: z.array(boxSchema).min(1, "at least one box is required"),

  // Optional legs at creation (staff only; customers can't attach carriers).
  legs: z.array(legSchema).max(2).optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type BoxInput = z.infer<typeof boxSchema>;
export type LegInput = z.infer<typeof legSchema>;
