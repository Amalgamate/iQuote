-- Stage 15: Team membership, invitations, and MFA fields

-- CreateEnum: TeamRole
CREATE TYPE "TeamRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- AlterTable: add teamRole, mfaSecret, mfaEnabled to User
ALTER TABLE "User" ADD COLUMN "teamRole" "TeamRole" NOT NULL DEFAULT 'OWNER';
ALTER TABLE "User" ADD COLUMN "mfaSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "mfaEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: TeamInvitation
CREATE TABLE "TeamInvitation" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "TeamRole" NOT NULL DEFAULT 'MEMBER',
    "token" TEXT NOT NULL,
    "invitedBy" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeamInvitation_token_key" ON "TeamInvitation"("token");
CREATE INDEX "TeamInvitation_organisationId_email_idx" ON "TeamInvitation"("organisationId", "email");
CREATE UNIQUE INDEX "TeamInvitation_organisationId_email_key" ON "TeamInvitation"("organisationId", "email");

-- AddForeignKey
ALTER TABLE "TeamInvitation"
    ADD CONSTRAINT "TeamInvitation_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamInvitation"
    ADD CONSTRAINT "TeamInvitation_invitedBy_fkey"
    FOREIGN KEY ("invitedBy") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
