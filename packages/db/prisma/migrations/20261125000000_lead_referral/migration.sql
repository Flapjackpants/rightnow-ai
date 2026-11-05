ALTER TABLE "Lead" ADD COLUMN "referredById" TEXT;
CREATE INDEX "Lead_referredById_idx" ON "Lead"("referredById");
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
