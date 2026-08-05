-- ============================================================================
-- 0039_password_resets
--
-- Forgot-password / reset-password support for both principals (staff users
-- and customers). Only a SHA-256 hash of the reset token is stored — never
-- the raw token — same principle as password_hash on users/customers. The
-- raw token exists only in the emailed link and in the requester's browser.
--
-- Looked up before any branch context exists (the requester is not logged
-- in yet), so — like `sessions` (0006) — this table is not branch-scoped and
-- carries a permissive RLS policy, backstopped by the fact it's keyed by an
-- unguessable token hash and always queried by exact match.
-- ============================================================================

CREATE TABLE password_resets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal     text NOT NULL CHECK (principal IN ('user','customer')),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  customer_id   uuid REFERENCES customers(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,        -- sha256(raw token), hex
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT password_resets_principal_ck CHECK (
    (principal = 'user'     AND user_id IS NOT NULL AND customer_id IS NULL) OR
    (principal = 'customer' AND customer_id IS NOT NULL AND user_id IS NULL)
  )
);

CREATE INDEX password_resets_user_idx ON password_resets(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX password_resets_customer_idx ON password_resets(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX password_resets_expires_idx ON password_resets(expires_at);

ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets FORCE ROW LEVEL SECURITY;
CREATE POLICY password_resets_all ON password_resets FOR ALL USING (true) WITH CHECK (true);
