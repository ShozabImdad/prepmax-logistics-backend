-- ============================================================================
-- 0026_bank_accounts_cleanup
-- Removes the auto-seeded "Cash in Hand" and "Bank (Unspecified)" mock
-- accounts created by 0025_bank_accounts.sql. Requested by client during
-- test phase (no real money recorded yet against these accounts) — staff
-- will create their own real named accounts (Cash in Hand, Meezan, HBL,
-- UBL, ...) from the new Bank Accounts UI instead.
--
-- Safety: any payment/expense that happens to already point at one of these
-- seeded accounts is un-linked first (bank_account_id -> NULL), falling
-- back to its legacy `account` text column, so nothing is lost even if some
-- test data was entered. Then the seeded rows themselves are deleted.
-- ============================================================================

UPDATE payments
   SET bank_account_id = NULL
 WHERE bank_account_id IN (
   SELECT id FROM bank_accounts WHERE name IN ('Cash in Hand', 'Bank (Unspecified)')
 );

UPDATE expenses
   SET bank_account_id = NULL
 WHERE bank_account_id IN (
   SELECT id FROM bank_accounts WHERE name IN ('Cash in Hand', 'Bank (Unspecified)')
 );

DELETE FROM bank_accounts WHERE name IN ('Cash in Hand', 'Bank (Unspecified)');

-- Note: 0025's seed INSERTs only ran once (at migration time) and there is
-- no ongoing seeding logic elsewhere (branch creation does not auto-create
-- a bank account) — so this cleanup is a one-time fix, not a recurring one.