-- ============================================================================
-- 0027_customer_manifests
-- Closes design-doc §G "Customer-portal Manifest" (client-requested
-- 2026-07-21). A customer can create a manifest for their own shipments;
-- it defaults to a house "Prepmax Logistics" vendor (never a real
-- downstream carrier) and staff can later re-assign the real carrier via
-- the existing PATCH /api/manifests/:publicId.
--
-- Decisions confirmed with client for this feature:
--   G-Q1: staff ARE notified in-app when a customer creates a manifest
--         (same pattern as quotes).
--   G-Q2: cross-manifest duplicate prevention applies to customers too —
--         reuses the existing addShipments()/removeShipment() row-locked
--         check unchanged.
--   G-Q3: client asked for ONE shared "Prepmax Logistics" identity across
--         branches. vendors is branch-scoped with FORCE ROW LEVEL SECURITY
--         (a branch manager can only ever see their own branch's rows),
--         so a single physical row cannot be visible everywhere.
--         Implemented as: one vendor row per branch, all named identically
--         ("Prepmax Logistics") and flagged is_house_vendor, so every
--         customer/branch sees the same *identity* even though the DB has
--         a row per branch. Flagged here rather than assumed silently.
--   G-Q4: manifest stays editable by the customer while status='open'
--         (existing status machine — no schema change needed for this).
-- ============================================================================

-- ── House vendor flag ────────────────────────────────────────────────────
ALTER TABLE vendors ADD COLUMN is_house_vendor boolean NOT NULL DEFAULT false;

-- At most one house vendor per branch.
CREATE UNIQUE INDEX vendors_house_vendor_uniq ON vendors(branch_id) WHERE is_house_vendor;

-- Seed the house vendor for every existing branch. public_id generated the
-- same way as 0025_bank_accounts.sql's seed inserts (no application code
-- runs during a migration).
INSERT INTO vendors (public_id, branch_id, name, vendor_type, is_house_vendor)
SELECT md5(random()::text || clock_timestamp()::text || b.id::text || 'house_vendor'),
       b.id, 'Prepmax Logistics', 'other', true
FROM branches b
ON CONFLICT (branch_id) WHERE is_house_vendor DO NOTHING;

-- ── Track which manifests were created by a customer ───────────────────
ALTER TABLE manifests ADD COLUMN created_by_customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;
CREATE INDEX manifests_customer_idx ON manifests(created_by_customer_id);
