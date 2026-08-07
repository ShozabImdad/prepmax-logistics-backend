// Courier catalog routes.
//
// Staff routes (/api/couriers) — full CRUD, gated by the same
// view/add/edit/delete permission split as Branches and Accounts
// (couriers.view, couriers.add, couriers.edit, couriers.delete), so each
// action can be toggled independently per role.
//
// Customer routes (/api/portal/couriers) — read-only, active couriers only,
// so the portal booking form's Service type / courier picker can be built
// from the same catalog without exposing manage actions.

import { Router, type Response } from "express";
import { asyncHandler } from "../../lib/http.js";
import { requireStaff, requireCustomer, requirePermission } from "../../middleware/auth.js";
import { createCourierSchema, updateCourierSchema } from "./schema.js";
import { CourierError, listCouriers, getCourier, createCourier, updateCourier, deleteCourier } from "./queries.js";

function handleCourierError(err: unknown, res: Response): void {
  if (err instanceof CourierError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

function param(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export const courierRouter: Router = Router(); // staff: /api/couriers
export const portalCourierRouter: Router = Router(); // customer: /api/portal/couriers

// ── STAFF ─────────────────────────────────────────────────────────────────

courierRouter.get(
  "/",
  requireStaff,
  requirePermission("couriers.view"),
  asyncHandler(async (req, res) => {
    // Staff management screen wants inactive couriers visible too (so they
    // can be reactivated), unless explicitly asked to filter.
    const activeOnly = req.query.activeOnly === "true";
    const couriers = await listCouriers(req.db!, { activeOnly });
    return res.json({ couriers });
  }),
);

courierRouter.get(
  "/:publicId",
  requireStaff,
  requirePermission("couriers.view"),
  asyncHandler(async (req, res) => {
    try {
      const courier = await getCourier(req.db!, param(req.params.publicId));
      return res.json({ courier });
    } catch (err) {
      return handleCourierError(err, res);
    }
  }),
);

courierRouter.post(
  "/",
  requireStaff,
  requirePermission("couriers.add"),
  asyncHandler(async (req, res) => {
    const parsed = createCourierSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid courier", details: parsed.error.flatten() });
    }
    try {
      const courier = await createCourier(req.db!, parsed.data);
      return res.status(201).json({ courier });
    } catch (err) {
      return handleCourierError(err, res);
    }
  }),
);

courierRouter.patch(
  "/:publicId",
  requireStaff,
  requirePermission("couriers.edit"),
  asyncHandler(async (req, res) => {
    const parsed = updateCourierSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid courier", details: parsed.error.flatten() });
    }
    try {
      const courier = await updateCourier(req.db!, param(req.params.publicId), parsed.data);
      return res.json({ courier });
    } catch (err) {
      return handleCourierError(err, res);
    }
  }),
);

courierRouter.delete(
  "/:publicId",
  requireStaff,
  requirePermission("couriers.delete"),
  asyncHandler(async (req, res) => {
    try {
      await deleteCourier(req.db!, param(req.params.publicId));
      return res.json({ ok: true });
    } catch (err) {
      return handleCourierError(err, res);
    }
  }),
);

// ── CUSTOMER (read-only) ─────────────────────────────────────────────────────

portalCourierRouter.get(
  "/",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const couriers = await listCouriers(req.db!, { activeOnly: true });
    return res.json({ couriers });
  }),
);
