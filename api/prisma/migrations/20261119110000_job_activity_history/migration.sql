CREATE TABLE "JobActivity" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorName" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobActivity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "JobActivity_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "JobActivity_jobId_createdAt_idx" ON "JobActivity"("jobId", "createdAt");

INSERT INTO "JobActivity" ("id", "jobId", "actorId", "actorName", "action", "details", "createdAt")
SELECT md5(random()::text || clock_timestamp()::text), j."id", j."ownerId", u."name",
       'JOB_HISTORY_BASELINE', jsonb_build_object('title', j."title", 'status', j."status"), j."createdAt"
FROM "Job" j JOIN "User" u ON u."id" = j."ownerId";
