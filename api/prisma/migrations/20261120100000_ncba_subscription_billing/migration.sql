ALTER TABLE "Subscription"
ADD COLUMN "currentPeriodEndsAt" TIMESTAMP(3);

CREATE TABLE "BillingPayment" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "phone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "transactionId" TEXT,
    "providerReference" TEXT,
    "statusDescription" TEXT,
    "paidAt" TIMESTAMP(3),
    "periodEndsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BillingPayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingPayment_idempotencyKey_key" ON "BillingPayment"("idempotencyKey");
CREATE UNIQUE INDEX "BillingPayment_transactionId_key" ON "BillingPayment"("transactionId");
CREATE INDEX "BillingPayment_organisationId_createdAt_idx" ON "BillingPayment"("organisationId", "createdAt");
CREATE INDEX "BillingPayment_status_createdAt_idx" ON "BillingPayment"("status", "createdAt");
CREATE UNIQUE INDEX "BillingPayment_one_pending_per_org_key" ON "BillingPayment"("organisationId") WHERE "status" = 'PENDING';

ALTER TABLE "BillingPayment"
ADD CONSTRAINT "BillingPayment_organisationId_fkey"
FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
