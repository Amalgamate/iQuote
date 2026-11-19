CREATE TABLE "SuperadminAuditEvent" (
  "id" TEXT NOT NULL,
  "actorId" TEXT,
  "actorEmail" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT,
  "summary" TEXT NOT NULL,
  "metadata" JSONB,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SuperadminAuditEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SuperadminAuditEvent_createdAt_idx" ON "SuperadminAuditEvent"("createdAt");
CREATE INDEX "SuperadminAuditEvent_action_createdAt_idx" ON "SuperadminAuditEvent"("action", "createdAt");
CREATE INDEX "SuperadminAuditEvent_targetType_targetId_createdAt_idx" ON "SuperadminAuditEvent"("targetType", "targetId", "createdAt");
