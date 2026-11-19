-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'SENT', 'VIEWED', 'APPROVED', 'DECLINED', 'EXPIRED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "organisationId" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organisation" (
    "id" TEXT NOT NULL,
    "subdomain" TEXT,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "country" TEXT,
    "businessType" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "defaultTaxRate" DECIMAL(5,2),
    "quotePrefix" TEXT,
    "logoUrl" TEXT,
    "paymentInstructions" TEXT,
    "terms" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ownerId" TEXT NOT NULL,

    CONSTRAINT "Organisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantEmailSettings" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'PLATFORM',
    "resendApiKeyCiphertext" TEXT,
    "senderName" TEXT,
    "senderEmail" TEXT,
    "customDomain" TEXT,
    "domainStatus" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "domainRecords" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantEmailSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignupVerification" (
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignupVerification_pkey" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'STARTER',
    "status" TEXT NOT NULL DEFAULT 'TRIALING',
    "billingInterval" TEXT NOT NULL DEFAULT 'MONTHLY',
    "trialStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trialEndsAt" TIMESTAMP(3) NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceItem" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'SERVICE',
    "description" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'job',
    "defaultPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "defaultTaxRate" DECIMAL(5,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isStarter" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteTemplate" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "workflow" TEXT NOT NULL,
    "lineItems" JSONB NOT NULL,
    "defaultNotes" TEXT,
    "defaultTerms" TEXT,
    "isStarter" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuoteTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "publicToken" TEXT,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL,
    "validUntil" TIMESTAMP(3),
    "notes" TEXT,
    "terms" TEXT,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "viewedAt" TIMESTAMP(3),
    "decisionComment" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLine" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'unit',
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "taxRate" DECIMAL(5,2),
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QuoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteSequence" (
    "organisationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QuoteSequence_pkey" PRIMARY KEY ("organisationId","year")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Organisation_subdomain_key" ON "Organisation"("subdomain");

-- CreateIndex
CREATE UNIQUE INDEX "Organisation_ownerId_key" ON "Organisation"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantEmailSettings_organisationId_key" ON "TenantEmailSettings"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_organisationId_key" ON "Subscription"("organisationId");

-- CreateIndex
CREATE INDEX "ServiceItem_organisationId_active_category_idx" ON "ServiceItem"("organisationId", "active", "category");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceItem_organisationId_category_name_key" ON "ServiceItem"("organisationId", "category", "name");

-- CreateIndex
CREATE INDEX "QuoteTemplate_organisationId_workflow_idx" ON "QuoteTemplate"("organisationId", "workflow");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteTemplate_organisationId_name_key" ON "QuoteTemplate"("organisationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Customer_organisationId_updatedAt_idx" ON "Customer"("organisationId", "updatedAt");

-- CreateIndex
CREATE INDEX "Customer_ownerId_updatedAt_idx" ON "Customer"("ownerId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_publicToken_key" ON "Quote"("publicToken");

-- CreateIndex
CREATE INDEX "Quote_ownerId_updatedAt_idx" ON "Quote"("ownerId", "updatedAt");

-- CreateIndex
CREATE INDEX "Quote_organisationId_status_updatedAt_idx" ON "Quote"("organisationId", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_organisationId_documentNumber_key" ON "Quote"("organisationId", "documentNumber");

-- CreateIndex
CREATE INDEX "QuoteLine_quoteId_position_idx" ON "QuoteLine"("quoteId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "LoginAttempt_key_key" ON "LoginAttempt"("key");

-- CreateIndex
CREATE INDEX "LoginAttempt_lockedUntil_idx" ON "LoginAttempt"("lockedUntil");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Organisation" ADD CONSTRAINT "Organisation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantEmailSettings" ADD CONSTRAINT "TenantEmailSettings_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceItem" ADD CONSTRAINT "ServiceItem_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteTemplate" ADD CONSTRAINT "QuoteTemplate_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteSequence" ADD CONSTRAINT "QuoteSequence_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

