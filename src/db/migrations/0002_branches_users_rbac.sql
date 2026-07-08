-- ============================================================================
-- 0002_branches_users_rbac
-- Branches, platform users (super-admin + branch managers), and the RBAC
-- permission model. Customers live in their own table (next migration).
-- ============================================================================

-- ── branches ────────────────────────────────────────────────────────────────
CREATE TABLE branches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id   text NOT NULL UNIQUE,          -- opaque id for URLs
  name        text NOT NULL,
  city        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER branches_updated_at BEFORE UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Branches are managed by super-admin and read during login/context setup.
-- RLS: super-admin sees all; a branch-scoped request sees only its own branch.
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches FORCE ROW LEVEL SECURITY;
CREATE POLICY branches_select ON branches FOR SELECT
  USING (app_is_super_admin() OR id = app_current_branch());
CREATE POLICY branches_write ON branches FOR ALL
  USING (app_is_super_admin())
  WITH CHECK (app_is_super_admin());

-- ── users (platform staff: super_admin | branch_manager) ────────────────────
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id      text NOT NULL UNIQUE,
  branch_id      uuid REFERENCES branches(id) ON DELETE RESTRICT, -- NULL for super_admin
  role           text NOT NULL CHECK (role IN ('super_admin', 'branch_manager')),
  email          text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  full_name      text NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- a branch_manager must have a branch; a super_admin must not.
  CONSTRAINT users_branch_role_ck CHECK (
    (role = 'super_admin'    AND branch_id IS NULL) OR
    (role = 'branch_manager' AND branch_id IS NOT NULL)
  )
);
CREATE INDEX users_branch_idx ON users(branch_id);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Users need a careful policy: LOGIN looks up a user by email BEFORE any branch
-- context exists (withoutContext). To support that safely without opening a
-- hole, SELECT is allowed when: super-admin, OR the row's branch matches the
-- current branch, OR no branch context is set at all (login lookup). Writes are
-- restricted to super-admin (managing staff accounts).
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_select ON users FOR SELECT
  USING (
    app_is_super_admin()
    OR (branch_id IS NOT DISTINCT FROM app_current_branch())
    OR app_current_branch() IS NULL   -- login lookup, before context is known
  );
CREATE POLICY users_write ON users FOR ALL
  USING (app_is_super_admin())
  WITH CHECK (app_is_super_admin());

-- ── RBAC: permissions, roles, and their links ───────────────────────────────
-- Permissions are a fixed catalog (seeded below). Roles are named permission
-- sets; role_permissions is the toggle grid. user_roles assigns roles to staff.

CREATE TABLE permissions (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key     text NOT NULL UNIQUE,     -- e.g. 'orders.create'
  module  text NOT NULL,            -- e.g. 'Orders'
  label   text NOT NULL
);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   uuid REFERENCES branches(id) ON DELETE CASCADE, -- NULL = global role
  name        text NOT NULL,
  is_system   boolean NOT NULL DEFAULT false, -- built-in roles can't be deleted
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, name)
);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id  uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id  uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

-- RBAC tables are managed by super-admin (and read to resolve a user's
-- effective permissions). Keep them readable within context, writable by
-- super-admin. permissions is a global catalog readable by any authenticated
-- context.
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY permissions_read ON permissions FOR SELECT USING (true);
CREATE POLICY permissions_write ON permissions FOR ALL
  USING (app_is_super_admin()) WITH CHECK (app_is_super_admin());

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_select ON roles FOR SELECT
  USING (app_is_super_admin() OR branch_id IS NULL OR branch_id = app_current_branch());
CREATE POLICY roles_write ON roles FOR ALL
  USING (app_is_super_admin()) WITH CHECK (app_is_super_admin());

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY role_permissions_select ON role_permissions FOR SELECT USING (true);
CREATE POLICY role_permissions_write ON role_permissions FOR ALL
  USING (app_is_super_admin()) WITH CHECK (app_is_super_admin());

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY user_roles_select ON user_roles FOR SELECT USING (true);
CREATE POLICY user_roles_write ON user_roles FOR ALL
  USING (app_is_super_admin()) WITH CHECK (app_is_super_admin());
