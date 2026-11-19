ALTER TABLE "Organisation"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "suspendedAt" TIMESTAMP(3),
  ADD COLUMN "suspendedByEmail" TEXT,
  ADD COLUMN "suspensionReason" TEXT,
  ADD COLUMN "restoredAt" TIMESTAMP(3),
  ADD COLUMN "restoredByEmail" TEXT;
