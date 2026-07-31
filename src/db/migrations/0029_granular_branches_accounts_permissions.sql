-- ============================================================================
-- 0029_granular_branches_accounts_permissions
--
-- Two changes, both enforced in routes (staff/routes.ts, accounts/routes.ts):
--
-- 1. Branches and Accounts (staff) go from a single `.manage` catch-all to
--    four granular actions each — `.view`, `.add`, `.edit`, `.delete` — same
--    shape as Orders/Customers. This lets a super-admin grant e.g. "view +
--    edit a branch" to a manager without also handing them create/delete.
--    Any role that already held `.manage` is topped up with add+edit+delete
--    so no one silently loses capability they had; `.view` already existed
--    separately and is untouched.
--
-- 2. `permissions.manage` is removed from the catalog entirely. The
--    Permissions module (role/permission management) was already hardcoded
--    to requireSuperAdmin in every route and never actually checked this key
--    — it's dead weight that could still be toggled onto a role from the UI
--    with no effect. Deleting the key means it can no longer be granted to
--    anyone, ever; the Permissions page stays super-admin-only, full stop.
--
-- Safe to re-run: every step is idempotent.
-- ============================================================================

-- ── 1a. New granular keys ────────────────────────────────────────────────────
INSERT INTO permissions (key, module, label) VALUES
  ('branches.add',    'Branches', 'Create branches'),
  ('branches.edit',   'Branches', 'Edit branch details'),
  ('branches.delete', 'Branches', 'Delete branches'),
  ('accounts.add',    'Accounts', 'Create staff accounts'),
  ('accounts.edit',   'Accounts', 'Edit staff accounts'),
  ('accounts.delete', 'Accounts', 'Delete staff accounts')
ON CONFLICT (key) DO NOTHING;

-- ── 1b. Top up roles that held the old `.manage` keys, then drop them ───────
DO $$
DECLARE
  mod text;
  manage_id uuid;
BEGIN
  FOREACH mod IN ARRAY ARRAY['branches', 'accounts']
  LOOP
    SELECT id INTO manage_id FROM permissions WHERE key = mod || '.manage';
    IF manage_id IS NULL THEN
      CONTINUE; -- already migrated
    END IF;

    INSERT INTO role_permissions (role_id, permission_id)
    SELECT rp.role_id, p.id
      FROM role_permissions rp
      JOIN permissions p ON p.key = ANY(ARRAY[mod || '.add', mod || '.edit', mod || '.delete'])
     WHERE rp.permission_id = manage_id
    ON CONFLICT (role_id, permission_id) DO NOTHING;

    -- Cascades to role_permissions via ON DELETE CASCADE.
    DELETE FROM permissions WHERE id = manage_id;
  END LOOP;
END $$;

-- ── 2. Remove `permissions.manage` — super-admin-only, not a grantable key ──
DELETE FROM permissions WHERE key = 'permissions.manage';
