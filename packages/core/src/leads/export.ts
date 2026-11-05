import type { Prisma, PrismaClient } from "@rightnow/db/client";
import { AccountError } from "../accounts/service";
import { scopeAllows } from "../apikeys";
import { audit } from "../audit";
import { listLeads, toApiLead, type LeadQuery } from "./service";
import { line } from "../csv";
export { csvCell, line } from "../csv"; // index.ts re-exports this file, so the public names stay

const FIXED = [
  ...["email", "firstName", "lastName", "companyName", "companyDomain", "jobTitle", "website"],
  ...[
    "industry",
    "phone",
    "personalization",
    "country",
    "region",
    "source",
    "lawfulBasis",
    "tags",
    "labels",
  ],
  ...["verificationStatus", "espType", "esg", "interestStatus", "createdAt"],
] as const;

async function* pages(prisma: Parameters<typeof listLeads>[0], ws: string, q: LeadQuery) {
  let cursor: string | undefined;
  do {
    const r = await listLeads(prisma, ws, { ...q, take: 100, cursor });
    yield r.leads;
    cursor = r.nextCursor ?? undefined;
  } while (cursor);
}

/** Streams the filtered leads page by page (two passes: custom columns are the union across all leads). */
export async function* exportLeadsCsv(
  prisma: Parameters<typeof listLeads>[0],
  ws: string,
  q: LeadQuery,
): AsyncIterable<string> {
  const keys = new Set<string>();
  for await (const leads of pages(prisma, ws, q))
    for (const l of leads)
      for (const k of Object.keys((l.customFields ?? {}) as object)) keys.add(k);
  const custom = [...keys].sort();
  yield line([...FIXED, ...custom]);
  for await (const leads of pages(prisma, ws, q)) {
    yield leads
      .map((l) => {
        const cf = (l.customFields ?? {}) as Record<string, unknown>;
        const row = FIXED.map((k) => {
          const v = l[k];
          return Array.isArray(v) ? v.join(";") : v;
        });
        return line([...row, ...custom.map((k) => cf[k])]);
      })
      .join("");
  }
}

/**
 * PS-LEAD-22: everything stored about one lead (a data-access export, audited as `lead.export`). Threads are the
 * lead's by `Thread.leadId` or by a message to/from/cc its address (exact, lowercase match; shortcut: leads merged
 * into this one are not folded in). Nothing of another lead or workspace is read.
 * I2: an API key (`c.scopes`) gets the threads only with `inbox:read` and notes/tasks/deals only with `crm:read`;
 * what it lacks is named in `omitted`.
 */
export async function exportLeadData(
  db: PrismaClient | Prisma.TransactionClient,
  ws: string,
  leadId: string,
  actorId?: string | null,
  c: { scopes?: string[] } = {},
) {
  const lead = await db.lead.findFirst({ where: { id: leadId, workspaceId: ws } });
  if (!lead) throw new AccountError(404, "Not found");
  const has = (s: string) => !c.scopes || scopeAllows(c.scopes, s);
  const omitted = [...(has("inbox:read") ? [] : ["threads"]), ...(has("crm:read") ? [] : ["crm"])];
  const byAddress = await db.message.findMany({
    where: {
      workspaceId: ws,
      OR: [{ fromEmail: lead.email }, { to: { has: lead.email } }, { cc: { has: lead.email } }],
    },
    select: { threadId: true },
    distinct: ["threadId"],
  });
  const found = await db.thread.findMany({
    where: { workspaceId: ws, OR: [{ leadId }, { id: { in: byAddress.map((m) => m.threadId) } }] },
    orderBy: [{ lastMessageAt: "asc" }, { id: "asc" }],
    include: { messages: { orderBy: [{ sentAt: "asc" }, { id: "asc" }] } },
  });
  // a thread that is not this lead's (another lead's or unassigned) shows only the messages that name this address; its notes stay out
  const involves = (m: { fromEmail: string; to: string[]; cc: string[] }) =>
    m.fromEmail === lead.email || m.to.includes(lead.email) || m.cc.includes(lead.email);
  const threads = found.map((t) =>
    t.leadId !== leadId ? { ...t, messages: t.messages.filter(involves) } : t,
  );
  const ownThreads = found.filter((t) => t.leadId === leadId).map((t) => t.id);
  const [notes, tasks, opportunities, events] = await Promise.all([
    db.note.findMany({
      where: { workspaceId: ws, OR: [{ leadId }, { threadId: { in: ownThreads } }] },
      orderBy: { createdAt: "asc" },
    }),
    db.task.findMany({ where: { workspaceId: ws, leadId }, orderBy: { createdAt: "asc" } }),
    db.opportunity.findMany({ where: { workspaceId: ws, leadId }, orderBy: { createdAt: "asc" } }),
    db.event.findMany({
      where: { workspaceId: ws, leadId },
      select: { id: true, type: true, occurredAt: true, campaignId: true, meta: true },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    }),
  ]);
  await audit(db, { workspaceId: ws, actorId }, "lead.export", leadId);
  return {
    lead: toApiLead(lead),
    ...(has("crm:read") && { notes, tasks, opportunities }),
    events,
    ...(omitted.length ? { omitted } : {}),
    ...(has("inbox:read") && {
      threads: threads.map((t) => ({
        id: t.id,
        subject: t.subject,
        messages: t.messages.map((m) => ({
          direction: m.direction,
          from: m.fromEmail,
          to: m.to,
          cc: m.cc,
          subject: m.subject,
          sentAt: m.sentAt,
          text: m.text,
          html: m.html,
          rfcMessageId: m.rfcMessageId,
        })),
      })),
    }),
  };
}
