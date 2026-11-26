-- AlterTable
-- The "website" column was added to schema.prisma without a migration, so a database
-- built from migrations alone (CI, a fresh production install) was missing it.
-- IF NOT EXISTS keeps this safe for databases where it was added by hand.
ALTER TABLE "Organisation" ADD COLUMN IF NOT EXISTS "website" TEXT;
