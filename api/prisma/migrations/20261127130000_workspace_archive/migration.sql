ALTER TABLE "Organisation"
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "archivedByEmail" TEXT,
  ADD COLUMN "archiveReason" TEXT,
  ADD COLUMN "statusBeforeArchive" TEXT,
  ADD COLUMN "unarchivedAt" TIMESTAMP(3),
  ADD COLUMN "unarchivedByEmail" TEXT;

CREATE INDEX "Organisation_status_archivedAt_idx" ON "Organisation"("status", "archivedAt");
