-- ============================================================================
-- 0020_de_manifest_manual_fields
-- Manual sender/receiver/destination fallback for de_manifest_shipments rows
-- that don't match an order (order_id NULL, reconciliation 'extra' —
-- external/unrecognised tracking codes). Lets staff type these in by hand
-- since there's no order to pull them from. mapShipment() in queries.ts
-- uses these only as a fallback: a matched order's own data always wins.
-- ============================================================================

ALTER TABLE de_manifest_shipments
  ADD COLUMN manual_sender_name   text,
  ADD COLUMN manual_receiver_name text,
  ADD COLUMN manual_destination   text;