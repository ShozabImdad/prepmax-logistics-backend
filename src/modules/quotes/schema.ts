// Quote request validation.

import { z } from "zod";

export const quoteItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().int().positive().default(1),
  unitValue: z.number().nonnegative().optional(),
});

export const quoteBoxSchema = z.object({
  parcelType: z.enum(["package", "document", "pallet", "fragile", "oversized", "other"]).default("package"),
  weightKg: z.number().nonnegative().default(0),
  lengthCm: z.number().nonnegative().default(0),
  widthCm: z.number().nonnegative().default(0),
  heightCm: z.number().nonnegative().default(0),
  items: z.array(quoteItemSchema).default([]),
});

// CUSTOMER: request a quote.
export const createQuoteSchema = z.object({
  originCountry: z.string().min(1),
  destinationCountry: z.string().min(1),
  serviceLevel: z.enum(["Standard", "Express", "Economy", "Freight"]),
  contentsNature: z.enum(["documents", "merchandise"]).optional(),
  boxes: z.array(quoteBoxSchema).min(1, "at least one box is required"),
  notes: z.string().max(3000).optional(),
});
export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;
export type QuoteBoxInput = z.infer<typeof quoteBoxSchema>;
export type QuoteItemInput = z.infer<typeof quoteItemSchema>;

// STAFF: respond with pricing / status.
export const updateQuoteSchema = z.object({
  status: z.enum(["new", "quoted", "accepted", "declined", "closed"]).optional(),
  quotedPrice: z.number().nonnegative().optional(),
  quotedCurrency: z.string().optional(),
  staffResponse: z.string().max(3000).optional(),
}).refine(
  (v) => v.status !== undefined || v.quotedPrice !== undefined || v.staffResponse !== undefined,
  { message: "Provide status, quotedPrice, and/or staffResponse" },
);
export type UpdateQuoteInput = z.infer<typeof updateQuoteSchema>;
