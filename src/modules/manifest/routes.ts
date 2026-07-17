// Manifest routes — staff only, permission-gated (manifest.view / .manage),
// branch-scoped via RLS beneath req.db. Mirrors modules/finance/routes.ts.
//
// Layout:
//   GET    /api/manifests
//   GET    /api/manifests/orders/search?q=&branchPublicId=
//   POST   /api/manifests
//   GET    /api/manifests/:publicId
//   PATCH  /api/manifests/:publicId              (open only)
//   POST   /api/manifests/:publicId/shipments    (bulk add, open only)
//   DELETE /api/manifests/:publicId/shipments/:orderPublicId  (open only)
//   POST   /api/manifests/:publicId/close        (open -> closed)
//   POST   /api/manifests/:publicId/dispatch     (closed -> dispatched)

import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../lib/http.js";
import { requireStaff, requirePermission } from "../../middleware/auth.js";
import { isStaff } from "../auth/types.js";
import {
  createManifestSchema, updateManifestSchema, addShipmentsSchema, listManifestsQuerySchema,
} from "./schema.js";
import {
  ManifestError,
  listManifests, getManifest, createManifest, updateManifest,
  addShipments, removeShipment, closeManifest, dispatchManifest, searchEligibleOrders,
} from "./queries.js";

export const manifestRouter: Router = Router(); // staff: /api/manifests

function handleManifestError(err: unknown, res: Response): void {
  if (err instanceof ManifestError) {
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

// Resolve branch ID for the current request — same convention as
// finance/routes.ts resolveBranchId.
async function resolveBranchId(
  req: Request,
  staff: { role: string; branchId: string | null },
  branchPublicId?: string,
): Promise<string> {
  if (staff.role === "branch_manager") return staff.branchId!;
  if (!branchPublicId) throw new ManifestError(400, "branchPublicId is required for super-admin");
  const row = await req.db!(async (sql) => {
    const { rows } = await sql.query<{ id: string }>("SELECT id FROM branches WHERE public_id = $1", [branchPublicId]);
    return rows[0];
  });
  if (!row) throw new ManifestError(404, "Branch not found");
  return row.id;
}

// ── list ─────────────────────────────────────────────────────────────────
manifestRouter.get(
  "/",
  requireStaff, requirePermission("manifest.view"),
  asyncHandler(async (req, res) => {
    const parsed = listManifestsQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    const manifests = await listManifests(req.db!, parsed.data);
    return res.json({ manifests });
  }),
);

// ── search eligible orders (for "add shipments" screen) ────────────────────
manifestRouter.get(
  "/orders/search",
  requireStaff, requirePermission("manifest.manage"),
  asyncHandler(async (req, res) => {
    const q = str(req.query.q);
    if (!q) return res.json({ orders: [] });
    const branchPublicId = str(req.query.branchPublicId);
    const orders = await searchEligibleOrders(req.db!, { q, branchPublicId });
    return res.json({ orders });
  }),
);

// ── create ───────────────────────────────────────────────────────────────
manifestRouter.post(
  "/",
  requireStaff, requirePermission("manifest.manage"),
  asyncHandler(async (req, res) => {
    const parsed = createManifestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid manifest", details: parsed.error.flatten() });
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    try {
      const branchId = await resolveBranchId(req, staff, parsed.data.branchPublicId);
      const manifest = await createManifest(req.db!, branchId, staff.userId, parsed.data);
      return res.status(201).json({ manifest });
    } catch (err) {
      return handleManifestError(err, res);
    }
  }),
);

// ── get one (header + shipments) ────────────────────────────────────────────
manifestRouter.get(
  "/:publicId",
  requireStaff, requirePermission("manifest.view"),
  asyncHandler(async (req, res) => {
    try {
      const manifest = await getManifest(req.db!, param(req.params.publicId));
      return res.json({ manifest });
    } catch (err) {
      return handleManifestError(err, res);
    }
  }),
);

// ── update header (open only) ───────────────────────────────────────────────
manifestRouter.patch(
  "/:publicId",
  requireStaff, requirePermission("manifest.manage"),
  asyncHandler(async (req, res) => {
    const parsed = updateManifestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid update", details: parsed.error.flatten() });
    try {
      const manifest = await updateManifest(req.db!, param(req.params.publicId), parsed.data);
      return res.json({ manifest });
    } catch (err) {
      return handleManifestError(err, res);
    }
  }),
);

// ── add shipments (bulk) ────────────────────────────────────────────────────
manifestRouter.post(
  "/:publicId/shipments",
  requireStaff, requirePermission("manifest.manage"),
  asyncHandler(async (req, res) => {
    const parsed = addShipmentsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid shipments", details: parsed.error.flatten() });
    try {
      const manifest = await addShipments(req.db!, param(req.params.publicId), parsed.data.orderPublicIds);
      return res.status(201).json({ manifest });
    } catch (err) {
      return handleManifestError(err, res);
    }
  }),
);

// ── remove one shipment ─────────────────────────────────────────────────────
manifestRouter.delete(
  "/:publicId/shipments/:orderPublicId",
  requireStaff, requirePermission("manifest.manage"),
  asyncHandler(async (req, res) => {
    try {
      const manifest = await removeShipment(req.db!, param(req.params.publicId), param(req.params.orderPublicId));
      return res.json({ manifest });
    } catch (err) {
      return handleManifestError(err, res);
    }
  }),
);

// ── close (open -> closed) ──────────────────────────────────────────────────
manifestRouter.post(
  "/:publicId/close",
  requireStaff, requirePermission("manifest.manage"),
  asyncHandler(async (req, res) => {
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    try {
      const manifest = await closeManifest(req.db!, param(req.params.publicId), staff.userId);
      return res.json({ manifest });
    } catch (err) {
      return handleManifestError(err, res);
    }
  }),
);

// ── dispatch (closed -> dispatched) ─────────────────────────────────────────
manifestRouter.post(
  "/:publicId/dispatch",
  requireStaff, requirePermission("manifest.manage"),
  asyncHandler(async (req, res) => {
    try {
      const manifest = await dispatchManifest(req.db!, param(req.params.publicId));
      return res.json({ manifest });
    } catch (err) {
      return handleManifestError(err, res);
    }
  }),
);