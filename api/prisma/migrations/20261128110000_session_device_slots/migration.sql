-- Store minimal session device metadata for user device controls.
-- Existing sessions default to desktop and remain usable until expiry/revocation.
ALTER TABLE "Session"
  ADD COLUMN "deviceType" TEXT NOT NULL DEFAULT 'DESKTOP',
  ADD COLUMN "deviceLabel" TEXT,
  ADD COLUMN "ipAddress" TEXT,
  ADD COLUMN "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "Session_userId_deviceType_expiresAt_idx"
  ON "Session"("userId", "deviceType", "expiresAt");
