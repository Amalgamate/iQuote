CREATE TABLE "PlatformNcbaConfig" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "stkUsernameCiphertext" TEXT,
    "stkSecretCiphertext" TEXT,
    "paybillNumber" TEXT,
    "tillAccountNumber" TEXT,
    "updatedByEmail" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformNcbaConfig_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Invoice" ADD COLUMN "sourceQuoteId" TEXT,
ADD COLUMN "lineItems" JSONB;

CREATE UNIQUE INDEX "Invoice_sourceQuoteId_key" ON "Invoice"("sourceQuoteId");

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_sourceQuoteId_fkey"
FOREIGN KEY ("sourceQuoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
