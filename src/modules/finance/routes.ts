// Finance routes — all staff-only, branch-scoped via req.db (RLS).
// Mounted at /api/finance. All routes (read and write) require
// finance.manage. Mirrors the auth-gating pattern from quotes/complaints.
//
// Layout:
//   GET    /api/finance/dashboard
//   GET    /api/finance/bank-accounts
//   POST   /api/finance/bank-accounts
//   PATCH  /api/finance/bank-accounts/:publicId
//   DELETE /api/finance/bank-accounts/:publicId
//   GET    /api/finance/vendors
//   POST   /api/finance/vendors
//   PATCH  /api/finance/vendors/:publicId
//   DELETE /api/finance/vendors/:publicId
//   GET    /api/finance/vendors/:publicId/ledger
//   GET    /api/finance/vendors/:publicId/ledger/pdf     (statement of account PDF)
//   GET    /api/finance/invoices
//   POST   /api/finance/invoices
//   GET    /api/finance/invoices/:publicId
//   GET    /api/finance/invoices/:publicId/pdf       (invoice / credit note PDF)
//   PATCH  /api/finance/invoices/:publicId
//   DELETE /api/finance/invoices/:publicId
//   GET    /api/finance/customers/:publicId/ledger
//   GET    /api/finance/customers/:publicId/ledger/pdf  (statement of account PDF)
//   GET    /api/finance/vendor-bills
//   POST   /api/finance/vendor-bills
//   GET    /api/finance/vendor-bills/:publicId
//   GET    /api/finance/vendor-bills/:publicId/pdf   (vendor bill PDF)
//   PATCH  /api/finance/vendor-bills/:publicId
//   DELETE /api/finance/vendor-bills/:publicId
//   GET    /api/finance/payments
//   POST   /api/finance/payments
//   DELETE /api/finance/payments/:publicId
//   GET    /api/finance/expenses
//   POST   /api/finance/expenses
//   PATCH  /api/finance/expenses/:publicId
//   DELETE /api/finance/expenses/:publicId
//   GET    /api/finance/reports?period=daily|monthly|yearly&from=&to=

import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../lib/http.js";
import { requireStaff, requirePermission } from "../../middleware/auth.js";
import { isStaff } from "../auth/types.js";
import { htmlToPdf } from "../documents/pdf.js";
import { invoiceHtml, vendorBillHtml, ledgerHtml } from "./templates.js";
import {
  createVendorSchema, updateVendorSchema,
  createInvoiceSchema, updateInvoiceSchema,
  createVendorBillSchema, updateVendorBillSchema,
  createPaymentSchema,
  createExpenseSchema, updateExpenseSchema,
  createBankAccountSchema, updateBankAccountSchema,
  reportPeriodSchema,
} from "./schema.js";
import {
  FinanceError,
listVendors, createVendor, updateVendor, deleteVendor, hardDeleteVendor, getVendorLedger,
  listInvoices, getInvoice, createInvoice, updateInvoice, deleteInvoice,
  getCustomerLedger,
  listVendorBills, getVendorBill, createVendorBill, updateVendorBill, deleteVendorBill,
  listPayments, createPayment, deletePayment,
  listExpenses, createExpense, updateExpense, deleteExpense,
  listBankAccounts, createBankAccount, updateBankAccount, deleteBankAccount,
  getFinanceDashboard, getFinanceReport,
  getCustomerHeaderInfo, getVendorHeaderInfo,
} from "./queries.js";

export const financeRouter: Router = Router();

function handleFinanceError(err: unknown, res: Response): void {
  if (err instanceof FinanceError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

function param(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// Resolve branch ID for the current request.
// - branch_manager: use their assigned branch (staff.branchId is always set).
// - super_admin:    must supply branchPublicId in the body; look up the real UUID.
// Mirrors the orders/service.ts resolveBranchAndCustomer pattern.
async function resolveBranchId(
  req: Request,
  staff: { role: string; branchId: string | null },
  branchPublicId?: string,
): Promise<string> {
  if (staff.role === "branch_manager") return staff.branchId!;
  // super_admin — must name the branch
  if (!branchPublicId) {
    throw new FinanceError(400, "branchPublicId is required for super-admin");
  }
  const row = await req.db!(async (sql) => {
    const { rows } = await sql.query<{ id: string }>(
      "SELECT id FROM branches WHERE public_id = $1",
      [branchPublicId],
    );
    return rows[0];
  });
  if (!row) throw new FinanceError(404, "Branch not found");
  return row.id;
}

// ── Dashboard ───────────────────────────────────────────────────────────────
financeRouter.get(
  "/dashboard",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const from = str(req.query.from);
    const to = str(req.query.to);
    const dashboard = await getFinanceDashboard(req.db!, { from, to });
    return res.json({ dashboard });
  }),
);

// ── Bank Accounts (cash + named bank accounts) ──────────────────────────────
financeRouter.get(
  "/bank-accounts",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const activeOnly = req.query.activeOnly === "true";
    const accountType = str(req.query.accountType);
    const branchPublicId = str(req.query.branchPublicId);
    const bankAccounts = await listBankAccounts(req.db!, { activeOnly, accountType, branchPublicId });
    return res.json({ bankAccounts });
  }),
);

financeRouter.post(
  "/bank-accounts",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const parsed = createBankAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid bank account", details: parsed.error.flatten() });
    }
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    try {
      const branchId = await resolveBranchId(req, staff, parsed.data.branchPublicId);
      const bankAccount = await createBankAccount(req.db!, branchId, staff.userId, parsed.data);
      return res.status(201).json({ bankAccount });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

financeRouter.patch(
  "/bank-accounts/:publicId",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const parsed = updateBankAccountSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid bank account update", details: parsed.error.flatten() });
    }
    try {
      const bankAccount = await updateBankAccount(req.db!, param(req.params.publicId), parsed.data);
      return res.json({ bankAccount });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

financeRouter.delete(
  "/bank-accounts/:publicId",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    try {
      await deleteBankAccount(req.db!, param(req.params.publicId));
      return res.json({ ok: true });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

// ── Vendors ─────────────────────────────────────────────────────────────────
financeRouter.get(
  "/vendors",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const activeOnly = req.query.activeOnly === "true";
    const q = str(req.query.q);
    const branchPublicId = str(req.query.branchPublicId);
    const vendors = await listVendors(req.db!, { activeOnly, q, branchPublicId });
    return res.json({ vendors });
  }),
);

financeRouter.post(
  "/vendors",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const parsed = createVendorSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid vendor", details: parsed.error.flatten() });
    }
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    try {
      const branchId = await resolveBranchId(req, staff, parsed.data.branchPublicId);
      const vendor = await createVendor(req.db!, branchId, staff.userId, parsed.data);
      return res.status(201).json({ vendor });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

financeRouter.patch(
  "/vendors/:publicId",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const parsed = updateVendorSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid vendor update", details: parsed.error.flatten() });
    }
    try {
      const vendor = await updateVendor(req.db!, param(req.params.publicId), parsed.data);
      return res.json({ vendor });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

financeRouter.delete(
  "/vendors/:publicId/hard",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    try {
      const result = await hardDeleteVendor(req.db!, param(req.params.publicId));
      return res.json({ ok: true, ...result });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

financeRouter.get(
  "/vendors/:publicId/ledger",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    try {
      const ledger = await getVendorLedger(req.db!, param(req.params.publicId));
      return res.json(ledger);
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

financeRouter.get(
  "/vendors/:publicId/ledger/pdf",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    try {
      const publicIdArg = param(req.params.publicId);
      const [ledger, info] = await Promise.all([
        getVendorLedger(req.db!, publicIdArg),
        getVendorHeaderInfo(req.db!, publicIdArg),
      ]);
      const contactLine = [info.contactName, info.phone, info.email].filter(Boolean).join(" · ");
      const html = ledgerHtml({
        kind: "vendor",
        partyName: info.name,
        contactLine: contactLine || info.address,
        branchName: info.branchName,
        branchCity: info.branchCity,
        entries: ledger.entries,
        closingBalance: ledger.closingBalance,
      });
      const pdf = await htmlToPdf(html, { format: "A4" });
      res.setHeader("content-type", "application/pdf");
      res.setHeader("content-disposition", `inline; filename="VendorStatement-${publicIdArg}.pdf"`);
      return res.end(pdf);
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

// ── Invoices (AR) ───────────────────────────────────────────────────────────
financeRouter.get(
  "/invoices",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const status = str(req.query.status);
    const q = str(req.query.q);
    const branchPublicId = str(req.query.branchPublicId);
    const invoices = await listInvoices(req.db!, { status, q, branchPublicId });
    return res.json({ invoices });
  }),
);

financeRouter.get(
  "/invoices/:publicId",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    try {
      const invoice = await getInvoice(req.db!, param(req.params.publicId));
      return res.json({ invoice });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

financeRouter.get(
  "/invoices/:publicId/pdf",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    try {
      const invoice = await getInvoice(req.db!, param(req.params.publicId));
      if (invoice.isCreditNote) {
        return res.status(400).json({ error: "Credit notes don't have a PDF — only debit invoices do" });
      }
      const pdf = await htmlToPdf(invoiceHtml(invoice), { format: "A4" });
      res.setHeader("content-type", "application/pdf");
      res.setHeader("content-disposition", `inline; filename="Invoice-${invoice.invoiceNo}.pdf"`);
      return res.end(pdf);
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

financeRouter.post(
  "/invoices",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const parsed = createInvoiceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid invoice", details: parsed.error.flatten() });
    }
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    try {
      const branchId = await resolveBranchId(req, staff, parsed.data.branchPublicId);
      const invoice = await createInvoice(req.db!, branchId, staff.userId, parsed.data);
      return res.status(201).json({ invoice });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

financeRouter.patch(
  "/invoices/:publicId",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const parsed = updateInvoiceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid invoice update", details: parsed.error.flatten() });
    }
    try {
      const invoice = await updateInvoice(req.db!, param(req.params.publicId), parsed.data);
      return res.json({ invoice });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

financeRouter.delete(
  "/invoices/:publicId",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    try {
      await deleteInvoice(req.db!, param(req.params.publicId));
      return res.json({ ok: true });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

// ── Customer Ledger (AR) ────────────────────────────────────────────────────
financeRouter.get(
  "/customers/:publicId/ledger",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    try {
      const ledger = await getCustomerLedger(req.db!, param(req.params.publicId));
      return res.json(ledger);
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

financeRouter.get(
  "/customers/:publicId/ledger/pdf",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    try {
      const publicIdArg = param(req.params.publicId);
      const [ledger, info] = await Promise.all([
        getCustomerLedger(req.db!, publicIdArg),
        getCustomerHeaderInfo(req.db!, publicIdArg),
      ]);
      const contactLine = [info.email, info.phone].filter(Boolean).join(" · ");
      const html = ledgerHtml({
        kind: "customer",
        partyName: info.name,
        contactLine,
        branchName: info.branchName,
        branchCity: info.branchCity,
        entries: ledger.entries,
        closingBalance: ledger.closingBalance,
      });
      const pdf = await htmlToPdf(html, { format: "A4" });
      res.setHeader("content-type", "application/pdf");
      res.setHeader("content-disposition", `inline; filename="CustomerStatement-${publicIdArg}.pdf"`);
      return res.end(pdf);
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

// ── Vendor Bills (AP) ───────────────────────────────────────────────────────
financeRouter.get(
  "/vendor-bills",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const status = str(req.query.status);
    const q = str(req.query.q);
    const branchPublicId = str(req.query.branchPublicId);
    const bills = await listVendorBills(req.db!, { status, q, branchPublicId });
    return res.json({ bills });
  }),
);

financeRouter.get(
  "/vendor-bills/:publicId",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    try {
      const bill = await getVendorBill(req.db!, param(req.params.publicId));
      return res.json({ bill });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

financeRouter.get(
  "/vendor-bills/:publicId/pdf",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    try {
      const bill = await getVendorBill(req.db!, param(req.params.publicId));
      const pdf = await htmlToPdf(vendorBillHtml(bill), { format: "A4" });
      res.setHeader("content-type", "application/pdf");
      res.setHeader("content-disposition", `inline; filename="VendorBill-${bill.billNo ?? bill.publicId}.pdf"`);
      return res.end(pdf);
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

financeRouter.post(
  "/vendor-bills",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const parsed = createVendorBillSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid vendor bill", details: parsed.error.flatten() });
    }
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    try {
      const branchId = await resolveBranchId(req, staff, parsed.data.branchPublicId);
      const bill = await createVendorBill(req.db!, branchId, staff.userId, parsed.data);
      return res.status(201).json({ bill });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

financeRouter.patch(
  "/vendor-bills/:publicId",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const parsed = updateVendorBillSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid vendor bill update", details: parsed.error.flatten() });
    }
    try {
      const bill = await updateVendorBill(req.db!, param(req.params.publicId), parsed.data);
      return res.json({ bill });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

financeRouter.delete(
  "/vendor-bills/:publicId",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    try {
      await deleteVendorBill(req.db!, param(req.params.publicId));
      return res.json({ ok: true });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

// ── Payments ────────────────────────────────────────────────────────────────
financeRouter.get(
  "/payments",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const direction = str(req.query.direction);
    const from = str(req.query.from);
    const to = str(req.query.to);
    const payments = await listPayments(req.db!, { direction, from, to });
    return res.json({ payments });
  }),
);

financeRouter.post(
  "/payments",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const parsed = createPaymentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid payment", details: parsed.error.flatten() });
    }
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    try {
      const branchId = await resolveBranchId(req, staff, parsed.data.branchPublicId);
      const payment = await createPayment(req.db!, branchId, staff.userId, parsed.data);
      return res.status(201).json({ payment });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

financeRouter.delete(
  "/payments/:publicId",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    try {
      await deletePayment(req.db!, param(req.params.publicId));
      return res.json({ ok: true });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

// ── Expenses ────────────────────────────────────────────────────────────────
financeRouter.get(
  "/expenses",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const category = str(req.query.category);
    const from = str(req.query.from);
    const to = str(req.query.to);
    const expenses = await listExpenses(req.db!, { category, from, to });
    return res.json({ expenses });
  }),
);

financeRouter.post(
  "/expenses",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const parsed = createExpenseSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid expense", details: parsed.error.flatten() });
    }
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    try {
      const branchId = await resolveBranchId(req, staff, parsed.data.branchPublicId);
      const expense = await createExpense(req.db!, branchId, staff.userId, parsed.data);
      return res.status(201).json({ expense });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

financeRouter.patch(
  "/expenses/:publicId",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const parsed = updateExpenseSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid expense update", details: parsed.error.flatten() });
    }
    try {
      const expense = await updateExpense(req.db!, param(req.params.publicId), parsed.data);
      return res.json({ expense });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

financeRouter.delete(
  "/expenses/:publicId",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    try {
      await deleteExpense(req.db!, param(req.params.publicId));
      return res.json({ ok: true });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

// ── Reports ─────────────────────────────────────────────────────────────────
financeRouter.get(
  "/reports",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    const periodParsed = reportPeriodSchema.safeParse(req.query.period ?? "monthly");
    if (!periodParsed.success) {
      return res.status(400).json({ error: "Invalid period (use daily|monthly|yearly)" });
    }
    const from = str(req.query.from);
    const to = str(req.query.to);
    const report = await getFinanceReport(req.db!, { period: periodParsed.data, from, to });
    return res.json({ report });
  }),
);

financeRouter.delete(
  "/vendors/:publicId",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    try {
      await deleteVendor(req.db!, param(req.params.publicId));
      return res.json({ ok: true });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

// ── Vendor hard delete (permanent, cascades bills + payments) ──────────────
financeRouter.delete(
  "/vendors/:publicId/hard",
  requireStaff, requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    try {
      const result = await hardDeleteVendor(req.db!, param(req.params.publicId));
      return res.json({ ok: true, ...result });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);