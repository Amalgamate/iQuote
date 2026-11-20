CREATE TABLE "JobAttachment" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "originalFilename" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "uploadedBy" TEXT NOT NULL,
  "uploaderName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobAttachment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "JobAttachment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "JobAttachment_storageKey_key" ON "JobAttachment"("storageKey");
CREATE INDEX "JobAttachment_jobId_createdAt_idx" ON "JobAttachment"("jobId", "createdAt");
