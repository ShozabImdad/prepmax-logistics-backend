// Permissions module — backs the admin "permissions toggle" page.
//
// Super-admin only (managing who-can-do-what is a super-admin responsibility).
//   GET  /api/permissions/catalog       → all permission keys (grouped by module)
//   GET  /api/permissions/roles         → roles + which permissions each holds
//   POST /api/permissions/roles/:id/toggle  { permissionKey, granted }
//
// The backend already enforces every permission on each request (requirePermission),
// so these toggles are the source of truth, not just cosmetic.

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/http.js";
import { requireSuperAdmin } from "../../middleware/auth.js";
import { withSuperAdminAllBranches } from "../../db/pool.js";

export const permissionsRouter: Router = Router();

// ── Catalog ─────────────────────────────────────────────────────────────────
permissionsRouter.get(
  "/catalog",
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

// ── Roles + their granted permission keys ───────────────────────────────────
permissionsRouter.get(
  "/roles",
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    const data = await withSuperAdminAllBranches(async (sql) => {
      const roles = await sql.query<{ id: string; name: string; branch_id: string | null; is_system: boolean }>(
        "SELECT id, name, branch_id, is_system FROM roles ORDER BY branch_id NULLS FIRST, name",
      );
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
    return res.json({
      roles: data.roles.map((r) => ({
        id: r.id, name: r.name, isGlobal: r.branch_id === null, isSystem: r.is_system,
        permissions: byRole.get(r.id) ?? [],
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
