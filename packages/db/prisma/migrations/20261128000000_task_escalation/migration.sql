ALTER TYPE "EventType" ADD VALUE 'ESCALATION_OVERDUE';
ALTER TABLE "Task" ADD COLUMN "escalateAfterHours" INTEGER,
ADD COLUMN "escalationAlerts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "nextEscalationAt" TIMESTAMP(3);
CREATE INDEX "Task_nextEscalationAt_idx" ON "Task"("nextEscalationAt");
