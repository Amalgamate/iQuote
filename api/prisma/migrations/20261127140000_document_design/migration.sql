-- Document design settings and frozen design snapshots (docs/DOCUMENT_DESIGN_PLAN.md, Phase 1).
--
-- Additive only. Every column is nullable or has a default, so existing rows stay valid and the
-- previous application version keeps working after this runs. No backfill is needed:
--   * Organisation.documentDesign = NULL means "never saved"; readers fall back to the default design.
--   * designSnapshot = NULL means "not yet sent"; renders of unsent documents use the live design.
-- Rollback: prisma/migrations/20261127140000_document_design/rollback.sql

-- AlterTable
ALTER TABLE "Organisation"
  ADD COLUMN "documentDesign" JSONB,
  ADD COLUMN "kraPin" TEXT,
  ADD COLUMN "vatNumber" TEXT,
  ADD COLUMN "address" TEXT;

-- AlterTable
ALTER TABLE "Quote"
  ADD COLUMN "designSnapshot" JSONB;

-- AlterTable
ALTER TABLE "Invoice"
  ADD COLUMN "designSnapshot" JSONB;

-- AlterTable
ALTER TABLE "Payment"
  ADD COLUMN "designSnapshot" JSONB;

-- AlterTable
ALTER TABLE "QuoteDelivery"
  ADD COLUMN "attachedPdf" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pdfBytes" INTEGER,
  ADD COLUMN "attachmentError" TEXT;

-- AlterTable
ALTER TABLE "ReceiptDelivery"
  ADD COLUMN "attachedPdf" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pdfBytes" INTEGER,
  ADD COLUMN "attachmentError" TEXT;
