// Staff (users) management — super-admin only. List, detail, edit, deactivate,
// delete, and role assignment for branch managers (and viewing super-admins).
//
// Uses withSuperAdminAllBranches since staff management spans all branches.

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/http.js";
import { requireSuperAdmin } from "../../middleware/auth.js";
import { withSuperAdminAllBranches } from "../../db/pool.js";

export const staffRouter: Router = Router();

// ── List staff (users) ───────────────────────────────────────────────────────
staffRouter.get(
  "/",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const rows = await withSuperAdminAllBranches(async (sql) => {
      const params: unknown[] = [];
      let where = "";
      if (search) {
        params.push(`%${search}%`);
        where = `WHERE u.full_name ILIKE $1 OR u.email ILIKE $1 OR COALESCE(b.name,'') ILIKE $1 OR COALESCE(b.city,'') ILIKE $1`;
      }
      const users = await sql.query(
        `SELECT u.id, u.public_id, u.full_name, u.email, u.role, u.is_active, u.created_at,
                b.name AS branch_name, b.public_id AS branch_public_id
           FROM users u LEFT JOIN branches b ON b.id = u.branch_id
           ${where}
          ORDER BY u.role, u.full_name`,
        params,
      );
      // roles per user
      const roleRows = await sql.query<{ user_id: string; role_id: string; name: string }>(
        `SELECT ur.user_id, r.id AS role_id, r.name
           FROM user_roles ur JOIN roles r ON r.id = ur.role_id`,
      );
      return { users: users.rows, roleRows: roleRows.rows };
    });
    const rolesByUser = new Map<string, { id: string; name: string }[]>();
    for (const r of rows.roleRows) {
      const arr = rolesByUser.get(r.user_id) ?? [];
      arr.push({ id: r.role_id, name: r.name });
      rolesByUser.set(r.user_id, arr);
    }
    return res.json({
      staff: rows.users.map((u) => ({
        publicId: u.public_id, fullName: u.full_name, email: u.email, role: u.role,
        isActive: u.is_active, createdAt: u.created_at,
        branchName: u.branch_name, branchPublicId: u.branch_public_id,
        assignedRoles: rolesByUser.get(u.id) ?? [],
      })),
    });
  }),
);

// ── Edit a staff member ──────────────────────────────────────────────────────
const staffEdit = z.object({
  fullName: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  branchPublicId: z.string().optional(), // reassign a manager to another branch
});
staffRouter.patch(
  "/:publicId",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const parsed = staffEdit.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid staff edit" });
    const pid = String(req.params.publicId ?? "");
    const updated = await withSuperAdminAllBranches(async (sql) => {
      const set: string[] = []; const vals: unknown[] = [];
      const push = (col: string, v: unknown) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
      if (parsed.data.fullName !== undefined) push("full_name", parsed.data.fullName);
      if (parsed.data.isActive !== undefined) push("is_active", parsed.data.isActive);
      if (parsed.data.branchPublicId !== undefined) {
        const b = await sql.query<{ id: string }>("SELECT id FROM branches WHERE public_id = $1", [parsed.data.branchPublicId]);
        if (!b.rows[0]) throw Object.assign(new Error("Branch not found"), { httpStatus: 404 });
        push("branch_id", b.rows[0].id);
      }
      if (set.length === 0) return 1;
      vals.push(pid);
      const r = await sql.query(`UPDATE users SET ${set.join(", ")} WHERE public_id = $${vals.length}`, vals);
      return r.rowCount ?? 0;
    }).catch((e) => { if ((e as { httpStatus?: number }).httpStatus === 404) return -1; throw e; });
    if (updated === -1) return res.status(404).json({ error: "Branch not found" });
    if (updated === 0) return res.status(404).json({ error: "Staff member not found" });
    return res.json({ ok: true });
  }),
);

// ── Delete a staff member (super-admin cannot be deleted via API) ────────────
staffRouter.delete(
  "/:publicId",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const pid = String(req.params.publicId ?? "");
    const me = req.auth!;
    const result = await withSuperAdminAllBranches(async (sql) => {
      const u = await sql.query<{ id: string; role: string; public_id: string }>(
        "SELECT id, role, public_id FROM users WHERE public_id = $1", [pid],
      );
      if (!u.rows[0]) return "not_found";
      if (u.rows[0].role === "super_admin") return "cannot_delete_super";
      // don't let a user delete themselves
      if (me.kind === "user" && me.publicId === pid) return "self";
      await sql.query("DELETE FROM users WHERE id = $1", [u.rows[0].id]); // user_roles cascade
      return "ok";
    });
    if (result === "not_found") return res.status(404).json({ error: "Staff member not found" });
    if (result === "cannot_delete_super") return res.status(409).json({ error: "Super-admin accounts cannot be deleted here" });
    if (result === "self") return res.status(409).json({ error: "You cannot delete your own account" });
    return res.json({ ok: true });
  }),
);

// ── Assign / unassign a role to a staff member ──────────────────────────────
const roleAssign = z.object({ roleId: z.string().min(1), assigned: z.boolean() });
staffRouter.post(
  "/:publicId/roles",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const parsed = roleAssign.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "roleId and assigned required" });
    const pid = String(req.params.publicId ?? "");
    const result = await withSuperAdminAllBranches(async (sql) => {
      const u = await sql.query<{ id: string }>("SELECT id FROM users WHERE public_id = $1", [pid]);
      if (!u.rows[0]) return "no_user";
      const r = await sql.query<{ id: string }>("SELECT id FROM roles WHERE id = $1", [parsed.data.roleId]);
      if (!r.rows[0]) return "no_role";
      if (parsed.data.assigned) {
        await sql.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [u.rows[0].id, parsed.data.roleId]);
      } else {
        await sql.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2", [u.rows[0].id, parsed.data.roleId]);
      }
      return "ok";
    });
    if (result === "no_user") return res.status(404).json({ error: "Staff member not found" });
    if (result === "no_role") return res.status(404).json({ error: "Role not found" });
    return res.json({ ok: true });
  }),
);
