-- ============================================================================
-- 0035_one_manager_per_branch
--
-- Strict 1:1 rule: a branch may have at most one user holding the global
-- "Branch Manager" RBAC role (roles.branch_id IS NULL, name = 'Branch
-- Manager') at any time. This is the RBAC role that grants real manager
-- permissions via user_roles — NOT the users.role scoping column, which is
-- unrelated to this rule and is left untouched by this migration.
--
-- Enforced at the app level in accounts/routes.ts POST /managers and
-- staff/routes.ts POST /:publicId/roles (checked before insert), and
-- backstopped here with a trigger so the rule holds even against a race
-- between two concurrent requests, or any future code path that inserts
-- into user_roles directly. A plain partial unique index isn't possible
-- here since the branch lives on users.branch_id, not on user_roles itself,
-- so a trigger is used instead.
--
-- Safe to re-run: DROP ... IF EXISTS guards it.
-- ============================================================================

CREATE OR REPLACE FUNCTION enforce_one_branch_manager_per_branch()
RETURNS trigger AS $$
DECLARE
  v_role_name   text;
  v_role_branch uuid;
  v_user_branch uuid;
  v_conflict    uuid;
BEGIN
  SELECT name, branch_id INTO v_role_name, v_role_branch
    FROM roles WHERE id = NEW.role_id;

  -- Only restrict the global "Branch Manager" role — custom/branch-scoped
  -- roles and every other global role are unaffected.
  IF v_role_name IS DISTINCT FROM 'Branch Manager' OR v_role_branch IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT branch_id INTO v_user_branch FROM users WHERE id = NEW.user_id;
  IF v_user_branch IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT ur.user_id INTO v_conflict
    FROM user_roles ur
    JOIN users u ON u.id = ur.user_id
   WHERE ur.role_id = NEW.role_id
     AND u.branch_id = v_user_branch
     AND ur.user_id != NEW.user_id
   LIMIT 1;

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'Branch already has a Branch Manager assigned'
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_one_branch_manager_per_branch ON user_roles;
CREATE TRIGGER trg_one_branch_manager_per_branch
  BEFORE INSERT OR UPDATE ON user_roles
  FOR EACH ROW
  EXECUTE FUNCTION enforce_one_branch_manager_per_branch();