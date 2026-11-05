ALTER TABLE "Workspace" ADD COLUMN "apolloConfigEnc" TEXT;

CREATE TABLE "LeadSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "filters" JSONB NOT NULL,
    "listId" TEXT NOT NULL,
    "campaignId" TEXT,
    "lawfulBasis" TEXT NOT NULL,
    "dailyCreditCap" INTEGER NOT NULL DEFAULT 25,
    "nextPage" INTEGER NOT NULL DEFAULT 1,
    "creditDay" DATE,
    "creditsUsed" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LeadSource_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "LeadSourceSeen" (
    "workspaceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeadSourceSeen_pkey" PRIMARY KEY ("workspaceId", "externalId")
);
CREATE UNIQUE INDEX "LeadSource_workspaceId_name_key" ON "LeadSource"("workspaceId", "name");
CREATE INDEX "LeadSource_enabled_lastRunAt_idx" ON "LeadSource"("enabled", "lastRunAt");
ALTER TABLE "LeadSource" ADD CONSTRAINT "LeadSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadSource" ADD CONSTRAINT "LeadSource_listId_fkey" FOREIGN KEY ("listId") REFERENCES "LeadList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadSourceSeen" ADD CONSTRAINT "LeadSourceSeen_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
