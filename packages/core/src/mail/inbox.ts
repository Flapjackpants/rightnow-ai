import { Prisma, type Message, type PrismaClient } from "@rightnow/db/client";
import { z } from "zod";
import { AccountError, notFound } from "../accounts/service";
import { audit } from "../audit";
import type { Clock } from "../clock";
import { withTxRetry } from "../dispatch";
import { addBlocklist } from "../leads/blocklist";
import { companyDomainOf } from "../leads/domain";
import { bulkLeads, createLead, LeadError } from "../leads/service";
import { hashValue, isSuppressed } from "../leads/suppression";
import { parseEmail } from "../leads/validate";
import type { Classification } from "./classify";
import { applyInbound } from "./stoprules";

type Db = PrismaClient;
type Actor = string | null | undefined;

const CATEGORIES = [
  ...["INTERESTED", "MEETING_REQUESTED", "NOT_INTERESTED", "WRONG_PERSON", "NEUTRAL"],
  ...["OUT_OF_OFFICE", "UNSUBSCRIBE", "AUTOMATED", "UNCERTAIN"],
] as const;
const VIEWS = [
  "primary",
  "others",
  "triage",
  "unread",
  "reminders",
  "sent",
  "scheduled",
  "all",
] as const;
const text = z.string().trim().min(1).max(200);
const bool = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);

export const threadFilterSchema = z.strictObject({
  view: z.enum(VIEWS).default("primary"),
  accountId: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional(),
  interestStatus: z.coerce.number().int().min(-4).max(4).optional(),
  leadLabel: text.optional(),
  category: z.enum(CATEGORIES).optional(),
  q: text.optional(),
  from: text.optional(),
  to: text.optional(),
  subject: text.optional(),
  after: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
  hasAttachment: bool.optional(),
  direction: z.enum(["received", "sent"]).optional(),
  cursor: z
    .string()
    .regex(/^[^|]+\|[^|]+$/)
    .optional(), // `lastMessageAt ISO|id`
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ThreadFilter = z.output<typeof threadFilterSchema>;

const sql = Prisma.sql;
const liveLead = sql`EXISTS (SELECT 1 FROM "Lead" l WHERE l.id = t."leadId" AND l."deletedAt" IS NULL)`;
const sentByUs = sql`EXISTS (SELECT 1 FROM "Message" m WHERE m."threadId" = t.id AND m.direction = 'OUT')`;
// PS-INBOX-16: a bounce or complaint report, a stranger and a deleted lead all land in Others
const PRIMARY = sql`t."lastInboundAt" IS NOT NULL AND t."lastInboundKind" IS DISTINCT FROM 'BOUNCE'
  AND t."lastInboundKind" IS DISTINCT FROM 'COMPLAINT' AND ${liveLead}`;
const OTHERS = sql`t."lastInboundAt" IS NOT NULL AND NOT (${PRIMARY})`;
// a reply from someone who matches no live lead, without the reports and opt-outs that have no person
const TRIAGE = sql`t."lastInboundAt" IS NOT NULL AND t."lastInboundKind" IS DISTINCT FROM 'BOUNCE'
  AND t."lastInboundKind" IS DISTINCT FROM 'COMPLAINT' AND NOT (${liveLead})`;
const VIEW_SQL = {
  primary: PRIMARY,
  others: OTHERS,
  triage: TRIAGE,
  unread: sql`t."isRead" = false`,
  reminders: sql`t."reminderAt" IS NOT NULL`,
  sent: sentByUs,
  // the lead has rows waiting in the send queue (PS-INBOX-24); the UI shows the P3 Scheduled view for this tab
  scheduled: sql`EXISTS (SELECT 1 FROM "ScheduledMessage" s JOIN "CampaignLead" cl ON cl.id = s."campaignLeadId"
    WHERE s.status = 'SCHEDULED' AND cl."leadId" = t."leadId")`,
  all: sql`true`,
} as const;

const like = (s: string) => `%${s.replace(/[\\%_]/g, "\\$&")}%`;

function whereOf(ws: string, f: Omit<ThreadFilter, "limit">): Prisma.Sql {
  const c = [sql`t."workspaceId" = ${ws}`, sql`t."deletedAt" IS NULL`, VIEW_SQL[f.view]];
  if (f.accountId) c.push(sql`t."accountId" = ${f.accountId}`);
  if (f.campaignId) c.push(sql`t."campaignId" = ${f.campaignId}`);
  if (f.category) c.push(sql`t.category = ${f.category}::"ReplyCategory"`);
  if (f.interestStatus !== undefined)
    c.push(
      sql`EXISTS (SELECT 1 FROM "Lead" l WHERE l.id = t."leadId" AND l."interestStatus" = ${f.interestStatus})`,
    );
  if (f.leadLabel)
    c.push(
      sql`EXISTS (SELECT 1 FROM "Lead" l WHERE l.id = t."leadId" AND ${f.leadLabel} = ANY(l.labels))`,
    );
  if (f.subject) c.push(sql`t.subject ILIKE ${like(f.subject)}`);
  if (f.after) c.push(sql`t."lastMessageAt" >= ${f.after}`);
  if (f.before) c.push(sql`t."lastMessageAt" <= ${f.before}`);
  if (f.hasAttachment !== undefined) c.push(sql`t."hasAttachment" = ${f.hasAttachment}`);
  if (f.direction === "received") c.push(sql`t."lastInboundAt" IS NOT NULL`);
  if (f.direction === "sent") c.push(sentByUs);
  if (f.from)
    c.push(
      sql`EXISTS (SELECT 1 FROM "Message" m WHERE m."threadId" = t.id AND m."fromEmail" ILIKE ${like(f.from)})`,
    );
  if (f.to)
    c.push(
      sql`EXISTS (SELECT 1 FROM "Message" m, unnest(m."to") a WHERE m."threadId" = t.id AND a ILIKE ${like(f.to)})`,
    );
  // shortcut: ILIKE scan, switch to a tsvector index when a workspace passes ~100k messages
  if (f.q) {
    const p = like(f.q);
    c.push(sql`(t.subject ILIKE ${p} OR EXISTS (SELECT 1 FROM "Message" m WHERE m."threadId" = t.id
      AND (m.subject ILIKE ${p} OR m."fromEmail" ILIKE ${p} OR m.text ILIKE ${p})))`);
  }
  if (f.cursor) {
    const [at, id] = f.cursor.split("|") as [string, string];
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) throw new AccountError(400, "invalid_cursor");
    c.push(sql`(t."lastMessageAt", t.id) < (${d}, ${id})`);
  }
  return Prisma.join(
    c.map((x) => sql`(${x})`),
    " AND ",
  );
}

const threadIds = async (db: Db, ws: string, f: Omit<ThreadFilter, "limit">, limit: number) =>
  (
    await db.$queryRaw<{ id: string }[]>`SELECT t.id FROM "Thread" t WHERE ${whereOf(ws, f)}
      ORDER BY t."lastMessageAt" DESC, t.id DESC LIMIT ${limit}`
  ).map((r) => r.id);

const ATTACHMENT_META = {
  id: true,
  filename: true,
  contentType: true,
  size: true,
  truncated: true,
} as const;

/** One page, newest first, with each thread's latest message. Attachments are metadata only: `data` is read by the download route alone. Next page: `cursor` = `${lastMessageAt.toISOString()}|${id}` of the last row. */
export async function listThreads(
  db: Db,
  ws: string,
  input: z.input<typeof threadFilterSchema> = {},
) {
  const f = threadFilterSchema.parse(input);
  const ids = await threadIds(db, ws, f, f.limit);
  // PA #6: the last message without its body; a 200-char snippet is cut in SQL, so no large text leaves the database
  const rows = await db.thread.findMany({
    where: { id: { in: ids }, workspaceId: ws },
    include: {
      messages: {
        orderBy: [{ sentAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          ...{
            id: true,
            direction: true,
            kind: true,
            fromEmail: true,
            fromName: true,
            sentAt: true,
          },
          attachments: { select: ATTACHMENT_META },
        },
      },
    },
  });
  const last = rows.flatMap((r) => r.messages.map((m) => m.id));
  const snippets = new Map(
    (
      await db.$queryRaw<{ id: string; snippet: string | null }[]>`
        SELECT id, left(text, 200) AS snippet FROM "Message" WHERE id = ANY(${last}::text[])`
    ).map((r) => [r.id, r.snippet]),
  );
  const byId = new Map(
    rows.map((r) => [
      r.id,
      { ...r, messages: r.messages.map((m) => ({ ...m, snippet: snippets.get(m.id) ?? null })) },
    ]),
  );
  return ids.flatMap((id) => byId.get(id) ?? []);
}

export async function getThread(db: Db, ws: string, id: string) {
  const t = await db.thread.findFirst({
    where: { id, workspaceId: ws, deletedAt: null },
    include: {
      messages: {
        orderBy: [{ sentAt: "asc" }, { id: "asc" }],
        include: { attachments: { select: ATTACHMENT_META } },
      },
      notes: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!t) throw notFound();
  const lead = t.leadId
    ? await db.lead.findFirst({
        where: { id: t.leadId, workspaceId: ws },
        select: {
          id: true,
          email: true,
          ownerId: true,
          firstName: true,
          lastName: true,
          companyName: true,
          jobTitle: true,
          interestStatus: true,
          labels: true,
          tags: true,
          deletedAt: true,
        },
      })
    : null;
  const first = t.messages.find((m) => m.scheduledMessageId);
  const origin = first
    ? await db.scheduledMessage.findFirst({
        where: { id: first.scheduledMessageId!, workspaceId: ws },
        select: {
          step: { select: { order: true } },
          variant: { select: { label: true } },
          campaign: { select: { id: true, name: true } },
        },
      })
    : null;
  const [leadNotes, scheduled] = t.leadId
    ? await Promise.all([
        db.note.findMany({
          where: { workspaceId: ws, leadId: t.leadId },
          orderBy: { createdAt: "asc" },
        }),
        db.scheduledMessage.findMany({
          where: { workspaceId: ws, status: "SCHEDULED", campaignLead: { leadId: t.leadId } },
          select: { id: true, campaignId: true, dueAt: true, renderedSubject: true },
          orderBy: { dueAt: "asc" },
          take: 20,
        }),
      ])
    : [[], []];
  const latestIn = [...t.messages].reverse().find((m) => m.direction === "IN");
  const domain = latestIn && companyDomainOf(latestIn.fromEmail);
  // with no live lead, offer colleagues from the sender's company; the user still decides
  const domainLeads =
    (!lead || lead.deletedAt) && domain
      ? await db.lead.findMany({
          where: { workspaceId: ws, deletedAt: null, companyDomain: domain },
          select: { id: true, email: true, firstName: true, lastName: true },
          orderBy: [{ lastContactedAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
          take: 5,
        })
      : [];
  return {
    ...t,
    messages: await inlineCid(db, t.messages),
    lead,
    leadNotes,
    scheduled,
    origin,
    domainLeads,
  };
}

const CID_IMAGE = /^image\/(png|jpe?g|gif|webp)$/i;
const CID_MAX = 1024 * 1024;

/**
 * M4: `cid:` images become `data:` URIs from the stored attachment bytes (images up to 1 MB), anything else is dropped,
 * so the sandboxed frame never needs a remote or cid fetch. shortcut: Content-ID is not stored, so `cid:x` matches the
 * attachment filename `x`; add a contentId column if a sender uses opaque ids.
 */
async function inlineCid<M extends { id: string; html: string | null }>(db: Db, msgs: M[]) {
  const withCid = msgs.filter((m) => m.html && /cid:/i.test(m.html));
  if (!withCid.length) return msgs;
  // one query for the whole thread, not one per message
  const all = await db.attachment.findMany({
    where: {
      messageId: { in: withCid.map((m) => m.id) },
      size: { lte: CID_MAX },
      data: { not: null },
    },
  });
  return msgs.map((m) => {
    if (!m.html || !/cid:/i.test(m.html)) return m;
    const files = all.filter((a) => a.messageId === m.id);
    const html = m.html.replace(/cid:([^"'\s)>]+)/gi, (_, id: string) => {
      const name = (() => {
        try {
          return decodeURIComponent(id);
        } catch {
          return id;
        }
      })();
      const f = files.find((a) => a.filename === name && CID_IMAGE.test(a.contentType));
      return f
        ? `data:${f.contentType};base64,${Buffer.from(f.data!).toString("base64")}`
        : "about:blank";
    });
    return { ...m, html };
  });
}

export const threadPatch = z.strictObject({
  isRead: z.boolean().optional(),
  category: z.enum(CATEGORIES).optional(),
  reminderAt: z.coerce.date().nullable().optional(),
});

/**
 * PS-INBOX-19: a category set by the user is final (`categorySource "USER"`) and audited as the feedback log. Lifting
 * the NOT_INTERESTED suppression it implies needs `admin` (D20); a MEMBER or API key changes the category only.
 */
export async function updateThread(
  db: Db,
  ws: string,
  actorId: Actor,
  id: string,
  input: unknown,
  o: { admin?: boolean } = {},
) {
  const p = threadPatch.parse(input);
  return db.$transaction(async (tx) => {
    const t = await tx.thread.findFirst({ where: { id, workspaceId: ws, deletedAt: null } });
    if (!t) throw notFound();
    if (p.category && p.category !== t.category) {
      // I9: undoing a classifier's NOT_INTERESTED also lifts the suppression that status created
      if (
        o.admin &&
        t.category === "NOT_INTERESTED" &&
        (t.categorySource === "RULE" || t.categorySource === "AI") &&
        t.leadId
      ) {
        const lead = await tx.lead.findFirst({
          where: { id: t.leadId, workspaceId: ws },
          select: { email: true },
        });
        if (lead)
          await tx.suppression.deleteMany({
            where: {
              workspaceId: ws,
              kind: "EMAIL",
              valueHash: hashValue(lead.email),
              reason: "NOT_INTERESTED",
              source: "status",
            },
          });
      }
      await audit(tx, { workspaceId: ws, actorId }, "inbox.category_override", id, {
        from: t.category,
        to: p.category,
        previousSource: t.categorySource,
      });
    }
    return tx.thread.update({
      where: { id },
      data: {
        ...(p.isRead !== undefined && { isRead: p.isRead }),
        ...(p.reminderAt !== undefined && { reminderAt: p.reminderAt }),
        ...(p.category && { category: p.category, categorySource: "USER" }),
      },
    });
  });
}

/** Local only: the provider mailbox is untouched and the lead stays in its campaign (PS-INBOX-14/15). New inbound mail revives the thread. */
export async function deleteThread(db: Db, clock: Clock, ws: string, actorId: Actor, id: string) {
  await db.$transaction(async (tx) => {
    const r = await tx.thread.updateMany({
      where: { id, workspaceId: ws, deletedAt: null },
      data: { deletedAt: clock.now() },
    });
    if (!r.count) throw notFound();
    await audit(tx, { workspaceId: ws, actorId, at: clock.now() }, "inbox.delete", id);
  });
}

/** PS-INBOX-23: marks this thread read, and only this one. */
export async function readAll(db: Db, ws: string, id: string) {
  const r = await db.thread.updateMany({
    where: { id, workspaceId: ws, deletedAt: null },
    data: { isRead: true },
  });
  if (!r.count) throw notFound();
  return { updated: r.count };
}

export async function unreadCount(db: Db, ws: string, now: Date) {
  const [c] = await db.$queryRaw<
    { primary: number; others: number; triage: number; total: number }[]
  >`
    SELECT (count(*) FILTER (WHERE ${PRIMARY}))::int AS "primary", (count(*) FILTER (WHERE ${OTHERS}))::int AS "others",
      (count(*) FILTER (WHERE ${TRIAGE}))::int AS "triage", count(*)::int AS "total"
    FROM "Thread" t WHERE t."workspaceId" = ${ws} AND t."deletedAt" IS NULL AND t."isRead" = false`;
  const remindersDue = await db.thread.count({
    where: { workspaceId: ws, deletedAt: null, reminderAt: { lte: now } },
  });
  return { ...c!, remindersDue };
}

/** What `applyInbound` needs, rebuilt from the stored message (the classifier ran at ingest). */
function classificationOf(m: Message, source: string | null): Classification | null {
  if (m.kind === "REPLY")
    return {
      kind: "REPLY",
      category: m.category ?? "NEUTRAL",
      source: source === "AI" ? "AI" : "RULE",
    };
  if (m.kind === "UNSUBSCRIBE") return { kind: "UNSUBSCRIBE" };
  if (m.kind === "AUTO_REPLY")
    return {
      kind: "AUTO_REPLY",
      category: m.category === "OUT_OF_OFFICE" ? "OUT_OF_OFFICE" : "AUTOMATED",
      oooUntil: m.oooUntil,
    };
  return null; // a bounce is keyed by the send it answers, not by the sender
}

/**
 * PS-INBOX-10: the thread (and its inbound messages) now belong to `leadId`; the newest inbound message runs the stop
 * rules again with the new match, so a forwarded reply stops the lead (D26). When that message's Event was stored
 * without a lead (M6) it is attributed now and the lead's reply counters move once.
 */
export async function attachLead(
  db: Db,
  clock: Clock,
  ws: string,
  actorId: Actor,
  id: string,
  leadId: string,
) {
  await withTxRetry(() =>
    db.$transaction(
      async (tx) => {
        const t = await tx.thread.findFirst({ where: { id, workspaceId: ws, deletedAt: null } });
        if (!t) throw notFound();
        const lead = await tx.lead.findFirst({
          where: { id: leadId, workspaceId: ws, deletedAt: null },
        });
        if (!lead) throw notFound();
        const m = await tx.message.findFirst({
          where: { threadId: id, direction: "IN" },
          orderBy: [{ sentAt: "desc" }, { id: "desc" }],
        });
        const cl = await tx.campaignLead.findFirst({
          where: { workspaceId: ws, leadId, enrolledAt: { lte: m?.sentAt ?? clock.now() } },
          orderBy: [{ enrolledAt: "desc" }, { id: "desc" }],
          select: { id: true, campaignId: true },
        });
        const campaignId = t.campaignId ?? cl?.campaignId ?? null;
        await tx.thread.update({
          where: { id },
          data: { leadId, campaignId, campaignLeadId: t.campaignLeadId ?? cl?.id ?? null },
        });
        await tx.message.updateMany({
          where: { threadId: id, direction: "IN" },
          data: { leadId, campaignId },
        });
        const c = m && classificationOf(m, t.categorySource);
        if (m && c) {
          const ev = await tx.event.findUnique({
            where: { dedupeKey: `${c.kind}:${ws}:${m.rfcMessageId}` },
          });
          await applyInbound(tx, clock, {
            workspaceId: ws,
            message: { ...m, leadId, campaignId },
            classification: c,
            match: {
              leadId,
              campaignId,
              campaignLeadId: t.campaignLeadId ?? cl?.id ?? null,
              scheduledMessageId: m.scheduledMessageId,
              threadId: id,
            },
          });
          if (ev && !ev.leadId) {
            await tx.event.updateMany({
              where: { id: ev.id, leadId: null },
              data: { leadId, campaignId },
            });
            await tx.lead.update({
              where: { id: leadId },
              data: {
                ...(c.kind === "REPLY" && { replies: { increment: 1 } }),
                ...(!lead.lastReplyAt || m.sentAt > lead.lastReplyAt
                  ? { lastReplyAt: m.sentAt }
                  : {}),
              },
            });
          }
        }
        await audit(tx, { workspaceId: ws, actorId, at: clock.now() }, "inbox.attach_lead", id, {
          leadId,
        });
      },
      { timeout: 15_000 },
    ),
  );
}

/**
 * A stranger's reply becomes a lead and the thread is attached in one step; `attachLead` then runs the
 * stop rules once and audits. Bounces, complaints and unsubscribes have no person to add, and an erased or opted-out
 * address is never recreated.
 */
export async function createLeadFromThread(
  db: Db,
  clock: Clock,
  ws: string,
  actorId: Actor,
  id: string,
): Promise<{ leadId: string; created: boolean }> {
  const t = await db.thread.findFirst({ where: { id, workspaceId: ws, deletedAt: null } });
  if (!t) throw notFound();
  if (
    t.leadId &&
    (await db.lead.findFirst({
      where: { id: t.leadId, workspaceId: ws, deletedAt: null },
      select: { id: true },
    }))
  )
    throw new AccountError(409, "lead_attached");
  const m = await db.message.findFirst({
    where: { threadId: id, direction: "IN" },
    orderBy: [{ sentAt: "desc" }, { id: "desc" }],
  });
  if (!m || (m.kind !== "REPLY" && m.kind !== "AUTO_REPLY"))
    throw new AccountError(400, "not_a_person");
  const email = parseEmail(m.fromEmail);
  if (!email) throw new AccountError(400, "not_a_person");
  if (await isSuppressed(db, ws, email)) throw new AccountError(409, "suppressed");

  const live = () =>
    db.lead.findFirst({ where: { workspaceId: ws, email, deletedAt: null }, select: { id: true } });
  const existing = await live();
  let leadId = existing?.id;
  let created = false;
  if (!leadId) {
    const parts = !m.fromName || m.fromName.includes("@") ? [] : m.fromName.trim().split(/\s+/);
    const [firstName, ...rest] = parts;
    try {
      const lead = await createLead(
        db,
        ws,
        actorId,
        {
          email,
          source: "inbox_triage",
          ...(firstName && { firstName: firstName.slice(0, 100) }),
          ...(rest.length && { lastName: rest.join(" ").slice(0, 100) }),
        },
        "manual",
      );
      leadId = lead.id;
      created = true;
    } catch (e) {
      // a concurrent call created the same lead first
      if (!(e instanceof LeadError) || e.status !== 409) throw e;
      const raced = await live();
      if (!raced) throw e;
      leadId = raced.id;
    }
  }
  await attachLead(db, clock, ws, actorId, id, leadId);
  return { leadId, created };
}

export const bulkThreadsInput = z
  .strictObject({
    ids: z.array(z.string().min(1)).min(1).max(500).optional(),
    filter: threadFilterSchema.omit({ cursor: true, limit: true }).optional(),
    action: z.enum(["read", "unread", "delete", "set_interest", "blocklist"]),
    interestStatus: z.number().int().min(-4).max(4).nullable().optional(),
  })
  .refine((v) => (v.ids === undefined) !== (v.filter === undefined), "ids or filter");
const BULK_MAX = 1000;

export async function bulkThreads(
  db: Db,
  clock: Clock,
  ws: string,
  actorId: Actor,
  input: unknown,
) {
  const b = bulkThreadsInput.parse(input);
  const ids = b.ids
    ? (
        await db.thread.findMany({
          where: { id: { in: b.ids }, workspaceId: ws, deletedAt: null },
          select: { id: true },
        })
      ).map((t) => t.id)
    : await threadIds(db, ws, b.filter!, BULK_MAX);
  const where = { id: { in: ids }, workspaceId: ws };
  if (b.action === "read" || b.action === "unread")
    await db.thread.updateMany({ where, data: { isRead: b.action === "read" } });
  else if (b.action === "delete")
    await db.thread.updateMany({ where, data: { deletedAt: clock.now() } });
  else if (b.action === "set_interest") {
    if (b.interestStatus === undefined) throw new AccountError(400, "interestStatus_required");
    const leads = await db.thread.findMany({ where, select: { leadId: true } });
    const leadIds = [...new Set(leads.flatMap((t) => (t.leadId ? [t.leadId] : [])))];
    if (leadIds.length)
      await bulkLeads(
        db,
        clock,
        ws,
        { ids: leadIds, action: "set_interest", value: b.interestStatus },
        actorId,
      );
  } else {
    const own = (
      await db.emailAccount.findMany({ where: { workspaceId: ws }, select: { email: true } })
    ).map((a) => a.email);
    const from = await db.message.findMany({
      where: { workspaceId: ws, threadId: { in: ids }, direction: "IN", fromEmail: { notIn: own } },
      select: { fromEmail: true },
      distinct: ["fromEmail"],
      take: BULK_MAX,
    });
    if (from.length)
      await addBlocklist(
        db,
        ws,
        actorId,
        from.map((m) => m.fromEmail),
      );
  }
  await audit(db, { workspaceId: ws, actorId, at: clock.now() }, "inbox.bulk", undefined, {
    action: b.action,
    count: ids.length,
  });
  return { affected: ids.length };
}

/** The stored file, for the download route only (the sole reader of `data`). */
export const getAttachment = (db: Db, ws: string, id: string) =>
  db.attachment.findFirst({ where: { id, message: { workspaceId: ws } } });
