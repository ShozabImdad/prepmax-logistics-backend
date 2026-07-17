-- ============================================================================
-- 0015_finance
-- A practical AR/AP (accounts-receivable / accounts-payable) layer for the
-- courier business. Not a full double-entry general ledger — a subsidiary-
-- ledger model: each customer and each vendor has a derived ledger (debits
-- and credits with a running balance), built at read time from invoices /
-- vendor_bills / payments. This matches how courier billing systems
-- (cTrunk, CargoWise, Linbis) structure "Customer Ledger" / "Vendor Ledger".
--
-- Tables:
--   vendors           — carriers/partners we pay (APX, SkyNet, Local, Aramex…)
--   invoices          — customer-facing bills (AR). A credit note is an
--                       invoice with is_credit_note=true (negative effect).
--   invoice_items     — line items on an invoice
--   vendor_bills      — what a vendor charges us (AP)
--   vendor_bill_items — optional line items (may reference orders)
--   payments          — money movements, both directions
--   expenses          — operating expenses (rent, salaries, fuel, …)
--
-- Ledgers are DERIVED (not stored). Customer Ledger = invoices (debits) +
-- inbound payments (credits), ordered by date, with a running balance.
-- Vendor Ledger = vendor_bills (credits) + outbound payments (debits).
--
-- RBAC: seeds `finance.view` and `finance.manage` permission keys into the
-- permissions catalog so role-admin screens can grant them to staff roles.
-- ============================================================================

-- ── vendors ─────────────────────────────────────────────────────────────────
CREATE TABLE vendors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id        text NOT NULL UNIQUE,
  branch_id        uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,

  name             text NOT NULL,
  code             text,                                  -- 'smartcargo-apx', NULL for Local
  vendor_type      text NOT NULL DEFAULT 'carrier'
                   CHECK (vendor_type IN ('carrier','local','other')),
  contact_name     text,
  phone            text,
  email            text,
  address          text,

  opening_balance  numeric(12,2) NOT NULL DEFAULT 0,      -- what we owed them on day 1
  is_active        boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendors_branch_idx ON vendors(branch_id);
CREATE UNIQUE INDEX vendors_name_branch_uniq ON vendors(branch_id, lower(name)) WHERE is_active = true;

ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors FORCE ROW LEVEL SECURITY;
CREATE POLICY vendors_all ON vendors FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── invoices (AR) ───────────────────────────────────────────────────────────
CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text NOT NULL UNIQUE,
  branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,

  invoice_no      text NOT NULL,                          -- PML-INV-2026-000123 (unique per branch)
  customer_id     uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  order_id        uuid REFERENCES orders(id) ON DELETE SET NULL,  -- nullable: ad-hoc / consolidated

  is_credit_note  boolean NOT NULL DEFAULT false,
  issue_date      date NOT NULL DEFAULT CURRENT_DATE,
  due_date        date,
  currency        text NOT NULL DEFAULT 'PKR',

  subtotal        numeric(12,2) NOT NULL DEFAULT 0,
  tax             numeric(12,2) NOT NULL DEFAULT 0,
  total           numeric(12,2) NOT NULL DEFAULT 0,
  amount_paid     numeric(12,2) NOT NULL DEFAULT 0,

  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','unpaid','partial','paid','void')),
  notes           text,

  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invoices_no_branch_uniq ON invoices(branch_id, invoice_no);
CREATE INDEX invoices_branch_idx ON invoices(branch_id);
CREATE INDEX invoices_customer_idx ON invoices(customer_id);
CREATE INDEX invoices_status_idx ON invoices(branch_id, status);
CREATE INDEX invoices_issue_date_idx ON invoices(branch_id, issue_date);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY invoices_all ON invoices FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── invoice_items ───────────────────────────────────────────────────────────
CREATE TABLE invoice_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  branch_id    uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,

  description  text NOT NULL,
  quantity     numeric(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price   numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  line_total   numeric(12,2) NOT NULL DEFAULT 0,

  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_items_invoice_idx ON invoice_items(invoice_id);
CREATE INDEX invoice_items_branch_idx ON invoice_items(branch_id);

ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_items_all ON invoice_items FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── vendor_bills (AP) ───────────────────────────────────────────────────────
CREATE TABLE vendor_bills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id     text NOT NULL UNIQUE,
  branch_id     uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,

  bill_no       text,                                     -- vendor's own bill number (free text)
  vendor_id     uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,

  bill_date     date NOT NULL DEFAULT CURRENT_DATE,
  due_date      date,
  currency      text NOT NULL DEFAULT 'PKR',

  subtotal      numeric(12,2) NOT NULL DEFAULT 0,
  tax           numeric(12,2) NOT NULL DEFAULT 0,
  total         numeric(12,2) NOT NULL DEFAULT 0,
  amount_paid   numeric(12,2) NOT NULL DEFAULT 0,

  status        text NOT NULL DEFAULT 'unpaid'
                CHECK (status IN ('unpaid','partial','paid','void')),
  notes         text,

  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_bills_branch_idx ON vendor_bills(branch_id);
CREATE INDEX vendor_bills_vendor_idx ON vendor_bills(vendor_id);
CREATE INDEX vendor_bills_status_idx ON vendor_bills(branch_id, status);
CREATE INDEX vendor_bills_bill_date_idx ON vendor_bills(branch_id, bill_date);

ALTER TABLE vendor_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_bills FORCE ROW LEVEL SECURITY;
CREATE POLICY vendor_bills_all ON vendor_bills FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── vendor_bill_items ───────────────────────────────────────────────────────
CREATE TABLE vendor_bill_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_bill_id  uuid NOT NULL REFERENCES vendor_bills(id) ON DELETE CASCADE,
  branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,

  order_id        uuid REFERENCES orders(id) ON DELETE SET NULL,
  description     text NOT NULL,
  amount          numeric(12,2) NOT NULL DEFAULT 0,

  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_bill_items_bill_idx ON vendor_bill_items(vendor_bill_id);
CREATE INDEX vendor_bill_items_branch_idx ON vendor_bill_items(branch_id);

ALTER TABLE vendor_bill_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_bill_items FORCE ROW LEVEL SECURITY;
CREATE POLICY vendor_bill_items_all ON vendor_bill_items FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── payments (both directions) ──────────────────────────────────────────────
CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       text NOT NULL UNIQUE,
  branch_id       uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,

  direction       text NOT NULL CHECK (direction IN ('in','out')),
  method          text NOT NULL DEFAULT 'cash'
                  CHECK (method IN ('cash','bank','cheque','online','other')),
  account         text NOT NULL DEFAULT 'cash_in_hand'
                  CHECK (account IN ('cash_in_hand','bank')),

  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  paid_on         date NOT NULL DEFAULT CURRENT_DATE,

  customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,   -- direction='in'
  vendor_id       uuid REFERENCES vendors(id) ON DELETE SET NULL,     -- direction='out' to a vendor
  invoice_id      uuid REFERENCES invoices(id) ON DELETE SET NULL,    -- allocation: AR
  vendor_bill_id  uuid REFERENCES vendor_bills(id) ON DELETE SET NULL,-- allocation: AP

  reference       text,
  notes           text,

  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_branch_idx ON payments(branch_id);
CREATE INDEX payments_direction_idx ON payments(branch_id, direction);
CREATE INDEX payments_paid_on_idx ON payments(branch_id, paid_on);
CREATE INDEX payments_customer_idx ON payments(customer_id);
CREATE INDEX payments_vendor_idx ON payments(vendor_id);
CREATE INDEX payments_invoice_idx ON payments(invoice_id);
CREATE INDEX payments_vendor_bill_idx ON payments(vendor_bill_id);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE POLICY payments_all ON payments FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── expenses ────────────────────────────────────────────────────────────────
CREATE TABLE expenses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id    text NOT NULL UNIQUE,
  branch_id    uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,

  category     text NOT NULL CHECK (category IN
               ('office_rent','salaries','fuel','utilities','marketing','miscellaneous')),
  amount       numeric(12,2) NOT NULL CHECK (amount > 0),
  account      text NOT NULL DEFAULT 'cash_in_hand'
               CHECK (account IN ('cash_in_hand','bank')),
  spent_on     date NOT NULL DEFAULT CURRENT_DATE,

  payee        text,
  description  text,
  reference    text,

  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expenses_branch_idx ON expenses(branch_id);
CREATE INDEX expenses_category_idx ON expenses(branch_id, category);
CREATE INDEX expenses_spent_on_idx ON expenses(branch_id, spent_on);

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses FORCE ROW LEVEL SECURITY;
CREATE POLICY expenses_all ON expenses FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── updated_at triggers (mirrors the pattern used on other tables) ──────────
CREATE OR REPLACE FUNCTION finance_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER vendors_touch   BEFORE UPDATE ON vendors   FOR EACH ROW EXECUTE FUNCTION finance_touch_updated_at();
CREATE TRIGGER invoices_touch  BEFORE UPDATE ON invoices  FOR EACH ROW EXECUTE FUNCTION finance_touch_updated_at();
CREATE TRIGGER vendor_bills_touch BEFORE UPDATE ON vendor_bills FOR EACH ROW EXECUTE FUNCTION finance_touch_updated_at();
CREATE TRIGGER payments_touch  BEFORE UPDATE ON payments  FOR EACH ROW EXECUTE FUNCTION finance_touch_updated_at();
CREATE TRIGGER expenses_touch  BEFORE UPDATE ON expenses  FOR EACH ROW EXECUTE FUNCTION finance_touch_updated_at();

-- ── RBAC: seed finance permissions into the catalog ─────────────────────────
-- The permissions table is (key, module, label) — see migration
-- 0002_branches_users_rbac.sql. Idempotent: ON CONFLICT DO NOTHING keeps this
-- safe to re-run.
INSERT INTO permissions (key, module, label) VALUES
  ('finance.view',   'Finance', 'View finance dashboard, vendors, invoices, bills, payments, expenses, and ledgers'),
  ('finance.manage', 'Finance', 'Create, edit, and delete vendors, invoices, vendor bills, payments, and expenses')
ON CONFLICT (key) DO NOTHING;
