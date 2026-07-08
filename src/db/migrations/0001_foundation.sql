-- ============================================================================
-- 0001_foundation
-- Extensions, helper functions, and the RLS context accessors that every
-- branch-scoped policy in later migrations depends on.
-- ============================================================================

-- pgcrypto gives us gen_random_uuid() (used for internal primary keys).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── RLS context accessors ───────────────────────────────────────────────────
-- These read the per-transaction settings that the app sets via set_config()
-- in db/pool.ts. Marked STABLE + returning safe defaults when unset, so a
-- query with NO context set sees NO branch rows (fails closed).

-- Current branch id, or NULL if not set.
CREATE OR REPLACE FUNCTION app_current_branch() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.branch_id', true), '')::uuid
$$;

-- True only when the request is a verified super-admin.
CREATE OR REPLACE FUNCTION app_is_super_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.is_super_admin', true) = 'on'
$$;

-- True only when a super-admin has explicitly requested an all-branches view.
CREATE OR REPLACE FUNCTION app_all_branches() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.all_branches', true) = 'on'
$$;

-- The canonical branch-visibility predicate reused by every branch-scoped
-- policy: a row is visible if it belongs to the current branch, OR the request
-- is a super-admin doing an explicit all-branches read.
CREATE OR REPLACE FUNCTION app_can_see_branch(row_branch uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT (app_is_super_admin() AND app_all_branches())
      OR (row_branch IS NOT NULL AND row_branch = app_current_branch())
$$;

-- Auto-update helper for updated_at columns.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
