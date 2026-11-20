CREATE TABLE "TenantPaymentSettings" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'NCBA',
  "merchantType" TEXT NOT NULL DEFAULT 'TILL',
  "tillNumber" TEXT,
  "paybillNumber" TEXT,
  "stkUsernameCiphertext" TEXT,
  "stkSecretCiphertext" TEXT,
  "notificationUsernameCiphertext" TEXT,
  "notificationPasswordCiphertext" TEXT,
  "notificationSecretCiphertext" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TenantPaymentSettings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantPaymentSettings_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TenantPaymentSettings_organisationId_key" ON "TenantPaymentSettings"("organisationId");
CREATE TABLE "InvoicePaymentAttempt" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'NCBA',
  "merchantType" TEXT NOT NULL DEFAULT 'TILL',
  "merchantCode" TEXT NOT NULL,
  "invoiceNumber" TEXT NOT NULL,
  "transactionId" TEXT,
  "providerReference" TEXT,
  "phone" TEXT NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'KES',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "statusDescription" TEXT,
  "gatewayUsernameCiphertext" TEXT NOT NULL,
  "gatewaySecretCiphertext" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "InvoicePaymentAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InvoicePaymentAttempt_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "InvoicePaymentAttempt_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "InvoicePaymentAttempt_idempotencyKey_key" ON "InvoicePaymentAttempt"("idempotencyKey");
CREATE UNIQUE INDEX "InvoicePaymentAttempt_transactionId_key" ON "InvoicePaymentAttempt"("transactionId");
CREATE INDEX "InvoicePaymentAttempt_organisationId_status_createdAt_idx" ON "InvoicePaymentAttempt"("organisationId", "status", "createdAt");
CREATE INDEX "InvoicePaymentAttempt_invoiceId_createdAt_idx" ON "InvoicePaymentAttempt"("invoiceId", "createdAt");
