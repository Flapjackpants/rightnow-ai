import type { AccountProvider, PrismaClient } from "@rightnow/db/client";
import { LIVE_STATUSES } from "../campaigns/hooks";
import { effectiveAllowance } from "../quota";

/** Days of new-lead sending a campaign backlog may hold before automated loading waits. */
const BACKLOG_DAYS = 2;

export type LeadCapacity = {
  dailySends: number;
  followUpsDue: number;
  newPerDay: number;
  queued: number;
  headroom: number;
};

export async function leadCapacity(
  prisma: PrismaClient,
  ws: string,
  now: Date,
  sendable: AccountProvider[],
): Promise<LeadCapacity> {
  const campaign = { workspaceId: ws, deletedAt: null, status: { in: [...LIVE_STATUSES] } };
  const [workspace, accounts, followUpsDue, queued] = await Promise.all([
    prisma.workspace.findUniqueOrThrow({ where: { id: ws }, select: { dailyCap: true } }),
    prisma.emailAccount.findMany({
      where: {
        workspaceId: ws,
        deletedAt: null,
        status: "CONNECTED",
        lifecycle: { in: ["ACTIVE", "REWARMING"] },
        provider: { in: sendable },
      },
    }),
    prisma.campaignLead.count({
      where: {
        workspaceId: ws,
        state: "ACTIVE",
        nextDueAt: { lte: new Date(now.getTime() + 24 * 60 * 60 * 1000) },
        campaign,
      },
    }),
    prisma.campaignLead.count({ where: { workspaceId: ws, state: "QUEUED", campaign } }),
  ]);
  const allowance = accounts.reduce((sum, account) => sum + effectiveAllowance(account, now), 0);
  const dailySends = Math.min(allowance, workspace.dailyCap ?? Infinity);
  const newPerDay = Math.max(0, dailySends - followUpsDue);
  return {
    dailySends,
    followUpsDue,
    newPerDay,
    queued,
    headroom: Math.max(0, newPerDay * BACKLOG_DAYS - queued),
  };
}
