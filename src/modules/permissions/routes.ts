// Permissions module — backs the admin "permissions toggle" page.
//
//   GET  /api/permissions/catalog       → all permission keys (grouped by module)
//   GET  /api/permissions/roles         → role list; grants included only for super-admin
//   POST /api/permissions/roles/:id/toggle  { permissionKey, granted }
//
// The GRANTS on a role (what a role can do) are the real Permissions page.
// This is hardcoded to super_admin only — not delegated via a permission key
// like permissions.view/permissions.manage. Two reasons:
//   1. It's the root of the whole RBAC tree: whoever can edit grants can
//      eventually grant themselves (or anyone) anything, so gating it with
//      a togglable permission is circular.
//   2. A role's grants are either fully visible or not present at all
//      (never partially), so the frontend can rely on `permissions` being
//      present exactly when the actor is a super-admin, instead of having to
//      handle an in-between state.
//
// roles.view / roles.manage (separate, still delegatable) only cover the role
// LIST — names, create, delete, and assigning a role to a staff member. Safe
// to hand a branch manager so e.g. their staff-creation role selector isn't
// empty. See staff/routes.ts for the role-assignment carve-out that still
// keeps the "Branch Manager" role itself super-admin-only to assign.

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/http.js";
import { requireStaff, requireSuperAdmin, requirePermission } from "../../middleware/auth.js";
import { withSuperAdminAllBranches } from "../../db/pool.js";

export const permissionsRouter: Router = Router();

// ── Catalog ─────────────────────────────────────────────────────────────────
permissionsRouter.get(
  "/catalog",
  requireStaff,
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    const rows = await withSuperAdminAllBranches(async (sql) => {
      const r = await sql.query(
        "SELECT key, module, label FROM permissions ORDER BY module, key",
      );
      return r.rows;
    });
    return res.json({
      permissions: rows.map((p) => ({ key: p.key, module: p.module, label: p.label })),
    });
  }),
);

// ── Roles + (super-admin only) which permissions each holds ─────────────────
permissionsRouter.get(
  "/roles",
  requireStaff,
  requirePermission("roles.view"),
  asyncHandler(async (req, res) => {
    const actor = req.auth!;
    const canSeeGrants = actor.kind === "user" && actor.role === "super_admin";

    const data = await withSuperAdminAllBranches(async (sql) => {
      const roles = await sql.query<{ id: string; name: string; branch_id: string | null; is_system: boolean }>(
        "SELECT id, name, branch_id, is_system FROM roles ORDER BY branch_id NULLS FIRST, name",
      );
      if (!canSeeGrants) return { roles: roles.rows, grants: [] as { role_id: string; key: string }[] };
      const grants = await sql.query<{ role_id: string; key: string }>(
        `SELECT rp.role_id, p.key
           FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id`,
      );
      return { roles: roles.rows, grants: grants.rows };
    });
    const byRole = new Map<string, string[]>();
    for (const g of data.grants) {
      const arr = byRole.get(g.role_id) ?? [];
      arr.push(g.key);
      byRole.set(g.role_id, arr);
    }
    // The global "Branch Manager" role is the branch-owner role itself —
    // assigning it is a super-admin-only action (see staff/routes.ts). Anyone
    // who isn't a super-admin therefore shouldn't even see it as an option in
    // their role selector/list; showing it would just invite a 403 on pick.
    const visibleRoles = canSeeGrants
      ? data.roles
      : data.roles.filter((r) => !(r.branch_id === null && r.name === "Branch Manager"));
    return res.json({
      // `permissions: undefined` (omitted from JSON) for anyone who isn't a
      // super-admin — a plain role-name selector, not the grants editor.
      roles: visibleRoles.map((r) => ({
        id: r.id, name: r.name, isGlobal: r.branch_id === null, isSystem: r.is_system,
        permissions: canSeeGrants ? (byRole.get(r.id) ?? []) : undefined,
      })),
    });
  }),
);

// ── Toggle a role's permission ──────────────────────────────────────────────
const toggleInput = z.object({
  permissionKey: z.string().min(1),
  granted: z.boolean(),
});
permissionsRouter.post(
  "/roles/:id/toggle",
  requireStaff,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const parsed = toggleInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "permissionKey and granted required" });
    const roleId = String(req.params.id ?? "");

    const result = await withSuperAdminAllBranches(async (sql) => {
      const perm = await sql.query<{ id: string }>("SELECT id FROM permissions WHERE key = $1", [parsed.data.permissionKey]);
      if (!perm.rows[0]) return "no_perm";
      const roleExists = await sql.query<{ id: string }>("SELECT id FROM roles WHERE id = $1", [roleId]);
      if (!roleExists.rows[0]) return "no_role";

      if (parsed.data.granted) {
        await sql.query(
          "INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
          [roleId, perm.rows[0].id],
        );
      } else {
        await sql.query(
          "DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2",
          [roleId, perm.rows[0].id],
        );
      }
      return "ok";
    });

    if (result === "no_perm") return res.status(404).json({ error: "Unknown permission" });
    if (result === "no_role") return res.status(404).json({ error: "Role not found" });
    return res.json({ ok: true });
  }),
);

// ── Create a custom role (global) ───────────────────────────────────────────
const createRole = z.object({ name: z.string().min(1).max(60) });
permissionsRouter.post(
  "/roles",
  requireStaff,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const parsed = createRole.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Role name is required" });
    try {
      const role = await withSuperAdminAllBranches(async (sql) => {
        const r = await sql.query<{ id: string; name: string }>(
          "INSERT INTO roles (branch_id, name, is_system) VALUES (NULL, $1, false) RETURNING id, name",
          [parsed.data.name.trim()],
        );
        return r.rows[0]!;
      });
      return res.status(201).json({ role: { id: role.id, name: role.name, isGlobal: true, isSystem: false, permissions: [] } });
    } catch (err) {
      if (typeof err === "object" && err && (err as { code?: string }).code === "23505") {
        return res.status(409).json({ error: "A role with that name already exists" });
      }
      throw err;
    }
  }),
);

// ── Delete a role (not system roles; unassigns from users automatically) ────
permissionsRouter.delete(
  "/roles/:id",
  requireStaff,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const roleId = String(req.params.id ?? "");
    const result = await withSuperAdminAllBranches(async (sql) => {
      const r = await sql.query<{ is_system: boolean }>("SELECT is_system FROM roles WHERE id = $1", [roleId]);
      if (!r.rows[0]) return "not_found";
      if (r.rows[0].is_system) return "system";
      await sql.query("DELETE FROM roles WHERE id = $1", [roleId]); // role_permissions + user_roles cascade
      return "ok";
    });
    if (result === "not_found") return res.status(404).json({ error: "Role not found" });
    if (result === "system") return res.status(409).json({ error: "System roles cannot be deleted" });
    return res.json({ ok: true });
  }),
);