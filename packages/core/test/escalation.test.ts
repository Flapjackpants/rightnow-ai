import { createTestDb } from "@rightnow/db/test-db";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createRule } from "../src/automations/rules";
import { dispatchEvents } from "../src/automations/engine";
import { fixedClock } from "../src/clock";
import { runEscalationCheck } from "../src/crm/escalation";
import { createWebhook } from "../src/webhooks/service";
import { seedCampaign } from "./campaign-fixture";
import { testEnv } from "./accounts-fixture";
import { jobs } from "../../../apps/worker/src/jobs";

const T = new Date("2026-10-20T10:00:00Z");
const HOUR = 3_600_000;
let db: Awaited<ReturnType<typeof createTestDb>>;
let seq = 0;
const clock = () => fixedClock(T);
beforeAll(async () => {
  testEnv();
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});
async function world() {
  const w = await seedCampaign(db.prisma, { at: T, leads: 1 });
  const lead = w.leads[0]!.lead;
  return { ...w, lead };
}
async function member(ws: string) {
  const id = `escalation-user-${++seq}`;
  await db.prisma.user.create({ data: { id, name: id, email: `${id}@test.io` } });
  await db.prisma.member.create({ data: { id, workspaceId: ws, userId: id, role: "member" } });
  return id;
}
async function task(w: Awaited<ReturnType<typeof world>>, overrides: Record<string, unknown> = {}) {
  return db.prisma.task.create({
    data: {
      workspaceId: w.ws,
      title: "Call <lead>",
      leadId: w.lead.id,
      createdAt: T,
      escalateAfterHours: 4,
      nextEscalationAt: new Date(T.getTime() + 4 * HOUR),
      ...overrides,
    },
  });
}
async function outbound(
  w: Awaited<ReturnType<typeof world>>,
  t: Date,
  to: string[],
  scheduledMessageId?: string,
) {
  const thread = await db.prisma.thread.create({
    data: {
      workspaceId: w.ws,
      accountId: w.accounts[0]!.id,
      providerThreadId: `escalation-${++seq}`,
      leadId: w.lead.id,
      subject: "Reply",
      lastMessageAt: t,
    },
  });
  return db.prisma.message.create({
    data: {
      workspaceId: w.ws,
      accountId: w.accounts[0]!.id,
      threadId: thread.id,
      rfcMessageId: `escalation-${++seq}@test.io`,
      direction: "OUT",
      folder: "SENT",
      fromEmail: w.accounts[0]!.email,
      to,
      cc: [],
      subject: "Reply",
      sentAt: t,
      kind: "OUTBOUND",
      leadId: w.lead.id,
      scheduledMessageId,
    },
  });
}
const alerts = (ws: string) =>
  db.prisma.event.findMany({
    where: { workspaceId: ws, type: "ESCALATION_OVERDUE" },
    orderBy: { occurredAt: "asc" },
  });

test("worker registers the ten-minute escalation check", () => {
  expect(jobs.find((job) => job.name === "escalation-check")).toMatchObject({
    cron: "*/10 * * * *",
    options: { policy: "stately", retryLimit: 0, heartbeatSeconds: 10 },
  });
});

test("create_task schedules escalation and defaults assignee to the lead owner", async () => {
  const w = await world();
  const owner = await member(w.ws);
  await db.prisma.lead.update({ where: { id: w.lead.id }, data: { ownerId: owner } });
  await createRule(db.prisma, w.ws, null, {
    name: `escalation-${++seq}`,
    trigger: "positive_reply",
    actions: [{ type: "create_task", title: "Call", escalateAfterHours: 4 }],
  });
  await db.prisma.event.create({
    data: {
      workspaceId: w.ws,
      type: "INTEREST_CHANGED",
      leadId: w.lead.id,
      occurredAt: T,
      meta: { to: 1 },
      dedupeKey: `escalation-${++seq}`,
    },
  });
  await dispatchEvents(db.prisma, clock(), { maxMs: 0 });
  expect(
    await db.prisma.task.findFirst({ where: { workspaceId: w.ws, title: "Call" } }),
  ).toMatchObject({
    assigneeId: owner,
    escalateAfterHours: 4,
    nextEscalationAt: new Date(T.getTime() + 4 * HOUR),
  });
  await db.prisma.task.updateMany({ where: { workspaceId: w.ws }, data: { status: "DONE" } });
});

test("unscheduled, early, and DONE tasks do not alert; due task advances and stops after three", async () => {
  const w = await world();
  const c = clock();
  await task(w, { escalateAfterHours: null, nextEscalationAt: new Date(T.getTime() + 4 * HOUR) });
  await task(w, { status: "DONE" });
  const due = await task(w);
  expect(await runEscalationCheck(db.prisma, c)).toEqual({ alerted: 0, closed: 0 });
  for (let n = 1; n <= 3; n++) {
    c.advance(4 * HOUR);
    expect(await runEscalationCheck(db.prisma, c)).toEqual({ alerted: 1, closed: 0 });
    expect(await db.prisma.task.findUniqueOrThrow({ where: { id: due.id } })).toMatchObject({
      escalationAlerts: n,
      nextEscalationAt: n === 3 ? null : new Date(T.getTime() + (n + 1) * 4 * HOUR),
    });
    expect((await alerts(w.ws))[n - 1]?.meta).toMatchObject({
      taskId: due.id,
      alert: n,
      assigneeId: null,
    });
  }
  c.advance(40 * HOUR);
  expect(await runEscalationCheck(db.prisma, c)).toEqual({ alerted: 0, closed: 0 });
  expect(await alerts(w.ws)).toHaveLength(3);
});

test("direct answer after creation closes task; forward, campaign send, and older reply do not", async () => {
  const w = await world();
  const c = clock();
  c.advance(4 * HOUR);
  const done = await task(w);
  await outbound(w, new Date(T.getTime() + HOUR), [w.lead.email]);
  expect(await runEscalationCheck(db.prisma, c)).toEqual({ alerted: 0, closed: 1 });
  expect(await db.prisma.task.findUniqueOrThrow({ where: { id: done.id } })).toMatchObject({
    status: "DONE",
    completedAt: c.now(),
    nextEscalationAt: null,
  });
  expect(
    await db.prisma.auditLog.findFirst({
      where: { workspaceId: w.ws, action: "task.auto_done", target: done.id },
    }),
  ).toMatchObject({ meta: { taskId: done.id } });
  expect(await runEscalationCheck(db.prisma, c)).toEqual({ alerted: 0, closed: 0 });
  const other = await world();
  await outbound(other, new Date(T.getTime() + HOUR), ["rep@test.io"]);
  await outbound(other, new Date(T.getTime() + HOUR), [other.lead.email], `scheduled-${++seq}`);
  await outbound(other, new Date(T.getTime() - HOUR), [other.lead.email]);
  await task(other);
  expect(await runEscalationCheck(db.prisma, c)).toMatchObject({ alerted: 1, closed: 0 });
  expect(await alerts(other.ws)).toHaveLength(1);
});

test("concurrent checks claim once; leadless tasks alert; workspaces stay scoped", async () => {
  const a = await world();
  const b = await world();
  const c = clock();
  c.advance(4 * HOUR);
  const leadless = await task(a, { leadId: null });
  await task(b);
  await Promise.all([runEscalationCheck(db.prisma, c), runEscalationCheck(db.prisma, c)]);
  expect(await alerts(a.ws)).toHaveLength(1);
  expect(await alerts(b.ws)).toHaveLength(1);
  expect((await alerts(a.ws))[0]?.leadId).toBeNull();
  expect((await db.prisma.task.findUniqueOrThrow({ where: { id: leadless.id } })).status).toBe(
    "OPEN",
  );
});

test("overdue rule moves owner and task assignee; sole owner stays and run succeeds", async () => {
  const w = await world();
  const a = await member(w.ws);
  const b = await member(w.ws);
  await db.prisma.lead.update({ where: { id: w.lead.id }, data: { ownerId: a } });
  const t = await task(w, { assigneeId: a });
  await createRule(db.prisma, w.ws, null, {
    name: `move-${++seq}`,
    trigger: "escalation_overdue",
    actions: [{ type: "assign_owner", strategy: "round_robin", userIds: [a, b] }],
  });
  const c = clock();
  c.advance(4 * HOUR);
  await runEscalationCheck(db.prisma, c);
  await dispatchEvents(db.prisma, c, { maxMs: 0 });
  expect((await db.prisma.lead.findUniqueOrThrow({ where: { id: w.lead.id } })).ownerId).toBe(b);
  expect((await db.prisma.task.findUniqueOrThrow({ where: { id: t.id } })).assigneeId).toBe(b);
  const other = await world();
  const only = await member(other.ws);
  await db.prisma.lead.update({ where: { id: other.lead.id }, data: { ownerId: only } });
  const t2 = await task(other, { assigneeId: only });
  await createRule(db.prisma, other.ws, null, {
    name: `stay-${++seq}`,
    trigger: "escalation_overdue",
    actions: [{ type: "assign_owner", strategy: "round_robin", userIds: [only] }],
  });
  await runEscalationCheck(db.prisma, c);
  await dispatchEvents(db.prisma, c, { maxMs: 0 });
  expect((await db.prisma.task.findUniqueOrThrow({ where: { id: t2.id } })).assigneeId).toBe(only);
  expect(
    (await db.prisma.automationRun.findFirstOrThrow({ where: { workspaceId: other.ws } })).status,
  ).toBe("OK");
});

test("subscribed webhook receives escalation task title and count", async () => {
  const w = await world();
  const t = await task(w);
  const c = clock();
  c.advance(4 * HOUR);
  await createWebhook(
    db.prisma,
    w.ws,
    "u1",
    { url: "https://hook.test/alert", events: ["escalation_overdue"] },
    { allowPrivate: false, resolve: async () => ["1.1.1.1"] },
  );
  await runEscalationCheck(db.prisma, c);
  await dispatchEvents(db.prisma, c, { maxMs: 0, appUrl: "https://app.test" });
  const d = await db.prisma.webhookDelivery.findFirstOrThrow({
    where: { workspaceId: w.ws, eventType: "escalation_overdue" },
  });
  expect(d.payload).toMatchObject({ task_title: t.title, alert_count: 1 });
});
