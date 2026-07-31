-- ============================================================================
-- 0030_permissions_module_grantable
--
-- Adds the Permissions module itself to the grantable permission catalog,
-- same shape as Branches/Accounts before their 0029 split: `.view` / `.manage`.
--
-- Why: role assignment during staff creation reads GET /permissions/roles to
-- populate the role selector, but that route was hardcoded requireSuperAdmin.
-- Any non-super-admin creating a staff account (accounts.add) always got an
-- empty selector, even when a super-admin intended to delegate role-picking
-- to them. `.view` fixes that read path; `.manage` lets a delegated admin
-- actually create custom roles / toggle grants (see routes.ts for the
-- self-escalation guard: even with permissions.manage, only a real
-- super-admin can toggle the permissions.view/.manage keys themselves).
--
-- Safe to re-run: idempotent.
-- ============================================================================

INSERT INTO permissions (key, module, label) VALUES
  ('permissions.view',   'Permissions', 'View roles and permission grants'),
  ('permissions.manage', 'Permissions', 'Create roles and toggle permission grants')
ON CONFLICT (key) DO NOTHING;
