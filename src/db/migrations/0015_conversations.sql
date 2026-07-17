-- ============================================================================
-- 0015_conversations
-- Threaded conversations on quotes and complaints. A customer files a quote
-- request or complaint; staff respond; the customer can reply back; etc. This
-- migration adds two parallel message tables — quote_messages and
-- complaint_messages — one per parent, so RLS joins stay simple and each
-- parent's messages are isolated by its own branch_id (denormalized, same
-- pattern as complaints.orders_id + branch_id in 0013).
--
-- Each message records who sent it:
--   sender='customer' → author_id = customers.id (the filing customer)
--   sender='staff'    → author_id = users.id (the responding staff member)
-- A CHECK constraint keeps the (sender, author table) pairing honest, and the
-- app always resolves the author's name at read time via a LEFT JOIN.
-- ============================================================================

-- ── quote_messages ──────────────────────────────────────────────────────────
CREATE TABLE quote_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id    text NOT NULL UNIQUE,
  branch_id    uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  quote_id     uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,

  sender       text NOT NULL CHECK (sender IN ('customer','staff')),
  author_id    uuid,                                  -- customers.id OR users.id
  body         text NOT NULL,

  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quote_messages_quote_idx ON quote_messages(quote_id);
CREATE INDEX quote_messages_branch_idx ON quote_messages(branch_id);
CREATE INDEX quote_messages_created_idx ON quote_messages(created_at);

ALTER TABLE quote_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_messages_all ON quote_messages FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- ── complaint_messages ──────────────────────────────────────────────────────
CREATE TABLE complaint_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id     text NOT NULL UNIQUE,
  branch_id     uuid NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  complaint_id  uuid NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,

  sender        text NOT NULL CHECK (sender IN ('customer','staff')),
  author_id     uuid,                                 -- customers.id OR users.id
  body          text NOT NULL,

  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX complaint_messages_complaint_idx ON complaint_messages(complaint_id);
CREATE INDEX complaint_messages_branch_idx ON complaint_messages(branch_id);
CREATE INDEX complaint_messages_created_idx ON complaint_messages(created_at);

ALTER TABLE complaint_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaint_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY complaint_messages_all ON complaint_messages FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));
