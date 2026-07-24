// Complaint routes.
//
// Customer routes (/api/portal/complaints) let a logged-in customer file a
// complaint against one of their own orders and see their history. Staff
// routes (/api/complaints) are permission-gated (complaints.manage)
// and scoped by branch RLS beneath req.db, same as orders.

import { Router, type Response } from "express";
import { asyncHandler } from "../../lib/http.js";
import { requireStaff, requireCustomer, requirePermission } from "../../middleware/auth.js";
import { isStaff, isCustomer } from "../auth/types.js";
import { createComplaintSchema, updateComplaintSchema } from "./schema.js";
import {
  createComplaint, listComplaints, listCustomerComplaints, updateComplaint, deleteComplaint,
  listComplaintMessages, addComplaintMessage, verifyComplaintOwnership, ComplaintError,
} from "./queries.js";
import { createBranchNotification } from "../notifications/service.js";
import { addSseClient } from "../notifications/sse.js";

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

// ── CUSTOMER: live stream ────────────────────────────────────────────────────
// No customer-facing SSE existed before this; staff already has one at
// /api/notifications/stream (see modules/notifications/routes.ts). This
// reuses the exact same branch-scoped hub (addSseClient / pushToBranch) —
// customers and staff on the same branch share one push fan-out, they just
// connect from different URLs. Mount at GET /api/portal/complaints/stream.
portalComplaintRouter.get("/stream", requireCustomer, (req, res) => {
  const cust = req.auth!;
  if (!isCustomer(cust)) {
    res.status(403).end();
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const remove = addSseClient(cust.branchId, cust.customerId, res);
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* closed */ }
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    remove();
  });
});

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
  requirePermission("complaints.manage"),
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
// ── SUPER ADMIN: delete a complaint ─────────────────────────────────────────
// Gated by both the normal permission (branch-scoped RLS still applies via
// req.db) AND a super-admin role check, since this is a hard delete.
complaintRouter.delete(
  "/:publicId",
  requireStaff,
  requirePermission("complaints.manage"),
  asyncHandler(async (req, res) => {
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    if (staff.role !== "super_admin") {
      return res.status(403).json({ error: "Super admin only" });
    }
    try {
      await deleteComplaint(req.db!, param(req.params.publicId));
      // 200 + JSON body (not bare 204) — the BFF proxy relays every backend
      // response through .json(), which throws on an empty 204 body.
      return res.status(200).json({ ok: true });
    } catch (err) {
      return handleComplaintError(err, res);
    }
  }),
);

complaintRouter.get(
  "/:publicId/messages",
  requireStaff,
  requirePermission("complaints.manage"),
  asyncHandler(async (req, res) => {
    try {
      const messages = await listComplaintMessages(req.db!, param(req.params.publicId));
      return res.json({ messages });
    } catch (err) {
      return handleComplaintError(err, res);
    }
  }),
);

complaintRouter.post(
  "/:publicId/messages",
  requireStaff,
  requirePermission("complaints.manage"),
  asyncHandler(async (req, res) => {
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!body) return res.status(400).json({ error: "Message body is required" });
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    try {
      const message = await addComplaintMessage(req.db!, param(req.params.publicId), "staff", staff.userId, body);
      return res.status(201).json({ message });
    } catch (err) {
      return handleComplaintError(err, res);
    }
  }),
);

// ── CUSTOMER: message thread on own complaint ───────────────────────────────
portalComplaintRouter.get(
  "/:publicId/messages",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    try {
      await verifyComplaintOwnership(req.db!, param(req.params.publicId), cust.customerId);
      const messages = await listComplaintMessages(req.db!, param(req.params.publicId));
      return res.json({ messages });
    } catch (err) {
      return handleComplaintError(err, res);
    }
  }),
);

portalComplaintRouter.post(
  "/:publicId/messages",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!body) return res.status(400).json({ error: "Message body is required" });
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    try {
      await verifyComplaintOwnership(req.db!, param(req.params.publicId), cust.customerId);
      const message = await addComplaintMessage(req.db!, param(req.params.publicId), "customer", cust.customerId, body);
      return res.status(201).json({ message });
    } catch (err) {
      return handleComplaintError(err, res);
    }
  }),
);