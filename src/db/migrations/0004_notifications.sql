-- ============================================================================
-- 0004_notifications
-- In-app notifications for staff + an audit log of customer emails.
-- Both branch-scoped under the standard RLS policy.
-- ============================================================================

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,  -- recipient; NULL = whole branch
  type        text NOT NULL,           -- 'booking_request' | 'exception' | ...
  order_id    uuid REFERENCES orders(id) ON DELETE CASCADE,
  message     text NOT NULL,
  is_read     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_branch_idx ON notifications(branch_id);
CREATE INDEX notifications_user_unread_idx ON notifications(user_id, is_read);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_all ON notifications FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

CREATE TABLE email_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id    uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  order_id     uuid REFERENCES orders(id) ON DELETE SET NULL,
  customer_id  uuid REFERENCES customers(id) ON DELETE SET NULL,
  to_email     text NOT NULL,
  template     text NOT NULL,          -- 'order_confirmed' | 'delivered' | ...
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','sent','failed','bounced')),
  provider_id  text,                   -- id returned by the email provider
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_log_branch_idx ON email_log(branch_id);
CREATE INDEX email_log_order_idx ON email_log(order_id);

ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_log FORCE ROW LEVEL SECURITY;
CREATE POLICY email_log_all ON email_log FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));
