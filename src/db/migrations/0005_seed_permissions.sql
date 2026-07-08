-- ============================================================================
-- 0005_seed_permissions
-- Seeds the fixed permission catalog (the modules/actions the toggle page
-- controls). Idempotent: ON CONFLICT DO NOTHING so re-running is harmless.
-- Actual role→permission toggles are data, set later via the app.
-- ============================================================================

INSERT INTO permissions (key, module, label) VALUES
  ('orders.view',        'Orders',      'View orders'),
  ('orders.create',      'Orders',      'Create orders'),
  ('orders.edit',        'Orders',      'Edit orders'),
  ('orders.approve',     'Orders',      'Approve customer booking requests'),
  ('orders.cancel',      'Orders',      'Cancel orders'),
  ('tracking.view',      'Tracking',    'View shipment tracking'),
  ('tracking.manage',    'Tracking',    'Attach / edit carrier legs'),
  ('customers.view',     'Customers',   'View customers'),
  ('customers.create',   'Customers',   'Create customer accounts'),
  ('customers.edit',     'Customers',   'Edit customers'),
  ('accounts.view',      'Accounts',    'View staff accounts'),
  ('accounts.manage',    'Accounts',    'Create / manage staff accounts'),
  ('branches.view',      'Branches',    'View branches'),
  ('branches.manage',    'Branches',    'Create / manage branches'),
  ('permissions.manage', 'Permissions', 'Manage roles & permissions'),
  ('reports.view',       'Reports',     'View reports'),
  ('documents.print',    'Documents',   'Print AWB & receipts')
ON CONFLICT (key) DO NOTHING;
