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

// ── Branch detail (super-admin: stats + recent orders + staff + customers) ──
accountsRouter.get(
  "/branches/:publicId",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const pid = String(req.params.publicId ?? "");
    const data = await withSuperAdminAllBranches(async (sql) => {
      const b = await sql.query(
        `SELECT id, public_id, name, city, is_active, volumetric_divisor, created_at
           FROM branches WHERE public_id = $1`,
        [pid],
      );
      if (!b.rows[0]) return null;
      const branch = b.rows[0];
      const bid = branch.id;

      const stats = await sql.query(
        `SELECT
           (SELECT COUNT(*) FROM orders WHERE branch_id = $1)                                   AS order_count,
           (SELECT COUNT(*) FROM orders WHERE branch_id = $1 AND order_status = 'delivered')     AS delivered_count,
           (SELECT COUNT(*) FROM orders WHERE branch_id = $1
              AND order_status NOT IN ('delivered','cancelled'))                                 AS active_count,
           (SELECT COALESCE(SUM(price),0) FROM orders WHERE branch_id = $1)                      AS revenue,
           (SELECT COUNT(*) FROM customers WHERE branch_id = $1)                                 AS customer_count,
           (SELECT COUNT(*) FROM users WHERE branch_id = $1)                                     AS staff_count`,
        [bid],
      );

      const recentOrders = await sql.query(
        `SELECT public_id, tracking_code, order_status, receiver_city, receiver_country, price, created_at
           FROM orders WHERE branch_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [bid],
      );
      const staff = await sql.query(
        `SELECT public_id, full_name, email, role, is_active
           FROM users WHERE branch_id = $1 ORDER BY full_name`,
        [bid],
      );
      const customers = await sql.query(
        `SELECT public_id, full_name, email, is_active
           FROM customers WHERE branch_id = $1 ORDER BY created_at DESC LIMIT 25`,
        [bid],
      );
      return { branch, stats: stats.rows[0], recentOrders: recentOrders.rows, staff: staff.rows, customers: customers.rows };
    });
    if (!data) return res.status(404).json({ error: "Branch not found" });
    const s = data.stats;
    return res.json({
      branch: {
        publicId: data.branch.public_id, name: data.branch.name, city: data.branch.city,
        isActive: data.branch.is_active, volumetricDivisor: data.branch.volumetric_divisor,
        createdAt: data.branch.created_at,
      },
      stats: {
        orders: Number(s.order_count), delivered: Number(s.delivered_count), active: Number(s.active_count),
        revenue: Number(s.revenue), customers: Number(s.customer_count), staff: Number(s.staff_count),
      },
      recentOrders: data.recentOrders.map((o) => ({
        publicId: o.public_id, trackingCode: o.tracking_code, orderStatus: o.order_status,
        receiverCity: o.receiver_city, receiverCountry: o.receiver_country,
        price: o.price != null ? Number(o.price) : null, createdAt: o.created_at,
      })),
      staff: data.staff.map((u) => ({
        publicId: u.public_id, fullName: u.full_name, email: u.email, role: u.role, isActive: u.is_active,
      })),
      customers: data.customers.map((c) => ({
        publicId: c.public_id, fullName: c.full_name, email: c.email, isActive: c.is_active,
      })),
    });
  }),
);

// ── Edit branch settings (super-admin only) ─────────────────────────────────
const branchEdit = z.object({
  name: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  volumetricDivisor: z.number().int().positive().optional(),
});
accountsRouter.patch(
  "/branches/:publicId",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const parsed = branchEdit.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid branch edit" });
    const pid = String(req.params.publicId ?? "");
    const updated = await withSuperAdminAllBranches(async (sql) => {
      const set: string[] = []; const vals: unknown[] = [];
      const push = (col: string, v: unknown) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
      if (parsed.data.name !== undefined) push("name", parsed.data.name);
      if (parsed.data.city !== undefined) push("city", parsed.data.city);
      if (parsed.data.isActive !== undefined) push("is_active", parsed.data.isActive);
      if (parsed.data.volumetricDivisor !== undefined) push("volumetric_divisor", parsed.data.volumetricDivisor);
      if (set.length === 0) return 1;
      vals.push(pid);
      const r = await sql.query(`UPDATE branches SET ${set.join(", ")} WHERE public_id = $${vals.length}`, vals);
      return r.rowCount ?? 0;
    });
    if (updated === 0) return res.status(404).json({ error: "Branch not found" });
    return res.json({ ok: true });
  }),
);

// ── Delete a branch (super-admin, full cascade) ─────────────────────────────
// branches are ON DELETE RESTRICT from orders/customers/users, so we tear
// those down in FK order first. Orders cascade to boxes/items/legs/tracking.
accountsRouter.delete(
  "/branches/:publicId",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const pid = String(req.params.publicId ?? "");
    const result = await withSuperAdminAllBranches(async (sql) => {
      const b = await sql.query<{ id: string }>("SELECT id FROM branches WHERE public_id = $1", [pid]);
      if (!b.rows[0]) return null;
      const bid = b.rows[0].id;
      const o = await sql.query("DELETE FROM orders WHERE branch_id = $1", [bid]);
      const c = await sql.query("DELETE FROM customers WHERE branch_id = $1", [bid]);
      const u = await sql.query("DELETE FROM users WHERE branch_id = $1", [bid]);
      await sql.query("DELETE FROM branches WHERE id = $1", [bid]); // branch-scoped roles cascade
      return { orders: o.rowCount ?? 0, customers: c.rowCount ?? 0, staff: u.rowCount ?? 0 };
    });
    if (!result) return res.status(404).json({ error: "Branch not found" });
    return res.json({ ok: true, deleted: result });
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
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const rows = await withSuperAdminAllBranches(async (sql) => {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (staff.role === "branch_manager") {
        params.push(staff.branchId);
        conds.push(`id = $${params.length}`);
      }
      if (search) {
        params.push(`%${search}%`);
        conds.push(`(name ILIKE $${params.length} OR city ILIKE $${params.length})`);
      }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
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
    const branchPublicId = typeof req.query.branchPublicId === "string" ? req.query.branchPublicId : "";
    const rows = await req.db!(async (sql) => {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (search) {
        params.push(`%${search}%`);
        conds.push(`(full_name ILIKE $${params.length} OR email ILIKE $${params.length} OR COALESCE(company_name,'') ILIKE $${params.length})`);
      }
      if (branchPublicId) {
        params.push(branchPublicId);
        conds.push(`branch_id = (SELECT id FROM branches WHERE public_id = $${params.length})`);
      }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
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

// ── Customer detail (profile + their orders) ────────────────────────────────
accountsRouter.get(
  "/customers/:publicId",
  requireStaff,
  requirePermission("customers.view"),
  asyncHandler(async (req, res) => {
    const pid = String(req.params.publicId ?? "");
    const data = await req.db!(async (sql) => {
      const c = await sql.query(
        `SELECT id, public_id, full_name, email, phone, company_name, ntn, address, is_active, created_at
           FROM customers WHERE public_id = $1`,
        [pid],
      );
      if (!c.rows[0]) return null;
      const cust = c.rows[0];
      const orders = await sql.query(
        `SELECT public_id, tracking_code, order_status, current_status, receiver_city, receiver_country, price, created_at
           FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [cust.id],
      );
      return { cust, orders: orders.rows };
    });
    if (!data) return res.status(404).json({ error: "Customer not found" });
    const c = data.cust;
    return res.json({
      customer: {
        publicId: c.public_id, fullName: c.full_name, email: c.email, phone: c.phone,
        companyName: c.company_name, ntn: c.ntn, address: c.address, isActive: c.is_active, createdAt: c.created_at,
      },
      orders: data.orders.map((o) => ({
        publicId: o.public_id, trackingCode: o.tracking_code, orderStatus: o.order_status,
        currentStatus: o.current_status, receiverCity: o.receiver_city, receiverCountry: o.receiver_country,
        price: o.price != null ? Number(o.price) : null, createdAt: o.created_at,
      })),
    });
  }),
);

// ── Edit a customer ──────────────────────────────────────────────────────────
const customerEdit = z.object({
  fullName: z.string().min(1).optional(),
  phone: z.string().optional(),
  companyName: z.string().optional(),
  ntn: z.string().optional(),
  address: z.string().optional(),
  isActive: z.boolean().optional(),
});
accountsRouter.patch(
  "/customers/:publicId",
  requireStaff,
  requirePermission("customers.edit"),
  asyncHandler(async (req, res) => {
    const parsed = customerEdit.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid customer edit" });
    const pid = String(req.params.publicId ?? "");
    const d = parsed.data;
    const set: string[] = []; const vals: unknown[] = [];
    const push = (col: string, v: unknown) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
    if (d.fullName !== undefined) push("full_name", d.fullName);
    if (d.phone !== undefined) push("phone", d.phone || null);
    if (d.companyName !== undefined) push("company_name", d.companyName || null);
    if (d.ntn !== undefined) push("ntn", d.ntn || null);
    if (d.address !== undefined) push("address", d.address || null);
    if (d.isActive !== undefined) push("is_active", d.isActive);
    if (set.length === 0) return res.json({ ok: true });
    const updated = await req.db!(async (sql) => {
      vals.push(pid);
      const r = await sql.query(`UPDATE customers SET ${set.join(", ")} WHERE public_id = $${vals.length}`, vals);
      return r.rowCount ?? 0;
    });
    if (updated === 0) return res.status(404).json({ error: "Customer not found" });
    return res.json({ ok: true });
  }),
);

// ── Delete a customer (cascade: their orders too, per client decision) ──────
accountsRouter.delete(
  "/customers/:publicId",
  requireStaff,
  requirePermission("customers.delete"),
  asyncHandler(async (req, res) => {
    const pid = String(req.params.publicId ?? "");
    const result = await req.db!(async (sql) => {
      const c = await sql.query<{ id: string }>("SELECT id FROM customers WHERE public_id = $1", [pid]);
      if (!c.rows[0]) return { found: false, orders: 0 };
      const custId = c.rows[0].id;
      // Cascade: delete the customer's orders (boxes/items/legs/events cascade via FK).
      const del = await sql.query("DELETE FROM orders WHERE customer_id = $1", [custId]);
      await sql.query("DELETE FROM customers WHERE id = $1", [custId]);
      return { found: true, orders: del.rowCount ?? 0 };
    });
    if (!result.found) return res.status(404).json({ error: "Customer not found" });
    return res.json({ ok: true, deletedOrders: result.orders });
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
