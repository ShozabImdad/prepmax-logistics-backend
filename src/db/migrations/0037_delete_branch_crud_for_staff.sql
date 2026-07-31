

-- ============================================================================
-- 0035_drop_branch_add_delete_permissions
--
-- Branch creation and deletion are now hardcoded to requireSuperAdmin
-- (see accounts/routes.ts POST /branches and DELETE /branches/:publicId),
-- so branches.add / branches.delete can no longer be meaningfully granted —
-- toggling them on for a role would be a no-op since the routes never check
-- them anymore. Removing them keeps the permissions catalog / roles UI from
-- showing an option that does nothing when granted.
--
-- role_permissions.permission_id has ON DELETE CASCADE (see
-- 0002_branches_users_rbac.sql), so deleting from `permissions` alone is
-- enough — no separate cleanup of role_permissions needed.
--
-- Safe to re-run: no-op if the keys are already gone.
-- ============================================================================

DELETE FROM permissions WHERE key IN ('branches.add', 'branches.delete');

UPDATE permissions SET module = 'Roles' WHERE key IN ('roles.view', 'roles.manage');