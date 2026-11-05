import type { AutomationRule, Event, Prisma, PrismaClient } from "@rightnow/db/client";
import { Prisma as P } from "@rightnow/db/client";
import { z } from "zod";
import { audit } from "../audit";
import { stopOpenCampaignLeads } from "../campaigns/hooks";
import { enrollBatch, moveToSubsequenceTx, noSkips } from "../campaigns/enroll";
import { sleep, type Clock } from "../clock";
import { ensureOpportunity, errorCode, inSavepoint } from "../crm/opportunities";
import { isLockTimeout, isRetryable, withTxRetry } from "../dispatch";
import { companyDomainOf } from "../leads/domain";
import { suppress } from "../leads/suppression";
import { startOfNextDay } from "../schedule";
import { enqueueDelivery, insertDeliveries } from "../webhooks/deliver";

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;
const BATCH = 20;
const IDLE_MS = 2_000;

const meta = (e: Pick<Event, "meta">) => (e.meta ?? {}) as Record<string, unknown>;
const to = (e: Event) => {
  const v = meta(e).to;
  return typeof v === "number" ? v : null;
};
const isInterest = (e: Event) => e.type === "INTEREST_CHANGED";

/** D43 triggers (PS-AUTO-02): which Events start a rule. */
export const TRIGGERS: Record<string, (e: Event) => boolean> = {
  reply_received: (e) => e.type === "REPLY",
  positive_reply: (e) => isInterest(e) && (to(e) ?? 0) > 0,
  negative_reply: (e) => isInterest(e) && (to(e) ?? 0) < 0,
  status_changed: isInterest,
  label_added: (e) => e.type === "LABEL_ADDED",
  unsubscribed: (e) => e.type === "UNSUBSCRIBE",
  bounced: (e) => e.type === "BOUNCE_HARD" || e.type === "BOUNCE_SOFT",
  campaign_completed: (e) => e.type === "CAMPAIGN_COMPLETED",
  account_error: (e) => e.type === "ACCOUNT_ERROR",
  send_failure_threshold: (e) =>
    e.type === "ACCOUNT_ERROR" &&
    ["send_failures", "bounce_rate", "complaint_rate"].includes(meta(e).reason as string),
  quota_reached: (e) => e.type === "QUOTA_REACHED",
  deal_won: (e) => e.type === "DEAL_WON",
  deal_lost: (e) => e.type === "DEAL_LOST",
};
/** Triggers whose Events never name a lead (R6: lead actions are refused on them). */
export const LEADLESS_TRIGGERS = new Set([
  "campaign_completed",
  "account_error",
  "send_failure_threshold",
  "quota_reached",
]);
/** Triggers whose Events never name a mailbox (R6: `pause_account` is refused on them). */
export const ACCOUNTLESS_TRIGGERS = new Set([
  "positive_reply",
  "negative_reply",
  "status_changed",
  "label_added",
  "campaign_completed",
]);

type Action = {
  input: z.ZodType;
  /** The API-key scope a rule using this action needs (R6). */
  scope: string;
  /** Needs the Event's lead: refused on lead-less triggers, skipped for an Event without one. */
  lead: boolean;
  run(
    tx: Tx,
    clock: Clock,
    e: Event,
    input: unknown,
    ruleId: string,
    appUrl?: string,
  ): Promise<void>;
};
const act = <S extends z.ZodType>(
  scope: string,
  lead: boolean,
  input: S,
  run: (
    tx: Tx,
    clock: Clock,
    e: Event,
    d: z.output<S>,
    ruleId: string,
    appUrl?: string,
  ) => Promise<unknown>,
): Action => ({
  input,
  scope,
  lead,
  run: async (tx, clock, e, d, ruleId, appUrl) => {
    if (!lead || e.leadId) await run(tx, clock, e, d as z.output<S>, ruleId, appUrl);
  },
});
const coded = (code: string) => Object.assign(new Error(code), { code });
const ref = z.string().min(1).max(100);
const none = z.strictObject({});

/**
 * D43 actions (PS-AUTO-03), each a write in the dispatcher's transaction, after the Event claim. They take their locks
 * in the user's order; a deadlock that follows reruns the batch (withTxRetry, D21).
 */
export const ACTIONS: Record<string, Action> = {
  stop_sequence: act(
    "campaigns:write",
    true,
    z.strictObject({ campaignId: ref.optional() }),
    (tx, clock, e, d) =>
      stopOpenCampaignLeads(
        tx,
        e.workspaceId,
        [e.leadId!],
        "MANUAL",
        clock.now(),
        d.campaignId ? { campaignId: d.campaignId } : {},
      ),
  ),
  create_opportunity: act("crm:write", true, none, (tx, clock, e, _d, ruleId) =>
    ensureOpportunity(tx, clock, e.workspaceId, null, e.leadId!, e.campaignId, { ruleId }),
  ),
  create_task: act(
    "crm:write",
    false,
    z.strictObject({
      title: z.string().trim().min(1).max(200),
      dueInDays: z.number().int().min(0).max(365).optional(),
      assigneeId: ref.optional(),
    }),
    (tx, clock, e, d) =>
      tx.task.create({
        data: {
          workspaceId: e.workspaceId,
          title: d.title,
          dueAt:
            d.dueInDays === undefined ? null : new Date(e.occurredAt.getTime() + d.dueInDays * DAY),
          assigneeId: d.assigneeId ?? null,
          leadId: e.leadId,
          createdAt: clock.now(),
        },
      }),
  ),
  suppress_contact: act("blocklist:write", true, none, async (tx, clock, e) => {
    const l = await tx.lead.findFirst({
      where: { id: e.leadId!, workspaceId: e.workspaceId },
      select: { email: true },
    });
    if (!l) return;
    // as optOutTx: the stop reason before suppress(), which stamps SUPPRESSED on whatever is still open
    await stopOpenCampaignLeads(tx, e.workspaceId, [e.leadId!], "SUPPRESSED", clock.now());
    await suppress(tx, e.workspaceId, [{ kind: "EMAIL", value: l.email }], "MANUAL", "automation");
  }),
  suppress_company_domain: act("blocklist:write", true, none, async (tx, _clock, e) => {
    const l = await tx.lead.findFirst({
      where: { id: e.leadId!, workspaceId: e.workspaceId },
      select: { email: true },
    });
    if (!l) return;
    const value = companyDomainOf(l.email);
    if (!value) return; // free mail has no company domain
    await suppress(tx, e.workspaceId, [{ kind: "DOMAIN", value }], "CUSTOMER", "automation");
  }),
  pause_account: act(
    "accounts:write",
    false,
    z.strictObject({ until: z.literal("next_day").optional() }),
    async (tx, clock, e, d, ruleId) => {
      if (!e.accountId) return;
      const now = clock.now();
      const where = { id: e.accountId, workspaceId: e.workspaceId, deletedAt: null };
      const a = await tx.emailAccount.findFirst({ where, select: { timezone: true } });
      if (!a) return;
      const until = d.until ? startOfNextDay(a.timezone, now) : null;
      // a user pause, NEEDS_ATTENTION or INACTIVE stays as it is
      const r = await tx.emailAccount.updateMany({
        where: { ...where, lifecycle: { in: ["ACTIVE", "REWARMING"] } },
        data: { lifecycle: "PAUSED", pausedUntil: until },
      });
      if (r.count)
        await audit(tx, { workspaceId: e.workspaceId, at: now }, "account.pause", e.accountId, {
          until: until?.toISOString() ?? null,
          ruleId,
        });
    },
  ),
  add_to_list: act("leads:write", true, z.strictObject({ listId: ref }), (tx, _c, e, d) =>
    tx.leadListMember.createMany({
      data: [{ listId: d.listId, leadId: e.leadId! }],
      skipDuplicates: true,
    }),
  ),
  enroll_campaign: act(
    "campaigns:write",
    true,
    z.strictObject({ campaignId: ref }),
    async (tx, _c, e, d) => {
      const c = await tx.campaign.findFirst({
        where: {
          id: d.campaignId,
          workspaceId: e.workspaceId,
          deletedAt: null,
          status: { not: "ARCHIVED" },
        },
        select: { id: true },
      });
      if (!c) throw coded("campaign_unavailable");
      await enrollBatch(tx, e.workspaceId, c.id, [e.leadId!], false, noSkips());
    },
  ),
  move_to_subsequence: act(
    "campaigns:write",
    true,
    z.strictObject({ subsequenceId: ref }),
    async (tx, clock, e, d) => {
      const sub = await tx.subsequence.findFirst({
        where: { id: d.subsequenceId, campaign: { workspaceId: e.workspaceId } },
        select: { campaignId: true },
      });
      if (!sub) throw coded("subsequence_unavailable");
      const cl = await tx.campaignLead.findFirst({
        where: { workspaceId: e.workspaceId, campaignId: sub.campaignId, leadId: e.leadId! },
        select: { id: true, subsequenceId: true },
      });
      if (!cl || cl.subsequenceId === d.subsequenceId) return; // not enrolled there, or already in it
      await moveToSubsequenceTx(tx, clock, e.workspaceId, null, cl.id, d.subsequenceId);
    },
  ),
  assign_owner: act("leads:write", true, z.strictObject({ userId: ref }), (tx, _c, e, d) =>
    tx.lead.updateMany({
      where: { id: e.leadId!, workspaceId: e.workspaceId },
      data: { ownerId: d.userId },
    }),
  ),
  add_tag: act(
    "leads:write",
    true,
    z.strictObject({ tag: z.string().trim().min(1).max(50) }),
    // the column may be NULL: coalesce, or the tag would never be added
    (tx, _c, e, d) =>
      tx.$executeRaw`UPDATE "Lead" SET tags = array_append(tags, ${d.tag}), "updatedAt" = now()
        WHERE id = ${e.leadId} AND "workspaceId" = ${e.workspaceId} AND NOT coalesce(${d.tag} = ANY(tags), false)`,
  ),
  // D44: one delivery to that webhook (subscribed or not); the (webhookId, eventId) unique keeps it to one
  send_webhook: act(
    "webhooks:write",
    false,
    z.strictObject({ webhookId: ref }),
    (tx, clock, e, d, _r, appUrl) => enqueueDelivery(tx, e, clock.now(), d.webhookId, appUrl),
  ),
};

/**
 * PS-AUTO-04: the built-in behaviour, a static list because it already runs atomically in the code paths that own it.
 * Only `positive_reply_opportunity` can be switched off (`Workspace.crmAutoOpportunity`).
 */
export const BUILTIN_RULES: {
  key: string;
  trigger: string;
  actions: string[];
  locked: boolean;
  reason: string;
  settingsHref?: string;
}[] = [
  {
    key: "positive_reply_opportunity",
    trigger: "positive_reply",
    actions: ["create_opportunity"],
    locked: false,
    reason:
      "A positive reply opens a deal in the pipeline (D40). Stopping the sequence on a reply is each campaign's Stop on reply setting.",
    settingsHref: "/campaigns",
  },
  {
    key: "unsubscribe_suppress",
    trigger: "unsubscribed",
    actions: ["suppress_contact", "stop_sequence"],
    locked: true,
    reason:
      "Compliance: an unsubscribe is always honored (CAN-SPAM, GDPR), so this cannot be turned off.",
  },
  {
    key: "bounce_stop_health",
    trigger: "bounced",
    actions: ["stop_sequence", "suppress_contact"],
    locked: true,
    reason:
      "A hard bounce stops the lead, suppresses the address and counts toward the mailbox health score (D27, D34).",
  },
  {
    key: "quota_defer",
    trigger: "quota_reached",
    actions: ["defer"],
    locked: true,
    reason: "Daily limits are never exceeded: the remaining messages wait for the next day (D19).",
  },
  {
    key: "failure_pause",
    trigger: "send_failure_threshold",
    actions: ["pause_account"],
    locked: true,
    reason:
      "Repeated send failures, or a bounce or complaint rate over the threshold, pause the mailbox (D18, D34).",
    settingsHref: "/settings",
  },
  {
    key: "deal_won_revenue",
    trigger: "deal_won",
    actions: [],
    locked: true,
    reason: "Revenue analytics read deals live, so a won deal counts at once (D42).",
  },
];

type Counts = { events: number; runs: number; deliveries: number };
type LeadRow = {
  id: string;
  workspaceId: string;
  deletedAt: Date | null;
  tags: string[];
  labels: string[];
  interestStatus: number | null;
};
export type RuleConditions = {
  campaignIds?: string[];
  accountIds?: string[];
  leadTags?: string[];
  interestCodes?: number[];
  labels?: string[];
};

/**
 * Deadlock/serialization (retries spent), a lock wait past `lock_timeout` or a lost connection: the Event stays pending.
 * A solo transaction timeout (P2028) is not transient: that Event itself is too slow and is stamped.
 */
const isTransient = (e: unknown) =>
  isRetryable(e) ||
  isLockTimeout(e) ||
  /^(P2024|P1001|P1002|P1008|P1017)$/.test(errorCode(e)) ||
  /ECONNRESET|ECONNREFUSED|Connection terminated/i.test(`${(e as Error | null)?.message}`);
/** A service error (AccountError, CampaignError: `status` + message) becomes a run error code; others pass unchanged. */
const asCode = (e: unknown) =>
  typeof (e as { status?: unknown } | null)?.status === "number" ? coded((e as Error).message) : e;
/** A lock wait past `lock_timeout` passes through the savepoints (as a retryable error would), so the Event stays pending. */
const LOCK = "55P03";
const lockAware = (f: () => Promise<void>) => async () => {
  try {
    await f();
  } catch (x) {
    throw isLockTimeout(x) ? coded(LOCK) : x;
  }
};
const passLock = (code: string) => {
  if (code === LOCK) throw coded(LOCK);
};

/** Optional AND-ed lists; within a list any entry matches. `labels` on a LABEL_ADDED Event means the added label. */
function matches(c: RuleConditions, e: Event, lead: LeadRow | undefined) {
  const any = <T>(l: T[] | undefined, ok: (x: T) => boolean) => !l?.length || l.some(ok);
  const added = e.type === "LABEL_ADDED" ? meta(e).label : undefined;
  return (
    any(c.campaignIds, (x) => x === e.campaignId) &&
    any(c.accountIds, (x) => x === e.accountId) &&
    any(c.leadTags, (x) => !!lead?.tags?.includes(x)) && // the list columns may be NULL
    any(c.interestCodes, (x) => lead?.interestStatus === x) &&
    any(c.labels, (x) => (added !== undefined ? added === x : !!lead?.labels?.includes(x)))
  );
}

/** One rule for one Event in SAVEPOINT rule: exactly once per (rule, event); a failing action leaves a FAILED run. */
async function runRule(
  tx: Tx,
  clock: Clock,
  now: Date,
  r: AutomationRule,
  e: Event,
  failWith?: string,
  appUrl?: string,
) {
  let n = 0;
  // FOR KEY SHARE: a rule deleted mid-batch reads as gone instead of failing the run insert on its FK
  const insertRun = async (status: "OK" | "FAILED", error: string | null) =>
    (await tx.$queryRaw<unknown[]>`SELECT 1 FROM "AutomationRule" WHERE id = ${r.id} FOR KEY SHARE`)
      .length > 0 &&
    (
      await tx.automationRun.createMany({
        data: [
          {
            workspaceId: e.workspaceId,
            ruleId: r.id,
            eventId: e.id,
            status,
            error,
            createdAt: now,
          },
        ],
        skipDuplicates: true,
      })
    ).count === 1;
  if (failWith) return (await insertRun("FAILED", failWith)) ? 1 : 0; // the record of an Event that failed alone
  await inSavepoint(
    tx,
    "rule",
    lockAware(async () => {
      if (!(await insertRun("OK", null))) return;
      for (const { type, ...input } of r.actions as { type: string }[]) {
        const a = ACTIONS[type];
        if (!a) throw coded("unknown_action");
        try {
          await a.run(tx, clock, e, input, r.id, appUrl);
        } catch (x) {
          throw asCode(x);
        }
      }
      n = 1;
    }),
    async (code) => {
      passLock(code);
      if (await insertRun("FAILED", code)) n = 1;
    },
  );
  return n;
}

/**
 * One claimed batch (or the given ids) in the caller's transaction; `claimed` receives the ids for the R1 fallback.
 * `failWith`: no actions or deliveries; each matching rule gets a FAILED run and the Event is stamped with that code.
 */
async function runBatch(
  tx: Tx,
  clock: Clock,
  sel: {
    limit: number;
    ids?: string[];
    lockTimeoutMs?: number;
    failWith?: string;
    appUrl?: string;
  },
  claimed: string[],
): Promise<Counts> {
  const out: Counts = { events: 0, runs: 0, deliveries: 0 };
  if (sel.lockTimeoutMs)
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${Math.trunc(sel.lockTimeoutMs)}ms'`);
  const ids = (
    await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Event" WHERE "dispatchedAt" IS NULL
        ${sel.ids ? P.sql`AND id = ANY(${sel.ids}::text[])` : P.empty}
      ORDER BY "createdAt", id LIMIT ${sel.limit} FOR UPDATE SKIP LOCKED`
  ).map((r) => r.id);
  if (!ids.length) return out;
  claimed.push(...ids);
  const events = await tx.event.findMany({
    where: { id: { in: ids } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const wsIds = [...new Set(events.map((e) => e.workspaceId))];
  const rules = await tx.automationRule.findMany({
    where: { workspaceId: { in: wsIds }, enabled: true },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  const leadIds = [...new Set(events.flatMap((e) => (e.leadId ? [e.leadId] : [])))];
  const leads = new Map(
    (
      await tx.lead.findMany({
        where: { id: { in: leadIds } },
        select: {
          id: true,
          workspaceId: true,
          deletedAt: true,
          tags: true,
          labels: true,
          interestStatus: true,
        },
      })
    ).map((l) => [l.id, l]),
  );
  const hooks = await tx.webhook.findMany({
    where: { workspaceId: { in: wsIds }, status: "ACTIVE" },
    select: { id: true, workspaceId: true, events: true, campaignId: true },
  });
  const now = clock.now();
  const ruled = new Set([...rules, ...hooks].map((r) => r.workspaceId));
  // D43: an Event of a workspace without enabled rules and ACTIVE webhooks is only stamped by the final UPDATE
  for (const e of events.filter((x) => ruled.has(x.workspaceId))) {
    await inSavepoint(
      tx,
      "evt",
      lockAware(async () => {
        const m = meta(e);
        const lead = e.leadId ? leads.get(e.leadId) : undefined;
        // D43: the loop guard (an action's own Event), no fabricated engagement, no deleted or foreign lead
        const liveLead =
          !e.leadId || (!!lead && !lead.deletedAt && lead.workspaceId === e.workspaceId);
        const evaluable = !m.ruleId && !m.machine && !m.scanner && liveLead;
        let runs = 0;
        if (evaluable)
          for (const r of rules)
            if (
              r.workspaceId === e.workspaceId &&
              TRIGGERS[r.trigger]?.(e) &&
              matches(r.conditions as RuleConditions, e, lead)
            )
              runs += await runRule(tx, clock, now, r, e, sel.failWith, sel.appUrl);
        // M6: a deleted (merged) lead's Event is not delivered either
        const deliveries =
          sel.failWith || !liveLead ? 0 : await insertDeliveries(tx, e, now, hooks, sel.appUrl);
        out.runs += runs;
        out.deliveries += deliveries;
      }),
      // R1: a poison event is stamped with its code; the rest of the batch commits
      async (code) => {
        passLock(code);
        console.error("dispatch_isolated", { eventId: e.id, code });
        await tx.event.update({
          where: { id: e.id },
          data: { dispatchedAt: now, dispatchError: code },
        });
      },
    );
  }
  await tx.event.updateMany({
    where: { id: { in: ids }, dispatchedAt: null },
    data: { dispatchedAt: now, ...(sel.failWith && { dispatchError: sel.failWith }) },
  });
  out.events = ids.length;
  return out;
}

const add = (a: Counts, b: Counts) => {
  a.events += b.events;
  a.runs += b.runs;
  a.deliveries += b.deliveries;
};
type Limits = { txTimeoutMs?: number; lockTimeoutMs?: number; appUrl?: string };

/**
 * One batch; when it fails as a whole (retries spent, timeout, lock wait), its events are retried one at a time (R1).
 * Both run with a `lock_timeout` below the transaction timeout (as claimDue): a blocked query is not interrupted by
 * the timeout, so lock contention surfaces as 55P03 instead, and a solo 55P03 leaves the Event pending.
 */
async function dispatchBatch(
  prisma: PrismaClient,
  clock: Clock,
  limit: number,
  out: Counts,
  o: Limits,
) {
  const timeout = { timeout: o.txTimeoutMs ?? 30_000 };
  const lockTimeoutMs = o.lockTimeoutMs ?? 10_000;
  const claimed: string[] = [];
  const solo = (id: string, failWith?: string) =>
    withTxRetry(() =>
      prisma.$transaction(
        (tx) =>
          runBatch(
            tx,
            clock,
            { limit: 1, ids: [id], lockTimeoutMs, failWith, appUrl: o.appUrl },
            [],
          ),
        timeout,
      ),
    );
  try {
    const r = await withTxRetry(() => {
      claimed.length = 0;
      return prisma.$transaction(
        (tx) => runBatch(tx, clock, { limit, lockTimeoutMs, appUrl: o.appUrl }, claimed),
        timeout,
      );
    });
    add(out, r);
    return r.events;
  } catch (e) {
    if (!claimed.length) throw e;
    let transient: unknown;
    for (const id of [...claimed])
      try {
        add(out, await solo(id));
      } catch (x) {
        // a transient failure is not the event's fault: it stays pending and the next tick retries it
        if (isTransient(x)) {
          transient ??= x;
          continue;
        }
        // the Event failed alone (P2028 = too slow by itself): stamped, with a FAILED run per matching rule
        const code = errorCode(x);
        console.error("dispatch_isolated", { eventId: id, code });
        try {
          add(out, await solo(id, code));
        } catch {
          out.events += (
            await prisma.event.updateMany({
              where: { id, dispatchedAt: null },
              data: { dispatchedAt: clock.now(), dispatchError: code },
            })
          ).count;
        }
      }
    if (transient) throw transient; // the run fails visibly; the events dispatched above stay committed
    return claimed.length;
  }
}

/**
 * D43 outbox dispatch: batches of ≤ `batch` pending Events claimed FOR UPDATE SKIP LOCKED, each Event (its rules and
 * deliveries) in SAVEPOINT evt, then stamped `dispatchedAt`. Loops until `maxMs` (a 2 s sleep when idle) or `signal`.
 */
export async function dispatchEvents(
  prisma: PrismaClient,
  clock: Clock,
  o: { batch?: number; maxMs: number; signal?: AbortSignal } & Limits,
): Promise<Counts> {
  const out: Counts = { events: 0, runs: 0, deliveries: 0 };
  const start = Date.now();
  for (;;) {
    const n = await dispatchBatch(prisma, clock, o.batch ?? BATCH, out, o);
    const left = o.maxMs - (Date.now() - start);
    if (o.signal?.aborted || left <= 0) return out;
    if (!n) await sleep(Math.min(IDLE_MS, left), o.signal);
  }
}
