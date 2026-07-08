-- ============================================================================
-- 0003_customers_orders
-- Customers, orders, boxes, items, carrier legs, and tracking events.
-- Every table is branch-scoped and protected by the standard RLS policy
-- (app_can_see_branch). branch_id is denormalized onto child tables so RLS
-- filters them directly without a join (per architecture plan §3).
-- ============================================================================

-- Reusable macro-ish note: each table below follows the same pattern —
--   ENABLE + FORCE ROW LEVEL SECURITY, then a policy using app_can_see_branch.

-- ── customers (portal login accounts, created by staff) ─────────────────────
CREATE TABLE customers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id      text NOT NULL UNIQUE,
  branch_id      uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  full_name      text NOT NULL,
  email          text NOT NULL,
  phone          text,
  password_hash  text NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- email unique per branch (same person could exist at two branches)
  UNIQUE (branch_id, email)
);
CREATE INDEX customers_branch_idx ON customers(branch_id);
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
-- Login lookup by email happens before branch context is known, so allow
-- SELECT when no branch context is set (same pattern as users), else scope it.
CREATE POLICY customers_select ON customers FOR SELECT
  USING (app_can_see_branch(branch_id) OR app_current_branch() IS NULL);
CREATE POLICY customers_write ON customers FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── orders ──────────────────────────────────────────────────────────────────
CREATE TABLE orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id            text NOT NULL UNIQUE,        -- opaque id for URLs
  tracking_code        text NOT NULL UNIQUE,        -- customer-facing PML-...
  awb_number           text UNIQUE,                 -- printed AWB number
  branch_id            uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  customer_id          uuid REFERENCES customers(id) ON DELETE SET NULL,

  order_status         text NOT NULL DEFAULT 'pending_approval'
                       CHECK (order_status IN
                         ('pending_approval','awaiting_carrier','active','delivered','cancelled')),
  created_via          text NOT NULL DEFAULT 'staff'
                       CHECK (created_via IN ('customer','staff')),

  -- sender / receiver (flattened; standard AWB blocks)
  sender_name     text, sender_company text, sender_phone text, sender_email text,
  sender_address  text, sender_city text, sender_country text, sender_postcode text,
  receiver_name   text, receiver_company text, receiver_phone text, receiver_email text,
  receiver_address text, receiver_city text, receiver_country text, receiver_postcode text,

  service_type     text,
  contents_nature  text,                            -- documents | merchandise
  declared_value   numeric(12,2),
  currency         text DEFAULT 'PKR',
  duties           text CHECK (duties IN ('DTP','DTU')),
  handling_flags   text[] DEFAULT '{}',             -- e.g. {fragile, perishable}
  notes            text,

  -- cached normalized tracking status (updated by the poller)
  current_status       text,
  current_status_text  text,
  last_synced_at       timestamptz,

  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_branch_idx ON orders(branch_id);
CREATE INDEX orders_customer_idx ON orders(customer_id);
CREATE INDEX orders_status_idx ON orders(order_status);
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY orders_all ON orders FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── boxes (pieces within a shipment) ────────────────────────────────────────
CREATE TABLE boxes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  branch_id      uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  label          text,
  weight_kg      numeric(10,3) NOT NULL DEFAULT 0,
  length_cm      numeric(10,2) NOT NULL DEFAULT 0,
  width_cm       numeric(10,2) NOT NULL DEFAULT 0,
  height_cm      numeric(10,2) NOT NULL DEFAULT 0,
  -- computed by the app on write (volumetric = L*W*H/divisor; chargeable =
  -- max(actual, volumetric)). Stored for display / AWB / audit.
  volumetric_kg  numeric(10,3) NOT NULL DEFAULT 0,
  chargeable_kg  numeric(10,3) NOT NULL DEFAULT 0,
  sequence       int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX boxes_order_idx ON boxes(order_id);
CREATE INDEX boxes_branch_idx ON boxes(branch_id);

ALTER TABLE boxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE boxes FORCE ROW LEVEL SECURITY;
CREATE POLICY boxes_all ON boxes FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── box_items (contents of each box) ────────────────────────────────────────
CREATE TABLE box_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  box_id             uuid NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  branch_id          uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  description        text NOT NULL,
  quantity           int NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_value         numeric(12,2),
  hs_code            text,
  country_of_origin  text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX box_items_box_idx ON box_items(box_id);
CREATE INDEX box_items_branch_idx ON box_items(branch_id);

ALTER TABLE box_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE box_items FORCE ROW LEVEL SECURITY;
CREATE POLICY box_items_all ON box_items FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── shipment_legs (1 required + optional 2nd carrier leg; APX→DPD) ──────────
CREATE TABLE shipment_legs (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                  uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  branch_id                 uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  carrier                   text NOT NULL,   -- adapter key: dpd, smartcargo-apx, ...
  carrier_tracking_number   text NOT NULL,
  sequence                  int NOT NULL DEFAULT 1,
  is_active                 boolean NOT NULL DEFAULT true,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, sequence)
);
CREATE INDEX shipment_legs_order_idx ON shipment_legs(order_id);
CREATE INDEX shipment_legs_branch_idx ON shipment_legs(branch_id);

ALTER TABLE shipment_legs ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_legs FORCE ROW LEVEL SECURITY;
CREATE POLICY shipment_legs_all ON shipment_legs FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── tracking_events (normalized events per leg, from the adapters) ──────────
CREATE TABLE tracking_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_leg_id  uuid NOT NULL REFERENCES shipment_legs(id) ON DELETE CASCADE,
  branch_id        uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  event_time       timestamptz,
  event_time_raw   text,             -- original string when tz is ambiguous
  location         text,
  description      text NOT NULL,
  raw_status       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tracking_events_leg_idx ON tracking_events(shipment_leg_id);
CREATE INDEX tracking_events_branch_idx ON tracking_events(branch_id);

ALTER TABLE tracking_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tracking_events_all ON tracking_events FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));
