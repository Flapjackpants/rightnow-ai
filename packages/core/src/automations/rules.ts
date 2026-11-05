import type { AutomationRule, AutomationRun, Prisma, PrismaClient } from "@rightnow/db/client";
import { z } from "zod";
import { AccountError, notFound } from "../accounts/service";
import { scopeAllows } from "../apikeys";
import { audit } from "../audit";
import { normalizeCountry } from "../leads/regions";
import {
  ACCOUNTLESS_TRIGGERS,
  ACTIONS,
  BUILTIN_RULES,
  LEADLESS_TRIGGERS,
  TRIGGERS,
  type RuleConditions,
} from "./engine";

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;
type Actor = string | null | undefined;
/** `scopes` is set when an API key calls (R6): each action then needs its own scope. */
type Caller = { scopes?: string[] };

const MAX_RULES = 50;
const id = z.string().min(1).max(100);
const word = z.string().trim().min(1).max(50);
const conditions = z.strictObject({
  campaignIds: z.array(id).max(100).optional(),
  accountIds: z.array(id).max(100).optional(),
  leadTags: z.array(word).max(100).optional(),
  interestCodes: z.array(z.number().int().min(-4).max(4)).max(9).optional(),
  labels: z.array(word).max(100).optional(),
});
export const ruleInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().optional(),
  trigger: z.string(),
  conditions: conditions.optional(),
  actions: z
    .array(z.looseObject({ type: z.string() }))
    .min(1)
    .max(10),
  position: z.number().int().min(0).max(1000).optional(),
});
type RuleInput = z.output<typeof ruleInput>;
type ActionEntry = { type: string } & Record<string, unknown>;

const bad = (m: string) => new AccountError(400, m);
function parse<S extends z.ZodType>(s: S, input: unknown): z.output<S> {
  const r = s.safeParse(input);
  if (!r.success) throw bad(r.error.issues[0]!.message);
  return r.data;
}

/** Trigger, action inputs, API-key scopes, trigger/action fit and workspace references; returns the parsed actions. */
async function validate(
  tx: Tx,
  ws: string,
  d: Pick<RuleInput, "trigger" | "conditions" | "actions">,
  c: Caller,
): Promise<ActionEntry[]> {
  if (!(d.trigger in TRIGGERS)) throw bad("unknown_trigger");
  const acts = d.actions.map(({ type, ...rest }) => {
    const a = ACTIONS[type];
    if (!a) throw bad("unknown_action");
    return { type, ...(parse(a.input, rest) as object) } as ActionEntry;
  });
  validateScopes(acts, c, d.trigger);
  for (const { type } of acts)
    if (
      (ACTIONS[type]!.lead && LEADLESS_TRIGGERS.has(d.trigger)) ||
      (type === "pause_account" && ACCOUNTLESS_TRIGGERS.has(d.trigger))
    )
      throw bad("action_not_applicable");
  const of = (t: string, k: string) =>
    acts.flatMap((a) => (a.type === t && typeof a[k] === "string" ? [a[k] as string] : []));
  const uniq = (a: string[]) => [...new Set(a)];
  const assignments = acts.filter((a) => a.type === "assign_owner");
  for (const a of assignments) {
    if (a.strategy !== "territory") continue;
    for (const t of a.territories as { countries?: string[]; regions?: string[] }[]) {
      if (!t.countries?.length && !t.regions?.length) throw bad("territory_empty");
      if (t.countries?.some((country) => !normalizeCountry(country))) throw bad("invalid_country");
    }
  }
  const campaigns = uniq([
    ...(d.conditions?.campaignIds ?? []),
    ...of("stop_sequence", "campaignId"),
    ...of("enroll_campaign", "campaignId"),
  ]);
  const accounts = uniq(d.conditions?.accountIds ?? []);
  const lists = uniq(of("add_to_list", "listId"));
  const subs = uniq(of("move_to_subsequence", "subsequenceId"));
  const users = uniq([
    ...of("assign_owner", "userId"),
    ...of("assign_owner", "fallbackUserId"),
    ...assignments.flatMap((a) => (Array.isArray(a.userIds) ? (a.userIds as string[]) : [])),
    ...assignments.flatMap((a) =>
      Array.isArray(a.territories)
        ? (a.territories as { userId: string }[]).map((t) => t.userId)
        : [],
    ),
    ...of("create_task", "assigneeId"),
  ]);
  const hooks = uniq(of("send_webhook", "webhookId"));
  const counts = await Promise.all([
    campaigns.length &&
      tx.campaign.count({ where: { id: { in: campaigns }, workspaceId: ws, deletedAt: null } }),
    accounts.length &&
      tx.emailAccount.count({ where: { id: { in: accounts }, workspaceId: ws, deletedAt: null } }),
    lists.length && tx.leadList.count({ where: { id: { in: lists }, workspaceId: ws } }),
    subs.length &&
      tx.subsequence.count({ where: { id: { in: subs }, campaign: { workspaceId: ws } } }),
    users.length && tx.member.count({ where: { workspaceId: ws, userId: { in: users } } }),
    hooks.length && tx.webhook.count({ where: { id: { in: hooks }, workspaceId: ws } }),
  ]);
  if (counts.some((n, i) => n !== [campaigns, accounts, lists, subs, users, hooks][i]!.length))
    throw bad("invalid_reference");
  return acts;
}

export const listRules = (db: Db, ws: string): Promise<AutomationRule[]> =>
  db.automationRule.findMany({
    where: { workspaceId: ws },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });

/** {name, trigger, conditions?, actions[1..10]}; ≤ 50 rules per workspace (409 rule_limit). */
export async function createRule(
  prisma: PrismaClient,
  ws: string,
  actor: Actor,
  input: unknown,
  c: Caller = {},
): Promise<AutomationRule> {
  const d = parse(ruleInput, input);
  return prisma.$transaction(async (tx) => {
    const actions = await validate(tx, ws, d, c);
    // serializes concurrent creates, so the limit holds (KEY SHARE from FK inserts does not wait on it)
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${ws} FOR NO KEY UPDATE`;
    const count = await tx.automationRule.count({ where: { workspaceId: ws } });
    if (count >= MAX_RULES) throw new AccountError(409, "rule_limit");
    const r = await tx.automationRule.create({
      data: {
        workspaceId: ws,
        name: d.name,
        enabled: d.enabled ?? true,
        trigger: d.trigger,
        conditions: d.conditions ?? {},
        actions: actions as Prisma.InputJsonArray,
        position: d.position ?? count,
      },
    });
    await audit(tx, { workspaceId: ws, actorId: actor }, "automation.create", r.id, {
      trigger: r.trigger,
    });
    return r;
  });
}

/** A partial patch, validated as the resulting rule (scopes always; references when trigger, conditions or actions change). */
export async function updateRule(
  prisma: PrismaClient,
  ws: string,
  actor: Actor,
  id: string,
  input: unknown,
  c: Caller = {},
): Promise<AutomationRule> {
  const p = parse(ruleInput.partial(), input);
  return prisma.$transaction(async (tx) => {
    const cur = await tx.automationRule.findFirst({ where: { id, workspaceId: ws } });
    if (!cur) throw notFound();
    const next = {
      trigger: p.trigger ?? cur.trigger,
      conditions: p.conditions ?? (cur.conditions as RuleConditions),
      actions: p.actions ?? (cur.actions as ActionEntry[]),
    };
    const changed =
      p.trigger !== undefined || p.conditions !== undefined || p.actions !== undefined;
    let actions: ActionEntry[] | undefined;
    if (changed) actions = await validate(tx, ws, next, c);
    else validateScopes(next.actions, c, next.trigger);
    const r = await tx.automationRule.update({
      where: { id },
      data: {
        ...(p.name !== undefined && { name: p.name }),
        ...(p.enabled !== undefined && { enabled: p.enabled }),
        ...(p.position !== undefined && { position: p.position }),
        ...(changed && {
          trigger: next.trigger,
          conditions: next.conditions,
          actions: actions as Prisma.InputJsonArray,
        }),
      },
    });
    await audit(tx, { workspaceId: ws, actorId: actor }, "automation.update", id, {
      fields: Object.keys(p),
    });
    return r;
  });
}

/** Triggers whose payload carries the reply body (only REPLY Events: `reply_*` fields). */
const REPLY_TRIGGERS = new Set(["reply_received"]);

function validateScopes(actions: { type: string }[], c: Caller, trigger: string) {
  for (const { type } of actions) {
    const scope = ACTIONS[type]?.scope;
    if (c.scopes && scope && !scopeAllows(c.scopes, scope))
      throw new AccountError(403, `scope_required:${scope}`);
    // fix I1: send_webhook on a reply hands the reply body to the URL, which otherwise needs inbox:read (R12)
    if (
      c.scopes &&
      type === "send_webhook" &&
      REPLY_TRIGGERS.has(trigger) &&
      !scopeAllows(c.scopes, "inbox:read")
    )
      throw new AccountError(403, "scope_required:inbox:read");
    // M4: the payload carries lead fields on every trigger that names a lead
    if (
      c.scopes &&
      type === "send_webhook" &&
      !LEADLESS_TRIGGERS.has(trigger) &&
      !scopeAllows(c.scopes, "leads:read")
    )
      throw new AccountError(403, "scope_required:leads:read");
  }
}

export async function deleteRule(prisma: PrismaClient, ws: string, actor: Actor, id: string) {
  await prisma.$transaction(async (tx) => {
    if (!(await tx.automationRule.deleteMany({ where: { id, workspaceId: ws } })).count)
      throw notFound();
    await audit(tx, { workspaceId: ws, actorId: actor }, "automation.delete", id);
  });
}

/** Newest first, paged by cursor (the next page starts at `nextCursor`). */
export async function listRuns(
  db: Db,
  ws: string,
  ruleId: string,
  q: { cursor?: string; take?: number },
): Promise<{ runs: AutomationRun[]; nextCursor: string | null }> {
  if (!(await db.automationRule.count({ where: { id: ruleId, workspaceId: ws } })))
    throw notFound();
  const take = Math.min(Math.max(q.take ?? 50, 1), 200);
  const runs = await db.automationRun.findMany({
    where: { workspaceId: ws, ruleId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(q.cursor && { cursor: { id: q.cursor } }),
  });
  const next = runs.length > take ? runs.pop()! : null;
  return { runs, nextCursor: next?.id ?? null };
}

export async function builtinRules(
  db: Db,
  ws: string,
): Promise<((typeof BUILTIN_RULES)[number] & { enabled: boolean })[]> {
  const w = await db.workspace.findUniqueOrThrow({
    where: { id: ws },
    select: { crmAutoOpportunity: true },
  });
  return BUILTIN_RULES.map((b) => ({ ...b, enabled: b.locked || w.crmAutoOpportunity }));
}

/** Only `positive_reply_opportunity` (Workspace.crmAutoOpportunity); a locked one → 409 builtin_locked. */
export async function setBuiltin(
  prisma: PrismaClient,
  ws: string,
  actor: Actor,
  key: string,
  enabled: boolean,
): Promise<void> {
  const b = BUILTIN_RULES.find((x) => x.key === key);
  if (!b) throw notFound();
  if (b.locked) throw new AccountError(409, "builtin_locked");
  await prisma.$transaction(async (tx) => {
    await tx.workspace.update({ where: { id: ws }, data: { crmAutoOpportunity: enabled } });
    await audit(tx, { workspaceId: ws, actorId: actor }, "builtin.update", key, { enabled });
  });
}
