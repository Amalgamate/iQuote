CREATE TABLE "InvoiceReconciliation" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorName" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "previousAmountPaid" DECIMAL(14,2) NOT NULL,
  "previousBalanceDue" DECIMAL(14,2) NOT NULL,
  "correctedAmountPaid" DECIMAL(14,2) NOT NULL,
  "correctedBalanceDue" DECIMAL(14,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvoiceReconciliation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InvoiceReconciliation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "InvoiceReconciliation_organisationId_createdAt_idx" ON "InvoiceReconciliation"("organisationId", "createdAt");
CREATE INDEX "InvoiceReconciliation_invoiceId_createdAt_idx" ON "InvoiceReconciliation"("invoiceId", "createdAt");
