-- ============================================================================
-- 0018_manifest
-- Manifest module — outbound consolidation. A manifest is a batch of orders
-- handed to one carrier/vendor (§3.2 of ACCOUNTS_MANIFEST_DESIGN.md — Q3
-- resolved as header-level vendor, one carrier per manifest).
--
-- House pattern: uuid PK, public_id, denormalised branch_id, RLS via
-- app_can_see_branch, finance_touch_updated_at trigger (reused from
-- 0015_finance.sql — no new trigger function needed).
--
-- Weight/piece/charge totals are DERIVED from orders.boxes and orders.price,
-- cached on the manifest header, and recomputed on every add/remove — same
-- "derived, cached, recomputed on write" pattern as the finance dashboard.
--
-- Duplicate-tracking prevention: UNIQUE(manifest_id, order_id) stops adding
-- the same order twice to the SAME manifest. Cross-manifest prevention (an
-- order can't sit on two live/non-dispatched manifests at once) is enforced
-- at the application layer in queries.ts with a row-locked check, because a
-- DB-level partial unique index can't reference the parent manifest's status.
-- ============================================================================

CREATE TABLE manifests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id         text NOT NULL UNIQUE,
  branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,

  manifest_no       text NOT NULL,                 -- PML-MF-2026-000045 (unique per branch)
  vendor_id         uuid REFERENCES vendors(id) ON DELETE RESTRICT,  -- carrier this batch is handed to
  manifest_date     date NOT NULL DEFAULT CURRENT_DATE,
  status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','closed','dispatched')),

  total_shipments   int NOT NULL DEFAULT 0,
  total_weight_kg   numeric(10,3) NOT NULL DEFAULT 0,

  notes             text,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  closed_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  dispatched_at     timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX manifests_no_branch_uniq ON manifests(branch_id, manifest_no);
CREATE INDEX manifests_branch_idx ON manifests(branch_id);
CREATE INDEX manifests_status_idx ON manifests(branch_id, status);
CREATE INDEX manifests_vendor_idx ON manifests(vendor_id);

CREATE TRIGGER manifests_touch BEFORE UPDATE ON manifests
  FOR EACH ROW EXECUTE FUNCTION finance_touch_updated_at();

ALTER TABLE manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE manifests FORCE ROW LEVEL SECURITY;
CREATE POLICY manifests_all ON manifests FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── manifest_shipments (orders on a manifest) ────────────────────────────────
CREATE TABLE manifest_shipments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id   uuid NOT NULL REFERENCES manifests(id) ON DELETE CASCADE,
  branch_id     uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  added_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (manifest_id, order_id)
);
CREATE INDEX manifest_shipments_manifest_idx ON manifest_shipments(manifest_id);
CREATE INDEX manifest_shipments_order_idx ON manifest_shipments(order_id);
CREATE INDEX manifest_shipments_branch_idx ON manifest_shipments(branch_id);

ALTER TABLE manifest_shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE manifest_shipments FORCE ROW LEVEL SECURITY;
CREATE POLICY manifest_shipments_all ON manifest_shipments FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── RBAC: seed manifest permissions ─────────────────────────────────────────
INSERT INTO permissions (key, module, label) VALUES
  ('manifest.view',   'Manifest', 'View manifests and their shipments'),
  ('manifest.manage', 'Manifest', 'Create, edit, close, and dispatch manifests')
ON CONFLICT (key) DO NOTHING;