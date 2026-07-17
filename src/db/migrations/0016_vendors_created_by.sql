-- ============================================================================
-- 0016_vendors_created_by
-- Fix: 0015_finance.sql created the `vendors` table without a `created_by`
-- column, but finance/queries.ts createVendor() always inserts one (same
-- pattern as invoices/vendor_bills/payments/expenses, which all have it).
-- Idempotent via IF NOT EXISTS so it's safe even on a fresh install where
-- 0015_finance.sql already includes the column.
-- ============================================================================

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;
