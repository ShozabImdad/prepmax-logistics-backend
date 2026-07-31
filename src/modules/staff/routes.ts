// Staff (users) management. List/edit/delete are gated by the granular
// accounts.view/.edit/.delete permissions (see migration 0029) so a manager
// can be given e.g. "view + edit" without create/delete.
// Role assignment (below) is gated by roles.manage, with a permission-subset
// safety check: a non-super-admin can only assign a role that grants nothing
// beyond what they hold themselves — see the route for details.
//
// Uses withSuperAdminAllBranches since staff management spans all branches.

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/http.js";
import { requireStaff, requirePermission } from "../../middleware/auth.js";
import { isStaff } from "../auth/types.js";
import { withSuperAdminAllBranches } from "../../db/pool.js";

export const staffRouter: Router = Router();

// ── List staff (users) ───────────────────────────────────────────────────────
staffRouter.get(
  "/",
  requireStaff,
  requirePermission("accounts.view"),
  asyncHandler(async (req, res) => {
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const staffReq = req.auth!;
    if (!isStaff(staffReq)) return res.status(403).json({ error: "Staff only" });
    const rows = await withSuperAdminAllBranches(async (sql) => {
      const params: unknown[] = [];
      const conds: string[] = [];
      if (search) {
        params.push(`%${search}%`);
        conds.push(`(u.full_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR COALESCE(b.name,'') ILIKE $${params.length} OR COALESCE(b.city,'') ILIKE $${params.length})`);
      }
      // A manager with accounts.view only ever sees their own branch's staff,
      // never the whole company (that scoping is what the permission grant
      // means here, same as the branches.view detail route above).
      if (staffReq.role !== "super_admin") {
        params.push(staffReq.branchId);
        conds.push(`u.branch_id = $${params.length}`);
      }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
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
// ── Edit a staff member ──────────────────────────────────────────────────────
const staffEdit = z.object({
  fullName: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  branchPublicId: z.string().optional(), // reassign a manager to another branch — super-admin only, see below
});
staffRouter.patch(
  "/:publicId",
  requireStaff,
  requirePermission("accounts.edit"),
  asyncHandler(async (req, res) => {
    const staffReq = req.auth!;
    if (!isStaff(staffReq)) return res.status(403).json({ error: "Staff only" });
    const parsed = staffEdit.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid staff edit" });
    const pid = String(req.params.publicId ?? "");
    const updated = await withSuperAdminAllBranches(async (sql) => {

// RBAC guard: holding accounts.edit is not enough to touch a Super
      // Admin or Branch Manager account — only an actor who is themselves
      // RBAC Super Admin or Branch Manager may edit those. This is checked
      // off actor.roleNames / user_roles, never off users.role, since a
      // regular staffer can be granted accounts.edit without being trusted
      // with protected accounts.
      const targetRoles = await sql.query<{ name: string }>(
        `SELECT r.name FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
           JOIN users u ON u.id = ur.user_id
          WHERE u.public_id = $1 AND r.name IN ('Super Admin', 'Branch Manager')`,
        [pid],
      );
      const targetIsProtected = targetRoles.rows.length > 0;
      const actorIsProtectedRole =
        staffReq.roleNames.includes("Super Admin") || staffReq.roleNames.includes("Branch Manager");
      if (targetIsProtected && !actorIsProtectedRole) {
      
        throw Object.assign(new Error("You don't have permission to edit this account"), { httpStatus: 403 });
      }

      let target: { branch_id: string | null; branch_public_id: string | null } | undefined;
      if (staffReq.role !== "super_admin") {
        const t = await sql.query<{ branch_id: string | null; branch_public_id: string | null }>(
          `SELECT u.branch_id, b.public_id AS branch_public_id
             FROM users u LEFT JOIN branches b ON b.id = u.branch_id
            WHERE u.public_id = $1`,
          [pid],
        );
        if (!t.rows[0] || t.rows[0].branch_id !== staffReq.branchId) return 0;
        target = t.rows[0];
        // Reassigning someone to a DIFFERENT branch is a super-admin action —
        // a manager holding accounts.edit can edit staff in their own branch,
        // but moving them elsewhere is out of scope for that grant. A no-op
        // resend of the staff member's current branch (which the edit form
        // sends by default) is allowed through rather than rejected.
        if (
          parsed.data.branchPublicId !== undefined &&
          parsed.data.branchPublicId !== target.branch_public_id
        ) {console.log("here");
        
          throw Object.assign(new Error("Only a super-admin can reassign a staff member's branch"), { httpStatus: 403 });
        }
      }
      const set: string[] = []; const vals: unknown[] = [];
      const push = (col: string, v: unknown) => { vals.push(v); set.push(`${col} = $${vals.length}`); };
      if (parsed.data.fullName !== undefined) push("full_name", parsed.data.fullName);
      if (parsed.data.isActive !== undefined) push("is_active", parsed.data.isActive);
      // Only actually touch branch_id when it's a real change (super-admin
      // reassigning, or the value differs from what's already set) — avoids
      // an unnecessary write on every edit just because the form echoes it back.
      const targetUser = await sql.query<{ id: string; branch_id: string | null; branch_public_id: string | null }>(
        `SELECT u.id, u.branch_id, b.public_id AS branch_public_id
           FROM users u LEFT JOIN branches b ON b.id = u.branch_id
          WHERE u.public_id = $1`,
        [pid],
      );
      const currentBranchPublicId = target?.branch_public_id ?? targetUser.rows[0]?.branch_public_id ?? null;
      const isRealBranchChange =
        parsed.data.branchPublicId !== undefined &&
        (staffReq.role === "super_admin" ? true : parsed.data.branchPublicId !== target?.branch_public_id);
      if (isRealBranchChange) {
        const b = await sql.query<{ id: string }>("SELECT id FROM branches WHERE public_id = $1", [parsed.data.branchPublicId]);
        if (!b.rows[0]) throw Object.assign(new Error("Branch not found"), { httpStatus: 404 });
        // 1:1 enforcement: if this user holds the global "Branch Manager" role
        // and is actually moving to a different branch, that destination
        // branch must not already have a different holder of that role.
        // Same rule as POST /:publicId/roles and accounts/routes.ts POST /managers.
        if (parsed.data.branchPublicId !== currentBranchPublicId && targetUser.rows[0]) {
          const holdsManagerRole = await sql.query<{ user_id: string }>(
            `SELECT ur.user_id FROM user_roles ur
               JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = $1 AND r.branch_id IS NULL AND r.name = 'Branch Manager'`,
            [targetUser.rows[0].id],
          );
          if (holdsManagerRole.rows[0]) {
            const existing = await sql.query<{ user_id: string }>(
              `SELECT ur.user_id FROM user_roles ur
                 JOIN roles r ON r.id = ur.role_id
                 JOIN users tu ON tu.id = ur.user_id
                WHERE r.branch_id IS NULL AND r.name = 'Branch Manager'
                  AND tu.branch_id = $1 AND ur.user_id != $2`,
              [b.rows[0].id, targetUser.rows[0].id],
            );
            if (existing.rows[0]) throw Object.assign(new Error("This branch already has a Branch Manager assigned"), { httpStatus: 409 });
          }
        }
        push("branch_id", b.rows[0].id);
      }
      if (set.length === 0) return 1;
      vals.push(pid);
      const r = await sql.query(`UPDATE users SET ${set.join(", ")} WHERE public_id = $${vals.length}`, vals);
      return r.rowCount ?? 0;
    }).catch((e) => {
      const status = (e as { httpStatus?: number }).httpStatus;
      if (status === 404) return -1;
      if (status === 403) return -2;
      if (status === 409) return -3;
      throw e;
    });
    if (updated === -1) return res.status(404).json({ error: "Branch not found" });
    if (updated === -2){
     return res.status(403).json({ error: "You don't have permission to edit this account" })};
    if (updated === -3) return res.status(409).json({ error: "This branch already has a Branch Manager assigned" });
    if (updated === 0) return res.status(404).json({ error: "Staff member not found" });
    return res.json({ ok: true });
  }),
);

// ── Delete a staff member (super-admin cannot be deleted via API) ────────────
staffRouter.delete(
  "/:publicId",
  requireStaff,
  requirePermission("accounts.delete"),
  asyncHandler(async (req, res) => {
    const pid = String(req.params.publicId ?? "");
    const me = req.auth!;
    if (!isStaff(me)) return res.status(403).json({ error: "Staff only" });
    const result = await withSuperAdminAllBranches(async (sql) => {
      const u = await sql.query<{ id: string; role: string; public_id: string; branch_id: string | null }>(
        "SELECT id, role, public_id, branch_id FROM users WHERE public_id = $1", [pid],
      );
      if (!u.rows[0]) return "not_found";
      if (u.rows[0].role === "super_admin") return "cannot_delete_super";

      // RBAC guard: same as PATCH /:publicId — accounts.delete alone isn't
      // enough to remove a Super Admin or Branch Manager account; the actor
      // must themselves hold one of those RBAC roles.
      const targetRoles = await sql.query<{ name: string }>(
        `SELECT r.name FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = $1 AND r.name IN ('Super Admin', 'Branch Manager')`,
        [u.rows[0].id],
      );
      if (targetRoles.rows.length > 0) {
        const actorIsProtectedRole = me.roleNames.includes("Super Admin") || me.roleNames.includes("Branch Manager");
        if (!actorIsProtectedRole) return "forbidden";
      }

      // A manager with accounts.delete can only delete staff in their own branch.
      if (me.role !== "super_admin" && u.rows[0].branch_id !== me.branchId) return "not_found";
      // don't let a user delete themselves
      if (me.kind === "user" && me.publicId === pid) return "self";
      await sql.query("DELETE FROM users WHERE id = $1", [u.rows[0].id]); // user_roles cascade
      return "ok";
    });
    if (result === "not_found") return res.status(404).json({ error: "Staff member not found" });

if (result === "forbidden") return res.status(403).json({ error: "You don't have permission to delete this account" });


    if (result === "cannot_delete_super") return res.status(409).json({ error: "Super-admin accounts cannot be deleted here" });
    if (result === "self") return res.status(409).json({ error: "You cannot delete your own account" });
    return res.json({ ok: true });
  }),
);

// ── Assign / unassign a role to a staff member ──────────────────────────────
// Gated by accounts.edit, same permission as PATCH /:publicId — reassigning
// a staff member's roles is treated as part of editing them, so anyone
// holding accounts.edit can do it (not hardcoded to Super Admin/Branch
// Manager anymore).
//
// A holder of accounts.edit is still limited to staff in their own branch
// (via actor.branchId below — that scoping comes from users.role/
// users.branch_id, the axis that answers "which branch," not "what
// permission"). Assigning the global "Branch Manager" role specifically
// stays RBAC-Super-Admin-only regardless of accounts.edit — handing that
// role out is equivalent to appointing a branch's manager, which is its own
// strict 1:1-per-branch action (see accounts/routes.ts POST /managers) and
// not something accounts.edit alone should unlock.
const roleAssign = z.object({ roleId: z.string().min(1), assigned: z.boolean() });
staffRouter.post(
  "/:publicId/roles",
  requireStaff,
  requirePermission("accounts.edit"),
  asyncHandler(async (req, res) => {
    const actor = req.auth!;
    if (!isStaff(actor)) return res.status(403).json({ error: "Staff only" });

    const parsed = roleAssign.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "roleId and assigned required" });
    const pid = String(req.params.publicId ?? "");
    const result = await withSuperAdminAllBranches(async (sql) => {
      const u = await sql.query<{ id: string; branch_id: string | null }>("SELECT id, branch_id FROM users WHERE public_id = $1", [pid]);
      if (!u.rows[0]) return "no_user";
      if (actor.role !== "super_admin" && u.rows[0].branch_id !== actor.branchId) return "no_user";

// RBAC guard: same as PATCH/DELETE /:publicId — accounts.edit alone
      // isn't enough to mutate ANY role on a Super Admin or Branch Manager
      // account (not just granting the Branch Manager role, which is
      // already checked separately below). The actor must themselves hold
      // one of those RBAC roles.
      const targetProtectedRoles = await sql.query<{ name: string }>(
        `SELECT r.name FROM user_roles ur
           JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = $1 AND r.name IN ('Super Admin', 'Branch Manager')`,
        [u.rows[0].id],
      );
      if (targetProtectedRoles.rows.length > 0) {
        const actorIsProtectedRole = actor.roleNames.includes("Super Admin") || actor.roleNames.includes("Branch Manager");
        if (!actorIsProtectedRole) return "forbidden";
      }

      const r = await sql.query<{ id: string; name: string; branch_id: string | null }>(
  "SELECT id, name, branch_id FROM roles WHERE id = $1", [parsed.data.roleId],
);
if (!r.rows[0]) return "no_role";
// Checked against actor.role (the immutable DB column), not an RBAC role
// name — see accounts/routes.ts POST /managers for the same rule and why.
if (parsed.data.assigned && actor.role !== "super_admin" && r.rows[0].branch_id === null && r.rows[0].name === "Branch Manager") {
  return "branch_manager_role";
}
// 1:1 enforcement: a branch may have at most one holder of the global
// "Branch Manager" role. Only a true DB super_admin can even reach this
// point for that role (checked above), but nothing else stops a super_admin
      // from granting it to a second person in the same branch via this
      // route — so check it here too, same rule as accounts/routes.ts
      // POST /managers.
      if (
        parsed.data.assigned &&
        r.rows[0].branch_id === null &&
        r.rows[0].name === "Branch Manager" &&
        u.rows[0].branch_id
      ) {
        const existing = await sql.query<{ user_id: string }>(
          `SELECT ur.user_id FROM user_roles ur
             JOIN users tu ON tu.id = ur.user_id
            WHERE ur.role_id = $1 AND tu.branch_id = $2 AND ur.user_id != $3`,
          [parsed.data.roleId, u.rows[0].branch_id, u.rows[0].id],
        );
        if (existing.rows[0]) return "branch_already_has_manager";
      }
      if (parsed.data.assigned) {
        await sql.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [u.rows[0].id, parsed.data.roleId]);
      } else {
        await sql.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2", [u.rows[0].id, parsed.data.roleId]);
      }
      return "ok";
    });
    if (result === "no_user") return res.status(404).json({ error: "Staff member not found" });
    if (result === "no_role") return res.status(404).json({ error: "Role not found" });

if (result === "forbidden") return res.status(403).json({ error: "You don't have permission to modify this account's roles" });

    if (result === "branch_already_has_manager") {
      return res.status(409).json({ error: "This branch already has a Branch Manager assigned" });
    }
    if (result === "branch_manager_role") {
      return res.status(403).json({ error: "Only a super-admin can assign the Branch Manager role" });
    }
    return res.json({ ok: true });
  }),
);