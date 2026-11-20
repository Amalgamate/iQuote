-- Deposit rules: track required deposit amount and deposit-paid total on invoices
ALTER TABLE "Invoice" ADD COLUMN "depositRequired" DECIMAL(14,2);
ALTER TABLE "Invoice" ADD COLUMN "depositPaid" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN "sentAt" TIMESTAMP(3);

-- Deposit flag on payments
ALTER TABLE "Payment" ADD COLUMN "isDeposit" BOOLEAN NOT NULL DEFAULT false;

-- Receipt delivery tracking (email delivery of payment receipts to customers)
CREATE TABLE "ReceiptDelivery" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "recipientName" TEXT,
    "providerMessageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReceiptDelivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReceiptDelivery_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReceiptDelivery_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ReceiptDelivery_paymentId_createdAt_idx" ON "ReceiptDelivery"("paymentId", "createdAt");
CREATE INDEX "ReceiptDelivery_status_idx" ON "ReceiptDelivery"("status");
CREATE INDEX "ReceiptDelivery_organisationId_createdAt_idx" ON "ReceiptDelivery"("organisationId", "createdAt");
