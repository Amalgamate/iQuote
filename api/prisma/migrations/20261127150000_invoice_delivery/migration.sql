-- Persist invoice email delivery and PDF attachment outcomes per attempt.
CREATE TABLE "InvoiceDelivery" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "recipientEmail" TEXT NOT NULL,
  "recipientName" TEXT,
  "providerMessageId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "errorMessage" TEXT,
  "attachedPdf" BOOLEAN NOT NULL DEFAULT false,
  "pdfBytes" INTEGER,
  "attachmentError" TEXT,
  "sentAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "bouncedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvoiceDelivery_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InvoiceDelivery_invoiceId_createdAt_idx" ON "InvoiceDelivery"("invoiceId", "createdAt");
CREATE INDEX "InvoiceDelivery_invoiceId_status_createdAt_idx" ON "InvoiceDelivery"("invoiceId", "status", "createdAt");
CREATE INDEX "InvoiceDelivery_status_idx" ON "InvoiceDelivery"("status");
CREATE INDEX "InvoiceDelivery_organisationId_createdAt_idx" ON "InvoiceDelivery"("organisationId", "createdAt");
ALTER TABLE "InvoiceDelivery" ADD CONSTRAINT "InvoiceDelivery_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvoiceDelivery" ADD CONSTRAINT "InvoiceDelivery_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
