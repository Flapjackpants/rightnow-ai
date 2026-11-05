import type { Prisma, PrismaClient } from "@rightnow/db/client";
import { z } from "zod";
import { AccountError, isPrismaCode, notFound } from "../accounts/service";
import { requireScopes } from "../apikeys";
import { audit } from "../audit";
import { leadQuery } from "../leads/service";
import { RENDER_LEAD_FIELDS } from "../planner";
import { TemplateError, render } from "../template";
import { threadFilterSchema } from "./inbox";

type Db = PrismaClient;
type Actor = string | null | undefined;

const taken = (e: unknown) => {
  if (isPrismaCode(e, "P2002")) throw new AccountError(409, "name_taken");
  throw e;
};

// ---- Notes (PS-INBOX-08): on a thread or on a lead, exactly one
const noteBody = z.string().trim().min(1).max(10_000);
export const noteInput = z
  .strictObject({
    threadId: z.string().min(1).optional(),
    leadId: z.string().min(1).optional(),
    kind: z.enum(["note", "call", "sms", "meeting"]).default("note"), // D41: calls and meetings are logged by hand
    body: noteBody,
  })
  .refine((v) => (v.threadId === undefined) !== (v.leadId === undefined), "threadId or leadId");

export const notePatch = z.strictObject({ body: noteBody });

export const listNotes = (db: Db, ws: string, q: { threadId?: string; leadId?: string }) =>
  db.note.findMany({
    where: {
      workspaceId: ws,
      ...(q.threadId && { threadId: q.threadId }),
      ...(q.leadId && { leadId: q.leadId }),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

export async function createNote(db: Db, ws: string, actorId: Actor, input: unknown) {
  const n = noteInput.parse(input);
  const ok = n.threadId
    ? await db.thread.count({ where: { id: n.threadId, workspaceId: ws, deletedAt: null } })
    : await db.lead.count({ where: { id: n.leadId, workspaceId: ws } });
  if (!ok) throw notFound();
  return db.note.create({ data: { ...n, workspaceId: ws, authorId: actorId ?? null } });
}

export async function updateNote(db: Db, ws: string, id: string, input: unknown) {
  const { body } = notePatch.parse(input);
  const r = await db.note.updateMany({ where: { id, workspaceId: ws }, data: { body } });
  if (!r.count) throw notFound();
  return db.note.findUniqueOrThrow({ where: { id } });
}

export async function deleteNote(db: Db, ws: string, id: string) {
  if (!(await db.note.deleteMany({ where: { id, workspaceId: ws } })).count) throw notFound();
}

// ---- Macros (PS-INBOX-09) and saved views (PS-INBOX-07)
const name = z.string().trim().min(1).max(100);
export const macroInput = z.strictObject({ name, body: z.string().min(1).max(10_000) });
const threadView = threadFilterSchema.omit({ cursor: true });
// Leads scope: the Leads page's flat filter fields (strings, as in its query string); `leadQuery` is the real check.
const leadView = z.strictObject(
  Object.fromEntries(
    [
      ..."q tag label interestStatus verificationStatus ownerId listId openedNoReply".split(" "),
      ..."lastContactedFrom lastContactedTo customKey customContains".split(" "),
    ].map((k) => [k, z.string().max(200).optional()]),
  ),
);
const SCOPES = ["inbox", "leads"] as const;
export type ViewScope = (typeof SCOPES)[number];
export const viewInput = z.strictObject({
  name,
  scope: z.enum(SCOPES).default("inbox"),
  filters: z.union([leadView, threadView]), // leadView first: it adds no defaults, so lead filters pass through unchanged,
});

/** An API key (`scopes` set) needs `inbox:*` for inbox views and `leads:*` for leads views; a session is not checked. */
export function requireViewScope(
  scopes: string[] | undefined,
  scope: (typeof SCOPES)[number],
  verb: "read" | "create" | "update" | "delete",
) {
  const needed = `${scope === "leads" ? "leads" : "inbox"}:${verb === "read" ? "read" : scope === "leads" ? verb : "write"}`;
  requireScopes(scopes, needed);
}

/** The filters parsed for the view's scope, so an inbox view never holds lead fields and the reverse. */
function filtersFor(scope: (typeof SCOPES)[number], raw: unknown): Prisma.InputJsonObject {
  const bad = () => new AccountError(400, "invalid_filters");
  if (scope === "inbox") {
    const r = threadView.safeParse(raw);
    if (!r.success) throw bad();
    return r.data as unknown as Prisma.InputJsonObject;
  }
  const r = leadView.safeParse(raw);
  if (!r.success || !leadQuery.safeParse(r.data).success) throw bad();
  return r.data as Prisma.InputJsonObject;
}

export const listMacros = (db: Db, ws: string) =>
  db.macro.findMany({ where: { workspaceId: ws }, orderBy: { name: "asc" } });
export const listViews = (db: Db, ws: string, scope: (typeof SCOPES)[number] = "inbox") =>
  db.inboxView.findMany({ where: { workspaceId: ws, scope }, orderBy: { name: "asc" } });

export async function createMacro(db: Db, ws: string, actorId: Actor, input: unknown) {
  const row = await db.macro
    .create({ data: { ...macroInput.parse(input), workspaceId: ws } })
    .catch(taken);
  await audit(db, { workspaceId: ws, actorId }, "macro.create", row.id);
  return row;
}
export async function updateMacro(db: Db, ws: string, actorId: Actor, id: string, input: unknown) {
  const data = macroInput.partial().parse(input);
  if (!(await db.macro.updateMany({ where: { id, workspaceId: ws }, data }).catch(taken)).count)
    throw notFound();
  await audit(db, { workspaceId: ws, actorId }, "macro.update", id);
  return db.macro.findUniqueOrThrow({ where: { id } });
}
export async function deleteMacro(db: Db, ws: string, actorId: Actor, id: string) {
  if (!(await db.macro.deleteMany({ where: { id, workspaceId: ws } })).count) throw notFound();
  await audit(db, { workspaceId: ws, actorId }, "macro.delete", id);
}

export async function createView(db: Db, ws: string, actorId: Actor, input: unknown) {
  const v = viewInput.parse(input);
  const row = await db.inboxView
    .create({
      data: {
        name: v.name,
        scope: v.scope,
        filters: filtersFor(v.scope, v.filters),
        workspaceId: ws,
      },
    })
    .catch(taken);
  await audit(db, { workspaceId: ws, actorId }, "inbox_view.create", row.id);
  return row;
}
export async function updateView(db: Db, ws: string, actorId: Actor, id: string, input: unknown) {
  const v = viewInput.partial().parse(input);
  const cur = await db.inboxView.findFirst({ where: { id, workspaceId: ws } });
  if (!cur) throw notFound();
  const data = {
    ...(v.name && { name: v.name }),
    ...(v.filters && {
      filters: filtersFor(cur.scope as (typeof SCOPES)[number], v.filters),
    }),
  };
  if (!(await db.inboxView.updateMany({ where: { id, workspaceId: ws }, data }).catch(taken)).count)
    throw notFound();
  await audit(db, { workspaceId: ws, actorId }, "inbox_view.update", id);
  return db.inboxView.findUniqueOrThrow({ where: { id } });
}
export async function deleteView(db: Db, ws: string, actorId: Actor, id: string) {
  if (!(await db.inboxView.deleteMany({ where: { id, workspaceId: ws } })).count) throw notFound();
  await audit(db, { workspaceId: ws, actorId }, "inbox_view.delete", id);
}

async function renderContext(
  db: Db,
  ws: string,
  t: {
    leadId: string | null;
    account: { firstName: string; lastName: string; email: string };
  },
) {
  const lead = t.leadId
    ? await db.lead.findFirst({ where: { id: t.leadId, workspaceId: ws } })
    : null;
  const fields: Record<string, string | number | boolean | null> = {};
  if (lead) {
    const custom = lead.customFields;
    if (custom && typeof custom === "object" && !Array.isArray(custom))
      Object.assign(fields, custom as Record<string, string | number | boolean | null>);
    for (const k of RENDER_LEAD_FIELDS) fields[k] = lead[k];
  }
  const owner = lead?.ownerId
    ? await db.member.findFirst({
        where: { workspaceId: ws, userId: lead.ownerId },
        select: { user: { select: { name: true, email: true } } },
      })
    : null;
  fields.ownerName = owner?.user.name ?? null;
  fields.ownerEmail = owner?.user.email ?? null;
  const ctx = {
    lead: fields,
    sender: {
      firstName: t.account.firstName,
      lastName: t.account.lastName,
      email: t.account.email,
    },
  };
  return { ctx, lead, owner };
}

/** The macro filled in for the thread's lead and sending mailbox: `{text, html}` (the same renderer campaigns use). */
export async function renderMacro(db: Db, ws: string, id: string, threadId: string) {
  const macro = await db.macro.findFirst({ where: { id, workspaceId: ws } });
  const t = await db.thread.findFirst({
    where: { id: threadId, workspaceId: ws, deletedAt: null },
    include: { account: true },
  });
  if (!macro || !t) throw notFound();
  const { ctx } = await renderContext(db, ws, t);
  try {
    return {
      text: render(macro.body, ctx, { seed: threadId, html: false }),
      html: render(macro.body, ctx, { seed: threadId, html: true }),
    };
  } catch (e) {
    if (e instanceof TemplateError)
      throw new AccountError(400, "invalid_template", { issues: e.issues });
    throw e;
  }
}

const HANDOFF =
  "Hi {{firstName|there}},\n\nThanks for your reply. I'm bringing in {{ownerName}}, who will take it from here. You can reach them directly at {{ownerEmail}}.\n\nBest,\n{{sendingAccountFirstName}}";

export async function handoffDraft(
  db: Db,
  ws: string,
  threadId: string,
): Promise<{ text: string; cc: string; ownerName: string | null }> {
  const t = await db.thread.findFirst({
    where: { id: threadId, workspaceId: ws, deletedAt: null },
    include: { account: true },
  });
  if (!t) throw notFound();
  const { ctx, lead, owner } = await renderContext(db, ws, t);
  if (!lead || !owner) throw new AccountError(409, "no_owner");
  return {
    text: render(HANDOFF, ctx, { seed: threadId, html: false }),
    cc: owner.user.email,
    ownerName: owner.user.name,
  };
}
