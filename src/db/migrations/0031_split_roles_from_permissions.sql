-- ============================================================================
-- 0031_split_roles_from_permissions
--
-- 0030 added permissions.view/.manage but conflated two different things
-- under one gate:
--   1. "Which roles exist" — just names, needed by e.g. the staff-creation
--      role selector. Low-stakes, fine to hand to a delegated manager.
--   2. "What can each role DO" — the actual permission grants on a role.
--      Higher-stakes; seeing/editing this is the real Permissions page.
--
-- This migration splits them into their own keys:
--   roles.view    — see the list of roles (id/name only, no grants)
--   roles.manage  — create / delete roles
--   permissions.view/.manage — unchanged meaning, now scoped ONLY to seeing
--     and toggling a role's granted permission keys, not the role list itself.
--
-- Anyone who already held permissions.view/.manage from 0030 is topped up
-- with roles.view/.manage respectively, so no one loses capability they had.
--
-- Safe to re-run: idempotent.
-- ============================================================================

INSERT INTO permissions (key, module, label) VALUES
  ('roles.view',   'Permissions', 'View the list of roles'),
  ('roles.manage', 'Permissions', 'Create and delete roles')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE
  pview_id uuid;
  pmanage_id uuid;
  rview_id uuid;
  rmanage_id uuid;
BEGIN
  SELECT id INTO pview_id   FROM permissions WHERE key = 'permissions.view';
  SELECT id INTO pmanage_id FROM permissions WHERE key = 'permissions.manage';
  SELECT id INTO rview_id   FROM permissions WHERE key = 'roles.view';
  SELECT id INTO rmanage_id FROM permissions WHERE key = 'roles.manage';

  IF pview_id IS NOT NULL AND rview_id IS NOT NULL THEN
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT rp.role_id, rview_id FROM role_permissions rp WHERE rp.permission_id = pview_id
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END IF;

  IF pmanage_id IS NOT NULL AND rmanage_id IS NOT NULL THEN
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT rp.role_id, rmanage_id FROM role_permissions rp WHERE rp.permission_id = pmanage_id
    ON CONFLICT (role_id, permission_id) DO NOTHING;
  END IF;
END $$;
