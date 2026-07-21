// Saved-contact (address book) routes.
//
// Staff routes (/api/contacts/*) — a branch-wide book, gated by the existing
// orders.view / orders.create permissions since contacts only exist to speed
// up order entry (no dedicated "contacts.*" permission was added — flag if
// you'd rather have one for finer-grained control).
//
// Customer routes (/api/portal/contacts/*) — each customer's own address
// book, gated by requireCustomer and always scoped to their own contacts,
// mirroring portalOrderRouter.

import { Router, type Response } from "express";
import { asyncHandler } from "../../lib/http.js";
import { requireStaff, requireCustomer, requirePermission } from "../../middleware/auth.js";
import { isStaff, isCustomer } from "../auth/types.js";
import { createSavedContactSchema } from "./schema.js";
import {
  SavedContactError,
  createCustomerContact,
  listCustomerContacts,
  deleteCustomerContact,
  createStaffContact,
  listStaffContacts,
  deleteStaffContact,
  resolveBranchId,
} from "./queries.js";

function handleContactError(err: unknown, res: Response): void {
  if (err instanceof SavedContactError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

function param(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export const contactsRouter: Router = Router();       // staff: /api/contacts
export const portalContactsRouter: Router = Router(); // customer: /api/portal/contacts

// ── STAFF ─────────────────────────────────────────────────────────────────

contactsRouter.post(
  "/",
  requireStaff,
  requirePermission("orders.create"),
  asyncHandler(async (req, res) => {
    const parsed = createSavedContactSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid contact", details: parsed.error.flatten() });
    }
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    try {
      let branchId: string;
      if (staff.role === "super_admin") {
        if (!parsed.data.branchPublicId) {
          return res.status(400).json({ error: "branchPublicId is required for super-admin" });
        }
        branchId = await resolveBranchId(req.db!, parsed.data.branchPublicId);
      } else {
        branchId = staff.branchId!;
      }
      const contact = await createStaffContact(req.db!, branchId, staff.userId, parsed.data);
      return res.status(201).json({ contact });
    } catch (err) {
      return handleContactError(err, res);
    }
  }),
);

contactsRouter.get(
  "/",
  requireStaff,
  requirePermission("orders.view"),
  asyncHandler(async (req, res) => {
    const customerPublicId = typeof req.query.customerPublicId === "string" ? req.query.customerPublicId : undefined;
    const contacts = await listStaffContacts(req.db!, { customerPublicId });
    return res.json({ contacts });
  }),
);

contactsRouter.delete(
  "/:publicId",
  requireStaff,
  requirePermission("orders.create"),
  asyncHandler(async (req, res) => {
    try {
      await deleteStaffContact(req.db!, param(req.params.publicId));
      return res.json({ ok: true });
    } catch (err) {
      return handleContactError(err, res);
    }
  }),
);

// ── CUSTOMER ─────────────────────────────────────────────────────────────────

portalContactsRouter.post(
  "/",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const parsed = createSavedContactSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid contact", details: parsed.error.flatten() });
    }
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    try {
      const contact = await createCustomerContact(req.db!, cust.branchId, cust.customerId, parsed.data);
      return res.status(201).json({ contact });
    } catch (err) {
      return handleContactError(err, res);
    }
  }),
);

portalContactsRouter.get(
  "/",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    const contacts = await listCustomerContacts(req.db!, cust.customerId);
    return res.json({ contacts });
  }),
);

portalContactsRouter.delete(
  "/:publicId",
  requireCustomer,
  asyncHandler(async (req, res) => {
    const cust = req.auth!;
    if (!isCustomer(cust)) return res.status(403).json({ error: "Customer only" });
    try {
      await deleteCustomerContact(req.db!, cust.customerId, param(req.params.publicId));
      return res.json({ ok: true });
    } catch (err) {
      return handleContactError(err, res);
    }
  }),
);
