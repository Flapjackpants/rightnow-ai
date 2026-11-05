import { randomBytes } from "node:crypto";
import { createPrisma } from "@rightnow/db/create";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Event, type EventType, type Prisma } from "@rightnow/db/client";
import { createTestDb } from "@rightnow/db/test-db";
import { AuthError, PermanentSendError } from "@rightnow/providers";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { recordProviderError } from "../src/accounts/health";
import { API_SCOPES } from "../src/apikeys";
import { analytics } from "../src/analytics/metrics";
import { exportActivityCsv } from "../src/analytics/export";
import { analyticsQuery } from "../src/analytics/query";
import { ACTIONS, BUILTIN_RULES, dispatchEvents, TRIGGERS } from "../src/automations/engine";
import {
  builtinRules,
  createRule,
  deleteRule,
  listRules,
  listRuns,
  setBuiltin,
  updateRule,
} from "../src/automations/rules";
import { fixedClock } from "../src/clock";
import { onInterestChange } from "../src/crm/opportunities";
import { ensureStages } from "../src/crm/stages";
import { evaluateHealth } from "../src/deliverability/health";
import { claimDue } from "../src/dispatch";
import { createLead, updateLead } from "../src/leads/service";
import { planDue } from "../src/planner";
import { createWebhook } from "../src/webhooks/service";
import { unsubscribeKeys } from "../src/unsubscribe";
import { insertDeliveries } from "../src/webhooks/deliver";
import { testEnv } from "./accounts-fixture";
import { planRow, seedCampaign } from "./campaign-fixture";

// the dispatcher's insertDeliveries, wrapped so a test can hold, fail or slow it (the real one runs unless replaced)
vi.mock("../src/webhooks/deliver", async (orig) => {
  const m = await orig<typeof import("../src/webhooks/deliver")>();
  return { ...m, insertDeliveries: vi.fn(m.insertDeliveries) };
});
const { insertDeliveries: realDeliveries } =
  await vi.importActual<typeof import("../src/webhooks/deliver")>("../src/webhooks/deliver");

let db: Awaited<ReturnType<typeof createTestDb>>;
const P = () => db.prisma;
const extra: PrismaClient[] = [];
const client = () => {
  const p = createPrisma(db.url, 5);
  extra.push(p);
  return p;
};
beforeAll(async () => {
  db = await createTestDb();
});
afterEach(() => {
  vi.mocked(insertDeliveries).mockImplementation(realDeliveries);
});
afterAll(async () => {
  await Promise.all(extra.map((p) => p.$disconnect()));
  await db.drop();
});

const T = new Date("2026-10-20T10:00:00Z");
const DAY = 86_400_000;
const clock = fixedClock(T);
let n = 0;

type World = Awaited<ReturnType<typeof world>>;
async function world(leads = 1) {
  const s = await seedCampaign(P(), { at: T, leads });
  return { ...s, lead: s.leads[0]?.lead, cl: s.leads[0]?.cl };
}
async function member(ws: string) {
  const id = `u${++n}`;
  await P().user.create({ data: { id, name: id, email: `${id}@x.io` } });
  await P().member.create({ data: { id, workspaceId: ws, userId: id, role: "member" } });
  return id;
}
const ev = (
  w: Pick<World, "ws">,
  type: EventType,
  o: Partial<Prisma.EventUncheckedCreateInput> = {},
) =>
  P().event.create({
    data: {
      workspaceId: w.ws,
      type,
      occurredAt: T,
      dedupeKey: `ev:${++n}`,
      ...o,
    },
  });
const reply = (w: World, o: Partial<Prisma.EventUncheckedCreateInput> = {}) =>
  ev(w, "REPLY", {
    leadId: w.lead!.id,
    campaignId: w.campaign.id,
    accountId: w.accounts[0]!.id,
    ...o,
  });
const rule = (w: Pick<World, "ws">, trigger: string, actions: object[], conditions?: object) =>
  createRule(P(), w.ws, null, { name: `r${++n}`, trigger, actions, conditions });
/** Dispatches until nothing is pending. */
async function drain(p: PrismaClient = P()) {
  const t = { events: 0, runs: 0, deliveries: 0 };
  for (;;) {
    const r = await dispatchEvents(p, clock, { maxMs: 0 });
    if (!r.events) return t;
    t.events += r.events;
    t.runs += r.runs;
    t.deliveries += r.deliveries;
  }
}
const runs = (ws: string) =>
  P().automationRun.findMany({ where: { workspaceId: ws }, orderBy: { id: "asc" } });
const err = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { status?: number; message?: string }) => ({ status: e.status, message: e.message }),
  );
const fake = (type: EventType, meta: Prisma.JsonValue = {}) => ({ type, meta }) as Event;

describe("triggers", () => {
  test("each trigger fires on its event and not on a near miss", () => {
    const cases: [string, Event, Event[]][] = [
      ["reply_received", fake("REPLY"), [fake("AUTO_REPLY")]],
      [
        "positive_reply",
        fake("INTEREST_CHANGED", { to: 1 }),
        [fake("INTEREST_CHANGED", { to: -1 }), fake("INTEREST_CHANGED", { to: null })],
      ],
      [
        "negative_reply",
        fake("INTEREST_CHANGED", { to: -1 }),
        [fake("INTEREST_CHANGED", { to: 1 }), fake("INTEREST_CHANGED", { to: null })],
      ],
      ["status_changed", fake("INTEREST_CHANGED", { to: null }), [fake("REPLY")]],
      ["label_added", fake("LABEL_ADDED", { label: "x" }), [fake("REPLY")]],
      ["unsubscribed", fake("UNSUBSCRIBE"), [fake("COMPLAINT")]],
      ["bounced", fake("BOUNCE_SOFT"), [fake("BOUNCE_UNKNOWN")]],
      ["campaign_completed", fake("CAMPAIGN_COMPLETED"), [fake("ACCEPTED")]],
      ["account_error", fake("ACCOUNT_ERROR", { reason: "auth" }), [fake("SEND_FAILED")]],
      [
        "send_failure_threshold",
        fake("ACCOUNT_ERROR", { reason: "bounce_rate" }),
        [fake("ACCOUNT_ERROR", { reason: "auth" })],
      ],
      ["quota_reached", fake("QUOTA_REACHED"), [fake("ACCEPTED")]],
      ["deal_won", fake("DEAL_WON"), [fake("DEAL_LOST")]],
      ["deal_lost", fake("DEAL_LOST"), [fake("DEAL_WON")]],
    ];
    expect(Object.keys(TRIGGERS).sort()).toEqual(cases.map((c) => c[0]).sort());
    expect(TRIGGERS.bounced!(fake("BOUNCE_HARD"))).toBe(true);
    for (const t of ["send_failures", "complaint_rate"])
      expect(TRIGGERS.send_failure_threshold!(fake("ACCOUNT_ERROR", { reason: t }))).toBe(true);
    for (const [k, hit, misses] of cases) {
      expect([k, TRIGGERS[k]!(hit)]).toEqual([k, true]);
      for (const m of misses) expect([k, TRIGGERS[k]!(m)]).toEqual([k, false]);
    }
  });

  test("a machine OPEN, a scanner CLICK and an Event of a soft-deleted lead fire nothing", async () => {
    const w = await world();
    for (const t of ["reply_received", "status_changed", "bounced"])
      await rule(w, t, [{ type: "create_task", title: "x" }]);
    await ev(w, "OPEN", { leadId: w.lead!.id, meta: { machine: true } });
    await ev(w, "CLICK", { leadId: w.lead!.id, meta: { scanner: true } });
    const gone = await P().lead.create({
      data: { workspaceId: w.ws, email: "gone@x.test", deletedAt: T },
    });
    await reply(w, { leadId: gone.id });
    await drain();
    expect(await runs(w.ws)).toEqual([]);
    expect(await P().event.count({ where: { workspaceId: w.ws, dispatchedAt: null } })).toBe(0);
  });
});

describe("conditions", () => {
  test("campaignIds and leadTags are AND-ed", async () => {
    const w = await world(2);
    const c2 = await seedCampaign(P(), { at: T, workspaceId: w.ws, useAccounts: w.accounts });
    const [vip, plain] = [w.leads[0]!.lead, w.leads[1]!.lead];
    await P().lead.update({ where: { id: vip.id }, data: { tags: ["vip"] } });
    const r = await rule(w, "reply_received", [{ type: "add_tag", tag: "hit" }], {
      campaignIds: [w.campaign.id],
      leadTags: ["vip"],
    });
    const e1 = await reply(w, { leadId: vip.id });
    await reply(w, { leadId: vip.id, campaignId: c2.campaign.id });
    await reply(w, { leadId: plain.id });
    await drain();
    expect((await runs(w.ws)).map((x) => [x.ruleId, x.eventId, x.status])).toEqual([
      [r.id, e1.id, "OK"],
    ]);
  });
});

describe("actions", () => {
  test("send_webhook builds the payload links from the dispatch appUrl (T00-A)", async () => {
    testEnv();
    const w = await world();
    const acc = w.accounts[0]!;
    const hook = await createWebhook(
      P(),
      w.ws,
      "u1",
      { url: "https://hook.test/h", events: ["email_sent"] },
      { allowPrivate: true, resolve: async () => ["127.0.0.1"] },
    );
    const th = await P().thread.create({
      data: {
        workspaceId: w.ws,
        accountId: acc.id,
        subject: "s",
        leadId: w.lead!.id,
        lastMessageAt: T,
      },
    });
    const m = await P().message.create({
      data: {
        workspaceId: w.ws,
        accountId: acc.id,
        threadId: th.id,
        rfcMessageId: `<a${++n}@x>`,
        direction: "IN",
        folder: "INBOX",
        fromEmail: w.lead!.email,
        to: [acc.email],
        subject: "s",
        text: "t",
        sentAt: T,
        kind: "REPLY",
      },
    });
    await rule(w, "reply_received", [{ type: "send_webhook", webhookId: hook.id }]);
    await reply(w, { messageId: m.id });
    await dispatchEvents(P(), clock, { maxMs: 0, appUrl: "https://inject.test" });
    const [d] = await P().webhookDelivery.findMany({ where: { webhookId: hook.id } });
    expect((d!.payload as { unibox_url: string }).unibox_url).toMatch(/^https:\/\/inject\.test\//);
  });

  test("stop_sequence stops the lead and cancels its open rows", async () => {
    const w = await world();
    const sm = await planRow(P(), {
      workspaceId: w.ws,
      campaignId: w.campaign.id,
      campaignLeadId: w.cl!.id,
      stepId: w.steps[0]!.id,
      accountId: w.accounts[0]!.id,
      dueAt: T,
    });
    await rule(w, "reply_received", [{ type: "stop_sequence" }]);
    await reply(w);
    await drain();
    expect(await P().campaignLead.findUniqueOrThrow({ where: { id: w.cl!.id } })).toMatchObject({
      state: "STOPPED",
      stopReason: "MANUAL",
    });
    expect((await P().scheduledMessage.findUniqueOrThrow({ where: { id: sm.id } })).status).toBe(
      "CANCELLED",
    );
  });

  test("create_opportunity opens one deal whose OPPORTUNITY Event carries the rule id", async () => {
    const w = await world();
    await ensureStages(P(), w.ws);
    const r = await rule(w, "reply_received", [{ type: "create_opportunity" }]);
    await reply(w);
    await reply(w);
    await drain();
    const deals = await P().opportunity.findMany({ where: { workspaceId: w.ws } });
    expect(deals.map((d) => [d.leadId, d.campaignId])).toEqual([[w.lead!.id, w.campaign.id]]);
    const opp = await P().event.findMany({ where: { workspaceId: w.ws, type: "OPPORTUNITY" } });
    expect(opp.map((e) => e.meta)).toEqual([
      { opportunityId: deals[0]!.id, value: "0.00", ruleId: r.id },
    ]);
  });

  test("create_task: OPEN, due at the event time + dueInDays, with the assignee", async () => {
    const w = await world();
    const u = await member(w.ws);
    await rule(w, "reply_received", [
      { type: "create_task", title: "Call", dueInDays: 2, assigneeId: u },
    ]);
    await reply(w, { occurredAt: new Date(T.getTime() - DAY) });
    await drain();
    const tasks = await P().task.findMany({ where: { workspaceId: w.ws } });
    expect(tasks.map((t) => [t.title, t.status, t.dueAt, t.assigneeId, t.leadId])).toEqual([
      ["Call", "OPEN", new Date(T.getTime() + DAY), u, w.lead!.id],
    ]);
  });

  test("suppress_contact: Suppression MANUAL/automation, CampaignLeads stopped", async () => {
    const w = await world();
    await rule(w, "reply_received", [{ type: "suppress_contact" }]);
    await reply(w);
    await drain();
    const s = await P().suppression.findMany({ where: { workspaceId: w.ws } });
    expect(s.map((x) => [x.kind, x.value, x.reason, x.source])).toEqual([
      ["EMAIL", w.lead!.email, "MANUAL", "automation"],
    ]);
    expect((await P().campaignLead.findUniqueOrThrow({ where: { id: w.cl!.id } })).state).toBe(
      "STOPPED",
    );
  });

  test("suppress_company_domain: Suppression DOMAIN/CUSTOMER/automation, the company's open leads stop", async () => {
    const w = await world();
    const domain = w.lead!.email.split("@")[1]!;
    const colleague = await P().lead.create({
      data: { workspaceId: w.ws, email: `colleague@${domain}` },
    });
    const c2 = await P().campaign.create({
      data: { workspaceId: w.ws, name: "c2", status: "ACTIVE" },
    });
    const colCl = await P().campaignLead.create({
      data: { workspaceId: w.ws, campaignId: c2.id, leadId: colleague.id, state: "ACTIVE" },
    });
    await rule(w, "deal_won", [{ type: "suppress_company_domain" }]);
    await ev(w, "DEAL_WON", { leadId: w.lead!.id });
    await drain();
    const s = await P().suppression.findMany({ where: { workspaceId: w.ws } });
    expect(s.map((x) => [x.kind, x.value, x.reason, x.source])).toEqual([
      ["DOMAIN", domain, "CUSTOMER", "automation"],
    ]);
    expect((await P().campaignLead.findUniqueOrThrow({ where: { id: colCl.id } })).state).toBe(
      "STOPPED",
    );
  });

  test("suppress_company_domain adds nothing for a free-mail lead", async () => {
    const w = await world();
    await P().lead.update({
      where: { id: w.lead!.id },
      data: { email: "someone@gmail.com" },
    });
    await rule(w, "deal_won", [{ type: "suppress_company_domain" }]);
    await ev(w, "DEAL_WON", { leadId: w.lead!.id });
    await drain();
    expect(await P().suppression.count({ where: { workspaceId: w.ws } })).toBe(0);
  });

  test("pause_account until next_day: PAUSED to the next local midnight; NEEDS_ATTENTION unchanged", async () => {
    const s = await seedCampaign(P(), {
      at: T,
      accounts: [{ timezone: "America/New_York" }, { lifecycle: "NEEDS_ATTENTION" }],
    });
    const [a, b] = s.accounts;
    const r = await rule(s, "quota_reached", [{ type: "pause_account", until: "next_day" }]);
    await ev(s, "QUOTA_REACHED", { accountId: a!.id });
    await ev(s, "QUOTA_REACHED", { accountId: b!.id });
    await drain();
    expect(await P().emailAccount.findUniqueOrThrow({ where: { id: a!.id } })).toMatchObject({
      lifecycle: "PAUSED",
      pausedUntil: new Date("2026-10-21T04:00:00Z"), // midnight in New York (EDT)
    });
    expect((await P().emailAccount.findUniqueOrThrow({ where: { id: b!.id } })).lifecycle).toBe(
      "NEEDS_ATTENTION",
    );
    const au = await P().auditLog.findMany({
      where: { workspaceId: s.ws, action: "account.pause" },
    });
    expect(au.map((x) => [x.target, x.meta])).toEqual([
      [a!.id, { until: "2026-10-21T04:00:00.000Z", ruleId: r.id }],
    ]);
  });

  test("add_to_list, enroll_campaign, move_to_subsequence, assign_owner, add_tag", async () => {
    const w = await world();
    const list = await P().leadList.create({ data: { workspaceId: w.ws, name: "L" } });
    const c2 = await seedCampaign(P(), { at: T, workspaceId: w.ws, useAccounts: w.accounts });
    const fresh = await P().lead.create({ data: { workspaceId: w.ws, email: "fresh@f.test" } });
    const sub = await P().subsequence.create({
      data: { campaignId: w.campaign.id, name: "S", trigger: {}, activatedAt: T },
    });
    const subStep = await P().sequenceStep.create({
      data: { campaignId: w.campaign.id, subsequenceId: sub.id, order: 1, delayValue: 0 },
    });
    const u = await member(w.ws);
    await rule(w, "reply_received", [
      { type: "add_to_list", listId: list.id },
      { type: "move_to_subsequence", subsequenceId: sub.id },
      { type: "assign_owner", userId: u },
      { type: "add_tag", tag: "hot" },
    ]);
    await rule(w, "label_added", [{ type: "enroll_campaign", campaignId: c2.campaign.id }]);
    await reply(w);
    await reply(w);
    await ev(w, "LABEL_ADDED", { leadId: fresh.id, meta: { label: "x" } });
    await drain();
    expect(await P().leadListMember.findMany({ where: { listId: list.id } })).toMatchObject([
      { leadId: w.lead!.id },
    ]);
    expect(await P().campaignLead.findUniqueOrThrow({ where: { id: w.cl!.id } })).toMatchObject({
      subsequenceId: sub.id,
      currentStepId: subStep.id,
    });
    expect(await P().lead.findUniqueOrThrow({ where: { id: w.lead!.id } })).toMatchObject({
      ownerId: u,
      tags: ["hot"],
    });
    expect(
      await P().campaignLead.findMany({
        where: { campaignId: c2.campaign.id },
        select: { leadId: true, state: true },
      }),
    ).toEqual([{ leadId: fresh.id, state: "QUEUED" }]);
    expect((await runs(w.ws)).map((r) => r.status)).toEqual(["OK", "OK", "OK"]);
  });
});

describe("owner assignment strategies", () => {
  test("round robin rotates, skips an owned lead, and keeps the cursor", async () => {
    const w = await world();
    const [a, b] = await Promise.all([member(w.ws), member(w.ws)]);
    const r = await rule(w, "label_added", [
      { type: "assign_owner", strategy: "round_robin", userIds: [a, b] },
    ]);
    const leads = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        P().lead.create({
          data: {
            workspaceId: w.ws,
            email: `rotation-${++n}-${i}@test.io`,
            ...(i === 1 ? { ownerId: b } : {}),
          },
        }),
      ),
    );
    for (const lead of leads) await ev(w, "LABEL_ADDED", { leadId: lead.id });
    await drain();
    expect(
      (
        await Promise.all(
          leads.map((lead) => P().lead.findUniqueOrThrow({ where: { id: lead.id } })),
        )
      ).map((lead) => lead.ownerId),
    ).toEqual([a, b, b, a, b]);
    expect((await P().automationRule.findUniqueOrThrow({ where: { id: r.id } })).assignCursor).toBe(
      4,
    );
  });

  test("removed members are skipped; no available member fails without assigning", async () => {
    const w = await world();
    const [a, b] = await Promise.all([member(w.ws), member(w.ws)]);
    await rule(w, "label_added", [
      { type: "assign_owner", strategy: "round_robin", userIds: [a, b] },
    ]);
    await P().member.deleteMany({ where: { workspaceId: w.ws, userId: a } });
    const lead = await P().lead.create({
      data: { workspaceId: w.ws, email: `removed-${++n}@test.io` },
    });
    await ev(w, "LABEL_ADDED", { leadId: lead.id });
    await drain();
    expect((await P().lead.findUniqueOrThrow({ where: { id: lead.id } })).ownerId).toBe(b);
    await P().member.deleteMany({ where: { workspaceId: w.ws, userId: b } });
    const other = await P().lead.create({
      data: { workspaceId: w.ws, email: `removed-${++n}@test.io` },
    });
    await ev(w, "LABEL_ADDED", { leadId: other.id });
    await drain();
    expect((await P().lead.findUniqueOrThrow({ where: { id: other.id } })).ownerId).toBeNull();
    expect((await runs(w.ws)).find((run) => run.status === "FAILED")?.error).toBe("no_assignee");
  });

  test("concurrent dispatchers split six leads evenly", async () => {
    const w = await world();
    const [a, b] = await Promise.all([member(w.ws), member(w.ws)]);
    await rule(w, "label_added", [
      { type: "assign_owner", strategy: "round_robin", userIds: [a, b] },
    ]);
    const leads = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        P().lead.create({ data: { workspaceId: w.ws, email: `concurrent-${++n}-${i}@test.io` } }),
      ),
    );
    for (const lead of leads) await ev(w, "LABEL_ADDED", { leadId: lead.id });
    await Promise.all([
      dispatchEvents(client(), clock, { maxMs: 0 }),
      dispatchEvents(client(), clock, { maxMs: 0 }),
    ]);
    await drain();
    const owners = await P().lead.findMany({
      where: { id: { in: leads.map((lead) => lead.id) } },
      select: { ownerId: true },
    });
    expect(owners.filter((lead) => lead.ownerId === a)).toHaveLength(3);
    expect(owners.filter((lead) => lead.ownerId === b)).toHaveLength(3);
  });

  test("territory matches normalized country or region, first match, then fallback", async () => {
    const w = await world();
    const [a, b, fallback] = await Promise.all([member(w.ws), member(w.ws), member(w.ws)]);
    await rule(w, "label_added", [
      {
        type: "assign_owner",
        strategy: "territory",
        territories: [
          { countries: ["DE"], userId: a },
          { regions: ["bavaria"], userId: b },
        ],
        fallbackUserId: fallback,
      },
    ]);
    const locations = [
      { country: "germany", region: " Bavaria " },
      { region: " Bavaria " },
      {},
      { country: "FR" },
    ];
    const leads = await Promise.all(
      locations.map((location, i) =>
        P().lead.create({
          data: { workspaceId: w.ws, email: `territory-${++n}-${i}@test.io`, ...location },
        }),
      ),
    );
    for (const lead of leads) await ev(w, "LABEL_ADDED", { leadId: lead.id });
    await drain();
    expect(
      (
        await Promise.all(
          leads.map((lead) => P().lead.findUniqueOrThrow({ where: { id: lead.id } })),
        )
      ).map((lead) => lead.ownerId),
    ).toEqual([a, b, fallback, fallback]);
    const noFallback = await world();
    await rule(noFallback, "label_added", [
      {
        type: "assign_owner",
        strategy: "territory",
        territories: [{ countries: ["DE"], userId: await member(noFallback.ws) }],
      },
    ]);
    await ev(noFallback, "LABEL_ADDED", { leadId: noFallback.lead!.id });
    await drain();
    expect((await runs(noFallback.ws))[0]).toMatchObject({
      status: "FAILED",
      error: "no_assignee",
    });
  });

  test("the original owner form still overwrites", async () => {
    const w = await world();
    const [a, b] = await Promise.all([member(w.ws), member(w.ws)]);
    await P().lead.update({ where: { id: w.lead!.id }, data: { ownerId: a } });
    await rule(w, "label_added", [{ type: "assign_owner", userId: b }]);
    await ev(w, "LABEL_ADDED", { leadId: w.lead!.id });
    await drain();
    expect((await P().lead.findUniqueOrThrow({ where: { id: w.lead!.id } })).ownerId).toBe(b);
  });

  test("validates strategy members, country, empty territory, and mixed input", async () => {
    const w = await world();
    const foreign = await member((await world()).ws);
    const a = await member(w.ws);
    for (const action of [
      { strategy: "round_robin", userIds: [a, foreign] },
      { strategy: "territory", territories: [{ countries: ["DE"], userId: foreign }] },
      {
        strategy: "territory",
        territories: [{ countries: ["DE"], userId: a }],
        fallbackUserId: foreign,
      },
    ])
      expect(await err(rule(w, "label_added", [{ type: "assign_owner", ...action }]))).toEqual({
        status: 400,
        message: "invalid_reference",
      });
    expect(
      await err(
        rule(w, "label_added", [
          {
            type: "assign_owner",
            strategy: "territory",
            territories: [{ countries: ["Nowhereland"], userId: a }],
          },
        ]),
      ),
    ).toEqual({ status: 400, message: "invalid_country" });
    expect(
      await err(
        rule(w, "label_added", [
          { type: "assign_owner", strategy: "territory", territories: [{ userId: a }] },
        ]),
      ),
    ).toEqual({ status: 400, message: "territory_empty" });
    expect(
      (
        await err(
          rule(w, "label_added", [
            { type: "assign_owner", userId: a, strategy: "round_robin", userIds: [a] },
          ]),
        )
      )?.status,
    ).toBe(400);
  });
});

describe("validation", () => {
  test("unknown trigger, 11 actions, foreign references, the 51st rule", async () => {
    const w = await world();
    const o = await world();
    const list = await P().leadList.create({ data: { workspaceId: o.ws, name: "L" } });
    const sub = await P().subsequence.create({
      data: { campaignId: o.campaign.id, name: "S", trigger: {} },
    });
    const u = await member(o.ws);
    expect(await err(rule(w, "nope", [{ type: "add_tag", tag: "a" }]))).toEqual({
      status: 400,
      message: "unknown_trigger",
    });
    expect(await err(rule(w, "reply_received", [{ type: "nope" }]))).toEqual({
      status: 400,
      message: "unknown_action",
    });
    expect(
      (await err(rule(w, "reply_received", Array(11).fill({ type: "add_tag", tag: "a" }))))?.status,
    ).toBe(400);
    for (const a of [
      { type: "add_to_list", listId: list.id },
      { type: "enroll_campaign", campaignId: o.campaign.id },
      { type: "move_to_subsequence", subsequenceId: sub.id },
      { type: "assign_owner", userId: u },
      { type: "create_task", title: "t", assigneeId: u },
    ])
      expect(await err(rule(w, "reply_received", [a]))).toEqual({
        status: 400,
        message: "invalid_reference",
      });
    expect(
      await err(
        rule(w, "reply_received", [{ type: "add_tag", tag: "a" }], {
          campaignIds: [o.campaign.id],
        }),
      ),
    ).toEqual({ status: 400, message: "invalid_reference" });
    for (let i = 0; i < 50; i++) await rule(w, "reply_received", [{ type: "add_tag", tag: "a" }]);
    expect(await err(rule(w, "reply_received", [{ type: "add_tag", tag: "a" }]))).toEqual({
      status: 409,
      message: "rule_limit",
    });
    expect((await listRules(P(), w.ws)).map((r) => r.position)).toEqual(
      Array.from({ length: 50 }, (_, i) => i),
    );
  });

  test("R6: an API key needs each action's scope; a lead action on a lead-less trigger is refused", async () => {
    const w = await world();
    const key = (actions: object[], scopes: string[], trigger = "reply_received") =>
      err(createRule(P(), w.ws, null, { name: "k", trigger, actions }, { scopes }));
    expect(await key([{ type: "suppress_contact" }], ["automations:write"])).toEqual({
      status: 403,
      message: "scope_required:blocklist:write",
    });
    expect(await key([{ type: "stop_sequence" }], ["automations:write", "leads:write"])).toEqual({
      status: 403,
      message: "scope_required:campaigns:write",
    });
    expect(await key([{ type: "pause_account" }], ["automations:write"])).toEqual({
      status: 403,
      message: "scope_required:accounts:write",
    });
    expect(
      await key([{ type: "create_task", title: "t" }], ["automations:write", "crm:write"]),
    ).toBe(null);
    expect(await key([{ type: "add_tag", tag: "t" }], ["all:all"])).toBe(null);
    expect(API_SCOPES).toEqual(expect.arrayContaining(["automations:read", "automations:write"]));
    expect(await err(rule(w, "quota_reached", [{ type: "stop_sequence" }]))).toEqual({
      status: 400,
      message: "action_not_applicable",
    });
    expect(await err(rule(w, "label_added", [{ type: "pause_account" }]))).toEqual({
      status: 400,
      message: "action_not_applicable",
    });
    expect(await err(rule(w, "account_error", [{ type: "create_task", title: "Check" }]))).toBe(
      null,
    );
    // the update is checked against the resulting rule
    const r = await rule(w, "quota_reached", [{ type: "create_task", title: "t" }]);
    expect(
      await err(updateRule(P(), w.ws, null, r.id, { actions: [{ type: "add_tag", tag: "x" }] })),
    ).toEqual({ status: 400, message: "action_not_applicable" });
    expect(
      await err(
        updateRule(
          P(),
          w.ws,
          null,
          r.id,
          { actions: [{ type: "pause_account" }] },
          { scopes: ["automations:write"] },
        ),
      ),
    ).toEqual({ status: 403, message: "scope_required:accounts:write" });
  });

  test("update, delete and runs are workspace scoped; runs page by cursor", async () => {
    const w = await world();
    const o = await world();
    const r = await rule(w, "reply_received", [{ type: "add_tag", tag: "a" }]);
    expect(await err(updateRule(P(), o.ws, null, r.id, { enabled: false }))).toEqual({
      status: 404,
      message: "Not found",
    });
    expect(await err(deleteRule(P(), o.ws, null, r.id))).toEqual({
      status: 404,
      message: "Not found",
    });
    expect(await err(listRuns(P(), o.ws, r.id, {}))).toEqual({ status: 404, message: "Not found" });
    for (let i = 0; i < 3; i++) await reply(w);
    await drain();
    const p1 = await listRuns(P(), w.ws, r.id, { take: 2 });
    expect(p1.runs).toHaveLength(2);
    const p2 = await listRuns(P(), w.ws, r.id, { take: 2, cursor: p1.nextCursor! });
    expect([p2.runs.length, p2.nextCursor]).toEqual([1, null]);
    expect(new Set([...p1.runs, ...p2.runs].map((x) => x.id)).size).toBe(3);
    expect((await updateRule(P(), w.ws, null, r.id, { enabled: false })).enabled).toBe(false);
    await deleteRule(P(), w.ws, null, r.id);
    expect(await listRules(P(), w.ws)).toEqual([]);
    expect(
      (
        await P().auditLog.findMany({
          where: { workspaceId: w.ws, action: { startsWith: "automation." } },
          orderBy: { createdAt: "asc" },
        })
      ).map((a) => a.action),
    ).toEqual(["automation.create", "automation.update", "automation.delete"]);
  });
});

describe("dispatch races", () => {
  test("two concurrent dispatchers over 100 replies and 2 rules: every (rule, event) once", async () => {
    const w = await world(10);
    await rule(w, "reply_received", [{ type: "create_task", title: "t" }]);
    await rule(w, "reply_received", [{ type: "add_tag", tag: "x" }]);
    await P().event.createMany({
      data: Array.from({ length: 100 }, (_, i) => ({
        workspaceId: w.ws,
        type: "REPLY" as const,
        occurredAt: T,
        leadId: w.leads[i % 10]!.lead.id,
        dedupeKey: `race:${w.ws}:${i}`,
      })),
    });
    // R3: a row inserted after the migration is pending
    expect(await P().event.count({ where: { workspaceId: w.ws, dispatchedAt: null } })).toBe(100);
    await Promise.all([drain(client()), drain(client())]);
    const r = await runs(w.ws);
    expect(r.filter((x) => x.status !== "OK").map((x) => x.error)).toEqual([]);
    expect([r.length, r.filter((x) => x.status === "OK").length]).toEqual([200, 200]);
    expect(await P().task.count({ where: { workspaceId: w.ws } })).toBe(100);
    expect(await P().event.count({ where: { workspaceId: w.ws, dispatchedAt: null } })).toBe(0);
    for (const l of w.leads)
      expect((await P().lead.findUniqueOrThrow({ where: { id: l.lead.id } })).tags).toEqual(["x"]);
  }, 60_000);

  test("forced interleaving: a second dispatcher skips the events a held batch claimed", async () => {
    const w = await world();
    await rule(w, "reply_received", [{ type: "create_task", title: "t" }]);
    await drain(); // nothing of this world is pending yet; clears other worlds
    const held = [];
    for (let i = 0; i < 20; i++) held.push(await reply(w));
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let inside!: () => void;
    const reached = new Promise<void>((r) => (inside = r));
    vi.mocked(insertDeliveries).mockImplementation(async () => {
      inside();
      await gate;
      return 0;
    });
    const first = dispatchEvents(client(), clock, { maxMs: 0 });
    await reached;
    vi.mocked(insertDeliveries).mockImplementation(async () => 0);
    const late = [];
    for (let i = 0; i < 5; i++) late.push(await reply(w));
    const second = await dispatchEvents(client(), clock, { maxMs: 0 });
    expect(second.events).toBe(5);
    open();
    expect((await first).events).toBe(20);
    const r = await runs(w.ws);
    expect(r.map((x) => x.eventId).sort()).toEqual([...held, ...late].map((e) => e.id).sort());
    expect(await P().task.count({ where: { workspaceId: w.ws } })).toBe(25);
  }, 60_000);

  test("R4: an action that throws records FAILED; the other rule and the stamp commit", async () => {
    const w = await world();
    const list = await P().leadList.create({ data: { workspaceId: w.ws, name: "L" } });
    const bad = await rule(w, "reply_received", [{ type: "add_to_list", listId: list.id }]);
    const good = await rule(w, "reply_received", [{ type: "create_task", title: "t" }]);
    await P().leadList.delete({ where: { id: list.id } }); // the FK now gives 23503
    const e = await reply(w);
    await drain();
    expect((await runs(w.ws)).map((x) => [x.ruleId, x.status, x.error]).sort()).toEqual(
      [
        [bad.id, "FAILED", "P2003"], // the LeadListMember FK (23503),
        [good.id, "OK", null],
      ].sort(),
    );
    expect(await P().task.count({ where: { workspaceId: w.ws } })).toBe(1);
    expect(await P().event.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({
      dispatchError: null,
    });
    expect((await P().event.findUniqueOrThrow({ where: { id: e.id } })).dispatchedAt).toEqual(T);
  });

  test("a forced 40P01 on the first try reruns the batch with the same counts", async () => {
    const w = await world();
    await rule(w, "reply_received", [{ type: "create_task", title: "t" }]);
    await drain();
    for (let i = 0; i < 3; i++) await reply(w);
    let tries = 0;
    vi.mocked(insertDeliveries).mockImplementation(async () => {
      if (++tries === 1) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      return 0;
    });
    expect(await drain()).toMatchObject({ events: 3, runs: 3 });
    expect(await P().task.count({ where: { workspaceId: w.ws } })).toBe(3);
    expect((await runs(w.ws)).length).toBe(3);
  });

  test("R1 poison event: stamped with dispatchError while the other 19 commit; the next batch moves on", async () => {
    const w = await world();
    await rule(w, "reply_received", [{ type: "create_task", title: "t" }]);
    await drain();
    const es = [];
    for (let i = 0; i < 20; i++) es.push(await reply(w));
    const poison = es[7]!;
    vi.mocked(insertDeliveries).mockImplementation(async (_tx, e) => {
      if (e.id === poison.id)
        throw Object.assign(new Error("bad payload"), { code: "bad_payload" });
      return 0;
    });
    expect(await dispatchEvents(P(), clock, { maxMs: 0 })).toMatchObject({ events: 20, runs: 19 });
    expect(await P().event.findUniqueOrThrow({ where: { id: poison.id } })).toMatchObject({
      dispatchedAt: T,
      dispatchError: "bad_payload",
    });
    expect((await runs(w.ws)).map((r) => r.eventId).sort()).toEqual(
      es
        .filter((e) => e !== poison)
        .map((e) => e.id)
        .sort(),
    );
    const next = await reply(w);
    expect(await dispatchEvents(P(), clock, { maxMs: 0 })).toMatchObject({ events: 1, runs: 1 });
    expect((await P().event.findUniqueOrThrow({ where: { id: next.id } })).dispatchedAt).toEqual(T);
  });

  test("R1: a batch whose retries are exhausted is retried one event at a time; a transient failure stays pending", async () => {
    const w = await world();
    await rule(w, "reply_received", [{ type: "create_task", title: "t" }]);
    await drain();
    const es = [];
    for (let i = 0; i < 4; i++) es.push(await reply(w));
    const [transient, broken] = [es[1]!, es[2]!];
    vi.mocked(insertDeliveries).mockImplementation(async (_tx, e) => {
      if (e.id === transient.id) throw Object.assign(new Error("deadlock"), { code: "40P01" });
      if (e.id === broken.id)
        throw Object.assign(new Error("bad payload"), { code: "bad_payload" });
      return 0;
    });
    // the run reports the transient failure; the events dispatched one by one stay committed
    expect(await err(dispatchEvents(P(), clock, { maxMs: 0 }))).toMatchObject({
      message: "deadlock",
    });
    expect(await P().event.findUniqueOrThrow({ where: { id: transient.id } })).toMatchObject({
      dispatchedAt: null,
      dispatchError: null,
    });
    // a genuinely non-retryable error is still isolated and stamped
    expect(await P().event.findUniqueOrThrow({ where: { id: broken.id } })).toMatchObject({
      dispatchedAt: T,
      dispatchError: "bad_payload",
    });
    expect(await P().task.count({ where: { workspaceId: w.ws } })).toBe(2);
    // the next tick retries only the pending event
    vi.mocked(insertDeliveries).mockImplementation(async () => 0);
    expect(await dispatchEvents(P(), clock, { maxMs: 0 })).toMatchObject({ events: 1, runs: 1 });
    expect(await P().task.count({ where: { workspaceId: w.ws } })).toBe(3);
  });

  test("an event too slow on its own (solo P2028) is stamped with a FAILED run; the others dispatch", async () => {
    const w = await world();
    const r = await rule(w, "reply_received", [{ type: "create_task", title: "t" }]);
    await drain();
    const es = [await reply(w), await reply(w), await reply(w)];
    const slow = es[1]!;
    vi.mocked(insertDeliveries).mockImplementation(async (_tx, e) => {
      if (e.id === slow.id) await new Promise((ok) => setTimeout(ok, 1_500));
      return 0;
    });
    expect(await dispatchEvents(P(), clock, { maxMs: 0, txTimeoutMs: 800 })).toMatchObject({
      events: 3,
      runs: 3,
    });
    expect(await P().event.findUniqueOrThrow({ where: { id: slow.id } })).toMatchObject({
      dispatchedAt: T,
      dispatchError: "P2028",
    });
    expect((await runs(w.ws)).map((x) => [x.eventId, x.ruleId, x.status, x.error]).sort()).toEqual(
      [
        [es[0]!.id, r.id, "OK", null],
        [slow.id, r.id, "FAILED", "P2028"],
        [es[2]!.id, r.id, "OK", null],
      ].sort(),
    );
    expect(await P().task.count({ where: { workspaceId: w.ws } })).toBe(2);
  }, 30_000);

  test("a lock wait past lock_timeout (55P03) stays pending and dispatches once the lock is gone", async () => {
    const w = await world();
    await rule(w, "reply_received", [{ type: "add_tag", tag: "x" }]);
    await drain();
    const e = await reply(w);
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    let locked!: () => void;
    const holding = new Promise<void>((ok) => (locked = ok));
    const held = P().$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Lead" WHERE id = ${w.lead!.id} FOR UPDATE`;
        locked();
        await gate;
      },
      { timeout: 20_000 },
    );
    await holding;
    const o = { maxMs: 0, txTimeoutMs: 1_500, lockTimeoutMs: 300 };
    expect((await err(dispatchEvents(client(), clock, o)))?.message).toMatch(/55P03|lock timeout/);
    expect(await P().event.findUniqueOrThrow({ where: { id: e.id } })).toMatchObject({
      dispatchedAt: null,
      dispatchError: null,
    });
    expect(await runs(w.ws)).toEqual([]);
    release();
    await held;
    expect(await dispatchEvents(P(), clock, o)).toMatchObject({ events: 1, runs: 1 });
    expect((await P().lead.findUniqueOrThrow({ where: { id: w.lead!.id } })).tags).toEqual(["x"]);
  }, 30_000);

  test("D43: Events of a workspace without enabled rules are only stamped (no savepoints)", async () => {
    await drain();
    const q = new PrismaClient({
      adapter: new PrismaPg({ connectionString: db.url, max: 2 }),
      log: [{ emit: "event", level: "query" }],
    });
    extra.push(q);
    const sql: string[] = [];
    q.$on("query", (e) => sql.push(e.query));
    const bare = await world();
    for (let i = 0; i < 3; i++) await reply(bare);
    expect(await dispatchEvents(q, clock, { maxMs: 0 })).toMatchObject({ events: 3, runs: 0 });
    expect(sql.filter((x) => /SAVEPOINT/.test(x))).toEqual([]);
    expect(await P().event.count({ where: { workspaceId: bare.ws, dispatchedAt: null } })).toBe(0);
    // with a rule: SAVEPOINT evt, SAVEPOINT rule, RELEASE rule, RELEASE evt
    const ruled = await world();
    await rule(ruled, "reply_received", [{ type: "add_tag", tag: "x" }]);
    await reply(ruled);
    sql.length = 0;
    expect(await dispatchEvents(q, clock, { maxMs: 0 })).toMatchObject({ events: 1, runs: 1 });
    expect(sql.filter((x) => /SAVEPOINT/.test(x))).toHaveLength(4);
  });

  test("dispatchEvents returns within maxMs when idle", async () => {
    await drain();
    const t0 = Date.now();
    expect(await dispatchEvents(P(), clock, { maxMs: 300 })).toEqual({
      events: 0,
      runs: 0,
      deliveries: 0,
    });
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe("loop guard", () => {
  test("an Event with meta.ruleId runs no rule; an action's OPPORTUNITY Event is never evaluated", async () => {
    const w = await world();
    await ensureStages(P(), w.ws);
    await rule(w, "reply_received", [{ type: "create_task", title: "t" }]);
    await rule(w, "positive_reply", [{ type: "create_opportunity" }]);
    await rule(w, "deal_won", [{ type: "create_task", title: "won" }]);
    await reply(w, { meta: { ruleId: "r-x" } });
    // a deal created straight into a WON stage would record DEAL_WON: it carries the rule id too
    await P().lead.update({ where: { id: w.lead!.id }, data: { interestStatus: 4 } });
    await ev(w, "INTEREST_CHANGED", { leadId: w.lead!.id, meta: { from: null, to: 4 } });
    await drain();
    await drain();
    const r = await runs(w.ws);
    expect(r).toHaveLength(1); // only positive_reply
    const won = await P().event.findMany({ where: { workspaceId: w.ws, type: "DEAL_WON" } });
    expect(won.map((e) => (e.meta as { ruleId?: string }).ruleId)).toEqual([r[0]!.ruleId]);
    expect(await P().task.count({ where: { workspaceId: w.ws } })).toBe(0);
  });
});

describe("event producers", () => {
  const events = (ws: string, type: EventType) =>
    P().event.findMany({ where: { workspaceId: ws, type }, orderBy: { createdAt: "asc" } });

  test("AuthError → one ACCOUNT_ERROR auth; a second call while NEEDS_ATTENTION → none", async () => {
    const s = await seedCampaign(P(), { at: T, accounts: [{}] });
    const A = s.accounts[0]!;
    await recordProviderError(P(), clock, A.id, new AuthError("invalid_grant"));
    await recordProviderError(P(), clock, A.id, new AuthError("invalid_grant"));
    expect((await events(s.ws, "ACCOUNT_ERROR")).map((e) => [e.accountId, e.meta])).toEqual([
      [A.id, { reason: "auth" }],
    ]);
  });

  test("a plain client: the NEEDS_ATTENTION write and its ACCOUNT_ERROR commit together", async () => {
    const s = await seedCampaign(P(), { at: T, accounts: [{}] });
    const A = s.accounts[0]!;
    await P().$executeRawUnsafe(`CREATE FUNCTION no_acct_err() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN IF NEW.type = 'ACCOUNT_ERROR' THEN RAISE EXCEPTION 'crash'; END IF; RETURN NEW; END $$`);
    await P().$executeRawUnsafe(
      `CREATE TRIGGER no_acct_err BEFORE INSERT ON "Event" FOR EACH ROW EXECUTE FUNCTION no_acct_err()`,
    );
    try {
      await expect(
        recordProviderError(P(), clock, A.id, new AuthError("invalid_grant")),
      ).rejects.toThrow();
    } finally {
      await P().$executeRawUnsafe(`DROP TRIGGER no_acct_err ON "Event"`);
      await P().$executeRawUnsafe(`DROP FUNCTION no_acct_err()`);
    }
    expect((await P().emailAccount.findUniqueOrThrow({ where: { id: A.id } })).lifecycle).toBe(
      "ACTIVE",
    );
    // the retry then records both
    await recordProviderError(P(), clock, A.id, new AuthError("invalid_grant"));
    expect((await events(s.ws, "ACCOUNT_ERROR")).map((e) => e.meta)).toEqual([{ reason: "auth" }]);
  });

  test("three unknown-scope strikes → ACCOUNT_ERROR send_failures", async () => {
    const s = await seedCampaign(P(), { at: T, accounts: [{}] });
    const A = s.accounts[0]!;
    for (let i = 0; i < 3; i++) {
      await recordProviderError(P(), clock, A.id, new PermanentSendError("rejected"));
      if (i < 2) expect(await events(s.ws, "ACCOUNT_ERROR")).toEqual([]);
    }
    expect((await events(s.ws, "ACCOUNT_ERROR")).map((e) => [e.accountId, e.meta])).toEqual([
      [A.id, { reason: "send_failures" }],
    ]);
  });

  test("the D34 health pause → ACCOUNT_ERROR bounce_rate", async () => {
    const s = await seedCampaign(P(), { at: T, accounts: [{}] });
    const A = s.accounts[0]!;
    const mk = (type: EventType, k: number) =>
      P().event.createMany({
        data: Array.from({ length: k }, () => ({
          workspaceId: s.ws,
          type,
          occurredAt: new Date(T.getTime() - 3600_000),
          accountId: A.id,
          scheduledMessageId: `sm-${++n}`,
          dedupeKey: `h:${++n}`,
        })),
      });
    await mk("ACCEPTED", 100);
    await mk("BOUNCE_HARD", 4);
    await evaluateHealth(P(), clock);
    expect((await events(s.ws, "ACCOUNT_ERROR")).map((e) => [e.accountId, e.meta])).toEqual([
      [A.id, { reason: "bounce_rate" }],
    ]);
  });

  test("an account at its limit claimed twice in one day → one QUOTA_REACHED, written after the claim committed", async () => {
    const s = await seedCampaign(P(), { at: T, rows: 2, accounts: [{}] });
    const A = s.accounts[0]!;
    await P().accountDailyUsage.create({
      data: { accountId: A.id, day: new Date("2026-10-20T00:00:00Z"), sent: 5 },
    });
    const p = client();
    const inTx: number[] = [];
    const orig = p.$transaction.bind(p) as (...a: unknown[]) => Promise<unknown>;
    (p as { $transaction: unknown }).$transaction = (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
      o: unknown,
    ) =>
      orig(async (tx: Prisma.TransactionClient) => {
        const r = await fn(tx);
        inTx.push(await tx.event.count({ where: { workspaceId: s.ws, type: "QUOTA_REACHED" } }));
        return r;
      }, o);
    const o = { limit: 5, bootId: "b", stalenessSec: 300, sendableProviders: ["SMTP" as const] };
    expect(await claimDue(p, clock, o)).toEqual([]);
    await P().scheduledMessage.updateMany({
      where: { campaignId: s.campaign.id },
      data: { dueAt: T },
    });
    expect(await claimDue(p, clock, o)).toEqual([]);
    expect(inTx.length).toBeGreaterThan(0);
    expect(inTx.every((c) => c === 0 || c === 1)).toBe(true);
    expect(inTx[0]).toBe(0); // the first claim transaction never sees its own QUOTA_REACHED
    expect(
      (await events(s.ws, "QUOTA_REACHED")).map((e) => [e.accountId, e.meta, e.dedupeKey]),
    ).toEqual([[A.id, { day: "2026-10-20" }, `quota:${A.id}:2026-10-20`]]);
  });

  test("a campaign completed by housekeeping → one CAMPAIGN_COMPLETED; two campaigns → two", async () => {
    const a = await seedCampaign(P(), { at: T, leads: 1 });
    const b = await seedCampaign(P(), {
      at: T,
      workspaceId: a.ws,
      useAccounts: a.accounts,
      leads: 1,
    });
    await P().campaignLead.updateMany({
      where: { workspaceId: a.ws },
      data: { state: "COMPLETED" },
    });
    const ENV = {
      appUrl: "https://app.example.com",
      unsubscribeKeys: unsubscribeKeys({ ENCRYPTION_KEY: randomBytes(32).toString("base64") }),
    };
    await planDue(P(), clock, { stalenessSec: 300, sendableProviders: ["SMTP"], env: ENV });
    await planDue(P(), clock, { stalenessSec: 300, sendableProviders: ["SMTP"], env: ENV });
    expect((await events(a.ws, "CAMPAIGN_COMPLETED")).map((e) => e.campaignId).sort()).toEqual(
      [a.campaign.id, b.campaign.id].sort(),
    );
  });

  test("labels added by createLead / updateLead → one LABEL_ADDED per new label", async () => {
    const w = await world();
    const l = await createLead(P(), w.ws, null, { email: "lab@l.test", labels: ["A"] });
    await updateLead(P(), clock, w.ws, l.id, { labels: ["A", "B"] });
    await updateLead(P(), clock, w.ws, l.id, { labels: ["A", "B"] });
    expect((await events(w.ws, "LABEL_ADDED")).map((e) => [e.leadId, e.meta])).toEqual([
      [l.id, { label: "A" }],
      [l.id, { label: "B" }],
    ]);
  });

  test("analytics totals and the activity CSV ignore the four new types", async () => {
    const w = await world();
    const q = analyticsQuery.parse({ from: "2026-10-01", to: "2026-10-31" });
    const before = await analytics(P(), w.ws, q);
    const csv = async () => {
      let s = "";
      for await (const c of exportActivityCsv(P(), w.ws, q)) s += c;
      return s;
    };
    const csvBefore = await csv();
    for (const t of [
      "ACCOUNT_ERROR",
      "QUOTA_REACHED",
      "CAMPAIGN_COMPLETED",
      "LABEL_ADDED",
    ] as const)
      await ev(w, t, {
        campaignId: w.campaign.id,
        accountId: w.accounts[0]!.id,
        leadId: w.lead!.id,
      });
    expect(await analytics(P(), w.ws, q)).toEqual(before);
    expect(await csv()).toBe(csvBefore);
  });
});

describe("builtins", () => {
  test("six keys; only positive_reply_opportunity is unlocked and mirrors crmAutoOpportunity", async () => {
    const w = await world();
    expect(BUILTIN_RULES.map((b) => b.key)).toEqual([
      "positive_reply_opportunity",
      "unsubscribe_suppress",
      "bounce_stop_health",
      "quota_defer",
      "failure_pause",
      "deal_won_revenue",
    ]);
    for (const b of BUILTIN_RULES) {
      expect(b.reason.length).toBeGreaterThan(10);
      expect(b.trigger in TRIGGERS).toBe(true);
      for (const a of b.actions) expect(a in ACTIONS || a === "defer").toBe(true);
    }
    const list = await builtinRules(P(), w.ws);
    expect(list.map((b) => [b.key, b.locked, b.enabled])).toEqual([
      ["positive_reply_opportunity", false, true],
      ["unsubscribe_suppress", true, true],
      ["bounce_stop_health", true, true],
      ["quota_defer", true, true],
      ["failure_pause", true, true],
      ["deal_won_revenue", true, true],
    ]);
    expect(await err(setBuiltin(P(), w.ws, null, "unsubscribe_suppress", false))).toEqual({
      status: 409,
      message: "builtin_locked",
    });
    expect(await err(setBuiltin(P(), w.ws, null, "nope", false))).toEqual({
      status: 404,
      message: "Not found",
    });
    await setBuiltin(P(), w.ws, null, "positive_reply_opportunity", false);
    expect((await builtinRules(P(), w.ws))[0]!.enabled).toBe(false);
    expect(
      (await P().workspace.findUniqueOrThrow({ where: { id: w.ws } })).crmAutoOpportunity,
    ).toBe(false);
    expect(
      (await P().auditLog.findMany({ where: { workspaceId: w.ws, action: "builtin.update" } })).map(
        (a) => [a.target, a.meta],
      ),
    ).toEqual([["positive_reply_opportunity", { enabled: false }]]);
    // the D40 reply hook no longer opens a deal
    await P().$transaction((tx) =>
      onInterestChange(tx, clock, w.ws, null, [{ leadId: w.lead!.id, from: null, to: 1 }], {
        source: "reply",
        campaignId: w.campaign.id,
      }),
    );
    expect(await P().opportunity.count({ where: { workspaceId: w.ws } })).toBe(0);
  });
});

describe("A12: no automation sends mail by itself", () => {
  test("the action list is fixed and none composes or sends a message (an AI INTERESTED tag reaches no send)", async () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(
      [
        "add_tag",
        "add_to_list",
        "assign_owner",
        "create_opportunity",
        "create_task",
        "enroll_campaign",
        "move_to_subsequence",
        "pause_account",
        "send_webhook",
        "stop_sequence",
        "suppress_company_domain",
        "suppress_contact",
      ].sort(),
    );
    // enroll/move schedule the human-written campaign steps through the normal sender; nothing reads AI text
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/automations/engine.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from "\.\.\/(ai|mail)\//);
    expect(src).not.toMatch(/aiSuggestion|sendReply|scheduledMessage\.create/);
  });
});
