-- ============================================================================
-- 0017_vendor_hard_delete_cascade
-- Allow vendor_bills/payments to cascade-delete when a vendor is hard-deleted.
-- Not strictly required by hardDeleteVendor() itself (it deletes bills/
-- payments manually before deleting the vendor row), but protects against
-- any other code path that might delete a vendor row directly and hit the
-- current RESTRICT/SET NULL constraints.
-- ============================================================================

ALTER TABLE vendor_bills
  DROP CONSTRAINT vendor_bills_vendor_id_fkey,
  ADD CONSTRAINT vendor_bills_vendor_id_fkey
    FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE;

ALTER TABLE payments
  DROP CONSTRAINT payments_vendor_id_fkey,
  ADD CONSTRAINT payments_vendor_id_fkey
    FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE;