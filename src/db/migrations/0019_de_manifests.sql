-- ============================================================================
-- 0019_de_manifests
-- De-Manifest module — inbound receiving & reconciliation (§3.3 of
-- ACCOUNTS_MANIFEST_DESIGN.md). Client asked Q5/Q6, unresolved — built the
-- flexible way so it doesn't block on the answer:
--   - order_id nullable: matched to our own PML order when the scanned
--     tracking resolves to one; NULL when it doesn't (an "extra"/unrecognised
--     shipment — could be an external AWB or a bad scan, we don't care which).
--   - scanned_tracking always stored raw regardless of whether it matched.
--   - source_manifest_id nullable: an optional link to a manifests row, for
--     the inter-branch case where the "expected" list is a known outbound
--     manifest. When NULL, there's no fixed expected list — rows are just
--     scanned and classified as they come in (external-courier case).
--
-- House pattern: uuid PK, public_id, denormalised branch_id, RLS via
-- app_can_see_branch, finance_touch_updated_at trigger (reused — no new
-- trigger function needed, same as 0018_manifests.sql).
--
-- Counts (total_expected/received/missing/extra/damaged) are DERIVED from
-- de_manifest_shipments and cached on the header, recomputed on every
-- add/update/remove — same "derived, cached, recomputed on write" pattern
-- as manifests and the finance dashboard.
-- ============================================================================

CREATE TABLE de_manifests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id           text NOT NULL UNIQUE,
  branch_id           uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,  -- arrival hub

  de_manifest_no      text NOT NULL,                 -- PML-DMF-2026-000012 (unique per branch)
  source_manifest_id  uuid REFERENCES manifests(id) ON DELETE SET NULL,  -- optional: known outbound manifest this reconciles against
  vendor_id           uuid REFERENCES vendors(id) ON DELETE RESTRICT,    -- courier/partner handing this batch over (nullable — free text fallback below)
  courier_name        text,                          -- free-text courier name when there's no vendor record (Q5 fallback)
  de_manifest_date     date NOT NULL DEFAULT CURRENT_DATE,
  status               text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','completed')),

  total_expected      int NOT NULL DEFAULT 0,
  total_received      int NOT NULL DEFAULT 0,
  total_missing        int NOT NULL DEFAULT 0,
  total_extra          int NOT NULL DEFAULT 0,
  total_damaged        int NOT NULL DEFAULT 0,

  remarks              text,
  received_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  completed_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  completed_at         timestamptz,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX de_manifests_no_branch_uniq ON de_manifests(branch_id, de_manifest_no);
CREATE INDEX de_manifests_branch_idx ON de_manifests(branch_id);
CREATE INDEX de_manifests_status_idx ON de_manifests(branch_id, status);
CREATE INDEX de_manifests_source_manifest_idx ON de_manifests(source_manifest_id);
CREATE INDEX de_manifests_vendor_idx ON de_manifests(vendor_id);

CREATE TRIGGER de_manifests_touch BEFORE UPDATE ON de_manifests
  FOR EACH ROW EXECUTE FUNCTION finance_touch_updated_at();

ALTER TABLE de_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE de_manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY de_manifests_all ON de_manifests FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── de_manifest_shipments (scanned rows) ────────────────────────────────────
CREATE TABLE de_manifest_shipments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  de_manifest_id    uuid NOT NULL REFERENCES de_manifests(id) ON DELETE CASCADE,
  branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,

  order_id          uuid REFERENCES orders(id) ON DELETE SET NULL,  -- matched PML order, NULL when unrecognised
  scanned_tracking  text NOT NULL,                                  -- raw scanned/typed value, always kept

  received_at       timestamptz,                                    -- NULL until physically scanned in
  condition         text CHECK (condition IN ('good','damaged','missing','open_package')),
  reconciliation    text NOT NULL DEFAULT 'pending'
                     CHECK (reconciliation IN ('pending','received','missing','extra','hold')),
  remarks           text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX de_manifest_shipments_de_manifest_idx ON de_manifest_shipments(de_manifest_id);
CREATE INDEX de_manifest_shipments_order_idx ON de_manifest_shipments(order_id);
CREATE INDEX de_manifest_shipments_branch_idx ON de_manifest_shipments(branch_id);
-- One row per order per de-manifest (only when matched — unmatched/"extra"
-- scans have NULL order_id and aren't constrained by this).
CREATE UNIQUE INDEX de_manifest_shipments_order_uniq
  ON de_manifest_shipments(de_manifest_id, order_id) WHERE order_id IS NOT NULL;

CREATE TRIGGER de_manifest_shipments_touch BEFORE UPDATE ON de_manifest_shipments
  FOR EACH ROW EXECUTE FUNCTION finance_touch_updated_at();

ALTER TABLE de_manifest_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE de_manifest_shipments FORCE ROW LEVEL SECURITY;
CREATE POLICY de_manifest_shipments_all ON de_manifest_shipments FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── RBAC: seed de-manifest permissions ──────────────────────────────────────
INSERT INTO permissions (key, module, label) VALUES
  ('demanifest.view',   'De-Manifest', 'View de-manifests and their shipments'),
  ('demanifest.manage', 'De-Manifest', 'Create, receive, reconcile, and complete de-manifests')
ON CONFLICT (key) DO NOTHING;
