-- ============================================================================
-- 0011_delete_permissions
-- Separate delete permissions — hard delete (cascade) is more sensitive than
-- edit, so it gets its own gate. Staff/branch/role deletion is super-admin
-- only (enforced in routes), so no separate keys needed there.
-- ============================================================================

INSERT INTO permissions (key, module, label) VALUES
  ('customers.delete', 'Customers', 'Delete customer accounts')
ON CONFLICT (key) DO NOTHING;
