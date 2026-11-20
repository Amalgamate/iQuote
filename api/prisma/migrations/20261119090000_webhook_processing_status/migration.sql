ALTER TABLE "WebhookEvent"
  ADD COLUMN "processingStatus" TEXT NOT NULL DEFAULT 'RECEIVED',
  ADD COLUMN "processingError" TEXT,
  ADD COLUMN "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "WebhookEvent" SET "processingStatus" = 'PROCESSED';

ALTER TABLE "WebhookEvent"
  ALTER COLUMN "processedAt" DROP NOT NULL,
  ALTER COLUMN "processedAt" DROP DEFAULT;

UPDATE "WebhookEvent" SET "receivedAt" = "processedAt";

CREATE INDEX "WebhookEvent_processingStatus_receivedAt_idx"
  ON "WebhookEvent"("processingStatus", "receivedAt");
