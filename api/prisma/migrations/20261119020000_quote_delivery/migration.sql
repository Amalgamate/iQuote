-- Migration: quote_delivery
-- Adds QuoteDelivery, WebhookEvent models and token revocation fields on Quote.

-- QuoteDelivery: tracks each email delivery attempt for a quote
CREATE TABLE "QuoteDelivery" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "recipientName" TEXT,
    "message" TEXT,
    "providerMessageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "bouncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteDelivery_pkey" PRIMARY KEY ("id")
);

-- Indexes on QuoteDelivery
CREATE INDEX "QuoteDelivery_quoteId_createdAt_idx" ON "QuoteDelivery"("quoteId", "createdAt");
CREATE INDEX "QuoteDelivery_status_idx" ON "QuoteDelivery"("status");

-- Foreign key: QuoteDelivery.quoteId → Quote.id (cascade on delete)
ALTER TABLE "QuoteDelivery"
  ADD CONSTRAINT "QuoteDelivery_quoteId_fkey"
  FOREIGN KEY ("quoteId") REFERENCES "Quote"("id")
  ON DELETE CASCADE;

-- Add token revocation fields to Quote
ALTER TABLE "Quote" ADD COLUMN "tokenRevokedAt" TIMESTAMP(3);
ALTER TABLE "Quote" ADD COLUMN "tokenRevokedBy" TEXT;

-- WebhookEvent: replay protection for incoming webhooks
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- Unique constraint on eventId for replay protection
CREATE UNIQUE INDEX "WebhookEvent_eventId_key" ON "WebhookEvent"("eventId");
