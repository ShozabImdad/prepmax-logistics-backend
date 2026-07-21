-- ============================================================================
-- 0021_credit_note_invoice_link
--
-- Credit notes are stored as invoices with is_credit_note = true, but until
-- now had no link back to the invoice they're meant to offset — you could
-- see a debit and a credit for the same customer around the same time and
-- have to guess whether they were related.
--
-- Adds an optional referenced_invoice_id: nullable, since some credit notes
-- are general goodwill adjustments not tied to one specific invoice.
-- ============================================================================

ALTER TABLE invoices
  ADD COLUMN referenced_invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL;

CREATE INDEX invoices_referenced_invoice_idx ON invoices(referenced_invoice_id);
