// Vendor (AP partner/carrier) routes — staff only, permission-gated
// (vendors.view / vendors.manage), branch-scoped via RLS beneath req.db,
// same pattern as modules/complaints/routes.ts.

import { Router, type Response } from "express";
import { asyncHandler } from "../../lib/http.js";
import { requireStaff, requirePermission } from "../../middleware/auth.js";
import { isStaff } from "../auth/types.js";
import { createVendorSchema, updateVendorSchema, listVendorsQuerySchema } from "./schema.js";
import { createVendor, listVendors, getVendor, updateVendor, deactivateVendor, hardDeleteVendor, VendorError } from "./queries.js";

function handleVendorError(err: unknown, res: Response): void {
  if (err instanceof VendorError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

function param(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export const vendorRouter: Router = Router(); // staff: /api/vendors

// ── list vendors ─────────────────────────────────────────────────────────
vendorRouter.get(
  "/",
  requireStaff,
  requirePermission("vendors.view"),
  asyncHandler(async (req, res) => {
    const parsed = listVendorsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    }
    const vendors = await listVendors(req.db!, parsed.data);
    return res.json({ vendors });
  }),
);

// ── create vendor ────────────────────────────────────────────────────────
vendorRouter.post(
  "/",
  requireStaff,
  requirePermission("vendors.manage"),
  asyncHandler(async (req, res) => {
    const parsed = createVendorSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid vendor", details: parsed.error.flatten() });
    }
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    try {
      const vendor = await createVendor(req.db!, staff.branchId, parsed.data);
      return res.status(201).json({ vendor });
    } catch (err) {
      return handleVendorError(err, res);
    }
  }),
);

// ── get one vendor ───────────────────────────────────────────────────────
vendorRouter.get(
  "/:publicId",
  requireStaff,
  requirePermission("vendors.view"),
  asyncHandler(async (req, res) => {
    try {
      const vendor = await getVendor(req.db!, param(req.params.publicId));
      return res.json({ vendor });
    } catch (err) {
      return handleVendorError(err, res);
    }
  }),
);

// ── update vendor ────────────────────────────────────────────────────────
vendorRouter.patch(
  "/:publicId",
  requireStaff,
  requirePermission("vendors.manage"),
  asyncHandler(async (req, res) => {
    const parsed = updateVendorSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid update", details: parsed.error.flatten() });
    }
    try {
      const vendor = await updateVendor(req.db!, param(req.params.publicId), parsed.data);
      return res.json({ vendor });
    } catch (err) {
      return handleVendorError(err, res);
    }
  }),
);

// ── deactivate vendor (soft delete) ──────────────────────────────────────
vendorRouter.delete(
  "/:publicId",
  requireStaff,
  requirePermission("vendors.manage"),
  asyncHandler(async (req, res) => {
    try {
      const vendor = await deactivateVendor(req.db!, param(req.params.publicId));
      return res.json({ vendor });
    } catch (err) {
      return handleVendorError(err, res);
    }
  }),
);
vendorRouter.delete(
  "/:publicId/hard",           
  requireStaff,
  requirePermission("finance.manage"),
  asyncHandler(async (req, res) => {
    try {
      const result = await hardDeleteVendor(req.db!, param(req.params.publicId));
      return res.json({ ok: true, ...result });
    } catch (err) {
      return handleVendorError(err, res);
    }
  }),
);