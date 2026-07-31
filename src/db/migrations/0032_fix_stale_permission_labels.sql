-- ============================================================================
-- 0032_fix_stale_permission_labels
--
-- 0030 labeled permissions.manage as "Create roles and toggle permission
-- grants" — accurate at the time, but 0031 moved role creation/deletion out
-- to its own roles.manage key. The old label is now wrong: permissions.manage
-- only toggles grants on an existing role, it doesn't create/delete roles.
--
-- Also tightening permissions.view's label so it doesn't read as a duplicate
-- of roles.view ("view roles" vs "view what a role can do" are different
-- things now, per the 0031 split).
--
-- Safe to re-run: idempotent (plain UPDATE).
-- ============================================================================

UPDATE permissions SET label = 'Toggle which permissions a role grants'
  WHERE key = 'permissions.manage';

UPDATE permissions SET label = 'View which permissions each role grants'
  WHERE key = 'permissions.view';
