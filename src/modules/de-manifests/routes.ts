// De-Manifest routes — staff only, permission-gated (demanifest.manage),
// branch-scoped via RLS beneath req.db. Mirrors modules/manifest/routes.ts.
//
// Layout:
//   GET    /api/de-manifests
//   POST   /api/de-manifests
//   GET    /api/de-manifests/:publicId
//   PATCH  /api/de-manifests/:publicId                       (open only)
//   POST   /api/de-manifests/:publicId/shipments              (scan/add one, open only)
//   PATCH  /api/de-manifests/:publicId/shipments/:shipmentId  (open only)
//   DELETE /api/de-manifests/:publicId/shipments/:shipmentId  (open only)
//   POST   /api/de-manifests/:publicId/complete                (open -> completed)

import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../lib/http.js";
import { requireStaff, requirePermission } from "../../middleware/auth.js";
import { isStaff } from "../auth/types.js";
import {
  createDeManifestSchema, updateDeManifestSchema, scanShipmentSchema,
  updateShipmentSchema, listDeManifestsQuerySchema,
} from "./schema.js";
import {
  DeManifestError,
  listDeManifests, getDeManifest, createDeManifest, updateDeManifest, deleteDeManifest,
  scanShipment, updateShipment, removeShipment, completeDeManifest,
} from "./queries.js";

export const deManifestRouter: Router = Router(); // staff: /api/de-manifests

function handleDeManifestError(err: unknown, res: Response): void {
  if (err instanceof DeManifestError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

function param(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

// Resolve branch ID for the current request — same convention as
// manifest/routes.ts resolveBranchId.
async function resolveBranchId(
  req: Request,
  staff: { role: string; branchId: string | null },
  branchPublicId?: string,
): Promise<string> {
  if (staff.role === "branch_manager") return staff.branchId!;
  if (!branchPublicId) throw new DeManifestError(400, "branchPublicId is required for super-admin");
  const row = await req.db!(async (sql) => {
    const { rows } = await sql.query<{ id: string }>("SELECT id FROM branches WHERE public_id = $1", [branchPublicId]);
    return rows[0];
  });
  if (!row) throw new DeManifestError(404, "Branch not found");
  return row.id;
}

// ── list ─────────────────────────────────────────────────────────────────
deManifestRouter.get(
  "/",
  requireStaff, requirePermission("demanifest.manage"),
  asyncHandler(async (req, res) => {
    const parsed = listDeManifestsQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
    const deManifests = await listDeManifests(req.db!, parsed.data);
    return res.json({ deManifests });
  }),
);

// ── create ───────────────────────────────────────────────────────────────
deManifestRouter.post(
  "/",
  requireStaff, requirePermission("demanifest.manage"),
  asyncHandler(async (req, res) => {
    const parsed = createDeManifestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid de-manifest", details: parsed.error.flatten() });
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    try {
      const branchId = await resolveBranchId(req, staff, parsed.data.branchPublicId);
      const deManifest = await createDeManifest(req.db!, branchId, staff.userId, parsed.data);
      return res.status(201).json({ deManifest });
    } catch (err) {
      return handleDeManifestError(err, res);
    }
  }),
);

// ── get one (header + shipments) ────────────────────────────────────────────
deManifestRouter.get(
  "/:publicId",
  requireStaff, requirePermission("demanifest.manage"),
  asyncHandler(async (req, res) => {
    try {
      const deManifest = await getDeManifest(req.db!, param(req.params.publicId));
      return res.json({ deManifest });
    } catch (err) {
      return handleDeManifestError(err, res);
    }
  }),
);

// ── update header (open only) ───────────────────────────────────────────────
deManifestRouter.patch(
  "/:publicId",
  requireStaff, requirePermission("demanifest.manage"),
  asyncHandler(async (req, res) => {
    const parsed = updateDeManifestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid update", details: parsed.error.flatten() });
    try {
      const deManifest = await updateDeManifest(req.db!, param(req.params.publicId), parsed.data);
      return res.json({ deManifest });
    } catch (err) {
      return handleDeManifestError(err, res);
    }
  }),
);

// ── scan/add a shipment ─────────────────────────────────────────────────────
deManifestRouter.post(
  "/:publicId/shipments",
  requireStaff, requirePermission("demanifest.manage"),
  asyncHandler(async (req, res) => {
    const parsed = scanShipmentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid shipment scan", details: parsed.error.flatten() });
    try {
      const deManifest = await scanShipment(req.db!, param(req.params.publicId), parsed.data);
      return res.status(201).json({ deManifest });
    } catch (err) {
      return handleDeManifestError(err, res);
    }
  }),
);

// ── update a scanned row (condition / reconciliation / remarks) ────────────
deManifestRouter.patch(
  "/:publicId/shipments/:shipmentId",
  requireStaff, requirePermission("demanifest.manage"),
  asyncHandler(async (req, res) => {
    const parsed = updateShipmentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid update", details: parsed.error.flatten() });
    try {
      const deManifest = await updateShipment(req.db!, param(req.params.publicId), param(req.params.shipmentId), parsed.data);
      return res.json({ deManifest });
    } catch (err) {
      return handleDeManifestError(err, res);
    }
  }),
);

// ── remove one scanned row ──────────────────────────────────────────────────
deManifestRouter.delete(
  "/:publicId/shipments/:shipmentId",
  requireStaff, requirePermission("demanifest.manage"),
  asyncHandler(async (req, res) => {
    try {
      const deManifest = await removeShipment(req.db!, param(req.params.publicId), param(req.params.shipmentId));
      return res.json({ deManifest });
    } catch (err) {
      return handleDeManifestError(err, res);
    }
  }),
);
// ── delete (hard delete) ────────────────────────────────────────────────────
deManifestRouter.delete(
  "/:publicId",
  requireStaff, requirePermission("demanifest.manage"),
  asyncHandler(async (req, res) => {
    try {
      await deleteDeManifest(req.db!, param(req.params.publicId));
      return res.json({ ok: true });
    } catch (err) {
      return handleDeManifestError(err, res);
    }
  }),
);


// ── complete (open -> completed; unscanned expected rows become 'missing') ─
deManifestRouter.post(
  "/:publicId/complete",
  requireStaff, requirePermission("demanifest.manage"),
  asyncHandler(async (req, res) => {
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    try {
      const deManifest = await completeDeManifest(req.db!, param(req.params.publicId), staff.userId);
      return res.json({ deManifest });
    } catch (err) {
      return handleDeManifestError(err, res);
    }
  }),
);
