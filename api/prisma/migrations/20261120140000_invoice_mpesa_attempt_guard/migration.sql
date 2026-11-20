-- Prevent concurrent invoice requests from producing multiple unresolved STK prompts.
-- A pending, unknown, or review-required attempt must first be reconciled.
CREATE UNIQUE INDEX "InvoicePaymentAttempt_one_unresolved_per_invoice_key"
ON "InvoicePaymentAttempt" ("invoiceId")
WHERE "status" IN ('PENDING', 'UNKNOWN', 'REVIEW');
