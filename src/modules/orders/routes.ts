// Order routes.
//
// Staff routes (/api/orders/*) are permission-gated (orders.create, .approve,
// tracking.manage, orders.view). Customer routes (/api/portal/orders/*) are
// gated by requireCustomer and always scoped to the logged-in customer's own
// orders. Branch isolation is enforced beneath all of this by RLS via req.db.

import { Router, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/http.js";
import {
  requireStaff,
  requireCustomer,
  requirePermission,
} from "../../middleware/auth.js";
import { isStaff, isCustomer } from "../auth/types.js";
import { createOrderSchema, legSchema } from "./schema.js";
import { createOrder, OrderError, type Creator } from "./service.js";
import {
  approveOrder,
  cancelOrder,
  attachLegs,
  listOrders,
  getOrderDetail,
  resolveOrderId,
} from "./queries.js";
import { syncOrder } from "../../tracking/sync.js";

function handleOrderError(err: unknown, res: Response): void {
  if (err instanceof OrderError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

// req.params values are typed as possibly-undefined under noUncheckedIndexedAccess.
// Routes below always have a single :publicId in the path, so this is safe.
function param(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

export const orderRouter: Router = Router();       // staff: /api/orders
export const portalOrderRouter: Router = Router(); // customer: /api/portal/orders

// ── STAFF: create order ─────────────────────────────────────────────────────
orderRouter.post(
  "/",
  requireStaff,
  requirePermission("orders.create"),
  asyncHandler(async (req, res) => {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid order", details: parsed.error.flatten() });
    }
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    const creator: Creator = {
      kind: "staff", role: staff.role, userId: staff.userId, branchId: staff.branchId,
    };
    try {
      const result = await createOrder(req.db!, creator, parsed.data);
      return res.status(201).json({ order: result });
    } catch (err) {
      return handleOrderError(err, res);
    }
  }),
);

// ── STAFF: list orders ──────────────────────────────────────────────────────
orderRouter.get(
  "/",
  requireStaff,
  requirePermission("orders.view"),
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const orders = await listOrders(req.db!, { status });
    return res.json({ orders });
  }),
);

// ── STAFF: order detail ─────────────────────────────────────────────────────
orderRouter.get(
  "/:publicId",
  requireStaff,
  requirePermission("orders.view"),
  asyncHandler(async (req, res) => {
    const order = await getOrderDetail(req.db!, param(req.params.publicId), { forCustomer: false });
    if (!order) return res.status(404).json({ error: "Order not found" });
    return res.json({ order });
  }),
);

// ── STAFF: approve a customer booking request ───────────────────────────────
orderRouter.post(
  "/:publicId/approve",
  requireStaff,
  requirePermission("orders.approve"),
  asyncHandler(async (req, res) => {
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    try {
      await approveOrder(req.db!, param(req.params.publicId), staff.userId);
      return res.json({ ok: true, orderStatus: "awaiting_carrier" });
    } catch (err) {
      return handleOrderError(err, res);
    }
  }),
);

// ── STAFF: cancel ───────────────────────────────────────────────────────────
orderRouter.post(
  "/:publicId/cancel",
  requireStaff,
  requirePermission("orders.cancel"),
  asyncHandler(async (req, res) => {
    try {
      await cancelOrder(req.db!, param(req.params.publicId));
      return res.json({ ok: true, orderStatus: "cancelled" });
    } catch (err) {
      return handleOrderError(err, res);
    }
  }),
);

// ── STAFF: attach carrier leg(s) ────────────────────────────────────────────
const attachLegsBody = z.object({ legs: z.array(legSchema).min(1).max(2) });
orderRouter.post(
  "/:publicId/legs",
  requireStaff,
  requirePermission("tracking.manage"),
  asyncHandler(async (req, res) => {
    const parsed = attachLegsBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "legs[] (1-2) required" });
    try {
      const result = await attachLegs(req.db!, param(req.params.publicId), parsed.data.legs);
      return res.json({ ok: true, ...result });
    } catch (err) {
      return handleOrderError(err, res);
    }
  }),
);

// ── STAFF: manually refresh tracking for one order (on-demand nudge) ────────
orderRouter.post(
  "/:publicId/sync",
  requireStaff,
  requirePermission("tracking.view"),
  asyncHandler(async (req, res) => {
    // Verify the order is visible to this staff (branch RLS) before syncing.
    const id = await resolveOrderId(req.db!, param(req.params.publicId));
    if (!id) return res.status(404).json({ error: "Order not found" });
    const result = await syncOrder(id);
    return res.json({ result });
  }),
);

// ── CUSTOMER: create a booking request ──────────────────────────────────────
portalOrderRouter.post(
  "/",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid order", details: parsed.error.flatten() });
    }
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    const creator: Creator = { kind: "customer", customerId: cust.customerId, branchId: cust.branchId };
    try {
      const result = await createOrder(req.db!, creator, parsed.data);
      return res.status(201).json({ order: result, message: "Booking request submitted for branch approval" });
    } catch (err) {
      return handleOrderError(err, res);
    }
  }),
);

// ── CUSTOMER: list own orders ───────────────────────────────────────────────
portalOrderRouter.get(
  "/",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    const orders = await listOrders(req.db!, { customerId: cust.customerId });
    return res.json({ orders });
  }),
);

// ── CUSTOMER: own order detail (internal fields stripped) ───────────────────
portalOrderRouter.get(
  "/:publicId",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    const order = await getOrderDetail(req.db!, param(req.params.publicId), {
      customerId: cust.customerId,
      forCustomer: true,
    });
    if (!order) return res.status(404).json({ error: "Order not found" });
    return res.json({ order });
  }),
);
