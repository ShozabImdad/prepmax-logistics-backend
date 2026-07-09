// Account management routes.
//   - Super-admin: create branches, branch-manager accounts, and customers.
//   - Branch manager: create customers in their own branch.
//
// Branch isolation is enforced by RLS via req.db (the manager's context can
// only INSERT rows for their own branch — the WITH CHECK policy blocks others,
// proven in the isolation tests). Permission checks gate who can call these.

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/http.js";
import { hashPassword } from "../../lib/password.js";
import { publicId } from "../../lib/ids.js";
import {
  requireStaff,
  requireSuperAdmin,
  requirePermission,
} from "../../middleware/auth.js";
import { isStaff } from "../auth/types.js";
import { withoutContext, withSuperAdminAllBranches } from "../../db/pool.js";

export const accountsRouter: Router = Router();

// ── Create a branch (super-admin only) ──────────────────────────────────────
const branchInput = z.object({
  name: z.string().min(1),
  city: z.string().min(1),
});
accountsRouter.post(
  "/branches",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const parsed = branchInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "name and city are required" });
    const row = await withSuperAdminAllBranches(async (sql) => {
      const { rows } = await sql.query(
        `INSERT INTO branches (public_id, name, city) VALUES ($1,$2,$3)
         RETURNING public_id, name, city, is_active`,
        [publicId(), parsed.data.name, parsed.data.city],
      );
      return rows[0];
    });
    // camelCase to match the list endpoint + frontend contract.
    return res.status(201).json({
      branch: { publicId: row.public_id, name: row.name, city: row.city, isActive: row.is_active },
    });
  }),
);

// ── Create a branch-manager account (super-admin only) ──────────────────────
const managerInput = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(1),
  branchPublicId: z.string().min(1),
});
accountsRouter.post(
  "/managers",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const parsed = managerInput.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "email, password (min 8), fullName, branchPublicId required" });
    }
    const hash = await hashPassword(parsed.data.password);
    try {
      const row = await withSuperAdminAllBranches(async (sql) => {
        const b = await sql.query<{ id: string }>(
          "SELECT id FROM branches WHERE public_id = $1",
          [parsed.data.branchPublicId],
        );
        if (!b.rows[0]) throw new HttpError(404, "Branch not found");
        const { rows } = await sql.query<{ id: string; public_id: string; email: string; full_name: string; branch_id: string }>(
          `INSERT INTO users (public_id, branch_id, role, email, password_hash, full_name)
           VALUES ($1,$2,'branch_manager',$3,$4,$5)
           RETURNING id, public_id, email, full_name, branch_id`,
          [publicId(), b.rows[0].id, parsed.data.email, hash, parsed.data.fullName],
        );
        const newUser = rows[0]!;
        // Assign the default global "Branch Manager" role so the new manager
        // has working permissions immediately. Their permissions can then be
        // tuned via the permissions toggle page.
        await sql.query(
          `INSERT INTO user_roles (user_id, role_id)
             SELECT $1, id FROM roles WHERE branch_id IS NULL AND name = 'Branch Manager'
           ON CONFLICT DO NOTHING`,
          [newUser.id],
        );
        return { publicId: newUser.public_id, email: newUser.email, fullName: newUser.full_name };
      });
      return res.status(201).json({ manager: row });
    } catch (err) {
      return handleError(err, res, "A user with that email already exists");
    }
  }),
);

// ── Create a customer account (super-admin OR branch manager) ───────────────
const customerInput = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(1),
  phone: z.string().optional(),
  // Business fields (all optional per client): company, NTN (tax no.), address.
  companyName: z.string().optional(),
  ntn: z.string().optional(),
  address: z.string().optional(),
  // super-admin may target a branch; managers always use their own
  branchPublicId: z.string().optional(),
});
accountsRouter.post(
  "/customers",
  requireStaff,
  requirePermission("customers.create"),
  asyncHandler(async (req, res) => {
    const parsed = customerInput.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "email, password (min 8), fullName required" });
    }
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    const hash = await hashPassword(parsed.data.password);

    try {
      const row = await req.db!(async (sql) => {
        // Resolve the target branch:
        //   - branch_manager: forced to their own branch
        //   - super_admin: must specify branchPublicId
        let branchId: string;
        if (staff.role === "branch_manager") {
          branchId = staff.branchId!;
        } else {
          if (!parsed.data.branchPublicId) throw new HttpError(400, "branchPublicId required for super-admin");
          const b = await sql.query<{ id: string }>(
            "SELECT id FROM branches WHERE public_id = $1",
            [parsed.data.branchPublicId],
          );
          if (!b.rows[0]) throw new HttpError(404, "Branch not found");
          branchId = b.rows[0].id;
        }
        const { rows } = await sql.query(
          `INSERT INTO customers (public_id, branch_id, full_name, email, phone, password_hash,
                                  company_name, ntn, address)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING public_id, full_name, email, phone, company_name, ntn, address`,
          [publicId(), branchId, parsed.data.fullName, parsed.data.email, parsed.data.phone ?? null, hash,
           parsed.data.companyName ?? null, parsed.data.ntn ?? null, parsed.data.address ?? null],
        );
        const c = rows[0];
        return {
          publicId: c.public_id, fullName: c.full_name, email: c.email, phone: c.phone,
          companyName: c.company_name, ntn: c.ntn, address: c.address,
        };
      });
      return res.status(201).json({ customer: row });
    } catch (err) {
      return handleError(err, res, "A customer with that email already exists in this branch");
    }
  }),
);

// ── List branches (super-admin sees all; managers see their own) ────────────
accountsRouter.get(
  "/branches",
  requireStaff,
  asyncHandler(async (req, res) => {
    const staff = req.auth!;
    if (!isStaff(staff)) return res.status(403).json({ error: "Staff only" });
    const rows = await withSuperAdminAllBranches(async (sql) => {
      const where = staff.role === "branch_manager" ? "WHERE id = $1" : "";
      const params = staff.role === "branch_manager" ? [staff.branchId] : [];
      const r = await sql.query(
        `SELECT public_id, name, city, is_active, volumetric_divisor, created_at
           FROM branches ${where} ORDER BY name`,
        params,
      );
      return r.rows;
    });
    return res.json({
      branches: rows.map((b) => ({
        publicId: b.public_id, name: b.name, city: b.city, isActive: b.is_active,
        volumetricDivisor: b.volumetric_divisor, createdAt: b.created_at,
      })),
    });
  }),
);

// ── List customers (branch-scoped via req.db / RLS) ─────────────────────────
accountsRouter.get(
  "/customers",
  requireStaff,
  requirePermission("customers.view"),
  asyncHandler(async (req, res) => {
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const rows = await req.db!(async (sql) => {
      const params: unknown[] = [];
      let where = "";
      if (search) {
        params.push(`%${search}%`);
        where = `WHERE full_name ILIKE $1 OR email ILIKE $1 OR COALESCE(company_name,'') ILIKE $1`;
      }
      const r = await sql.query(
        `SELECT public_id, full_name, email, phone, company_name, ntn, address, is_active, created_at
           FROM customers ${where} ORDER BY created_at DESC LIMIT 200`,
        params,
      );
      return r.rows;
    });
    return res.json({
      customers: rows.map((c) => ({
        publicId: c.public_id, fullName: c.full_name, email: c.email, phone: c.phone,
        companyName: c.company_name, ntn: c.ntn, address: c.address, isActive: c.is_active, createdAt: c.created_at,
      })),
    });
  }),
);

// ── tiny error helpers ──────────────────────────────────────────────────────
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
function handleError(err: unknown, res: import("express").Response, uniqueMsg: string) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  // Postgres unique-violation
  if (typeof err === "object" && err && (err as { code?: string }).code === "23505") {
    return res.status(409).json({ error: uniqueMsg });
  }
  throw err;
}
