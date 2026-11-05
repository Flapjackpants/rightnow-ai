ALTER TABLE "Workspace" ADD COLUMN "crmSyncConfigEnc" TEXT, ADD COLUMN "crmSyncLastRunAt" TIMESTAMP(3), ADD COLUMN "crmSyncLastError" TEXT, ADD COLUMN "crmSyncLastErrorAt" TIMESTAMP(3), ADD COLUMN "crmCustomersPulledAt" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN "crmSyncedAt" TIMESTAMP(3);
ALTER TABLE "Opportunity" ADD COLUMN "crmSyncedAt" TIMESTAMP(3);
