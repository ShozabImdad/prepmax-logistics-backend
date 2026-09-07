-- Allow negative unit_price on invoice line items so debit invoices can
-- carry an explicit deduction/adjustment line (orders total ± adjustment).
ALTER TABLE invoice_items DROP CONSTRAINT IF EXISTS invoice_items_unit_price_check;
