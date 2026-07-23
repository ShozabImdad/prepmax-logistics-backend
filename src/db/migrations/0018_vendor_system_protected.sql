-- ============================================================================
-- 0018_vendor_system_protected
-- Marks certain vendors as system-required and un-editable/un-deletable —
-- e.g. "Prepmax Logistics" itself, which must always exist as a vendor
-- record (used for internal/self-billing reconciliation) and must never be
-- edited or removed by branch managers or super admins through the UI/API.
-- Enforced in finance/queries.ts (updateVendor/deleteVendor/hardDeleteVendor),
-- not just in the frontend, so it can't be bypassed via direct API calls.
-- ============================================================================

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS is_protected boolean NOT NULL DEFAULT false;

-- Seed: protect any existing "Prepmax Logistics" vendor row(s), across all
-- branches, regardless of case/whitespace variations.
UPDATE vendors
   SET is_protected = true
 WHERE lower(trim(name)) = 'prepmax logistics';