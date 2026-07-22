-- ============================================================================
-- 0025_bank_accounts
-- Closes design-doc gaps Q7 / Part 2 §C (#1 and #2):
--   - Multiple named bank accounts (Meezan, HBL, UBL, ...) instead of one
--     generic "bank" bucket, plus a "Cash in Hand" account.
--   - Opening balances for cash + each bank account.
-- Branch-scoped, same house pattern as vendors (0015_finance.sql).
--
-- payments.account / expenses.account (text: 'cash_in_hand' | 'bank') are
-- kept as-is for backward compatibility with existing reports/queries — a
-- new nullable bank_account_id is added alongside them so a payment/expense
-- can point at a *specific* account. When bank_account_id is set, `account`
-- is derived from that account's type so the two never disagree.
-- ============================================================================

CREATE TABLE bank_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id         text NOT NULL UNIQUE,
  branch_id         uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,

  name              text NOT NULL,                 -- e.g. 'Cash in Hand', 'Meezan Bank', 'HBL - Main'
  account_type      text NOT NULL CHECK (account_type IN ('cash', 'bank')),
  bank_name         text,                           -- e.g. 'Meezan', 'HBL', 'UBL' (bank type only)
  account_number    text,
  opening_balance   numeric(12,2) NOT NULL DEFAULT 0,

  is_active         boolean NOT NULL DEFAULT true,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  UNIQUE (branch_id, name)
);
CREATE INDEX bank_accounts_branch_idx ON bank_accounts(branch_id);
CREATE INDEX bank_accounts_type_idx ON bank_accounts(account_type);

CREATE TRIGGER bank_accounts_updated_at BEFORE UPDATE ON bank_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_accounts_all ON bank_accounts FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── Seed a default "Cash in Hand" account per existing branch ───────────────
-- (opening_balance 0 — staff can edit it in after this migration to the
-- real starting figure via PATCH /api/finance/bank-accounts/:publicId)
INSERT INTO bank_accounts (public_id, branch_id, name, account_type, opening_balance)
SELECT md5(random()::text || clock_timestamp()::text || b.id::text), b.id, 'Cash in Hand', 'cash', 0
FROM branches b
ON CONFLICT (branch_id, name) DO NOTHING;

-- Seed a legacy "Bank (Unspecified)" bucket per branch so pre-existing
-- account='bank' payments/expenses (recorded before named bank accounts
-- existed) have something concrete to backfill onto. Its opening_balance is
-- 0 by design: it's derived entirely from the full history of payments and
-- expenses already linked to it, so 0 + that history is already correct.
INSERT INTO bank_accounts (public_id, branch_id, name, account_type, opening_balance)
SELECT md5(random()::text || clock_timestamp()::text || b.id::text || 'bank'), b.id, 'Bank (Unspecified)', 'bank', 0
FROM branches b
ON CONFLICT (branch_id, name) DO NOTHING;

-- ── Link payments / expenses to a specific account ──────────────────────────
ALTER TABLE payments ADD COLUMN bank_account_id uuid REFERENCES bank_accounts(id) ON DELETE RESTRICT;
ALTER TABLE expenses ADD COLUMN bank_account_id uuid REFERENCES bank_accounts(id) ON DELETE RESTRICT;

CREATE INDEX payments_bank_account_idx ON payments(bank_account_id);
CREATE INDEX expenses_bank_account_idx ON expenses(bank_account_id);

-- Backfill existing rows onto the per-branch default account matching their
-- current `account` text, so history keeps working with the new model.
UPDATE payments p
   SET bank_account_id = ba.id
  FROM bank_accounts ba
 WHERE p.branch_id = ba.branch_id
   AND p.bank_account_id IS NULL
   AND ((p.account = 'cash_in_hand' AND ba.name = 'Cash in Hand')
     OR (p.account = 'bank'         AND ba.name = 'Bank (Unspecified)'));

UPDATE expenses e
   SET bank_account_id = ba.id
  FROM bank_accounts ba
 WHERE e.branch_id = ba.branch_id
   AND e.bank_account_id IS NULL
   AND ((e.account = 'cash_in_hand' AND ba.name = 'Cash in Hand')
     OR (e.account = 'bank'         AND ba.name = 'Bank (Unspecified)'));

-- No new permission key needed — bank accounts are managed under the
-- existing finance.manage permission, same as vendors/invoices/payments.
