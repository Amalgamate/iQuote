ALTER TABLE "Quote" ADD COLUMN "publishedVersionId" TEXT;

-- Preserve existing customer URLs while resolving them to the newest sent revision.
WITH RECURSIVE lineage AS (
  SELECT q."id" AS root_id, q."id", q."parentQuoteId", q."version", q."status"
  FROM "Quote" q
  WHERE q."parentQuoteId" IS NULL AND q."publicToken" IS NOT NULL
  UNION ALL
  SELECT lineage.root_id, child."id", child."parentQuoteId", child."version", child."status"
  FROM "Quote" child
  JOIN lineage ON child."parentQuoteId" = lineage."id"
), latest_published AS (
  SELECT DISTINCT ON (root_id) root_id, id
  FROM lineage
  WHERE "status" <> 'DRAFT'
  ORDER BY root_id, version DESC, id DESC
)
UPDATE "Quote" root
SET "publishedVersionId" = latest_published.id
FROM latest_published
WHERE root."id" = latest_published.root_id;

UPDATE "Quote"
SET "publishedVersionId" = "id"
WHERE "parentQuoteId" IS NULL
  AND "publicToken" IS NOT NULL
  AND "publishedVersionId" IS NULL;
