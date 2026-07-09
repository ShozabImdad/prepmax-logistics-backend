-- ============================================================================
-- 0010_order_business_fields
-- Richer order fields to match a real courier/customs workflow (informed by
-- the reference SCS-Cargo project + client requirements):
--   • Sender/receiver CNIC (Pakistan national ID) + structured address
--     (line1/line2/state/postcode already partially present) + company.
--   • Route origin/destination countries (distinct from address countries).
--   • Service level, pricing (what we charge), payment tracking, and declared
--     customs value/currency.
--   • Per-box parcel type + per-item declared value.
-- All nullable / defaulted so existing orders stay valid.
-- ============================================================================

-- ── orders: identity + structured address extras ────────────────────────────
ALTER TABLE orders
  ADD COLUMN sender_cnic        text,
  ADD COLUMN sender_ntn         text,
  ADD COLUMN sender_address2    text,
  ADD COLUMN sender_state       text,
  ADD COLUMN receiver_cnic      text,
  ADD COLUMN receiver_address2  text,
  ADD COLUMN receiver_state     text,
  -- explicit route (from/to country) separate from address countries
  ADD COLUMN origin_country      text,
  ADD COLUMN destination_country text,
  ADD COLUMN service_level       text,   -- Standard | Express | Economy | Freight

  -- ── pricing / finance ──
  -- what we charge the customer for the shipment
  ADD COLUMN price              numeric(12,2),
  ADD COLUMN price_currency     text DEFAULT 'PKR',
  -- customer payment tracking
  ADD COLUMN payment_status     text DEFAULT 'unpaid'
                                CHECK (payment_status IN ('unpaid','paid','partial')),
  ADD COLUMN amount_paid        numeric(12,2) DEFAULT 0,
  -- declared customs value (sum of item declared values), in a currency
  ADD COLUMN declared_total     numeric(12,2),
  ADD COLUMN declared_currency  text DEFAULT 'USD';

-- ── boxes: parcel type ──────────────────────────────────────────────────────
ALTER TABLE boxes
  ADD COLUMN parcel_type text DEFAULT 'package';  -- package|document|pallet|fragile|oversized|other

-- ── box_items: declared value already exists as unit_value; add a clearer
--    per-item declared value used for customs (USD by convention). We reuse
--    unit_value semantically but add pieces alias is unnecessary (quantity).
-- (no change needed — unit_value + quantity already cover this.)
