ALTER TABLE "Job"
  ADD COLUMN "progressTokenHash" TEXT,
  ADD COLUMN "progressEnabledAt" TIMESTAMP(3);
ALTER TABLE "JobMilestone" ADD COLUMN "customerVisible" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "Job_progressTokenHash_key" ON "Job"("progressTokenHash");
