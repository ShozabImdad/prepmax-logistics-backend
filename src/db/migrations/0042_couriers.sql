-- ============================================================================
-- 0042_couriers
-- Turns the previously-hardcoded Direct / Via / By Sea courier lists
-- (src/modules/orders/delivery-times.ts + the admin frontend's OrderForm.tsx
-- DIRECT_OPTIONS/VIA_OPTIONS/BY_SEA_OPTIONS) into an editable catalog:
-- staff with couriers.manage can add, edit, deactivate, or delete couriers
-- and set each one's category + service level, instead of a code change.
--
-- Global catalog, not branch-scoped (same pattern as `permissions`) — every
-- branch sees and books the same courier list. No RLS.
--
-- `orders.service_type` keeps being stored as the free-text
-- "<Category> — <Name>" string (see encodeServiceType() in OrderForm.tsx);
-- this table is not a foreign key of orders, it's the catalog the picker
-- (and the delivery-estimate lookup) reads from. name is unique per category
-- so "<Category> — <Name>" always resolves to exactly one row.
-- ============================================================================

CREATE TABLE couriers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id    text NOT NULL UNIQUE,

  category     text NOT NULL CHECK (category IN ('Direct', 'Via', 'By Sea')),
  name         text NOT NULL,     -- the option label, e.g. "Skynet", "Prepmax UK Normal", "UK"
  level        text NOT NULL CHECK (level IN ('Standard', 'Express', 'Freight')),

  min_days     integer NOT NULL CHECK (min_days >= 0),
  max_days     integer NOT NULL CHECK (max_days >= min_days),

  is_active    boolean NOT NULL DEFAULT true,  -- inactive couriers stay for historical orders but drop off the picker
  sort_order   integer NOT NULL DEFAULT 0,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (category, name)
);

CREATE INDEX couriers_category_idx ON couriers(category, sort_order);

CREATE TRIGGER couriers_updated_at BEFORE UPDATE ON couriers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed with the exact set that was previously hardcoded (delivery-times.ts +
-- OrderForm.tsx as of this migration), so no existing order's estimate or
-- picker option disappears when this table becomes the source of truth.
-- Via names intentionally keep their existing leading-space / prefix quirks
-- (e.g. ' UK DPD (CCP)') because that's the literal string already stored in
-- some orders' service_type — renaming here would break those lookups.
INSERT INTO couriers (public_id, category, name, level, min_days, max_days, sort_order) VALUES
  (gen_random_uuid()::text, 'Direct', 'Skynet',                      'Express',  5, 7, 1),
  (gen_random_uuid()::text, 'Direct', 'UPS',                         'Express',  4, 6, 2),
  (gen_random_uuid()::text, 'Direct', 'DHL',                         'Express',  3, 5, 3),
  (gen_random_uuid()::text, 'Direct', 'Fedex',                       'Express',  5, 6, 4),
  (gen_random_uuid()::text, 'Direct', 'DPEX',                        'Express',  5, 7, 5),
  (gen_random_uuid()::text, 'Direct', 'Aramex',                      'Express',  6, 8, 6),
  (gen_random_uuid()::text, 'Direct', 'Prepmax UK Normal',           'Express',  4, 6, 7),
  (gen_random_uuid()::text, 'Direct', 'Prepmax Uk (Direct Flight)',  'Express',  3, 5, 8),
  (gen_random_uuid()::text, 'Direct', 'Direct main',                 'Express',  3, 5, 9),
  (gen_random_uuid()::text, 'Direct', 'Skynet( Direct Flight)',      'Express',  5, 6, 10),

  (gen_random_uuid()::text, 'Via', 'Skynet Via DHL',      'Standard', 8, 10, 1),
  (gen_random_uuid()::text, 'Via', 'Skynet Via Aramex',   'Standard', 8, 10, 2),
  (gen_random_uuid()::text, 'Via', 'Skynet Via UPS',      'Standard', 8, 10, 3),
  (gen_random_uuid()::text, 'Via', 'Skynet Via DPEX',     'Standard', 8, 10, 4),
  (gen_random_uuid()::text, 'Via', ' UK DPD (CCP)',       'Standard', 8, 10, 5),
  (gen_random_uuid()::text, 'Via', ' UK DPD (CC)',        'Standard', 8, 10, 6),
  (gen_random_uuid()::text, 'Via', ' UK UPS',             'Standard', 8, 10, 7),
  (gen_random_uuid()::text, 'Via', ' UK DHL',             'Standard', 8, 10, 8),
  (gen_random_uuid()::text, 'Via', ' UK FedEx',           'Standard', 8, 10, 9),
  (gen_random_uuid()::text, 'Via', ' Dubai DHL',          'Standard', 8, 10, 10),
  (gen_random_uuid()::text, 'Via', ' Dubai UPS',          'Standard', 8, 10, 11),
  (gen_random_uuid()::text, 'Via', ' Dubai Fedex',        'Standard', 8, 10, 12),
  (gen_random_uuid()::text, 'Via', ' Dubai Aramex',       'Standard', 8, 10, 13),
  (gen_random_uuid()::text, 'Via', ' Dubai Local',        'Standard', 8, 10, 14),
  (gen_random_uuid()::text, 'Via', ' Singapore DHL',      'Standard', 8, 10, 15),
  (gen_random_uuid()::text, 'Via', ' Singapore UPS',      'Standard', 8, 10, 16),
  (gen_random_uuid()::text, 'Via', ' Singapore FedEx',    'Standard', 8, 10, 17),
  (gen_random_uuid()::text, 'Via', 'Direct JFK(USA-CCP)', 'Standard', 8, 10, 18),
  (gen_random_uuid()::text, 'Via', 'Direct JFK(USA-CC)',  'Standard', 8, 10, 19),
  (gen_random_uuid()::text, 'Via', 'Post Office',         'Standard', 8, 10, 20),
  (gen_random_uuid()::text, 'Via', 'Prepmax Via Uk (Normal)', 'Standard', 8, 9, 21),

  (gen_random_uuid()::text, 'By Sea', 'UK',     'Freight', 45, 60, 1),
  (gen_random_uuid()::text, 'By Sea', 'USA',    'Freight', 50, 65, 2),
  (gen_random_uuid()::text, 'By Sea', 'UAE',    'Freight', 30, 40, 3),
  (gen_random_uuid()::text, 'By Sea', 'Canada', 'Freight', 50, 65, 4)
ON CONFLICT (category, name) DO NOTHING;

INSERT INTO permissions (key, module, label) VALUES
  ('couriers.view',   'Couriers', 'View the courier / service-type catalog'),
  ('couriers.add',    'Couriers', 'Add new couriers'),
  ('couriers.edit',   'Couriers', 'Edit couriers (category, level, delivery days, active status)'),
  ('couriers.delete', 'Couriers', 'Delete couriers')
ON CONFLICT (key) DO NOTHING;
