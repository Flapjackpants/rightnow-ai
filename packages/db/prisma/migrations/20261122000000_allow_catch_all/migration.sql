-- Catch-all addresses can be emailed without also allowing risky ones
ALTER TABLE "Campaign" ADD COLUMN     "allowCatchAll" BOOLEAN NOT NULL DEFAULT false;

-- Existing campaigns keep their old behaviour: allowRisky also allowed catch-all.
UPDATE "Campaign" SET "allowCatchAll" = "allowRisky";
