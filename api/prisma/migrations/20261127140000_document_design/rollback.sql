-- Rollback for 20261127140000_document_design.
--
-- DESTRUCTIVE: this drops the stored design and every frozen snapshot. Running it after the
-- settings screen has been used loses that data; the app falls back to the default design and to
-- the live branding, so documents still render, but they will not match what customers received.
-- Take a backup first: scripts/backup-db.sh, or the procedure in docs/DOCUMENT_DESIGN_PLAN.md.
--
-- Run only after the previous application version is deployed, because the current version's
-- Prisma client selects these columns and will fail without them.

ALTER TABLE "ReceiptDelivery"
  DROP COLUMN IF EXISTS "attachmentError",
  DROP COLUMN IF EXISTS "pdfBytes",
  DROP COLUMN IF EXISTS "attachedPdf";

ALTER TABLE "QuoteDelivery"
  DROP COLUMN IF EXISTS "attachmentError",
  DROP COLUMN IF EXISTS "pdfBytes",
  DROP COLUMN IF EXISTS "attachedPdf";

ALTER TABLE "Payment"
  DROP COLUMN IF EXISTS "designSnapshot";

ALTER TABLE "Invoice"
  DROP COLUMN IF EXISTS "designSnapshot";

ALTER TABLE "Quote"
  DROP COLUMN IF EXISTS "designSnapshot";

ALTER TABLE "Organisation"
  DROP COLUMN IF EXISTS "address",
  DROP COLUMN IF EXISTS "vatNumber",
  DROP COLUMN IF EXISTS "kraPin",
  DROP COLUMN IF EXISTS "documentDesign";

-- Mark the migration as unapplied so `prisma migrate deploy` can run it again.
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261127140000_document_design';
