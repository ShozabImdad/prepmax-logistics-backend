-- ============================================================================
-- 0006_sessions
-- Server-side sessions (architecture plan §11): the session id lives in an
-- HttpOnly cookie; the actual session data lives here so it can be revoked
-- instantly (delete the row → the user is logged out on their next request).
--
-- A session belongs to EITHER a staff user OR a customer (never both). It is
-- looked up by id on every request before any branch context exists, so this
-- table is intentionally NOT branch-scoped by RLS — it's keyed by an
-- unguessable random session id and only ever queried by that id.
-- ============================================================================

CREATE TABLE sessions (
  id            text PRIMARY KEY,             -- random 256-bit token (the cookie value)
  principal     text NOT NULL CHECK (principal IN ('user','customer')),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  customer_id   uuid REFERENCES customers(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_principal_ck CHECK (
    (principal = 'user'     AND user_id IS NOT NULL AND customer_id IS NULL) OR
    (principal = 'customer' AND customer_id IS NOT NULL AND user_id IS NULL)
  )
);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

-- Not branch-scoped: RLS enabled but with a permissive policy, because lookups
-- happen pre-context and are already protected by the unguessable primary key.
-- The app role still only ever selects/deletes by exact id.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_all ON sessions FOR ALL USING (true) WITH CHECK (true);
