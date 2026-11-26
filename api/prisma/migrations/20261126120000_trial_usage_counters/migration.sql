ALTER TABLE "Subscription"
  ADD COLUMN "trialQuotesUsed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "trialInvoicesUsed" INTEGER NOT NULL DEFAULT 0;

-- Preserve existing trial usage and prevent deletion of old documents from
-- reopening trial slots after this migration.
UPDATE "Subscription" AS s
SET "trialQuotesUsed" = COALESCE((
      SELECT COUNT(*)::INTEGER
      FROM "Quote" AS q
      WHERE q."organisationId" = s."organisationId"
    ), 0),
    "trialInvoicesUsed" = COALESCE((
      SELECT COUNT(*)::INTEGER
      FROM "Invoice" AS i
      WHERE i."organisationId" = s."organisationId"
    ), 0)
WHERE s."status" = 'TRIALING';
