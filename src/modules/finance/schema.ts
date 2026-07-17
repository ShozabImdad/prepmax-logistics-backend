// Finance module validation — vendors, invoices, vendor bills, payments,
// expenses. Zod schemas match the columns defined in migration 0016_finance.sql.
// All amounts are numeric(12,2); Zod coerces to JS number.

import { z } from "zod";

// ── Vendors ────────────────────────────────────────────────────────────────
export const vendorTypeSchema = z.enum(["carrier", "local", "other"]);
export type VendorType = z.infer<typeof vendorTypeSchema>;

export const createVendorSchema = z.object({
  branchPublicId: z.string().optional(),  // required for super_admin
  name: z.string().min(1, "Name is required").max(200),
  code: z.string().max(60).optional(),
  vendorType: vendorTypeSchema.default("carrier"),
  contactName: z.string().max(200).optional(),
  phone: z.string().max(60).optional(),
  email: z.string().email().max(200).optional().or(z.literal("")),
  address: z.string().max(500).optional(),
  openingBalance: z.number().nonnegative().default(0),
  isActive: z.boolean().default(true),
});
export type CreateVendorInput = z.infer<typeof createVendorSchema>;

export const updateVendorSchema = createVendorSchema.partial();
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;

// ── Invoices (AR) ──────────────────────────────────────────────────────────
export const invoiceStatusSchema = z.enum(["draft", "unpaid", "partial", "paid", "void"]);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

export const invoiceItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().positive().default(1),
  unitPrice: z.number().nonnegative().default(0),
});
export type InvoiceItemInput = z.infer<typeof invoiceItemSchema>;

export const createInvoiceSchema = z.object({
  branchPublicId: z.string().optional(),  // required for super_admin
  customerPublicId: z.string().min(1),
  orderPublicId: z.string().optional(),
  isCreditNote: z.boolean().default(false),
  issueDate: z.string().optional(),                  // ISO date YYYY-MM-DD
  dueDate: z.string().optional(),
  currency: z.string().max(3).default("PKR"),
  items: z.array(invoiceItemSchema).min(1, "At least one line item is required"),
  tax: z.number().nonnegative().default(0),
  notes: z.string().max(2000).optional(),
  status: invoiceStatusSchema.default("unpaid"),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export const updateInvoiceSchema = z.object({
  customerPublicId: z.string().optional(),
  orderPublicId: z.string().optional().nullable(),
  isCreditNote: z.boolean().optional(),
  issueDate: z.string().optional(),
  dueDate: z.string().optional().nullable(),
  currency: z.string().max(3).optional(),
  items: z.array(invoiceItemSchema).optional(),
  tax: z.number().nonnegative().optional(),
  notes: z.string().max(2000).optional().nullable(),
  status: invoiceStatusSchema.optional(),
});
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;

// ── Vendor bills (AP) ──────────────────────────────────────────────────────
export const vendorBillStatusSchema = z.enum(["unpaid", "partial", "paid", "void"]);
export type VendorBillStatus = z.infer<typeof vendorBillStatusSchema>;

export const vendorBillItemSchema = z.object({
  orderPublicId: z.string().optional(),
  description: z.string().min(1).max(500),
  amount: z.number().nonnegative().default(0),
});
export type VendorBillItemInput = z.infer<typeof vendorBillItemSchema>;

export const createVendorBillSchema = z.object({
  branchPublicId: z.string().optional(),  // required for super_admin
  vendorPublicId: z.string().min(1),
  billNo: z.string().max(120).optional(),
  billDate: z.string().optional(),
  dueDate: z.string().optional(),
  currency: z.string().max(3).default("PKR"),
  items: z.array(vendorBillItemSchema).default([]),
  tax: z.number().nonnegative().default(0),
  notes: z.string().max(2000).optional(),
  status: vendorBillStatusSchema.default("unpaid"),
});
export type CreateVendorBillInput = z.infer<typeof createVendorBillSchema>;

export const updateVendorBillSchema = z.object({
  vendorPublicId: z.string().optional(),
  billNo: z.string().max(120).optional().nullable(),
  billDate: z.string().optional(),
  dueDate: z.string().optional().nullable(),
  currency: z.string().max(3).optional(),
  items: z.array(vendorBillItemSchema).optional(),
  tax: z.number().nonnegative().optional(),
  notes: z.string().max(2000).optional().nullable(),
  status: vendorBillStatusSchema.optional(),
});
export type UpdateVendorBillInput = z.infer<typeof updateVendorBillSchema>;

// ── Payments ───────────────────────────────────────────────────────────────
export const paymentDirectionSchema = z.enum(["in", "out"]);
export const paymentMethodSchema = z.enum(["cash", "bank", "cheque", "online", "other"]);
export const paymentAccountSchema = z.enum(["cash_in_hand", "bank"]);

export const createPaymentSchema = z.object({
  branchPublicId: z.string().optional(),  // required for super_admin
  direction: paymentDirectionSchema,
  method: paymentMethodSchema.default("cash"),
  account: paymentAccountSchema.default("cash_in_hand"),
  amount: z.number().positive("Amount must be > 0"),
  paidOn: z.string().optional(),                       // ISO date
  customerPublicId: z.string().optional(),
  vendorPublicId: z.string().optional(),
  invoicePublicId: z.string().optional(),
  vendorBillPublicId: z.string().optional(),
  reference: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
}).refine(
  (v) => (v.direction === "in" && v.customerPublicId) || (v.direction === "out"),
  { message: "Inbound payments should reference a customer" },
);
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

// ── Expenses ───────────────────────────────────────────────────────────────
export const expenseCategorySchema = z.enum([
  "office_rent", "salaries", "fuel", "utilities", "marketing", "miscellaneous",
]);
export type ExpenseCategory = z.infer<typeof expenseCategorySchema>;

export const createExpenseSchema = z.object({
  branchPublicId: z.string().optional(),  // required for super_admin
  category: expenseCategorySchema,
  amount: z.number().positive("Amount must be > 0"),
  account: paymentAccountSchema.default("cash_in_hand"),
  spentOn: z.string().optional(),
  payee: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  reference: z.string().max(200).optional(),
});
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const updateExpenseSchema = createExpenseSchema.partial();
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;

// ── Reports ────────────────────────────────────────────────────────────────
export const reportPeriodSchema = z.enum(["daily", "monthly", "yearly"]);
export type ReportPeriod = z.infer<typeof reportPeriodSchema>;