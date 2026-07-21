// Customer portal finance routes — read-only, scoped to the logged-in
// customer's own records. Mounted at /api/portal/finance.
// Mirrors the auth-gating pattern used by portalOrderRouter / portalComplaintRouter.
//
// Layout:
//   GET /api/portal/finance/summary          — outstanding balance, totals
//   GET /api/portal/finance/invoices         — this customer's invoices
//   GET /api/portal/finance/invoices/:publicId — single invoice (ownership checked)
//   GET /api/portal/finance/payments         — this customer's payment history

import { Router } from "express";
import { asyncHandler } from "../../lib/http.js";
import { requireCustomer } from "../../middleware/auth.js";
import { isCustomer } from "../auth/types.js";
import { FinanceError, listInvoices, getInvoice, listPayments, getCustomerLedger } from "./queries.js";

export const portalFinanceRouter: Router = Router();

function handleFinanceError(err: unknown, res: import("express").Response): void {
  if (err instanceof FinanceError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

// ── Summary: outstanding balance + paid/pending totals ──────────────────────
portalFinanceRouter.get(
  "/summary",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    try {
      const [ledger, invoices] = await Promise.all([
        getCustomerLedger(req.db!, cust.publicId),
        listInvoices(req.db!, { customerPublicId: cust.publicId }),
      ]);
      const nonVoid = invoices.filter((i) => i.status !== "void");
      const totalInvoiced = nonVoid.reduce((s, i) => s + i.total, 0);
      const totalPaid = nonVoid.reduce((s, i) => s + i.amountPaid, 0);
      const totalPending = nonVoid.reduce((s, i) => s + Math.max(0, i.total - i.amountPaid), 0);
      return res.json({
        summary: {
          outstandingBalance: ledger.closingBalance, // running balance from the ledger — the authoritative "what you owe"
          totalInvoiced,
          totalPaid,
          totalPending,
          invoiceCount: nonVoid.length,
        },
      });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

// ── Invoices (list) ──────────────────────────────────────────────────────────
portalFinanceRouter.get(
  "/invoices",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const invoices = await listInvoices(req.db!, { customerPublicId: cust.publicId, status });
    return res.json({ invoices });
  }),
);

// ── Invoices (single) — ownership enforced, not just branch RLS ─────────────
portalFinanceRouter.get(
  "/invoices/:publicId",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    try {
      const invoice = await getInvoice(req.db!, req.params.publicId as string);
      if (invoice.customerPublicId !== cust.publicId) {
        // Don't leak existence of another customer's invoice.
        return res.status(404).json({ error: "Invoice not found" });
      }
      return res.json({ invoice });
    } catch (err) {
      return handleFinanceError(err, res);
    }
  }),
);

// ── Payment history ──────────────────────────────────────────────────────────
portalFinanceRouter.get(
  "/payments",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    const payments = await listPayments(req.db!, { customerPublicId: cust.publicId, direction: "in" });
    return res.json({ payments });
  }),
);
