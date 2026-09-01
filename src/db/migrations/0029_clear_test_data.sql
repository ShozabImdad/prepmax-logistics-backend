-- ============================================================================
-- 0029_clear_test_data
-- One-time cleanup (test phase, no real data to preserve here — same intent
-- as 0026_bank_accounts_cleanup.sql). Clears:
--   1. de_manifests + de_manifest_shipments (all rows)
--   2. manifests + manifest_shipments (all rows)
--   3. bank_accounts (all rows)
--   4. vendors that are NOT system-protected / NOT the house vendor
--      (is_protected = false AND is_house_vendor = false), along with
--      whatever vendor_bills / vendor_bill_items / payments cascade from
--      them.
--
-- FK map that drives the ordering below:
--   de_manifest_shipments.de_manifest_id -> de_manifests   ON DELETE CASCADE
--   de_manifests.source_manifest_id      -> manifests      ON DELETE SET NULL
--   de_manifests.vendor_id               -> vendors         ON DELETE RESTRICT
--   manifest_shipments.manifest_id       -> manifests       ON DELETE CASCADE
--   manifests.vendor_id                  -> vendors         ON DELETE RESTRICT
--   payments.bank_account_id             -> bank_accounts   ON DELETE RESTRICT
--   expenses.bank_account_id             -> bank_accounts   ON DELETE RESTRICT
--   vendor_bills.vendor_id               -> vendors         ON DELETE CASCADE (0017)
--   vendor_bill_items.vendor_bill_id     -> vendor_bills    ON DELETE CASCADE
--   payments.vendor_id                   -> vendors         ON DELETE CASCADE (0017)
--   payments.vendor_bill_id              -> vendor_bills    ON DELETE SET NULL
--
-- Because manifests/de_manifests hold vendor_id as RESTRICT, they must be
-- cleared BEFORE vendors, or the vendor DELETE below would fail. Because
-- bank_accounts is RESTRICT from payments/expenses, those two columns are
-- nulled out before bank_accounts is deleted. vendor_bills/vendor_bill_items
-- /payments tied to a deleted vendor are left to CASCADE automatically
-- (0017_vendor_hard_delete_cascade.sql) — no explicit DELETE needed for them.
--
-- Wrapped in a transaction so this is all-or-nothing.
-- ============================================================================

BEGIN;

-- ── 1. De-manifests (cascades de_manifest_shipments) ────────────────────────
DELETE FROM de_manifests;

-- ── 2. Manifests (cascades manifest_shipments) ───────────────────────────────
DELETE FROM manifests;

-- ── 3. Bank accounts ──────────────────────────────────────────────────────
-- Detach anything still pointing at a bank account first (RESTRICT columns),
-- same safety pattern as 0026_bank_accounts_cleanup.sql, then delete all
-- bank_accounts rows.
UPDATE payments SET bank_account_id = NULL WHERE bank_account_id IS NOT NULL;
UPDATE expenses SET bank_account_id = NULL WHERE bank_account_id IS NOT NULL;

DELETE FROM bank_accounts;

-- ── 4. Non-system vendors ────────────────────────────────────────────────
-- Keeps: is_protected = true  (e.g. "Prepmax Logistics" self-billing vendor,
--        0018_vendor_system_protected.sql)
--        is_house_vendor = true (per-branch house vendor for customer
--        portal manifests, 0027_customer_manifests.sql)
-- Everything else is test data: deleting these rows cascades to their
-- vendor_bills, vendor_bill_items, and payments automatically.
DELETE FROM vendors
 WHERE is_protected = false
   AND is_house_vendor = false;

COMMIT;
