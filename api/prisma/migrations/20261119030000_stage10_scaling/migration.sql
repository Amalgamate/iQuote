-- Migration: stage10_scaling
-- Adds customer archive, quote versioning/revision, template versioning,
-- and indexes for server-side pagination/search.
-- Rollback: reverse each statement in order.

-- 1. Customer archive: soft delete instead of hard delete
ALTER TABLE "Customer" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Replace old indexes with ones that support archived filtering + name search
DROP INDEX IF EXISTS "Customer_organisationId_updatedAt_idx";
CREATE INDEX "Customer_organisationId_archivedAt_updatedAt_idx" ON "Customer"("organisationId", "archivedAt", "updatedAt");
CREATE INDEX "Customer_organisationId_archivedAt_name_idx" ON "Customer"("organisationId", "archivedAt", "name");

-- 2. Quote versioning: revision tracking and immutability support
ALTER TABLE "Quote" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Quote" ADD COLUMN "parentQuoteId" TEXT;

-- Index for fetching revision history by parent
CREATE INDEX "Quote_parentQuoteId_idx" ON "Quote"("parentQuoteId");

-- Index for paginated list queries (organisation + updatedAt)
CREATE INDEX "Quote_organisationId_updatedAt_idx" ON "Quote"("organisationId", "updatedAt");

-- 3. QuoteTemplate versioning: track edits without overwriting used templates
ALTER TABLE "QuoteTemplate" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
