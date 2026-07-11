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
import { createOrderSchema, editOrderSchema, legSchema } from "./schema.js";
import { createOrder, OrderError, type Creator } from "./service.js";
import {
  approveOrder,
  cancelOrder,
  deleteOrder,
  attachLegs,
  editLeg,
  listOrders,
  getOrderDetail,
  resolveOrderId,
  editOrder,
} from "./queries.js";
import { syncOrder } from "../../tracking/sync.js";
import { emitEvent } from "../notifications/events.js";

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
      // Emit AFTER the create transaction has committed (non-blocking).
      emitEvent({ kind: "order_created", orderId: result.orderId, branchId: result.branchId, createdVia: result.createdVia });
      return res.status(201).json({ order: { publicId: result.publicId, trackingCode: result.trackingCode, orderStatus: result.orderStatus } });
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
    const search = typeof req.query.q === "string" ? req.query.q : undefined;
    const createdVia = typeof req.query.createdVia === "string" ? req.query.createdVia : undefined;
    const orders = await listOrders(req.db!, { status, createdVia, search });
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
      const { orderId, branchId } = await approveOrder(req.db!, param(req.params.publicId), staff.userId);
      emitEvent({ kind: "order_approved", orderId, branchId });
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

// ── STAFF: delete an order permanently (cascade) ────────────────────────────
orderRouter.delete(
  "/:publicId",
  requireStaff,
  requirePermission("orders.delete"),
  asyncHandler(async (req, res) => {
    try {
      await deleteOrder(req.db!, param(req.params.publicId));
      return res.json({ ok: true });
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
      // When the first leg activates the order, notify the customer it's now trackable.
      if (result.justActivated) {
        emitEvent({ kind: "order_activated", orderId: result.orderId, branchId: result.branchId });
      }
      return res.json({ ok: true, orderStatus: result.orderStatus, legCount: result.legCount });
    } catch (err) {
      return handleOrderError(err, res);
    }
  }),
);

// ── STAFF: edit an existing carrier leg (correct carrier / tracking number) ──
const editLegBody = z.object({
  carrier: z.string().min(1).optional(),
  trackingNumber: z.string().min(1).optional(),
});
orderRouter.patch(
  "/:publicId/legs/:sequence",
  requireStaff,
  requirePermission("tracking.manage"),
  asyncHandler(async (req, res) => {
    const parsed = editLegBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "carrier and/or trackingNumber required" });
    const seq = Number(param(req.params.sequence));
    if (!Number.isInteger(seq) || seq < 1) return res.status(400).json({ error: "Invalid leg sequence" });
    try {
      const result = await editLeg(req.db!, param(req.params.publicId), seq, parsed.data);
      return res.json({ ok: true, eventsCleared: result.cleared });
    } catch (err) {
      return handleOrderError(err, res);
    }
  }),
);

// ── STAFF: edit an order ────────────────────────────────────────────────────
orderRouter.patch(
  "/:publicId",
  requireStaff,
  requirePermission("orders.edit"),
  asyncHandler(async (req, res) => {
    const parsed = editOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid edit", details: parsed.error.flatten() });
    }
    try {
      await editOrder(req.db!, param(req.params.publicId), parsed.data);
      return res.json({ ok: true });
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
    // Customers submit a booking REQUEST — they don't set what the vendor
    // charges. Strip pricing/payment so only staff can price an order.
    const bookingInput = {
      ...parsed.data,
      price: undefined,
      paymentStatus: undefined,
      amountPaid: undefined,
    };
    try {
      const result = await createOrder(req.db!, creator, bookingInput);
      emitEvent({ kind: "order_created", orderId: result.orderId, branchId: result.branchId, createdVia: result.createdVia });
      return res.status(201).json({
        order: { publicId: result.publicId, trackingCode: result.trackingCode, orderStatus: result.orderStatus },
        message: "Booking request submitted for branch approval",
      });
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
