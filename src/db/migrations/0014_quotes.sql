-- ============================================================================
-- 0014_quotes
-- Customer quote requests: "how much to ship this?" filed from the portal,
-- before any order exists. Branch-scoped like complaints/orders (standard
-- app_can_see_branch RLS policy). Cargo detail (boxes/items) is stored as
-- JSONB rather than normalized tables — a quote request is a lightweight,
-- disposable draft, not the source of truth an order's boxes/items are.
-- ============================================================================

CREATE TABLE quotes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id           text NOT NULL UNIQUE,
  branch_id           uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  origin_country      text NOT NULL,
  destination_country text NOT NULL,
  service_level       text NOT NULL CHECK (service_level IN ('Standard','Express','Economy','Freight')),
  contents_nature     text CHECK (contents_nature IN ('documents','merchandise')),

  -- Cargo detail: [{ parcelType, weightKg, lengthCm, widthCm, heightCm,
  --                   items: [{ description, quantity, unitValue }] }, ...]
  boxes               jsonb NOT NULL DEFAULT '[]'::jsonb,

  notes               text,

  status              text NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','quoted','accepted','declined','closed')),
  quoted_price        numeric(12,2),
  quoted_currency     text DEFAULT 'PKR',
  staff_response      text,                                  -- staff note to the customer
  handled_by          uuid REFERENCES users(id) ON DELETE SET NULL,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quotes_branch_idx ON quotes(branch_id);
CREATE INDEX quotes_customer_idx ON quotes(customer_id);
CREATE INDEX quotes_status_idx ON quotes(status);
CREATE TRIGGER quotes_updated_at BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes FORCE ROW LEVEL SECURITY;
CREATE POLICY quotes_all ON quotes FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── permissions ───────────────────────────────────────────────────────────
INSERT INTO permissions (key, module, label) VALUES
  ('quotes.view',   'Quotes', 'View customer quote requests'),
  ('quotes.manage', 'Quotes', 'Respond to quote requests with pricing')
ON CONFLICT (key) DO NOTHING;
