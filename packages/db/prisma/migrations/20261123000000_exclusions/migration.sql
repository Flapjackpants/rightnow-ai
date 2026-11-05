-- Customer and region exclusions (P9-T03)
ALTER TYPE "SuppressionReason" ADD VALUE 'CUSTOMER';
ALTER TABLE "Lead" ADD COLUMN "region" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "excludedCountries" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "excludedRegions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
