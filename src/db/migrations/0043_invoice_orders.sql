-- Multi-order invoices: an invoice can cover many customer orders in a date
-- range (consolidated AR billing). Header invoices.order_id stays for
-- backward compat (single-order / first order); this join is the source of truth.

CREATE TABLE invoice_orders (
  invoice_id  uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  branch_id   uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invoice_id, order_id)
);
CREATE INDEX invoice_orders_order_idx ON invoice_orders(order_id);
CREATE INDEX invoice_orders_branch_idx ON invoice_orders(branch_id);

ALTER TABLE invoice_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_orders_all ON invoice_orders FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- Per-line order link (mirrors vendor_bill_items.order_id) so PDF/ledger
-- lines can show which shipment each charge belongs to.
ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS invoice_items_order_idx ON invoice_items(order_id);

-- Backfill join rows from legacy single-order header FK.
INSERT INTO invoice_orders (invoice_id, order_id, branch_id)
SELECT i.id, i.order_id, i.branch_id
  FROM invoices i
 WHERE i.order_id IS NOT NULL
ON CONFLICT DO NOTHING;
