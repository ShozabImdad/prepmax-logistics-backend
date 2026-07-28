-- ============================================================================
-- 0028_customer_notifications
-- Adds an optional customer_id to the existing notifications table so
-- staff actions on a customer-created record (e.g. their manifest) can
-- notify that customer. Reuses the same table/shape as staff notifications
-- rather than a parallel table — same read/unread/created_at semantics.
--
-- IMPORTANT: unlike branch_id, ownership of a customer_id row is NOT
-- enforced by RLS (this codebase's RLS is branch-scoped only, not
-- customer-scoped — see 0003_customers_orders.sql). Every query that reads
-- these rows on the customer's behalf MUST filter by customer_id in the
-- WHERE clause itself, same convention as verifyManifestOwnership /
-- verifyQuoteOwnership elsewhere in this codebase. Never assume the RLS
-- branch policy alone is enough to scope a customer's own notifications.
-- ============================================================================

ALTER TABLE notifications
  ADD COLUMN customer_id uuid REFERENCES customers(id) ON DELETE CASCADE;

CREATE INDEX notifications_customer_unread_idx ON notifications(customer_id, is_read);