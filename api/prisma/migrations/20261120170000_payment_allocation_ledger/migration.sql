CREATE TABLE "PaymentAllocation" (
  "id" TEXT NOT NULL,
  "organisationId" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "currency" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentAllocation_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PaymentAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PaymentAllocation_idempotencyKey_key" ON "PaymentAllocation"("idempotencyKey");
CREATE INDEX "PaymentAllocation_invoiceId_createdAt_idx" ON "PaymentAllocation"("invoiceId", "createdAt");
CREATE INDEX "PaymentAllocation_paymentId_createdAt_idx" ON "PaymentAllocation"("paymentId", "createdAt");
CREATE INDEX "PaymentAllocation_organisationId_createdAt_idx" ON "PaymentAllocation"("organisationId", "createdAt");

INSERT INTO "PaymentAllocation" ("id", "organisationId", "invoiceId", "paymentId", "eventType", "amount", "currency", "idempotencyKey", "reason", "actorId", "actorName", "createdAt")
SELECT 'allocation_' || p."id", p."organisationId", p."invoiceId", p."id", 'ALLOCATE', p."amount", p."currency", 'opening-allocation:' || p."id", 'Opening allocation migrated from the original invoice payment.', p."receivedBy", COALESCE(u."name", 'Existing team member'), p."createdAt"
FROM "Payment" p LEFT JOIN "User" u ON u."id" = p."receivedBy";
