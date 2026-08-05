-- ============================================================================
-- 0040_users_self_update
--
-- Bug: 0033 locked ALL writes to `users` behind app_is_super_admin() (staff
-- management is super-admin-only). That's correct for admin CRUD on OTHER
-- staff accounts, but it also silently blocked a branch_manager's own
-- self-service "change my password" — the UPDATE ran under that principal's
-- normal (non-super-admin) branch context, matched zero rows against
-- users_write's USING clause, and affected 0 rows without raising an error.
--
-- Fix: add a narrowly-scoped, additional PERMISSIVE policy that allows a
-- request to UPDATE the single users row matching an explicitly-flagged
-- "this is me" id — set via app.self_id, which the app only ever sets, for
-- the duration of a single transaction, immediately before the self-service
-- password UPDATE (see changeOwnStaffPassword in modules/auth/service.ts).
-- Postgres combines multiple PERMISSIVE policies for the same command with
-- OR, so this simply adds "...or it's your own row" on top of the existing
-- super-admin-only rule — it does not loosen anything else.
-- ============================================================================

-- Current "acting as self" id, or NULL if not set. Mirrors app_current_branch().
CREATE OR REPLACE FUNCTION app_current_self_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.self_id', true), '')::uuid
$$;

CREATE POLICY users_self_update ON users FOR UPDATE
  USING (id = app_current_self_id())
  WITH CHECK (id = app_current_self_id());
