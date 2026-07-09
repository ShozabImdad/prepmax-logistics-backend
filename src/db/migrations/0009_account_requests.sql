-- ============================================================================
-- 0009_account_requests
-- Public "Request an Account" submissions from the marketing site. A prospect
-- doesn't belong to a branch yet (staff decide that when they create the real
-- account), so this is a GLOBAL table — not branch-scoped.
--
-- Any authenticated staff member may read/manage requests; the public insert
-- path uses a trusted server context (the public route runs as super-admin,
-- like public tracking). RLS keeps it readable only to staff contexts.
-- ============================================================================

CREATE TABLE account_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id     text NOT NULL UNIQUE,
  full_name     text NOT NULL,
  company_name  text,
  email         text NOT NULL,
  phone         text NOT NULL,
  message       text,
  status        text NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','contacted','converted','rejected')),
  handled_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_requests_status_idx ON account_requests(status);
CREATE TRIGGER account_requests_updated_at BEFORE UPDATE ON account_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Readable/writable only within a staff (super-admin) context. The public
-- insert route sets super-admin context server-side; branch managers and
-- super-admins reading the queue also pass. Not visible to customer contexts.
ALTER TABLE account_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY account_requests_staff ON account_requests FOR ALL
  USING (app_is_super_admin())
  WITH CHECK (app_is_super_admin());
