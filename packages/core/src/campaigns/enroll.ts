import type { Prisma, PrismaClient } from "@rightnow/db/client";
import { audit } from "../audit";
import type { Clock } from "../clock";
import { leadQuery, leadWhere, type LeadQuery } from "../leads/service";
import { regionExcluded } from "../leads/regions";
import { suppressedEmails } from "../leads/suppression";
import { withTxRetry } from "../dispatch";
import { enterSubsequence, subsequenceUsed } from "../planner";
import { editHooks, lockEnrollment, openInOtherLive } from "./hooks";
import { CampaignError, liveCampaign } from "./service";
import { OPEN_STATES } from "./lead-status";

type Db = PrismaClient;
type Tx = Prisma.TransactionClient;
type Actor = string | null | undefined;

const BATCH = 1000;
export type EnrollSkips = {
  in_other_active_campaign: number;
  already_in_campaign: number;
  suppressed: number;
  deleted: number;
  excluded_region: number;
};
export const noSkips = (): EnrollSkips => ({
  in_other_active_campaign: 0,
  already_in_campaign: 0,
  suppressed: 0,
  deleted: 0,
  excluded_region: 0,
});

/**
 * One batch of enrollment inside the caller's transaction. Takes the per-workspace enrollment lock (726004) first, so
 * two enrollments of the same lead into different campaigns serialize and the conflict check sees the earlier one.
 * `leadIds` that are missing, foreign or soft-deleted count as `deleted`.
 */
export async function enrollBatch(
  tx: Tx,
  ws: string,
  campaignId: string,
  leadIds: string[],
  allowDuplicates: boolean,
  skipped: EnrollSkips,
): Promise<number> {
  await lockEnrollment(tx, ws);
  const rules = await tx.workspace.findUniqueOrThrow({
    where: { id: ws },
    select: { excludedCountries: true, excludedRegions: true },
  });
  const ids = [...new Set(leadIds)];
  const leads = await tx.lead.findMany({
    where: { id: { in: ids }, workspaceId: ws, deletedAt: null },
    select: { id: true, email: true, country: true, region: true },
  });
  skipped.deleted += ids.length - leads.length;
  const [there, blocked, others] = await Promise.all([
    tx.campaignLead.findMany({
      where: { campaignId, leadId: { in: leads.map((l) => l.id) } },
      select: { leadId: true },
    }),
    suppressedEmails(
      tx,
      ws,
      leads.map((l) => l.email),
    ),
    allowDuplicates
      ? []
      : openInOtherLive(
          tx,
          ws,
          leads.map((l) => l.id),
          campaignId,
        ),
  ]);
  const inThis = new Set(there.map((r) => r.leadId));
  const inOther = others instanceof Set ? others : new Set<string>();
  const take: string[] = [];
  for (const l of leads) {
    if (inThis.has(l.id)) skipped.already_in_campaign++;
    else if (blocked.has(l.email)) skipped.suppressed++;
    else if (regionExcluded(l, rules)) skipped.excluded_region++;
    else if (inOther.has(l.id)) skipped.in_other_active_campaign++;
    else take.push(l.id);
  }
  // Explicit duplicates are exempt from the launch-time conflict check (also for rows enrolled earlier).
  if (allowDuplicates && inThis.size)
    await tx.campaignLead.updateMany({
      where: { campaignId, leadId: { in: [...inThis] }, duplicateOk: false },
      data: { duplicateOk: true },
    });
  const r = await tx.campaignLead.createMany({
    data: take.map((leadId) => ({
      workspaceId: ws,
      campaignId,
      leadId,
      duplicateOk: allowDuplicates,
    })),
    skipDuplicates: true,
  });
  skipped.already_in_campaign += take.length - r.count;
  return r.count;
}

/** All lead ids of a list or filter, in id order, `BATCH` at a time. */
async function* sourceIds(db: Db, ws: string, p: EnrollInput): AsyncGenerator<string[]> {
  if (p.leadIds) {
    for (let i = 0; i < p.leadIds.length; i += BATCH) yield p.leadIds.slice(i, i + BATCH);
    return;
  }
  const where: Prisma.LeadWhereInput = p.listId
    ? { workspaceId: ws, deletedAt: null, listMembers: { some: { listId: p.listId } } }
    : leadWhere(ws, leadQuery.parse(p.filter));
  for (let cursor: string | undefined; ;) {
    const rows = await db.lead.findMany({
      where,
      select: { id: true },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
    if (!rows.length) return;
    yield rows.map((r) => r.id);
    cursor = rows[rows.length - 1]!.id;
  }
}

export type EnrollInput = {
  leadIds?: string[];
  listId?: string;
  filter?: LeadQuery;
  allowDuplicates?: boolean;
};

export async function enrollLeads(
  prisma: Db,
  _clock: Clock,
  ws: string,
  campaignId: string,
  p: EnrollInput,
  actorId?: Actor,
) {
  if ([p.leadIds, p.listId, p.filter].filter((x) => x !== undefined).length !== 1)
    throw new CampaignError(400, "one_source_required");
  const c = await liveCampaign(prisma, ws, campaignId);
  if (c.status === "ARCHIVED") throw new CampaignError(409, "campaign_archived");
  if (
    p.listId &&
    !(await prisma.leadList.findFirst({
      where: { id: p.listId, workspaceId: ws },
      select: { id: true },
    }))
  )
    throw new CampaignError(400, "unknown_list");
  const skipped = noSkips();
  let enrolled = 0;
  for await (const ids of sourceIds(prisma, ws, p))
    enrolled += await prisma.$transaction(
      (tx) => enrollBatch(tx, ws, campaignId, ids, p.allowDuplicates ?? false, skipped),
      { timeout: 30_000 },
    );
  await audit(prisma, { workspaceId: ws, actorId }, "campaign.update", campaignId, { enrolled });
  return { enrolled, skipped };
}

// --- CampaignLead operations ---------------------------------------------------------------------------------------

async function liveCl(tx: Tx, ws: string, id: string) {
  const cl = await tx.campaignLead.findFirst({
    where: { id, workspaceId: ws, campaign: { deletedAt: null } },
  });
  if (!cl) throw new CampaignError(404, "Not found");
  return cl;
}
const audited = (
  tx: Tx,
  ws: string,
  actorId: Actor,
  cl: { campaignId: string; id: string },
  op: string,
) =>
  audit(tx, { workspaceId: ws, actorId }, "campaign.update", cl.campaignId, {
    campaignLead: cl.id,
    op,
  });

/** STOPPED MANUAL; the lead's SCHEDULED rows are cancelled in the same transaction (hook). */
export async function removeCampaignLead(
  prisma: Db,
  clock: Clock,
  ws: string,
  actorId: Actor,
  id: string,
) {
  return prisma.$transaction(async (tx) => {
    const cl = await liveCl(tx, ws, id);
    const r = await tx.campaignLead.updateMany({
      where: { id, state: { in: [...OPEN_STATES] } },
      data: { state: "STOPPED", stopReason: "MANUAL", nextDueAt: null, completedAt: clock.now() },
    });
    if (r.count) {
      await editHooks.cancelOpenRows(tx, [id]);
      await audited(tx, ws, actorId, cl, "remove");
    }
    return tx.campaignLead.findUniqueOrThrow({ where: { id } });
  });
}

/** Pausing keeps SCHEDULED rows; claim and planner (T09/T10b) must skip leads whose state is not QUEUED or ACTIVE. */
export async function pauseCampaignLead(prisma: Db, ws: string, actorId: Actor, id: string) {
  return prisma.$transaction(async (tx) => {
    const cl = await liveCl(tx, ws, id);
    const r = await tx.campaignLead.updateMany({
      where: { id, state: { in: ["QUEUED", "ACTIVE"] } },
      data: { state: "PAUSED" },
    });
    if (!r.count) throw new CampaignError(409, "lead_not_pausable");
    await audited(tx, ws, actorId, cl, "pause");
    return tx.campaignLead.findUniqueOrThrow({ where: { id } });
  });
}

/** Back to ACTIVE once step 1 was sent (the sticky account is set), else to QUEUED. */
export async function resumeCampaignLead(prisma: Db, ws: string, actorId: Actor, id: string) {
  return prisma.$transaction(async (tx) => {
    const cl = await liveCl(tx, ws, id);
    const r = await tx.campaignLead.updateMany({
      where: { id, state: "PAUSED" },
      // ACTIVE once step 1 went out or the lead sits in a subsequence; a stale SEND_FAILED reason is cleared
      data: { state: cl.accountId || cl.subsequenceId ? "ACTIVE" : "QUEUED", stopReason: null },
    });
    if (!r.count) throw new CampaignError(409, "lead_not_paused");
    await audited(tx, ws, actorId, cl, "resume");
    return tx.campaignLead.findUniqueOrThrow({ where: { id } });
  });
}

/**
 * Manual entry into a subsequence (C2), through `enterSubsequence` in one transaction: the main sequence's open rows
 * are cancelled and the lead moves to the subsequence's first step (due after `preDelayMinutes`). 409 when the lead
 * is already in it, or a step of it already went out to this lead (re-entry rule).
 */
export async function moveToSubsequence(
  prisma: Db,
  clock: Clock,
  ws: string,
  actorId: Actor,
  id: string,
  subsequenceId: string,
) {
  return withTxRetry(() =>
    prisma.$transaction((tx) => moveToSubsequenceTx(tx, clock, ws, actorId, id, subsequenceId)),
  );
}

/** The body of `moveToSubsequence` in the caller's transaction (the D43 `move_to_subsequence` action). */
export async function moveToSubsequenceTx(
  tx: Tx,
  clock: Clock,
  ws: string,
  actorId: Actor,
  id: string,
  subsequenceId: string,
) {
  const cl = await liveCl(tx, ws, id);
  if (![...OPEN_STATES, "COMPLETED"].includes(cl.state))
    throw new CampaignError(409, "lead_not_movable");
  const sub = await tx.subsequence.findFirst({
    where: { id: subsequenceId, campaignId: cl.campaignId, active: true },
    include: { steps: { where: { deletedAt: null }, take: 1 } },
  });
  if (!sub) throw new CampaignError(404, "Not found");
  if (!sub.steps[0]) throw new CampaignError(400, "subsequence_has_no_steps");
  if (cl.subsequenceId === subsequenceId) throw new CampaignError(409, "already_in_subsequence");
  if (await subsequenceUsed(tx, id, subsequenceId))
    throw new CampaignError(409, "subsequence_already_entered");
  if (!(await enterSubsequence(tx, clock, id, subsequenceId)))
    throw new CampaignError(409, "lead_not_movable");
  await audited(tx, ws, actorId, cl, "move_to_subsequence");
  return tx.campaignLead.findUniqueOrThrow({ where: { id } });
}

/** Leaves the subsequence and stops the lead (STOPPED MANUAL), cancelling its open rows (D22: not skipStep, which would advance it). */
export async function removeFromSubsequence(
  prisma: Db,
  clock: Clock,
  ws: string,
  actorId: Actor,
  id: string,
) {
  return prisma.$transaction(async (tx) => {
    const cl = await liveCl(tx, ws, id);
    if (!cl.subsequenceId) throw new CampaignError(409, "not_in_subsequence");
    const r = await tx.campaignLead.updateMany({
      where: { id, subsequenceId: { not: null }, state: { in: [...OPEN_STATES] } },
      data: {
        subsequenceId: null,
        state: "STOPPED",
        stopReason: "MANUAL",
        currentStepId: null,
        nextDueAt: null,
        completedAt: clock.now(),
      },
    });
    if (!r.count) throw new CampaignError(409, "lead_not_movable");
    await editHooks.cancelOpenRows(tx, [id]);
    await audited(tx, ws, actorId, cl, "remove_from_subsequence");
    return tx.campaignLead.findUniqueOrThrow({ where: { id } });
  });
}
