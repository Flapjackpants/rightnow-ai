import { Prisma, type StopReason } from "@rightnow/db/client";
import { rerenderScheduled } from "../planner";
import { OPEN_STATES } from "./lead-status";

type Tx = Prisma.TransactionClient;

/**
 * Seams for the send tables (bodies by P3-T09). Every caller runs them INSIDE the transaction that changes the sequence.
 *
 * Rules for the hook bodies: only status SCHEDULED rows are touched (SELECT ... FOR UPDATE SKIP LOCKED never waits, so
 * there is no lock-order constraint here). SENDING and UNCERTAIN rows belong to the sender / resolveUncertain.
 * A row skipped because a claim holds it is NOT cancelled by these hooks, so the CLAIM must protect itself:
 *
 * CLAIM-SIDE RE-CHECKS (T09, binding). Inside the claim transaction, after locking the ScheduledMessage row and then
 * the CampaignLead row (D21 order), verify ALL of the following, else CANCEL the row (uncertainAt NULL) and move on:
 *   - cl.state = 'ACTIVE' (QUEUED only for a step-1 row of the main sequence; PAUSED, STOPPED, COMPLETED reject);
 *   - sm.stepId = cl.currentStepId (a lead moved to a subsequence, or advanced, rejects every old-flow row);
 *   - Lead.deletedAt IS NULL (merged and deleted leads are never mailed);
 *   - the step is live (SequenceStep.deletedAt IS NULL);
 *   - the variant exists and is active.
 * A subsequence move leaves the lead with a new currentStepId and subsequenceId, so the second check rejects the
 * old rows even when the hook skipped them. Entering a subsequence on a QUEUED lead leaves accountId null: the planner
 * routes any row of a lead without a sticky sender through pickAccount (and re-routes it like step 1), and the first
 * SENT row makes its account sticky (planner.ts advanceLead). Re-entry vs the (campaignLeadId, stepId) key: entering
 * is refused once any step of that subsequence has a non-revivable row (subsequenceUsed); a plainly cancelled row is
 * revived in place by the planner's upsert. A delay change re-times the leads waiting on the step (recomputeDue)
 * from the previous step's sentAt, so a shortened delay makes a row immediately due (window and gap rules still apply).
 *
 * STALE TEXT (Revision 3): a claimed row keeps its rendered text and is sent as rendered. Any path that puts a row
 * BACK to SCHEDULED later (T11 RETRY / RELEASED / stale-claim recovery) and the claim itself must re-run
 * `renderForLead` under the row lock and overwrite renderedSubject / renderedBody / renderedText when the variant
 * text changed (deterministic per seed, no network). If the variant is gone or inactive, the row is CANCELLED.
 *
 * suppress() stamps SUPPRESSED on the CampaignLeads it stops. Callers that know better (T08 unsubscribe: UNSUBSCRIBED,
 * T11 bounce: BOUNCED) must set their own stopReason first or in the same transaction before calling suppress().
 */
/**
 * CANCELs the rows matching `where` whose status is in `statuses`, skipping rows a claim holds (FOR UPDATE SKIP LOCKED
 * never waits; the claim re-checks itself). uncertainAt is left as is, so the planner may revive a plain cancel.
 */
export async function cancelRows(
  tx: Tx,
  where: Prisma.Sql,
  statuses: ("SCHEDULED" | "HELD")[] = ["SCHEDULED"],
) {
  const ids = (
    await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "ScheduledMessage" WHERE ${where} AND status::text = ANY(${statuses}::text[])
      ORDER BY id FOR UPDATE SKIP LOCKED`
  ).map((r) => r.id);
  if (ids.length)
    await tx.scheduledMessage.updateMany({
      where: { id: { in: ids }, status: { in: statuses } },
      data: { status: "CANCELLED" },
    });
}

export const editHooks = {
  /**
   * A variant's subject, body or `active` changed, or it was deleted. A live variant's SCHEDULED rows are re-rendered in
   * place (T10b); a removed or deactivated one's are CANCELLED and the planner re-plans them with another variant.
   */
  async variantChanged(
    tx: Tx,
    p: {
      workspaceId: string;
      campaignId: string;
      stepId: string;
      variantId: string;
      removed: boolean;
    },
  ): Promise<void> {
    const where = Prisma.sql`"variantId" = ${p.variantId}`;
    const v = p.removed ? null : await tx.stepVariant.findUnique({ where: { id: p.variantId } });
    if (v?.active) await rerenderScheduled(tx, where);
    else await cancelRows(tx, where);
  },
  /** True when a ScheduledMessage references the step; deleteStep then soft-deletes it (M5, stepId is Restrict). */
  async stepReferenced(tx: Tx, stepId: string): Promise<boolean> {
    return (await tx.scheduledMessage.count({ where: { stepId } })) > 0;
  },
  /** A step was deleted: CANCEL its SCHEDULED rows. T10b moves the leads whose currentStepId is the step (skipStep). */
  async stepRemoved(
    tx: Tx,
    p: { workspaceId: string; campaignId: string; stepId: string },
  ): Promise<void> {
    await cancelRows(tx, Prisma.sql`"stepId" = ${p.stepId}`);
  },
  /**
   * Step order or delay really changed (never called for a no-op patch). CANCEL the SCHEDULED rows of `stepId` (or of
   * the whole sequence when `stepId` is absent: reorder, delete) so dueAt is recomputed.
   */
  async stepsChanged(
    tx: Tx,
    p: { workspaceId: string; campaignId: string; subsequenceId: string | null; stepId?: string },
  ): Promise<void> {
    await cancelRows(
      tx,
      p.stepId
        ? Prisma.sql`"stepId" = ${p.stepId}`
        : Prisma.sql`"stepId" IN (SELECT id FROM "SequenceStep" WHERE "campaignId" = ${p.campaignId}
            AND "subsequenceId" IS NOT DISTINCT FROM ${p.subsequenceId})`,
    );
  },
  /** True once any non-cancelled ScheduledMessage of the campaign exists; reorderSteps is then refused (409). */
  async campaignHasSends(tx: Tx, campaignId: string): Promise<boolean> {
    return (
      (await tx.scheduledMessage.count({ where: { campaignId, status: { not: "CANCELLED" } } })) > 0
    );
  },
  /**
   * CampaignLeads left the main flow (moved to a subsequence, removed, suppressed): CANCEL their SCHEDULED rows in the
   * same transaction (C2). T10b wraps this as enterSubsequence / skipStep.
   */
  async cancelOpenRows(tx: Tx, campaignLeadIds: string[]): Promise<void> {
    if (campaignLeadIds.length)
      await cancelRows(tx, Prisma.sql`"campaignLeadId" = ANY(${campaignLeadIds}::text[])`);
  },
};

/**
 * STOPs the open CampaignLeads (PAUSED included) of these leads (deleted, merged away, unsubscribed, replied), narrowed
 * by `where`, and cancels their open rows, in `tx`. D21 order: the rows first, then the CampaignLeads.
 */
export async function stopOpenCampaignLeads(
  tx: Tx,
  ws: string,
  leadIds: string[],
  stopReason: StopReason = "SKIPPED",
  at = new Date(),
  where: Prisma.CampaignLeadWhereInput = {},
) {
  if (!leadIds.length) return;
  const ids = (
    await tx.campaignLead.findMany({
      where: {
        ...where,
        workspaceId: ws,
        leadId: { in: leadIds },
        state: { in: [...OPEN_STATES] },
      },
      select: { id: true },
    })
  ).map((c) => c.id);
  if (!ids.length) return;
  await editHooks.cancelOpenRows(tx, ids);
  await tx.campaignLead.updateMany({
    where: { id: { in: ids }, state: { in: [...OPEN_STATES] } },
    data: { state: "STOPPED", stopReason, nextDueAt: null, completedAt: at },
  });
}

/** Stops one QUEUED or ACTIVE CampaignLead (a PAUSED one stays paused); the caller already holds its row lock. */
export const stopLead = (tx: Tx, id: string, stopReason: StopReason, at: Date) =>
  tx.campaignLead.updateMany({
    where: { id, state: { in: ["QUEUED", "ACTIVE"] } },
    data: { state: "STOPPED", stopReason, nextDueAt: null, completedAt: at },
  });

/** Advisory lock namespace 726004 (CLAUDE.md registry): per workspace, held by enrollment, launch/resume and merge. */
export const ENROLL_LOCK = 726004;
export const lockEnrollment = (tx: Tx, ws: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(${ENROLL_LOCK}::int, hashtext(${ws}))`;

/** Campaign statuses that count as live for the cross-campaign conflict rule (system-paused ones included). */
export const LIVE_STATUSES = ["ACTIVE", "PAUSED", "ACCOUNTS_UNHEALTHY", "BOUNCE_PROTECT"] as const;

/** The conflict rule: which of these leads are open in a live campaign other than `exceptCampaignId`. */
export async function openInOtherLive(
  tx: Tx,
  ws: string,
  leadIds: string[],
  exceptCampaignId: string,
): Promise<Set<string>> {
  const rows = await tx.campaignLead.findMany({
    where: {
      workspaceId: ws,
      leadId: { in: leadIds },
      campaignId: { not: exceptCampaignId },
      state: { in: [...OPEN_STATES] },
      campaign: { workspaceId: ws, deletedAt: null, status: { in: [...LIVE_STATUSES] } },
    },
    select: { leadId: true },
  });
  return new Set(rows.map((r) => r.leadId));
}
