-- 0022_collapse_view_manage_permissions
-- Collapses the separate `<module>.view` / `<module>.manage` permission pairs
-- into a single `<module>.manage` key for: complaints, quotes, finance,
-- manifest, demanifest. Anyone who can access the module can now both view
-- and change it — matches how these modules are actually used day to day.
--
-- Orders/customers/tracking/etc. are untouched — they keep their finer-
-- grained action keys (orders.create, orders.approve, ...).
--
-- Safe to re-run: every step is idempotent.

DO $$
DECLARE
  mod text;
  view_key text;
  manage_key text;
  view_id uuid;
  manage_id uuid;
BEGIN
  FOREACH mod IN ARRAY ARRAY['complaints', 'quotes', 'finance', 'manifest', 'demanifest']
  LOOP
    view_key   := mod || '.view';
    manage_key := mod || '.manage';

    SELECT id INTO view_id   FROM permissions WHERE key = view_key;
    SELECT id INTO manage_id FROM permissions WHERE key = manage_key;

    -- Nothing to merge if either side is already gone (already migrated).
    IF view_id IS NULL OR manage_id IS NULL THEN
      CONTINUE;
    END IF;

    -- Any role that had `.view` but not `.manage` gets `.manage` granted,
    -- so no one silently loses access to a module they could already see.
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT rp.role_id, manage_id
    FROM role_permissions rp
    WHERE rp.permission_id = view_id
    ON CONFLICT (role_id, permission_id) DO NOTHING;

    -- Drop the `.view` key entirely — cascades and removes it from every
    -- role_permissions row via the FK ON DELETE CASCADE.
    DELETE FROM permissions WHERE id = view_id;
  END LOOP;
END $$;

-- Re-label the surviving keys so they read as "access", not "manage-only".
UPDATE permissions SET label = 'View and manage customer complaints'
  WHERE key = 'complaints.manage';
UPDATE permissions SET label = 'View and respond to customer quote requests'
  WHERE key = 'quotes.manage';
UPDATE permissions SET label = 'View and manage finance: vendors, invoices, bills, payments, expenses, ledgers'
  WHERE key = 'finance.manage';
UPDATE permissions SET label = 'View and manage manifests: create, edit, close, dispatch'
  WHERE key = 'manifest.manage';
UPDATE permissions SET label = 'View and manage de-manifests: create, receive, reconcile, complete'
  WHERE key = 'demanifest.manage';
