import { Prisma, type EventType, type Message, type ScheduledMessage } from "@rightnow/db/client";
import { audit } from "../audit";
import { stopOpenCampaignLeads } from "../campaigns/hooks";
import { OPEN_STATES } from "../campaigns/lead-status";
import type { Clock } from "../clock";
import { inSavepoint, onInterestChange } from "../crm/opportunities";
import { companyDomainOf } from "../leads/domain";
import { applyInterestChange, labelsAdded } from "../leads/service";
import { suppress } from "../leads/suppression";
import { enterSubsequence, leadStatusTrigger } from "../planner";
import { acceptTx, refOf } from "../sender";
import { optOutTx } from "../unsubscribe";
import { INTEREST_OF, stripQuoted, type Classification } from "./classify";
import { recordEvent } from "./events";
import { applyReferrals } from "./referral";
import type { Match } from "./match";

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;
const OOO_MAX_MS = 90 * DAY;
const OOO_DEFAULT_MS = 7 * DAY; // M12: an OOO without a date still pauses the sequence
const BOUNCE_LOOKBACK_MS = 14 * DAY;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A REPLY_KEYWORD trigger one of whose phrases occurs in `text` as whole words, ignoring case. */
const keywordHit = (t: Prisma.JsonValue, text: string) => {
  const x = t as { kind?: unknown; phrases?: unknown } | null;
  return (
    x?.kind === "REPLY_KEYWORD" &&
    Array.isArray(x.phrases) &&
    x.phrases.some(
      (p) =>
        typeof p === "string" &&
        p.trim() !== "" && // a blank phrase would match any text
        new RegExp(`(?<![\\p{L}\\p{N}_])${esc(p.trim())}(?![\\p{L}\\p{N}_])`, "iu").test(text),
    )
  );
};

/**
 * D26/D27 stop rules for one stored message, inside its ingest transaction (call only when `created`). Order (I1, with
 * the Lead writes after Suppression so CampaignLead locks always precede Lead locks, D21): M17 settle, CampaignLead
 * stops (rows first via cancelRows), subsequence entry, Suppression, Lead interest and counters, Events.
 * Counters, interest and subsequences move once per message across mailboxes: when the twin's Event already exists only
 * the idempotent stops run; when a concurrent twin wins the Event insert, a retryable error makes `withTxRetry` rerun.
 */
export async function applyInbound(
  tx: Tx,
  clock: Clock,
  p: { workspaceId: string; message: Message; classification: Classification; match: Match },
): Promise<void> {
  const { workspaceId: ws, message: m, classification: c, match } = p;
  if (m.direction !== "IN" || c.kind === "OUTBOUND") return;
  const now = clock.now();
  const type: EventType = c.kind === "BOUNCE" ? `BOUNCE_${c.bounceType}` : c.kind;
  const dedupeKey = `${type}:${ws}:${m.rfcMessageId}`;
  if (c.kind === "BOUNCE" || c.kind === "COMPLAINT")
    return bounce(tx, clock, ws, m, c, match, type, dedupeKey);
  const fresh = !(await tx.event.findUnique({ where: { dedupeKey }, select: { id: true } }));

  // a deleted lead's enrolments are already stopped: nothing is revived or counted for it
  const lead = match.leadId
    ? await tx.lead.findFirst({ where: { id: match.leadId, workspaceId: ws, deletedAt: null } })
    : null;
  const senders = await tx.lead.findMany({
    where: { workspaceId: ws, email: m.fromEmail, deletedAt: null },
    select: { id: true },
  });
  const leadIds = [...new Set([...senders.map((l) => l.id), ...(lead ? [lead.id] : [])])];
  const sm = match.scheduledMessageId
    ? await tx.scheduledMessage.findFirst({
        where: { id: match.scheduledMessageId, workspaceId: ws },
      })
    : null;
  // I7: an answer to one of our sends always counts; an unthreaded one only for enrolments it postdates (D26)
  const dated: Prisma.CampaignLeadWhereInput = sm ? {} : { enrolledAt: { lte: m.sentAt } };

  // M17: an answer proves an UNCERTAIN/HELD send went out, so a later Release cannot send it twice. The row is locked
  // now (D21: ScheduledMessage first) and settled after the stops, so every CampaignLead lock precedes usage/Lead.
  const settle = await lockUnsettled(tx, sm);
  // a lead the user PAUSED is stopped by a reply but never re-activated by a subsequence
  const subCl =
    c.kind === "REPLY" && fresh && lead && match.campaignLeadId
      ? await tx.campaignLead.findFirst({
          where: {
            ...dated,
            id: match.campaignLeadId,
            workspaceId: ws,
            leadId: lead.id,
            OR: [
              { state: { in: ["QUEUED", "ACTIVE"] } },
              { state: "STOPPED", stopReason: "REPLIED" },
            ],
          },
        })
      : null;

  if (c.kind === "REPLY") {
    await stopOpenCampaignLeads(tx, ws, leadIds, "REPLIED", now, {
      ...dated,
      campaign: { stopOnReply: true },
    });
    await companyStop(tx, now, ws, m, match, senders.length > 0, leadIds, dated);
  }
  if (c.kind === "AUTO_REPLY") {
    await stopOpenCampaignLeads(tx, ws, leadIds, "AUTO_REPLIED", now, {
      ...dated,
      campaign: { stopOnAutoReply: true },
    });
    if (c.category === "OUT_OF_OFFICE") {
      const until = new Date(
        c.oooUntil
          ? Math.min(c.oooUntil.getTime(), now.getTime() + OOO_MAX_MS)
          : now.getTime() + OOO_DEFAULT_MS,
      );
      if (until > now) await pushFollowUps(tx, ws, leadIds, dated, until);
    }
  }

  const interest =
    c.kind === "REPLY" && fresh && lead && lead.interestStatus === null
      ? INTEREST_OF[c.category]
      : undefined;
  if (subCl) {
    const subs = await tx.subsequence.findMany({
      where: { campaignId: subCl.campaignId, active: true, activatedAt: { lte: now } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const text = stripQuoted(m.text ?? "");
    const sub =
      subs.find((s) => keywordHit(s.trigger, text)) ??
      (interest === undefined
        ? undefined
        : subs.find((s) => leadStatusTrigger(s.trigger, interest)));
    if (sub) await enterSubsequence(tx, clock, subCl.id, sub.id);
  }

  if (c.kind === "UNSUBSCRIBE") await optOutTx(tx, clock, ws, m.fromEmail, leadIds, "mailto");
  if (interest === -1 && lead) await applyInterestChange(tx, clock, ws, lead.id, -1); // suppresses only

  if (settle && sm) await settleSent(tx, clock, sm, m.sentAt);

  if (fresh && lead) {
    const newer = !lead.lastReplyAt || m.sentAt > lead.lastReplyAt;
    const eng = (lead.lastEngagement ?? {}) as Prisma.JsonObject;
    await tx.lead.update({
      where: { id: lead.id },
      data: {
        ...(c.kind === "REPLY" && { replies: { increment: 1 } }),
        ...(newer && {
          lastReplyAt: m.sentAt,
          lastEngagement: {
            ...eng,
            reply: {
              stepId: sm?.stepId ?? null,
              variantId: sm?.variantId ?? null,
              at: m.sentAt.toISOString(),
            },
          },
        }),
        ...(interest !== undefined && { interestStatus: interest, lastInterestChangeAt: now }),
      },
    });
  }

  // PS-INBOX-20: a label the AI chose, only if it is still aiSelectable; added with a LABEL_ADDED Event like a manual one
  if (
    c.kind === "REPLY" &&
    c.label &&
    fresh &&
    lead &&
    (await tx.leadLabel.count({ where: { workspaceId: ws, name: c.label, aiSelectable: true } }))
  ) {
    const added =
      await tx.$executeRaw`UPDATE "Lead" SET labels = array_append(COALESCE(labels, '{}'), ${c.label}) WHERE id = ${lead.id} AND NOT (${c.label} = ANY(COALESCE(labels, '{}')))`;
    if (added) await labelsAdded(tx, ws, lead.id, [], [c.label], now);
  }

  const inserted = await recordEvent(tx, {
    workspaceId: ws,
    type,
    occurredAt: m.sentAt,
    leadId: match.leadId,
    campaignId: match.campaignId,
    accountId: m.accountId,
    stepId: sm?.stepId ?? null,
    variantId: sm?.variantId ?? null,
    scheduledMessageId: sm?.id ?? null,
    messageId: m.id,
    meta:
      c.kind === "REPLY"
        ? { category: c.category, source: c.source }
        : c.kind === "AUTO_REPLY"
          ? { category: c.category, oooUntil: c.oooUntil?.toISOString() ?? null }
          : {},
    dedupeKey,
  });
  // a twin in another mailbox committed first: rerun so counters are not moved twice
  if (fresh && !inserted)
    throw Object.assign(new Error("applyInbound: concurrent duplicate event"), { code: "P2034" });
  if (interest !== undefined && lead)
    await recordEvent(tx, {
      workspaceId: ws,
      type: "INTEREST_CHANGED",
      occurredAt: now,
      leadId: lead.id,
      campaignId: match.campaignId,
      messageId: m.id,
      meta: { from: null, to: interest, source: "reply" },
      dedupeKey: `interest:${lead.id}:${now.getTime()}`,
    });
  // D40 / Rev 2 C1: only a fresh reply that set an interest (the twin check passed), after its Events, in a savepoint:
  // a CRM failure is audited and never blocks the message, its stops, its Events or the sync watermark
  if (interest !== undefined && lead)
    await inSavepoint(
      tx,
      "crm_hook",
      () =>
        onInterestChange(tx, clock, ws, null, [{ leadId: lead.id, from: null, to: interest }], {
          source: "reply",
          campaignId: match.campaignId,
          scheduledMessageId: sm?.id,
        }),
      (code) =>
        audit(tx, { workspaceId: ws, at: now }, "crm.hook_failed", lead.id, {
          leadId: lead.id,
          code,
        }),
    );
  if (c.kind === "REPLY" && fresh && lead)
    await inSavepoint(
      tx,
      "referral",
      () => applyReferrals(tx, clock, ws, m, lead, c.category),
      (code) => audit(tx, { workspaceId: ws, at: now }, "referral.hook_failed", lead.id, { code }),
    );
}

/** M17: locks an UNCERTAIN/HELD send that an inbound message proves went out (D21: ScheduledMessage first). */
async function lockUnsettled(tx: Tx, sm: ScheduledMessage | null): Promise<boolean> {
  if (!sm?.rfcMessageId || (sm.status !== "UNCERTAIN" && sm.status !== "HELD")) return false;
  const r = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "ScheduledMessage" WHERE id = ${sm.id} AND status::text IN ('UNCERTAIN', 'HELD') FOR UPDATE`;
  return r.length > 0;
}

/** Settles a row `lockUnsettled` holds as SENT, so a later Release cannot send it twice. Call after the stops. */
async function settleSent(tx: Tx, clock: Clock, sm: ScheduledMessage, at: Date) {
  await acceptTx(
    tx,
    clock,
    {
      ...refOf(sm),
      id: sm.id,
      campaignLeadId: sm.campaignLeadId,
      stepId: sm.stepId,
      claimToken: sm.claimToken ?? "", // acceptTx stores "" as null
      claimedAt: sm.claimedAt ?? clock.now(),
      rfcMessageId: sm.rfcMessageId!,
    },
    { rfcMessageId: sm.rfcMessageId! },
    sm.claimedAt && sm.claimedAt <= at ? sm.claimedAt : at,
  );
}

/**
 * D26 company stop: in each campaign with stopForCompanyOnReply where a replying lead is enrolled, the other open leads
 * of its (non-free-mail) company domain stop COMPANY_REPLIED. I8: a sender who is no lead counts only as an answer to
 * one of our sends, and only in that send's campaign.
 */
async function companyStop(
  tx: Tx,
  now: Date,
  ws: string,
  m: Message,
  match: Match,
  senderIsLead: boolean,
  leadIds: string[],
  dated: Prisma.CampaignLeadWhereInput,
) {
  const byCampaign = new Map<string, Set<string>>();
  const add = (campaignId: string, domain: string | null) => {
    const d = domain && companyDomainOf(`@${domain}`);
    if (d) byCampaign.set(campaignId, (byCampaign.get(campaignId) ?? new Set()).add(d));
  };
  const mine = await tx.campaignLead.findMany({
    where: {
      ...dated,
      workspaceId: ws,
      leadId: { in: leadIds },
      campaign: { stopForCompanyOnReply: true },
    },
    select: { campaignId: true, lead: { select: { companyDomain: true } } },
  });
  for (const x of mine) add(x.campaignId, x.lead.companyDomain);
  if (!senderIsLead && match.scheduledMessageId && match.campaignId) {
    const camp = await tx.campaign.findFirst({
      where: { id: match.campaignId, workspaceId: ws, stopForCompanyOnReply: true },
      select: { id: true },
    });
    if (camp) add(camp.id, companyDomainOf(m.fromEmail));
  }
  for (const [campaignId, domains] of byCampaign) {
    const where: Prisma.CampaignLeadWhereInput = {
      ...dated,
      campaignId,
      lead: { companyDomain: { in: [...domains] } },
    };
    const others = await tx.campaignLead.findMany({
      where: {
        ...where,
        workspaceId: ws,
        leadId: { notIn: leadIds },
        state: { in: [...OPEN_STATES] },
      },
      select: { leadId: true },
    });
    await stopOpenCampaignLeads(
      tx,
      ws,
      others.map((o) => o.leadId),
      "COMPANY_REPLIED",
      now,
      where,
    );
  }
}

/** OOO: the open leads' SCHEDULED rows and nextDueAt move to `until` at the earliest (the claim re-aligns to the window). */
async function pushFollowUps(
  tx: Tx,
  ws: string,
  leadIds: string[],
  dated: Prisma.CampaignLeadWhereInput,
  until: Date,
) {
  const cls = (
    await tx.campaignLead.findMany({
      where: {
        ...dated,
        workspaceId: ws,
        leadId: { in: leadIds },
        state: { in: [...OPEN_STATES] },
        campaign: { stopOnAutoReply: false },
      },
      select: { id: true },
    })
  ).map((x) => x.id);
  if (!cls.length) return;
  // M1: a row a claim holds is skipped (it is already on its way)
  const rows = (
    await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "ScheduledMessage" WHERE "campaignLeadId" = ANY(${cls}::text[]) AND status = 'SCHEDULED'
      ORDER BY id FOR UPDATE SKIP LOCKED`
  ).map((r) => r.id);
  await tx.scheduledMessage.updateMany({
    where: { id: { in: rows }, status: "SCHEDULED", dueAt: { lt: until } },
    data: { dueAt: until },
  });
  await tx.campaignLead.updateMany({
    where: { id: { in: cls }, state: { in: [...OPEN_STATES] }, nextDueAt: { lt: until } },
    data: { nextDueAt: until },
  });
}

/**
 * D27 + I2: the target is the original send (by its Message-ID, else the newest SENT row from this mailbox to the
 * recipient within 14 days). Only HARD suppresses; it stops the lead (BOUNCED) only when the DSN names the lead, or names
 * nobody and the lead was the only recipient. Otherwise a named cc/bcc of that send alone is suppressed. A DSN without a
 * target, or naming someone that send never went to, is recorded only (PA #4: the From of a DSN is not authenticated).
 * A DSN of an UNCERTAIN/HELD send proves it went out and settles it SENT, like a reply (M17).
 * An ARF complaint (D34) finds its target the same way; with one it stops every open enrolment of the lead COMPLAINED
 * and suppresses the address (COMPLAINT); without one only the Event is recorded.
 */
async function bounce(
  tx: Tx,
  clock: Clock,
  ws: string,
  m: Message,
  c: Extract<Classification, { kind: "BOUNCE" | "COMPLAINT" }>,
  match: Match,
  type: EventType,
  dedupeKey: string,
) {
  const now = clock.now();
  const recipient = c.recipient?.trim().toLowerCase() || null;
  const include = {
    campaignLead: { select: { leadId: true, lead: { select: { email: true } } } },
  } as const;
  const sm =
    (c.originalMessageId
      ? await tx.scheduledMessage.findFirst({
          where: { workspaceId: ws, rfcMessageId: c.originalMessageId },
          include,
        })
      : null) ??
    (recipient
      ? await tx.scheduledMessage.findFirst({
          where: {
            workspaceId: ws,
            accountId: m.accountId,
            status: "SENT",
            sentAt: { gte: new Date(m.sentAt.getTime() - BOUNCE_LOOKBACK_MS) },
            OR: [
              { campaignLead: { lead: { email: recipient } } },
              { cc: { has: recipient } },
              { bcc: { has: recipient } },
            ],
          },
          orderBy: [{ sentAt: "desc" }, { id: "desc" }],
          include,
        })
      : null);
  const settle = await lockUnsettled(tx, sm);
  const leadEmail = sm?.campaignLead.lead.email.toLowerCase();
  const isLead = !!sm && (recipient ? recipient === leadEmail : !sm.cc.length && !sm.bcc.length);
  const complaint = c.kind === "COMPLAINT";
  if (complaint || c.bounceType === "HARD") {
    // stopReason before suppress(), which would stamp SUPPRESSED on whatever is still open. A complaint is about all
    // our mail, so every open enrolment of the lead stops COMPLAINED; a bounce only the one that bounced.
    if (isLead)
      await stopOpenCampaignLeads(
        tx,
        ws,
        [sm.campaignLead.leadId],
        complaint ? "COMPLAINED" : "BOUNCED",
        now,
        complaint ? {} : { id: sm.campaignLeadId },
      );
    const copied =
      !!recipient && !!sm && [...sm.cc, ...sm.bcc].some((x) => x.toLowerCase() === recipient);
    const addr = isLead ? leadEmail : copied ? recipient : null;
    if (addr)
      await suppress(
        tx,
        ws,
        [{ kind: "EMAIL", value: addr }],
        complaint ? "COMPLAINT" : "HARD_BOUNCE",
        complaint ? "arf" : "dsn",
      );
  }
  if (settle && sm) await settleSent(tx, clock, sm, m.sentAt);
  await recordEvent(tx, {
    workspaceId: ws,
    type,
    occurredAt: m.sentAt,
    leadId: sm?.campaignLead.leadId ?? match.leadId,
    campaignId: sm?.campaignId ?? match.campaignId,
    // D34: health belongs to the mailbox that sent it, not to a feedback-loop or shared mailbox that received the report
    accountId: sm?.accountId ?? m.accountId,
    stepId: sm?.stepId ?? null,
    variantId: sm?.variantId ?? null,
    scheduledMessageId: sm?.id ?? null,
    messageId: m.id,
    meta: c.kind === "BOUNCE" ? { status: c.status, recipient, reason: c.reason } : { recipient },
    dedupeKey,
  });
}
