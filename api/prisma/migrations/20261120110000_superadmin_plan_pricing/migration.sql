CREATE TABLE "PlatformPlanPrice" (
    "plan" TEXT NOT NULL,
    "amount" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "updatedByEmail" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformPlanPrice_pkey" PRIMARY KEY ("plan")
);
