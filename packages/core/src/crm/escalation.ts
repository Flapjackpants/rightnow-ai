import type { PrismaClient } from "@rightnow/db/client";
import { audit } from "../audit";
import type { Clock } from "../clock";
import { recordEvent } from "../mail/events";

const MAX_ALERTS = 3;
const BATCH = 200;
const HOUR = 3_600_000;

/** Claims each due task once, then either closes it on a direct answer or records its next alert. */
export async function runEscalationCheck(
  prisma: PrismaClient,
  clock: Clock,
  signal?: AbortSignal,
): Promise<{ alerted: number; closed: number }> {
  const now = clock.now();
  const due = await prisma.task.findMany({
    where: { status: "OPEN", escalateAfterHours: { not: null }, nextEscalationAt: { lte: now } },
    orderBy: [{ nextEscalationAt: "asc" }, { id: "asc" }],
    take: BATCH,
  });
  const result = { alerted: 0, closed: 0 };
  for (const task of due) {
    if (signal?.aborted) break;
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        const lead = task.leadId
          ? await tx.lead.findFirst({
              where: { id: task.leadId, workspaceId: task.workspaceId },
              select: { email: true },
            })
          : null;
        const answer = lead
          ? await tx.message.findFirst({
              where: {
                workspaceId: task.workspaceId,
                leadId: task.leadId,
                direction: "OUT",
                scheduledMessageId: null,
                sentAt: { gte: task.createdAt },
                to: { has: lead.email },
              },
              select: { id: true },
            })
          : null;
        const n = task.escalationAlerts + 1;
        const claimed = await tx.task.updateMany({
          where: {
            id: task.id,
            workspaceId: task.workspaceId,
            status: "OPEN",
            nextEscalationAt: task.nextEscalationAt,
          },
          data: answer
            ? { status: "DONE", completedAt: now, nextEscalationAt: null }
            : {
                escalationAlerts: n,
                nextEscalationAt:
                  n >= MAX_ALERTS
                    ? null
                    : new Date(now.getTime() + (task.escalateAfterHours ?? 0) * HOUR),
              },
        });
        if (!claimed.count) return null;
        if (answer) {
          await audit(tx, { workspaceId: task.workspaceId, at: now }, "task.auto_done", task.id, {
            taskId: task.id,
          });
          return "closed";
        }
        const latest = task.leadId
          ? await tx.message.findFirst({
              where: { workspaceId: task.workspaceId, leadId: task.leadId, direction: "IN" },
              orderBy: { sentAt: "desc" },
              select: { id: true },
            })
          : null;
        await recordEvent(tx, {
          workspaceId: task.workspaceId,
          type: "ESCALATION_OVERDUE",
          occurredAt: now,
          leadId: task.leadId,
          messageId: latest?.id ?? null,
          meta: { taskId: task.id, alert: n, assigneeId: task.assigneeId },
          dedupeKey: `escalation:${task.id}:${n}`,
        });
        return "alerted";
      });
      if (outcome) result[outcome]++;
    } catch (error) {
      console.error("escalation_check_failed", { taskId: task.id, error });
    }
  }
  return result;
}
