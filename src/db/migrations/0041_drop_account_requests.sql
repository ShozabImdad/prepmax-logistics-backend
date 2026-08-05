-- Drop the account_requests module entirely.
-- Customers are now created exclusively by staff via POST /api/accounts/customers.
-- No public self-registration or request queue exists.

DROP TABLE IF EXISTS account_requests;
