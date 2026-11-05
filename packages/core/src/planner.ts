import { randomUUID } from "node:crypto";
import { convert } from "html-to-text";
import {
  Prisma,
  type AccountProvider,
  type Campaign,
  type CampaignSchedule,
  type EmailAccount,
  type Lead,
  type PrismaClient,
  type SequenceStep,
  type StepVariant,
  type Workspace,
} from "@rightnow/db/client";
import type { Clock } from "./clock";
import { cancelRows, editHooks, stopLead } from "./campaigns/hooks";
import { campaignVariables } from "./campaigns/sequence";
import { accountOk, withTxRetry } from "./dispatch";
import { getEnv } from "./env";
import { regionExcluded } from "./leads/regions";
import { suppressedEmails } from "./leads/suppression";
import { recordEvent } from "./mail/events";
import type { EspRule } from "./campaigns/schema";
import { committedToday, pickAccount, remainingToday, routeAllowed } from "./rotation";
import {
  addDelay,
  dayKey,
  isInWindow,
  localMidnightUtc,
  nextWindowStart,
  startOfNextDay,
  type Window,
} from "./schedule";
import { renderBody, renderSubject, templateVariables, TemplateError } from "./template";
import {
  listUnsubscribeHeaders,
  unsubscribeKeys,
  unsubscribeUrl,
  withComplianceFooter,
  type RenderEnv,
} from "./unsubscribe";
import { OPEN_STATES, OPEN_STATES_SQL } from "./campaigns/lead-status";

type Tx = Prisma.TransactionClient;
type Now = Pick<Clock, "now">;

const PLANNER_LOCK = 726003;
const PLAN_TX_MS = 30_000;
const MAX_PAGES = 10; // candidates examined per campaign and tick: at most 10 x batch
const BACKOFF_MS = 3600_000;
const LEAD_FIELDS = [
  "email",
  "firstName",
  "lastName",
  "companyName",
  "companyDomain",
  "jobTitle",
  "website",
  "industry",
  "phone",
  "personalization",
] as const;
export const RENDER_LEAD_FIELDS = LEAD_FIELDS;

export type PlanOpts = {
  stalenessSec: number;
  sendableProviders: AccountProvider[];
  env: RenderEnv;
  batch?: number;
  /** Test seam: runs inside each campaign's planning transaction, right after the planner lock is taken. */
  txHook?: (tx: Tx, campaignId: string) => Promise<void>;
};
export type PlanResult = {
  planned: number;
  revived: number;
  rerouted: number;
  skipped: number;
  completed: number;
};

const windowsOf = (s: Pick<CampaignSchedule, "timezone" | "days" | "from" | "to">[]): Window[] =>
  s.map(({ timezone, days, from, to }) => ({ timezone, days, from, to }));

// --- rendering ------------------------------------------------------------------------------------------------------

export type Rendered = {
  subject: string;
  html: string | null;
  text: string;
  headers: Record<string, string>;
};

/**
 * The exact text a row stores and the sender sends. Subject only via renderSubject (single line, whatever the lead
 * data holds); every campaign custom-field key is present (null when the lead lacks it) so fallbacks resolve; the
 * compliance footer and List-Unsubscribe headers come from unsubscribe.ts. `replyTo`: the subject a blank follow-up
 * subject answers ("Re: …", M7). Throws TemplateError, `physical_address_required` or `invalid_account_email`
 * (see renderProblem).
 */
export function renderForLead(p: {
  campaign: Campaign;
  step: SequenceStep;
  variant: StepVariant;
  lead: Lead;
  account: EmailAccount;
  workspace: Workspace;
  env: RenderEnv;
  customKeys?: Iterable<string>;
  replyTo?: string | null;
}): Rendered {
  const { campaign: c, step, variant: v, lead, account: a, workspace: w } = p;
  const fields: Record<string, string | number | boolean | null> = {};
  for (const k of p.customKeys ?? []) fields[k] = null;
  const custom = lead.customFields;
  if (custom && typeof custom === "object" && !Array.isArray(custom))
    Object.assign(fields, custom as Record<string, string | number | boolean | null>);
  for (const k of LEAD_FIELDS) fields[k] = lead[k];
  const unsub = { w: w.id, l: lead.id, c: c.id };
  const url = unsubscribeUrl(p.env, unsub, a.email);
  const headers = listUnsubscribeHeaders(p.env, unsub, a.email);
  const ctx = {
    lead: fields,
    sender: { firstName: a.firstName, lastName: a.lastName, email: a.email },
    unsubscribeLink: url,
  };
  const seed = `${lead.id}:${step.id}:${v.id}`;
  let subject: string;
  if (v.subject.trim()) subject = renderSubject(v.subject, ctx, seed).text;
  else if (p.replyTo) subject = /^re:/i.test(p.replyTo) ? p.replyTo : `Re: ${p.replyTo}`;
  else throw new TemplateError("The subject is empty and there is no earlier email to reply to");
  const first = step.subsequenceId === null && step.order === 1;
  const textOnly = c.textOnly || (first && (c.firstEmailTextOnly || w.firstEmailTextOnly));
  const html = renderBody(v.body, ctx, { seed, html: true }).text;
  const out = withComplianceFooter(
    { html: textOnly ? null : html, text: convert(html, { wordwrap: false }) },
    {
      unsubscribeUrl: url,
      physicalAddress: w.physicalAddress ?? "",
      hasLinkVariable: templateVariables(v.body).includes("unsubscribeLink"),
      link: c.unsubscribeLink,
      optOutText: c.optOutText,
    },
  );
  return { subject, html: out.html, text: out.text, headers };
}

const PROBLEMS: Record<string, string> = {
  physical_address_required:
    "Add your physical mailing address in workspace settings. Every campaign email must carry it.",
  invalid_account_email:
    "The sending account's address is not a plain email address, so no unsubscribe link can be built.",
};

/** A render failure the user can fix (template, address, account email), as a clear message; null for anything else. */
export function renderProblem(e: unknown): { code: string; message: string } | null {
  if (e instanceof TemplateError) return { code: "template_invalid", message: e.message };
  const m = e instanceof Error ? e.message : "";
  return PROBLEMS[m] ? { code: m, message: PROBLEMS[m] } : null;
}

const processEnv = (): RenderEnv => {
  const e = getEnv();
  return { appUrl: e.APP_URL, unsubscribeKeys: unsubscribeKeys(e) };
};

/** The renderedSubject of the lead's first SENT email (normally step 1), for a blank follow-up subject. */
export const priorSubject = async (tx: Tx, campaignLeadId: string) =>
  (
    await tx.scheduledMessage.findFirst({
      where: { campaignLeadId, status: "SENT" },
      orderBy: [{ sentAt: "asc" }, { id: "asc" }],
      select: { renderedSubject: true },
    })
  )?.renderedSubject ?? null;

type RowRef = { campaignLeadId: string; stepId: string; variantId: string | null };

/** Loads `f(k)` once per key (awaited one at a time: a transaction runs one query at a time). */
const memo = <V>(f: (k: string) => Promise<V>) => {
  const m = new Map<string, Promise<V>>();
  return (k: string) => {
    if (!m.has(k)) m.set(k, f(k));
    return m.get(k)!;
  };
};

/**
 * Renders existing rows (I-1): the leads of all `rows` load in one query, and the shared data (campaign, workspace,
 * campaign custom-field keys, step, variant, account) once per call, not per row. A row renders to null when its
 * variant is gone or inactive (it must not be sent).
 */
async function rowRenderer(tx: Tx, rows: RowRef[], env: RenderEnv) {
  const cls = new Map(
    (
      await tx.campaignLead.findMany({ where: { id: { in: rows.map((r) => r.campaignLeadId) } } })
    ).map((c) => [c.id, c]),
  );
  const leads = new Map(
    (await tx.lead.findMany({ where: { id: { in: [...cls.values()].map((c) => c.leadId) } } })).map(
      (l) => [l.id, l],
    ),
  );
  const campaignOf = memo((id) => tx.campaign.findUniqueOrThrow({ where: { id } }));
  const workspaceOf = memo((id) => tx.workspace.findUniqueOrThrow({ where: { id } }));
  const keysOf = memo((id) => campaignVariables(tx, id));
  const stepOf = memo((id) => tx.sequenceStep.findUniqueOrThrow({ where: { id } }));
  const variantOf = memo((id) => tx.stepVariant.findUnique({ where: { id } }));
  const accountOf = memo((id) => tx.emailAccount.findUniqueOrThrow({ where: { id } }));
  return async (m: RowRef, accountId: string): Promise<Rendered | null> => {
    const variant = m.variantId ? await variantOf(m.variantId) : null;
    if (!variant?.active) return null;
    const cl = cls.get(m.campaignLeadId)!;
    const campaign = await campaignOf(cl.campaignId);
    return renderForLead({
      campaign,
      step: await stepOf(m.stepId),
      variant,
      lead: leads.get(cl.leadId)!,
      account: await accountOf(accountId),
      workspace: await workspaceOf(campaign.workspaceId),
      env,
      customKeys: await keysOf(campaign.id),
      replyTo: variant.subject.trim() ? null : await priorSubject(tx, cl.id),
    });
  };
}

const stored = (r: Rendered) => ({
  renderedSubject: r.subject,
  renderedBody: r.html ?? r.text,
  renderedText: r.text,
});

/**
 * Edit hook body (Revision 3): re-renders the SCHEDULED rows matching `where` in place, written back in one statement.
 * Rows a claim holds are skipped (SKIP LOCKED) and keep their text. A row whose variant is gone, or that no longer
 * renders, is CANCELLED (uncertainAt stays NULL, so the planner re-plans it with a working variant).
 */
export async function rerenderScheduled(tx: Tx, where: Prisma.Sql, env?: RenderEnv) {
  const rows = await tx.$queryRaw<
    {
      id: string;
      campaignLeadId: string;
      stepId: string;
      variantId: string | null;
      accountId: string;
    }[]
  >`
    SELECT id, "campaignLeadId", "stepId", "variantId", "accountId" FROM "ScheduledMessage"
    WHERE ${where} AND status = 'SCHEDULED' ORDER BY id FOR UPDATE SKIP LOCKED`;
  if (!rows.length) return;
  const render = await rowRenderer(tx, rows, env ?? processEnv());
  const ok = { id: [] as string[], s: [] as string[], b: [] as string[], t: [] as string[] };
  const bad: string[] = [];
  for (const m of rows) {
    let r: Rendered | null;
    try {
      r = await render(m, m.accountId);
    } catch (e) {
      if (!renderProblem(e)) throw e;
      r = null;
    }
    if (!r) bad.push(m.id);
    else {
      const x = stored(r);
      ok.id.push(m.id);
      ok.s.push(x.renderedSubject);
      ok.b.push(x.renderedBody);
      ok.t.push(x.renderedText);
    }
  }
  if (ok.id.length)
    await tx.$executeRaw`
      UPDATE "ScheduledMessage" sm SET "renderedSubject" = v.s, "renderedBody" = v.b, "renderedText" = v.t,
        "updatedAt" = now()
      FROM unnest(${ok.id}::text[], ${ok.s}::text[], ${ok.b}::text[], ${ok.t}::text[]) AS v(id, s, b, t)
      WHERE sm.id = v.id AND sm.status = 'SCHEDULED'`;
  if (bad.length)
    await tx.scheduledMessage.updateMany({
      where: { id: { in: bad }, status: "SCHEDULED" },
      data: { status: "CANCELLED", error: "rerender_failed" },
    });
}

// --- the row write --------------------------------------------------------------------------------------------------

/**
 * Inserts the (lead, step) row, or revives it when it exists as a plain CANCELLED row (same id). Anything else (any
 * live or finished status, or a row that ever had an unknown outcome) is left untouched and null is returned (C1).
 */
export async function upsertScheduled(
  tx: Tx,
  r: {
    workspaceId: string;
    campaignId: string;
    campaignLeadId: string;
    stepId: string;
    variantId: string;
    accountId: string;
    subject: string;
    body: string;
    text: string;
    now: Date;
  },
): Promise<{ id: string; revived: boolean } | null> {
  const ts = r.now.toISOString(); // ::timestamp drops the Z: columns hold UTC wall time
  const [row] = await tx.$queryRaw<{ id: string; revived: boolean }[]>`
    INSERT INTO "ScheduledMessage" (id, "workspaceId", "campaignId", "campaignLeadId", "stepId", "variantId",
      "accountId", "dueAt", status, "idempotencyKey", "renderedSubject", "renderedBody", "renderedText", cc, bcc,
      "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${r.workspaceId}, ${r.campaignId}, ${r.campaignLeadId}, ${r.stepId}, ${r.variantId},
      ${r.accountId}, ${ts}::timestamp, 'SCHEDULED', ${`${r.campaignLeadId}:${r.stepId}`}, ${r.subject}, ${r.body},
      ${r.text}, '{}', '{}', ${ts}::timestamp, ${ts}::timestamp)
    ON CONFLICT ("idempotencyKey") DO UPDATE SET status = 'SCHEDULED', "dueAt" = EXCLUDED."dueAt",
      "accountId" = EXCLUDED."accountId", "variantId" = EXCLUDED."variantId",
      "renderedSubject" = EXCLUDED."renderedSubject", "renderedBody" = EXCLUDED."renderedBody",
      "renderedText" = EXCLUDED."renderedText", error = NULL, "claimToken" = NULL, attempts = 0, "claimErrors" = 0,
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE "ScheduledMessage".status = 'CANCELLED' AND "ScheduledMessage"."uncertainAt" IS NULL
    RETURNING id, (xmax::text <> '0') AS revived`;
  return row ?? null;
}

// --- planDue --------------------------------------------------------------------------------------------------------

/**
 * One planner tick over every ACTIVE campaign (I5: a failing campaign is logged and the next one proceeds). Per campaign:
 * end-date completion, then (only inside a schedule window, after startAt) the planning transaction and the step-1
 * re-route pass, then housekeeping and completion. No provider calls.
 */
export async function planDue(db: PrismaClient, clock: Clock, o: PlanOpts): Promise<PlanResult> {
  const out: PlanResult = { planned: 0, revived: 0, rerouted: 0, skipped: 0, completed: 0 };
  const now = clock.now();
  const campaigns = await db.campaign.findMany({
    where: { status: "ACTIVE", deletedAt: null },
    include: { schedules: true },
    orderBy: { id: "asc" },
  });
  for (const c of campaigns) {
    try {
      if (c.endAt && c.endAt <= now) {
        out.completed += await withTxRetry(() =>
          db.$transaction((tx) => endCampaign(tx, c.id, now)),
        );
        continue;
      }
      await withTxRetry(() => db.$transaction((tx) => reviveUnassigned(tx, c.id, now)));
      if ((!c.startAt || c.startAt <= now) && isInWindow(windowsOf(c.schedules), now)) {
        const r = await withTxRetry(() =>
          db.$transaction((tx) => planCampaign(tx, c.id, now, o), { timeout: PLAN_TX_MS }),
        );
        out.planned += r.planned;
        out.revived += r.revived;
        out.skipped += r.skipped;
        out.rerouted += await withTxRetry(() =>
          db.$transaction((tx) => reroute(tx, c.id, now, o), { timeout: PLAN_TX_MS }),
        );
      }
      out.completed += await withTxRetry(() => db.$transaction((tx) => housekeep(tx, c.id, now)));
    } catch (e) {
      console.error(`planDue: campaign ${c.id} skipped this tick`, e);
    }
  }
  // gate M-7: archive/delete/end cancel with SKIP LOCKED, so a row a claim held then stays SCHEDULED; sweep it up here
  await db.$transaction((tx) =>
    cancelRows(
      tx,
      Prisma.sql`"campaignId" IN (SELECT id FROM "Campaign"
        WHERE status IN ('ARCHIVED', 'COMPLETED') OR "deletedAt" IS NOT NULL)`,
    ),
  );
  return out;
}

/**
 * Lock order (the I4/D21 planner exception): the advisory lock, then CampaignLead rows (FOR UPDATE SKIP LOCKED), then
 * only ScheduledMessage rows no claim can hold (new, or CANCELLED with uncertainAt NULL), then StepVariant.assigned and
 * CampaignDailyUsage.newLeads as the last statements. pickAccount and the cap counts only read.
 */
async function planCampaign(tx: Tx, campaignId: string, now: Date, o: PlanOpts) {
  const r = { planned: 0, revived: 0, skipped: 0 };
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLANNER_LOCK}::int, hashtext(${campaignId}))`;
  await o.txHook?.(tx, campaignId);
  const c = await tx.campaign.findUnique({ where: { id: campaignId } });
  if (!c || c.status !== "ACTIVE" || c.deletedAt) return r;
  const w = await tx.workspace.findUniqueOrThrow({ where: { id: c.workspaceId } });
  if (!w.physicalAddress?.trim()) return r; // sending is blocked anyway; the explainer says why
  const steps = await tx.sequenceStep.findMany({
    where: { campaignId, deletedAt: null },
    orderBy: [{ order: "asc" }, { id: "asc" }],
  });
  const first = steps.find((s) => s.subsequenceId === null);
  if (!first) return r;
  const ts = now.toISOString();
  const batch = o.batch ?? 200;

  const byId = new Map(steps.map((s) => [s.id, s]));
  const variants = await tx.stepVariant.findMany({
    where: { stepId: { in: steps.map((s) => s.id) }, active: true },
    orderBy: { label: "asc" },
  });
  const day = dayKey(w.timezone, now);
  // D46: with abResetDaily the balance key is today's counter (0 when it was last written on an earlier local day)
  const assigned = new Map(
    variants.map((v) => [
      v.id,
      !c.abResetDaily
        ? v.assigned
        : v.assignedDay?.toISOString().slice(0, 10) === day
          ? v.assignedToday
          : 0,
    ]),
  );
  const inc = new Map<string, number>();
  const subs = new Map(
    (await tx.subsequence.findMany({ where: { campaignId } })).map((s) => [s.id, s]),
  );
  const customKeys = await campaignVariables(tx, campaignId);
  // assigned live accounts: a lead whose ESP none of them may serve (tags, ESP rules) is durably unroutable
  const assignedAccounts = await tx.emailAccount.findMany({
    where: { deletedAt: null, campaigns: { some: { campaignId } } },
  });
  const rules = (c.espRoutingRules ?? []) as EspRule[];
  const routable = (esp: Lead["espType"]) =>
    assignedAccounts.some(
      (a) =>
        (!c.accountTags.length || a.tags.some((t) => c.accountTags.includes(t))) &&
        routeAllowed(rules, a.provider, esp),
    );
  const accounts = new Map<string, EmailAccount | null>(assignedAccounts.map((a) => [a.id, a]));
  const accountOf = async (id: string) => {
    if (!accounts.has(id)) accounts.set(id, await tx.emailAccount.findUnique({ where: { id } }));
    return accounts.get(id)!;
  };
  const from = localMidnightUtc(day, w.timezone).toISOString();
  const to = startOfNextDay(w.timezone, now).toISOString();
  const usage = await tx.campaignDailyUsage.findUnique({
    where: { campaignId_day: { campaignId, day: new Date(`${day}T00:00:00Z`) } },
  });
  let newLeads = 0;
  const newBudgetLeft = () =>
    c.maxNewLeadsPerDay === null || (usage?.newLeads ?? 0) + newLeads < c.maxNewLeadsPerDay;
  const units = 1 + c.cc.length + c.bcc.length;

  // rows already planned for today (dueAt on the workspace's day, not cancelled); this transaction's inserts included
  const companyToday = (domain: string, ws: boolean) => tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "ScheduledMessage" sm
    JOIN "SequenceStep" st ON st.id = sm."stepId"
    JOIN "CampaignLead" cl ON cl.id = sm."campaignLeadId"
    JOIN "Lead" l ON l.id = cl."leadId"
    WHERE sm."workspaceId" = ${w.id} AND (${ws}::boolean OR sm."campaignId" = ${campaignId})
      AND st."subsequenceId" IS NULL AND st."order" = 1 AND sm.status <> 'CANCELLED'
      AND sm."dueAt" >= ${from}::timestamp AND sm."dueAt" < ${to}::timestamp
      AND l."companyDomain" = ${domain}`;
  const subToday = (subId: string) => tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM "ScheduledMessage" sm JOIN "SequenceStep" st ON st.id = sm."stepId"
    WHERE st."subsequenceId" = ${subId} AND sm.status <> 'CANCELLED'
      AND sm."dueAt" >= ${from}::timestamp AND sm."dueAt" < ${to}::timestamp`;
  const atLimit = async (q: Promise<{ n: number }[]>, limit: number | null) =>
    limit !== null && ((await q)[0]?.n ?? 0) >= limit;

  // C-1 (I5): whatever is full for the rest of this tick is excluded from later pages, so it cannot starve other leads
  const seen: string[] = [];
  const fullAccounts = new Set<string>();
  const fullSubs = new Set<string>();
  const fullDomains = new Set<string>();
  const noCapacity = new Set<string>(); // ESPs for which pickAccount found no account with room this tick
  // a durable reason (no route, no variant, broken template, missing step) backs the lead off instead of looping hot
  const backOff = async (id: string, why: string) => {
    await tx.campaignLead.updateMany({
      where: { id },
      data: { nextDueAt: new Date(now.getTime() + BACKOFF_MS) },
    });
    console.warn(`planDue: lead ${id} backed off 1 h: ${why}`);
  };

  let written = 0;
  while (written < batch && seen.length < batch * MAX_PAGES) {
    // I3/C2: only the lead's current step, and only while no row for it exists except a plain CANCELLED one
    // G-I1: a lead waiting for verification never uses up the page budget (re-checked under the lock below)
    const due = await tx.$queryRaw<{ id: string }[]>`
      SELECT cl.id FROM "CampaignLead" cl
      WHERE cl."campaignId" = ${campaignId} AND cl.state IN ('QUEUED', 'ACTIVE')
        AND (${newBudgetLeft()}::boolean OR cl.state <> 'QUEUED')
        AND (cl."nextDueAt" IS NULL OR cl."nextDueAt" <= ${ts}::timestamp)
        AND cl.id <> ALL(${seen}::text[])
        AND (cl."accountId" IS NULL OR cl."accountId" <> ALL(${[...fullAccounts]}::text[]))
        AND (cl."subsequenceId" IS NULL OR cl."subsequenceId" <> ALL(${[...fullSubs]}::text[]))
        AND NOT EXISTS (SELECT 1 FROM "Lead" l WHERE l.id = cl."leadId" AND l."verificationStatus" = 'PENDING_JOB')
        AND NOT EXISTS (SELECT 1 FROM "ScheduledMessage" sm
          WHERE sm."campaignLeadId" = cl.id AND sm."stepId" = COALESCE(cl."currentStepId", ${first.id})
            AND (sm.status <> 'CANCELLED' OR sm."uncertainAt" IS NOT NULL))
      ORDER BY ((cl.state = 'QUEUED') = ${c.prioritizeNewLeads}::boolean) DESC, cl."nextDueAt" ASC NULLS FIRST, cl.id
      LIMIT ${batch}
      FOR UPDATE SKIP LOCKED`;
    if (!due.length) break;
    seen.push(...due.map((d) => d.id));
    const order = new Map(due.map((d, i) => [d.id, i]));
    const cls = (await tx.campaignLead.findMany({ where: { id: { in: [...order.keys()] } } })).sort(
      (a, b) => order.get(a.id)! - order.get(b.id)!,
    );
    const leads = new Map(
      (await tx.lead.findMany({ where: { id: { in: cls.map((x) => x.leadId) } } })).map((l) => [
        l.id,
        l,
      ]),
    );
    const blocked = await suppressedEmails(
      tx,
      w.id,
      [...leads.values()].map((l) => l.email),
    );

    for (const cl of cls) {
      if (written >= batch) break; // the rest are planned next tick
      const lead = leads.get(cl.leadId)!;
      const step = byId.get(cl.currentStepId ?? first.id);
      if (!step) {
        await backOff(cl.id, "its current step was deleted");
        continue;
      }
      if (lead.verificationStatus === "PENDING_JOB") continue; // D38: waits for the lead-verify job
      const stop = lead.deletedAt
        ? "SKIPPED"
        : blocked.has(lead.email)
          ? "SUPPRESSED"
          : regionExcluded(lead, w)
            ? "SKIPPED"
            : lead.verificationStatus === "INVALID" ||
                (lead.verificationStatus === "RISKY" && !c.allowRisky) ||
                (lead.verificationStatus === "CATCH_ALL" && !c.allowCatchAll)
              ? "SKIPPED"
              : null;
      if (stop) {
        await stopLead(tx, cl.id, stop, now);
        continue;
      }
      const isNew = cl.state === "QUEUED";
      if (isNew) {
        if (!newBudgetLeft()) continue;
        const dom = lead.companyDomain; // null (free mail) never matches a company rule
        if (dom && fullDomains.has(dom)) continue;
        if (
          dom &&
          ((await atLimit(companyToday(dom, false), c.perCompanyDailyLimit)) ||
            (await atLimit(companyToday(dom, true), w.perCompanyDailyLimit)))
        ) {
          fullDomains.add(dom);
          continue;
        }
      }
      const sub = step.subsequenceId ? subs.get(step.subsequenceId) : undefined;
      if (sub && (await atLimit(subToday(sub.id), sub.dailyLimit))) {
        fullSubs.add(sub.id);
        continue;
      }
      const choices = variants.filter((v) => v.stepId === step.id);
      if (!choices.length) {
        await backOff(cl.id, "its step has no active variant");
        continue;
      }

      // sticky sender once something was SENT; until then (step 1, or a subsequence entered from QUEUED) rotation picks
      let account: EmailAccount | null;
      if (cl.accountId) {
        if (fullAccounts.has(cl.accountId)) continue;
        account = await accountOf(cl.accountId);
        if (account?.deletedAt) continue; // housekeep pauses the lead (deleted sticky sender)
        // no burst: a backlog of follow-ups is planned only as far as today's allowance reaches
        if (
          account &&
          remainingToday(
            account,
            (await committedToday(tx, [account], now)).get(account.id)!,
            now,
          ) < units
        ) {
          fullAccounts.add(account.id);
          continue;
        }
      } else {
        if (!routable(lead.espType)) {
          await backOff(
            cl.id,
            `no assigned account may send to ${lead.espType} (tags or ESP rules)`,
          );
          continue;
        }
        if (noCapacity.has(lead.espType)) continue;
        account = await pickAccount(tx, {
          campaign: c,
          leadEsp: lead.espType,
          now,
          stalenessSec: o.stalenessSec,
          sendableProviders: o.sendableProviders,
        });
        if (!account) noCapacity.add(lead.espType);
      }
      if (!account) continue; // "not now": no row, the next tick tries again

      const variant = choices.reduce((best, v) =>
        assigned.get(v.id)! / v.weight < assigned.get(best.id)! / best.weight ? v : best,
      );
      let out: Rendered;
      try {
        out = renderForLead({
          campaign: c,
          step,
          variant,
          lead,
          account,
          workspace: w,
          env: o.env,
          customKeys,
          replyTo: variant.subject.trim() ? null : await priorSubject(tx, cl.id),
        });
      } catch (e) {
        const p = renderProblem(e);
        if (!p) throw e;
        r.skipped += 1; // M14: this lead only; the batch goes on
        await backOff(cl.id, `${p.code}: ${p.message}`);
        continue;
      }
      const row = await upsertScheduled(tx, {
        workspaceId: c.workspaceId,
        campaignId,
        campaignLeadId: cl.id,
        stepId: step.id,
        variantId: variant.id,
        accountId: account.id,
        subject: out.subject,
        body: out.html ?? out.text,
        text: out.text,
        now,
      });
      if (!row) continue;
      written += 1;
      if (row.revived) r.revived += 1;
      else r.planned += 1;
      await tx.campaignLead.updateMany({
        where: { id: cl.id, state: cl.state },
        data: { state: "ACTIVE", currentStepId: step.id },
      });
      if (isNew) newLeads += 1;
      assigned.set(variant.id, assigned.get(variant.id)! + 1);
      inc.set(variant.id, (inc.get(variant.id) ?? 0) + 1);
    }
  }
  // shortcut: a row re-planned from a paused variant counts in `assigned` twice (old and new variant), so a re-activated variant looks fuller than it is, until the daily reset; acceptable, fix by decrementing on cancel if it matters
  for (const [id, n] of [...inc].sort(([a], [b]) => (a < b ? -1 : 1)))
    await tx.$executeRaw`
      UPDATE "StepVariant" SET assigned = assigned + ${n}::int,
        "assignedToday" = CASE WHEN "assignedDay" = ${day}::date THEN "assignedToday" + ${n}::int ELSE ${n}::int END,
        "assignedDay" = ${day}::date
      WHERE id = ${id}`;
  if (newLeads)
    await tx.$executeRaw`
      INSERT INTO "CampaignDailyUsage" ("campaignId", day, "newLeads") VALUES (${campaignId}, ${day}::date, ${newLeads}::int)
      ON CONFLICT ("campaignId", day) DO UPDATE SET "newLeads" = "CampaignDailyUsage"."newLeads" + ${newLeads}::int`;
  return r;
}

/**
 * PS-ACC-27: SCHEDULED rows of leads without a sticky sender (main step 1, or a subsequence entered before anything
 * was sent) whose account is no longer usable move to a new pickAccount choice, re-rendered for it. Own transaction;
 * ScheduledMessage rows first (SKIP LOCKED), everything else is read.
 */
async function reroute(tx: Tx, campaignId: string, now: Date, o: PlanOpts) {
  const ts = now.toISOString();
  const rows = await tx.$queryRaw<
    {
      id: string;
      accountId: string;
      campaignLeadId: string;
      stepId: string;
      variantId: string | null;
      espType: Lead["espType"];
    }[]
  >`
    SELECT sm.id, sm."accountId", sm."campaignLeadId", sm."stepId", sm."variantId", l."espType"
    FROM "ScheduledMessage" sm
    JOIN "CampaignLead" cl ON cl.id = sm."campaignLeadId"
    JOIN "Lead" l ON l.id = cl."leadId"
    JOIN "EmailAccount" a ON a.id = sm."accountId"
    WHERE sm."campaignId" = ${campaignId} AND sm.status = 'SCHEDULED' AND cl."accountId" IS NULL
      AND NOT COALESCE((${accountOk(ts, o)}
        AND EXISTS (SELECT 1 FROM "CampaignAccount" ca WHERE ca."campaignId" = sm."campaignId" AND ca."accountId" = a.id)), false)
    ORDER BY sm."dueAt", sm.id
    LIMIT ${o.batch ?? 200}
    FOR UPDATE OF sm SKIP LOCKED`;
  if (!rows.length) return 0;
  const campaign = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  let n = 0;
  const render = await rowRenderer(tx, rows, o.env);
  for (const m of rows) {
    const to = await pickAccount(tx, {
      campaign,
      leadEsp: m.espType,
      now,
      stalenessSec: o.stalenessSec,
      sendableProviders: o.sendableProviders,
    });
    if (!to || to.id === m.accountId) continue;
    let r: Rendered | null;
    try {
      r = await render(m, to.id);
    } catch (e) {
      if (!renderProblem(e)) throw e;
      continue;
    }
    if (!r) continue; // variant gone: the claim cancels it and the planner re-plans
    n += (
      await tx.scheduledMessage.updateMany({
        where: { id: m.id, status: "SCHEDULED", accountId: m.accountId },
        data: { accountId: to.id, ...stored(r) },
      })
    ).count;
  }
  return n;
}

/** Past endAt (M1): COMPLETED and its SCHEDULED rows CANCELLED. */
async function endCampaign(tx: Tx, campaignId: string, now: Date) {
  const r = await tx.campaign.updateManyAndReturn({
    where: { id: campaignId, status: "ACTIVE" },
    data: { status: "COMPLETED", updatedAt: now },
    select: { id: true, workspaceId: true },
  });
  if (r.length) await cancelRows(tx, Prisma.sql`"campaignId" = ${campaignId}`);
  return completed(tx, r, now);
}

/** D43 / Rev 2 R5: one CAMPAIGN_COMPLETED per campaign the COMPLETED write returned; the count of them. */
async function completed(tx: Tx, rows: { id: string; workspaceId: string }[], now: Date) {
  for (const c of rows)
    await recordEvent(tx, {
      workspaceId: c.workspaceId,
      type: "CAMPAIGN_COMPLETED",
      occurredAt: now,
      campaignId: c.id,
      dedupeKey: `campaign_completed:${c.id}:${now.getTime()}`,
    });
  return rows.length;
}

/**
 * C2/I1: SCHEDULED rows that are not their lead's current step, or whose lead finished, are CANCELLED. A non-evergreen
 * campaign with no open lead and no open row is COMPLETED (one conditional statement).
 *
 * Deleted or unassigned sticky sender (P3-T10b re-review, gate I-3, D23, D39 N-2): a follow-up must come from the
 * lead's step-1 mailbox, so it is never re-routed. The lead is PAUSED ACCOUNT_UNASSIGNED (the explainer lists it;
 * `reviveUnassigned` reverses it once the mailbox is live and assigned again) and its SCHEDULED rows are CANCELLED, so
 * neither the planner nor the claim looks at it again every tick.
 */
async function housekeep(tx: Tx, campaignId: string, now: Date) {
  const orphaned = Prisma.sql`cl."campaignId" = ${campaignId} AND cl.state IN ('QUEUED', 'ACTIVE')
    AND cl."accountId" IS NOT NULL AND NOT ${stickyLive}`;
  await cancelRows(
    tx,
    Prisma.sql`"campaignId" = ${campaignId} AND EXISTS (SELECT 1 FROM "CampaignLead" cl
      WHERE cl.id = "ScheduledMessage"."campaignLeadId" AND ${orphaned})`,
  );
  await tx.$executeRaw`UPDATE "CampaignLead" cl SET state = 'PAUSED', "stopReason" = 'ACCOUNT_UNASSIGNED'
    WHERE ${orphaned}`;
  await cancelRows(
    tx,
    Prisma.sql`"campaignId" = ${campaignId} AND EXISTS (SELECT 1 FROM "CampaignLead" cl
      WHERE cl.id = "ScheduledMessage"."campaignLeadId" AND (cl.state IN ('COMPLETED', 'STOPPED')
        OR (cl."currentStepId" IS NOT NULL AND cl."currentStepId" <> "ScheduledMessage"."stepId")))`,
  );
  const done = await tx.$queryRaw<{ id: string; workspaceId: string }[]>`
    UPDATE "Campaign" c SET status = 'COMPLETED', "updatedAt" = ${now.toISOString()}::timestamp
    WHERE c.id = ${campaignId} AND c.status = 'ACTIVE' AND NOT c.evergreen
      AND NOT EXISTS (SELECT 1 FROM "CampaignLead" WHERE "campaignId" = c.id AND state = ANY(${OPEN_STATES_SQL}))
      AND NOT EXISTS (SELECT 1 FROM "ScheduledMessage" WHERE "campaignId" = c.id
        AND status IN ('SCHEDULED', 'SENDING', 'UNCERTAIN', 'HELD'))
    RETURNING c.id, c."workspaceId"`;
  return completed(tx, done, now);
}

/** The lead's sticky account (alias `cl`) is live and assigned to its campaign. */
const stickyLive = Prisma.sql`EXISTS (SELECT 1 FROM "EmailAccount" a JOIN "CampaignAccount" ca ON ca."accountId" = a.id
      WHERE a.id = cl."accountId" AND a."deletedAt" IS NULL AND ca."campaignId" = cl."campaignId")`;

/** D39 N-2: housekeeping's own pause ends once the sticky account is back; the lead is due now (planned this tick). */
function reviveUnassigned(tx: Tx, campaignId: string, now: Date) {
  return tx.$executeRaw`UPDATE "CampaignLead" cl SET state = 'ACTIVE', "stopReason" = NULL,
      "nextDueAt" = ${now.toISOString()}::timestamp
    WHERE cl."campaignId" = ${campaignId} AND cl.state = 'PAUSED' AND cl."stopReason" = 'ACCOUNT_UNASSIGNED'
      AND ${stickyLive}`;
}

// --- sequence movement ----------------------------------------------------------------------------------------------

/** Due time of `step` counted from `from`: its delay in the first schedule's zone, then the next window opening. */
async function dueAfter(tx: Tx, campaignId: string, from: Date, step: SequenceStep) {
  const sched = await tx.campaignSchedule.findMany({
    where: { campaignId },
    orderBy: { id: "asc" },
  });
  const t = addDelay(from, step.delayValue, step.delayUnit, sched[0]?.timezone ?? "UTC");
  try {
    return nextWindowStart(windowsOf(sched), t);
  } catch {
    return t; // no window can ever open: the planner never plans it, and the SENT transaction must not fail over it
  }
}

const isTrigger = (t: Prisma.JsonValue, f: (x: Record<string, unknown>) => boolean) =>
  !!t && typeof t === "object" && !Array.isArray(t) && f(t as Record<string, unknown>);

async function advance(
  tx: Tx,
  now: Date,
  id: string,
  stepId: string,
  from: Date,
  keepDue: boolean,
) {
  const cl = await tx.campaignLead.findUnique({ where: { id } });
  // a stopped or completed lead never moves again: a late SENT must not revive it into a subsequence
  if (!cl || cl.currentStepId !== stepId || !(OPEN_STATES as readonly string[]).includes(cl.state))
    return;
  const step = await tx.sequenceStep.findUniqueOrThrow({ where: { id: stepId } });
  const next = await tx.sequenceStep.findFirst({
    where: {
      campaignId: step.campaignId,
      subsequenceId: step.subsequenceId,
      deletedAt: null,
      order: { gt: step.order },
    },
    orderBy: [{ order: "asc" }, { id: "asc" }],
  });
  // sticky sender: the account of the lead's first SENT email (main step 1, or the first step of a subsequence entered
  // before anything was sent)
  const sent = cl.accountId
    ? null
    : await tx.scheduledMessage.findFirst({
        where: { campaignLeadId: id, stepId, status: "SENT" },
        select: { accountId: true },
      });
  const accountId = cl.accountId ?? sent?.accountId ?? null;
  const mine = { id, currentStepId: stepId };
  if (next) {
    await tx.campaignLead.updateMany({
      where: mine,
      data: {
        currentStepId: next.id,
        accountId,
        nextDueAt: keepDue ? cl.nextDueAt : await dueAfter(tx, step.campaignId, from, next),
      },
    });
    return;
  }
  await tx.campaignLead.updateMany({
    where: { ...mine, state: { in: [...OPEN_STATES] } },
    data: { state: "COMPLETED", completedAt: now, nextDueAt: null, accountId },
  });
  if (step.subsequenceId) return; // completed_no_reply follows the main sequence only
  await enterActivitySubsequence(tx, now, id, step.campaignId, "completed_no_reply");
}

/** Enters the campaign's first active ACTIVITY subsequence for `activity`, if any. */
export async function enterActivitySubsequence(
  tx: Tx,
  now: Date,
  campaignLeadId: string,
  campaignId: string,
  activity: "completed_no_reply" | "opened" | "clicked",
): Promise<void> {
  const subs = await tx.subsequence.findMany({
    where: { campaignId, active: true, activatedAt: { lte: now } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const hit = subs.find((s) =>
    isTrigger(s.trigger, (t) => t.kind === "ACTIVITY" && t.activity === activity),
  );
  if (hit) await enterSubsequence(tx, { now: () => now }, campaignLeadId, hit.id);
}

/**
 * Called by the sender and the resolver in the SENT transaction. No-op unless `stepId` is the lead's current step.
 * Next step: nextDueAt = next window after sentAt + its delay. Last step: COMPLETED, then a `completed_no_reply`
 * subsequence (main sequence only) is entered.
 */
export async function advanceLead(
  tx: Tx,
  clock: Now,
  p: { campaignLeadId: string; stepId: string; sentAt: Date },
): Promise<void> {
  await advance(tx, clock.now(), p.campaignLeadId, p.stepId, p.sentAt, false);
}

/**
 * C1: cancels the lead's SCHEDULED rows of the step and moves the lead past it, so the planner never revives them.
 * Main step 1 → STOPPED MANUAL (no sticky sender can exist), except for deleteStep (`keepDue`), where the next step
 * becomes the new step 1. Otherwise like advanceLead with sentAt = now; `keepDue` keeps nextDueAt.
 */
export async function skipStep(
  tx: Tx,
  clock: Now,
  campaignLeadId: string,
  stepId: string,
  o: { keepDue?: boolean } = {},
): Promise<void> {
  const now = clock.now();
  await cancelRows(tx, Prisma.sql`"campaignLeadId" = ${campaignLeadId} AND "stepId" = ${stepId}`);
  const step = await tx.sequenceStep.findUnique({ where: { id: stepId } });
  if (!step) return;
  if (step.subsequenceId === null && step.order === 1 && !o.keepDue) {
    await tx.campaignLead.updateMany({
      where: { id: campaignLeadId, currentStepId: stepId, state: { in: [...OPEN_STATES] } },
      data: { state: "STOPPED", stopReason: "MANUAL", nextDueAt: null, completedAt: now },
    });
    return;
  }
  await advance(tx, now, campaignLeadId, stepId, now, !!o.keepDue);
}

/** True when the lead ever had a non-revivable row in the subsequence: re-entering it could send a step twice. */
export async function subsequenceUsed(tx: Tx, campaignLeadId: string, subsequenceId: string) {
  return (
    (await tx.scheduledMessage.count({
      where: {
        campaignLeadId,
        step: { subsequenceId },
        OR: [{ status: { not: "CANCELLED" } }, { uncertainAt: { not: null } }],
      },
    })) > 0
  );
}

/**
 * C2, in the caller's transaction: cancels the lead's SCHEDULED rows first, then moves it to the subsequence's first
 * step (due after preDelayMinutes). Re-entry rule: false (nothing changes) when the lead is already in it, when it is
 * not active or has no step, or when a step of it ever went out (subsequenceUsed). A re-entry whose earlier rows were
 * only plainly cancelled is allowed; the planner then revives those rows in place (same id).
 */
export async function enterSubsequence(
  tx: Tx,
  clock: Now,
  campaignLeadId: string,
  subsequenceId: string,
): Promise<boolean> {
  const cl = await tx.campaignLead.findUnique({ where: { id: campaignLeadId } });
  if (!cl || cl.subsequenceId === subsequenceId) return false;
  const sub = await tx.subsequence.findFirst({
    where: { id: subsequenceId, campaignId: cl.campaignId, active: true },
    include: {
      steps: { where: { deletedAt: null }, orderBy: [{ order: "asc" }, { id: "asc" }], take: 1 },
    },
  });
  if (!sub?.steps[0] || (await subsequenceUsed(tx, campaignLeadId, subsequenceId))) return false;
  await editHooks.cancelOpenRows(tx, [campaignLeadId]);
  const r = await tx.campaignLead.updateMany({
    where: { id: campaignLeadId, state: cl.state }, // not overwriting a concurrent pause or stop
    data: {
      subsequenceId,
      state: cl.state === "PAUSED" ? "PAUSED" : "ACTIVE",
      stopReason: null,
      completedAt: null,
      currentStepId: sub.steps[0].id,
      nextDueAt: new Date(clock.now().getTime() + sub.preDelayMinutes * 60_000),
    },
  });
  return r.count > 0;
}

/** True when a LEAD_STATUS trigger lists `interest`. */
export const leadStatusTrigger = (t: Prisma.JsonValue, interest: number) =>
  isTrigger(
    t,
    (x) => x.kind === "LEAD_STATUS" && Array.isArray(x.interest) && x.interest.includes(interest),
  );

/** Leads waiting on a step whose delay changed: nextDueAt is recomputed from the previous step's sentAt. */
export async function recomputeDue(tx: Tx, stepId: string) {
  const step = await tx.sequenceStep.findUniqueOrThrow({ where: { id: stepId } });
  const prev = await tx.sequenceStep.findFirst({
    where: {
      campaignId: step.campaignId,
      subsequenceId: step.subsequenceId,
      deletedAt: null,
      order: { lt: step.order },
    },
    orderBy: [{ order: "desc" }, { id: "desc" }],
  });
  if (!prev) return; // a first step has no delay to apply (main step 1 is 0; a subsequence waits preDelayMinutes)
  const cls = await tx.campaignLead.findMany({
    where: { currentStepId: stepId, state: { in: [...OPEN_STATES] } },
    select: {
      id: true,
      messages: { where: { stepId: prev.id, status: "SENT" }, select: { sentAt: true } },
    },
  });
  for (const cl of cls) {
    const sentAt = cl.messages[0]?.sentAt;
    if (!sentAt) continue; // reached by a skip, not a send: keep its time
    await tx.campaignLead.updateMany({
      where: { id: cl.id, currentStepId: stepId },
      data: { nextDueAt: await dueAfter(tx, step.campaignId, sentAt, step) },
    });
  }
}
