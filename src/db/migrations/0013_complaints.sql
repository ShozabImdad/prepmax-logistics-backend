-- ============================================================================
-- 0013_complaints
-- Customer complaints filed against their own orders. Branch-scoped like
-- orders/customers (standard app_can_see_branch RLS policy). A complaint
-- always belongs to exactly one order and one customer; both are denormalized
-- alongside branch_id so RLS filters it directly without a join.
-- ============================================================================

CREATE TABLE complaints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id     text NOT NULL UNIQUE,
  branch_id     uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  category      text NOT NULL CHECK (category IN (
                  'Delayed shipment',
                  'Damaged package',
                  'Missing items',
                  'Wrong delivery address',
                  'Billing / pricing issue',
                  'Poor customer service',
                  'Other'
                )),
  message       text NOT NULL,

  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','in_review','resolved','closed')),
  response      text,                                  -- staff reply to the customer
  handled_by    uuid REFERENCES users(id) ON DELETE SET NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX complaints_branch_idx ON complaints(branch_id);
CREATE INDEX complaints_order_idx ON complaints(order_id);
CREATE INDEX complaints_customer_idx ON complaints(customer_id);
CREATE INDEX complaints_status_idx ON complaints(status);
CREATE TRIGGER complaints_updated_at BEFORE UPDATE ON complaints
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaints FORCE ROW LEVEL SECURITY;
CREATE POLICY complaints_all ON complaints FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── permissions ───────────────────────────────────────────────────────────
INSERT INTO permissions (key, module, label) VALUES
  ('complaints.view',   'Complaints', 'View customer complaints'),
  ('complaints.manage', 'Complaints', 'Respond to / update complaint status')
ON CONFLICT (key) DO NOTHING;
