// Customer portal manifest routes — §G of ACCOUNTS_MANIFEST_DESIGN.md.
// A logged-in customer can create a manifest for their own shipments and
// hand them over to Prepmax. It's always stamped with the branch's house
// vendor ("Prepmax Logistics") — a customer can never see or set the real
// downstream carrier, even after staff re-assign it (carrier redaction,
// same principle as public tracking's redactCarrier). Mounted at
// /api/portal/manifests.
//
// Layout:
//   GET    /api/portal/manifests                        — list own manifests
//   POST   /api/portal/manifests                         — create (open, house vendor)
//   GET    /api/portal/manifests/:publicId               — detail (own only)
//   GET    /api/portal/manifests/orders/search?q=        — own eligible orders
//   POST   /api/portal/manifests/:publicId/shipments     — add own orders (open only)
//   DELETE /api/portal/manifests/:publicId/shipments/:orderPublicId (open only)
//
// Deliberately NOT exposed to customers: changing the vendor, close, dispatch,
// PDF/CSV/Excel export — those stay staff-only via /api/manifests.

import { Router } from "express";
import { asyncHandler } from "../../lib/http.js";
import { requireCustomer } from "../../middleware/auth.js";
import { isCustomer } from "../auth/types.js";
import { createBranchNotification } from "../notifications/service.js";
import { createCustomerManifestSchema, addShipmentsSchema } from "./schema.js";
import {
  ManifestError,
  createCustomerManifest, listCustomerManifests, getManifest, verifyManifestOwnership,
  addCustomerShipments, removeCustomerShipment, searchEligibleOrdersForCustomer,
} from "./queries.js";

export const portalManifestRouter: Router = Router();

function handleManifestError(err: unknown, res: import("express").Response): void {
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

// A customer-facing manifest never reveals the real carrier — always shown
// as "Prepmax Logistics" regardless of what vendor_id staff later set it to
// (redaction rule, §G point 6 of the design doc).
function redactManifestForCustomer<T extends { vendorPublicId: string | null; vendorName: string | null }>(
  m: T,
): T {
  return { ...m, vendorPublicId: null, vendorName: "Prepmax Logistics" };
}

// ── list own manifests ──────────────────────────────────────────────────────
portalManifestRouter.get(
  "/",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    const manifests = await listCustomerManifests(req.db!, cust.customerId);
    return res.json({ manifests: manifests.map(redactManifestForCustomer) });
  }),
);

// ── search own eligible orders (for "add shipments" screen) ────────────────
portalManifestRouter.get(
  "/orders/search",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    const q = str(req.query.q);
    const orders = await searchEligibleOrdersForCustomer(req.db!, cust.customerId, q);
    return res.json({ orders });
  }),
);

// ── create ───────────────────────────────────────────────────────────────
portalManifestRouter.post(
  "/",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const parsed = createCustomerManifestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid manifest", details: parsed.error.flatten() });
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    try {
      const manifest = await createCustomerManifest(req.db!, cust.branchId, cust.customerId, parsed.data);
      // Staff in-app alert (G-Q1) — best-effort, same pattern as quotes.
      try {
        await createBranchNotification(req.db!, cust.branchId, {
          type: "manifest_requested",
          message: `New customer manifest ${manifest.manifestNo} from ${cust.fullName}`,
          orderId: null,
        });
      } catch (err) {
        console.error("[manifests] notification failed:", err);
      }
      return res.status(201).json({ manifest: redactManifestForCustomer(manifest) });
    } catch (err) {
      return handleManifestError(err, res);
    }
  }),
);

// ── get one (own only) ──────────────────────────────────────────────────────
portalManifestRouter.get(
  "/:publicId",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    try {
      await verifyManifestOwnership(req.db!, param(req.params.publicId), cust.customerId);
      const manifest = await getManifest(req.db!, param(req.params.publicId));
      return res.json({ manifest: redactManifestForCustomer(manifest) });
    } catch (err) {
      return handleManifestError(err, res);
    }
  }),
);

// ── add shipments (own orders, open only — enforced in queries) ────────────
portalManifestRouter.post(
  "/:publicId/shipments",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const parsed = addShipmentsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid shipments", details: parsed.error.flatten() });
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    try {
      const manifest = await addCustomerShipments(
        req.db!, param(req.params.publicId), cust.customerId, parsed.data.orderPublicIds,
      );
      return res.status(201).json({ manifest: redactManifestForCustomer(manifest) });
    } catch (err) {
      return handleManifestError(err, res);
    }
  }),
);

// ── remove one shipment (own manifest, open only) ───────────────────────────
portalManifestRouter.delete(
  "/:publicId/shipments/:orderPublicId",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    try {
      const manifest = await removeCustomerShipment(
        req.db!, param(req.params.publicId), cust.customerId, param(req.params.orderPublicId),
      );
      return res.json({ manifest: redactManifestForCustomer(manifest) });
    } catch (err) {
      return handleManifestError(err, res);
    }
  }),
);
