ALTER TABLE "User" ADD COLUMN "mfaEnabledAt" TIMESTAMP(3);
UPDATE "User" SET "mfaEnabledAt" = CURRENT_TIMESTAMP WHERE "mfaEnabled" = TRUE;
UPDATE "Session" SET "mfaVerifiedAt" = NULL WHERE "userId" IN (SELECT "id" FROM "User" WHERE "role" = 'SUPERADMIN');
