// Complaint routes.
//
// Customer routes (/api/portal/complaints) let a logged-in customer file a
// complaint against one of their own orders and see their history. Staff
// routes (/api/complaints) are permission-gated (complaints.view / .manage)
// and scoped by branch RLS beneath req.db, same as orders.

import { Router, type Response } from "express";
import { asyncHandler } from "../../lib/http.js";
import { requireStaff, requireCustomer, requirePermission } from "../../middleware/auth.js";
import { isStaff, isCustomer } from "../auth/types.js";
import { createComplaintSchema, updateComplaintSchema } from "./schema.js";
import { createComplaint, listComplaints, listCustomerComplaints, updateComplaint, ComplaintError } from "./queries.js";
import { createBranchNotification } from "../notifications/service.js";

function handleComplaintError(err: unknown, res: Response): void {
  if (err instanceof ComplaintError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

function param(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export const complaintRouter: Router = Router();       // staff: /api/complaints
export const portalComplaintRouter: Router = Router(); // customer: /api/portal/complaints

// ── CUSTOMER: file a complaint ──────────────────────────────────────────────
portalComplaintRouter.post(
  "/",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const parsed = createComplaintSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid complaint", details: parsed.error.flatten() });
    }
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    try {
      const result = await createComplaint(req.db!, cust.customerId, cust.branchId, parsed.data);
      // Admin in-app alert. Best-effort: a notification failure shouldn't fail
      // the complaint the customer just successfully filed.
      try {
        await createBranchNotification(req.db!, cust.branchId, {
          type: "complaint_submitted",
          message: `New complaint on ${result.trackingCode} from ${cust.fullName}`,
          orderId: result.orderId,
        });
      } catch (err) {
        console.error("[complaints] notification failed:", err);
      }
      return res.status(201).json({
        complaint: {
          publicId: result.publicId,
          orderPublicId: result.orderPublicId,
          trackingCode: result.trackingCode,
          category: result.category,
          message: result.message,
          status: result.status,
          response: result.response,
          createdAt: result.createdAt,
          updatedAt: result.updatedAt,
        },
      });
    } catch (err) {
      return handleComplaintError(err, res);
    }
  }),
);

// ── CUSTOMER: list own complaints ───────────────────────────────────────────
portalComplaintRouter.get(
  "/",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    const complaints = await listCustomerComplaints(req.db!, cust.customerId);
    return res.json({ complaints });
  }),
);

// ── STAFF: list complaints (branch-scoped via RLS) ──────────────────────────
complaintRouter.get(
  "/",
  requireStaff,
  requirePermission("complaints.view"),
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const complaints = await listComplaints(req.db!, { status });
    return res.json({ complaints });
  }),
);

// ── STAFF: update status / add a response ───────────────────────────────────
complaintRouter.patch(
  "/:publicId",
  requireStaff,
  requirePermission("complaints.manage"),
  asyncHandler(async (req, res) => {
    const parsed = updateComplaintSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid update", details: parsed.error.flatten() });
    }
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    try {
      const result = await updateComplaint(req.db!, param(req.params.publicId), staff.userId, parsed.data);
      return res.json({
        complaint: {
          publicId: result.publicId,
          orderPublicId: result.orderPublicId,
          trackingCode: result.trackingCode,
          category: result.category,
          message: result.message,
          status: result.status,
          response: result.response,
          createdAt: result.createdAt,
          updatedAt: result.updatedAt,
        },
      });
    } catch (err) {
      return handleComplaintError(err, res);
    }
  }),
);
