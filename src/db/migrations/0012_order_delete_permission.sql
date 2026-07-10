-- ============================================================================
-- 0012_order_delete_permission
-- Hard-delete for orders. Like customers.delete, a hard delete (removes the
-- order plus its boxes/items/legs/tracking events via ON DELETE CASCADE) is
-- more sensitive than edit/cancel, so it gets its own permission gate. Not
-- granted to the default Branch Manager role — super-admin has it implicitly.
-- ============================================================================

INSERT INTO permissions (key, module, label) VALUES
  ('orders.delete', 'Orders', 'Delete orders permanently')
ON CONFLICT (key) DO NOTHING;
