// Validation schemas for order creation/edit.

import { z } from "zod";

// Structured contact block (sender / receiver).
const contact = {
  name: z.string().min(1).optional(),
  company: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  cnic: z.string().optional(),
  ntn: z.string().optional(),
  address: z.string().optional(),   // line 1
  address2: z.string().optional(),  // line 2
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postcode: z.string().optional(),
};

export const itemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().int().positive().default(1),
  unitValue: z.number().nonnegative().optional(),   // declared value (customs)
  hsCode: z.string().optional(),
  countryOfOrigin: z.string().optional(),
});

export const boxSchema = z.object({
  label: z.string().optional(),
  parcelType: z.enum(["package", "document", "pallet", "fragile", "oversized", "other"]).default("package"),
  weightKg: z.number().nonnegative().default(0),
  lengthCm: z.number().nonnegative().default(0),
  widthCm: z.number().nonnegative().default(0),
  heightCm: z.number().nonnegative().default(0),
  items: z.array(itemSchema).default([]),
});

export const legSchema = z.object({
  carrier: z.string().min(1),
  trackingNumber: z.string().min(1),
});

// Shared order fields (used by create + edit).
const orderCore = {
  sender: z.object(contact).default({}),
  receiver: z.object(contact).default({}),

  // route (from/to country), distinct from address countries
  originCountry: z.string().optional(),
  destinationCountry: z.string().optional(),

  serviceType: z.string().optional(),
  serviceLevel: z.enum(["Standard", "Express", "Economy", "Freight"]).optional(),
  contentsNature: z.enum(["documents", "merchandise"]).optional(),
  duties: z.enum(["DTP", "DTU"]).optional(),
  handlingFlags: z.array(z.string()).default([]),
  notes: z.string().optional(),

  // pricing / finance
  price: z.number().nonnegative().optional(),
  priceCurrency: z.string().default("PKR"),
  paymentStatus: z.enum(["unpaid", "paid", "partial"]).optional(),
  amountPaid: z.number().nonnegative().optional(),
  declaredCurrency: z.string().default("USD"),
};

export const createOrderSchema = z.object({
  customerPublicId: z.string().optional(),
  branchPublicId: z.string().optional(),
  ...orderCore,
  boxes: z.array(boxSchema).min(1, "at least one box is required"),
  legs: z.array(legSchema).max(2).optional(),
});

// Edit: everything optional; boxes optional (replace-all when provided).
export const editOrderSchema = z.object({
  sender: z.object(contact).optional(),
  receiver: z.object(contact).optional(),
  originCountry: z.string().optional(),
  destinationCountry: z.string().optional(),
  serviceType: z.string().optional(),
  serviceLevel: z.enum(["Standard", "Express", "Economy", "Freight"]).optional(),
  contentsNature: z.enum(["documents", "merchandise"]).optional(),
  duties: z.enum(["DTP", "DTU"]).optional(),
  handlingFlags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  price: z.number().nonnegative().optional(),
  priceCurrency: z.string().optional(),
  paymentStatus: z.enum(["unpaid", "paid", "partial"]).optional(),
  amountPaid: z.number().nonnegative().optional(),
  declaredCurrency: z.string().optional(),
  boxes: z.array(boxSchema).min(1).optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type EditOrderInput = z.infer<typeof editOrderSchema>;
export type BoxInput = z.infer<typeof boxSchema>;
export type LegInput = z.infer<typeof legSchema>;
