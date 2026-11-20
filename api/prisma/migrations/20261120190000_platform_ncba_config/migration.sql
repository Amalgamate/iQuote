CREATE TABLE "PlatformNcbaConfig" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "stkUsernameCiphertext" TEXT,
    "stkSecretCiphertext" TEXT,
    "paybillNumber" TEXT,
    "tillAccountNumber" TEXT,
    "updatedByEmail" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformNcbaConfig_pkey" PRIMARY KEY ("id")
);
