-- ============================================================================
-- 0008_customer_business_fields
-- Additional customer fields requested by the client: company name, NTN
-- (Pakistan National Tax Number), and address. All optional — staff fill what
-- they have; name/email/phone remain the required core.
-- ============================================================================

ALTER TABLE customers
  ADD COLUMN company_name text,
  ADD COLUMN ntn          text,
  ADD COLUMN address      text;
