-- ============================================================================
-- 0024_saved_contacts
-- Reusable sender/receiver address book, so OrderForm doesn't need to be
-- filled out from scratch every time. Mirrors the exact contact shape already
-- used on orders (sender_*/receiver_* columns from 0003 + 0010).
--
-- Two ownership modes, distinguished by which owner column is set:
--   - owner_customer_id set  -> belongs to that customer's own portal address
--     book (only they can see/use it).
--   - created_by_user_id set (owner_customer_id NULL) -> a branch-wide
--     contact saved by staff, reusable by any staff at that branch (e.g. a
--     frequent receiver).
-- Exactly one of the two is set; enforced by a CHECK constraint.
-- branch_id is denormalized per the project's standard RLS pattern.
-- ============================================================================

CREATE TABLE saved_contacts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id          text NOT NULL UNIQUE,
  branch_id          uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,

  owner_customer_id   uuid REFERENCES customers(id) ON DELETE CASCADE,
  created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT saved_contacts_owner_xor CHECK (
    (owner_customer_id IS NOT NULL AND created_by_user_id IS NULL)
    OR (owner_customer_id IS NULL)
  ),

  -- sender | receiver | both — which OrderForm section(s) this contact can
  -- fill. "both" covers contacts equally likely to be either party.
  kind        text NOT NULL DEFAULT 'both' CHECK (kind IN ('sender', 'receiver', 'both')),
  label       text NOT NULL,   -- user-chosen nickname, e.g. "Main Warehouse", "Home"

  name        text NOT NULL,
  company     text,
  phone       text,
  email       text,
  cnic        text,
  ntn         text,
  address     text,
  address2    text,
  city        text,
  state       text,
  country     text,
  postcode    text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX saved_contacts_branch_idx ON saved_contacts(branch_id);
CREATE INDEX saved_contacts_owner_customer_idx ON saved_contacts(owner_customer_id);

CREATE TRIGGER saved_contacts_updated_at BEFORE UPDATE ON saved_contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE saved_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY saved_contacts_all ON saved_contacts FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));
