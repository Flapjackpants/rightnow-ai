import { randomBytes } from "node:crypto";
import { createPrisma } from "@rightnow/db/create";
import type { AccountProvider, Prisma, PrismaClient, ScheduledMessage } from "@rightnow/db/client";
import { createTestDb } from "@rightnow/db/test-db";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { moveToSubsequence } from "../src/campaigns/enroll";
import { deleteStep, updateStep, updateVariant } from "../src/campaigns/sequence";
import { fixedClock, type Clock } from "../src/clock";
import { claimDue } from "../src/dispatch";
import { updateLead } from "../src/leads/service";
import { hashValue } from "../src/leads/suppression";
import {
  advanceLead,
  enterSubsequence,
  planDue,
  renderForLead,
  renderProblem,
  skipStep,
  upsertScheduled,
} from "../src/planner";
import { addDelay } from "../src/schedule";
import { TemplateError } from "../src/template";
import { unsubscribeKeys, type RenderEnv } from "../src/unsubscribe";
import { testEnv } from "./accounts-fixture";
import { markFresh, planRow, seedCampaign } from "./campaign-fixture";

let db: Awaited<ReturnType<typeof createTestDb>>;
const extra: PrismaClient[] = [];
const client = () => {
  const p = createPrisma(db.url, 5);
  extra.push(p);
  return p;
};
const P = () => db.prisma;
const ALL: AccountProvider[] = ["GMAIL", "MICROSOFT", "SMTP"];
const T = new Date("2026-10-20T10:00:00Z"); // Tuesday
const MIN = 60_000;
const ago = (ms: number) => new Date(T.getTime() - ms);
const ENV: RenderEnv = {
  appUrl: "https://app.example.com",
  unsubscribeKeys: unsubscribeKeys({ ENCRYPTION_KEY: randomBytes(32).toString("base64") }),
};
type Opts = Partial<Parameters<typeof planDue>[2]>;
const plan = (o: Opts = {}, clock: Clock = fixedClock(T), p: PrismaClient = P()) =>
  planDue(p, clock, { stalenessSec: 300, sendableProviders: ALL, env: ENV, ...o });
const rowsOf = (campaignId: string) =>
  P().scheduledMessage.findMany({ where: { campaignId }, orderBy: { id: "asc" } });
const clOf = (id: string) => P().campaignLead.findUniqueOrThrow({ where: { id } });
const tx = <R>(f: (t: Prisma.TransactionClient) => Promise<R>) => P().$transaction(f);

type Seeded = Awaited<ReturnType<typeof seedCampaign>>;
/** Every lead of the campaign back to a fresh enrollment: QUEUED, no step, not due-gated. */
const queue = (s: Seeded) =>
  P().campaignLead.updateMany({
    where: { campaignId: s.campaign.id },
    data: { state: "QUEUED", currentStepId: null, nextDueAt: null },
  });
/** Lead i sent step 1 from `accountId` (variant `variantId`) and now waits ACTIVE on step `stepIdx`, due at `due`. */
async function onFollowUp(
  s: Seeded,
  i: number,
  accountId: string,
  o: { stepIdx?: number; due?: Date; subject?: string; variantId?: string } = {},
) {
  const c = s.leads[i]!.cl;
  await planRow(P(), {
    workspaceId: s.ws,
    campaignId: s.campaign.id,
    campaignLeadId: c.id,
    stepId: s.steps[0]!.id,
    variantId: o.variantId ?? s.steps[0]!.variant.id,
    accountId,
    dueAt: ago(1440 * MIN),
    status: "SENT",
    sentAt: ago(1440 * MIN),
    renderedSubject: o.subject ?? "Hi",
  });
  return P().campaignLead.update({
    where: { id: c.id },
    data: {
      state: "ACTIVE",
      accountId,
      currentStepId: s.steps[o.stepIdx ?? 1]!.id,
      nextDueAt: o.due ?? ago(MIN),
    },
  });
}

beforeEach(async () => {
  testEnv();
  db = await createTestDb();
});
afterEach(async () => {
  await Promise.all(extra.splice(0).map((p) => p.$disconnect()));
  await db.drop();
});

describe("planDue: routing", () => {
  test("even rotation through the planner", async () => {
    const s = await seedCampaign(P(), {
      at: T,
      leads: 30,
      accounts: [{ dailyLimit: 50 }, { dailyLimit: 50 }, { dailyLimit: 50 }],
      campaign: { maxNewLeadsPerDay: null },
    });
    await queue(s);
    const r = await plan();
    expect(r).toMatchObject({ planned: 30, revived: 0, skipped: 0 });
    const rows = await rowsOf(s.campaign.id);
    const per = s.accounts.map((a) => rows.filter((x) => x.accountId === a.id).length);
    expect(per).toEqual([10, 10, 10]);
    expect(rows.every((x) => x.stepId === s.steps[0]!.id && x.status === "SCHEDULED")).toBe(true);
    const cls = await P().campaignLead.findMany({ where: { campaignId: s.campaign.id } });
    expect(cls.every((c) => c.state === "ACTIVE" && c.currentStepId === s.steps[0]!.id)).toBe(true);
    expect(cls.every((c) => c.accountId === null)).toBe(true); // sticky only once step 1 is SENT
    const usage = await P().campaignDailyUsage.findMany({ where: { campaignId: s.campaign.id } });
    expect(usage.map((u) => u.newLeads)).toEqual([30]);
    expect(
      (await P().stepVariant.findUniqueOrThrow({ where: { id: s.steps[0]!.variant.id } })).assigned,
    ).toBe(30);
  });

  test("sticky follow-ups", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 1, steps: 2, accounts: [{}, {}] });
    const [a] = s.accounts;
    await P().accountDailyUsage.create({
      data: { accountId: a!.id, day: new Date("2026-10-20"), sent: 3 },
    }); // B is emptier
    await onFollowUp(s, 0, a!.id);
    expect((await plan()).planned).toBe(1);
    const step2 = (await rowsOf(s.campaign.id)).find((r) => r.stepId === s.steps[1]!.id)!;
    expect(step2).toMatchObject({ accountId: a!.id, status: "SCHEDULED" });
  });

  test("N-2: an unassigned sticky account pauses its leads ACCOUNT_UNASSIGNED; re-assigning resumes them", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 2, steps: 2, accounts: [{}, {}] });
    const [a] = s.accounts;
    await onFollowUp(s, 0, a!.id);
    // lead 1 was paused by a send failure of its own: never touched by the reversal
    await onFollowUp(s, 1, a!.id);
    await P().campaignLead.update({
      where: { id: s.leads[1]!.cl.id },
      data: { state: "PAUSED", stopReason: "SEND_FAILED" },
    });
    await P().campaignAccount.deleteMany({ where: { accountId: a!.id } });
    await plan();
    expect(await clOf(s.leads[0]!.cl.id)).toMatchObject({
      state: "PAUSED",
      stopReason: "ACCOUNT_UNASSIGNED",
    });
    expect(await P().scheduledMessage.count({ where: { status: "SCHEDULED" } })).toBe(0);

    await P().campaignAccount.create({ data: { campaignId: s.campaign.id, accountId: a!.id } });
    await plan();
    expect(await clOf(s.leads[0]!.cl.id)).toMatchObject({
      state: "ACTIVE",
      stopReason: null,
      nextDueAt: T,
    });
    expect(
      await P().scheduledMessage.findFirst({
        where: { campaignLeadId: s.leads[0]!.cl.id, stepId: s.steps[1]!.id },
      }),
    ).toMatchObject({ status: "SCHEDULED", accountId: a!.id });
    expect(await clOf(s.leads[1]!.cl.id)).toMatchObject({
      state: "PAUSED",
      stopReason: "SEND_FAILED",
    });
  });

  test("step-1 re-route on ineligible account", async () => {
    const s = await seedCampaign(P(), {
      at: T,
      leads: 2,
      steps: 2,
      accounts: [{ firstName: "Alice" }, { firstName: "Bob", lifecycle: "PAUSED" }],
    });
    const [a, b] = s.accounts;
    for (const st of s.steps)
      await P().stepVariant.update({
        where: { id: st.variant.id },
        data: { body: "<p>From {{sendingAccountFirstName}}</p>" },
      });
    await P().campaignLead.update({
      where: { id: s.leads[0]!.cl.id },
      data: { state: "QUEUED", currentStepId: null },
    });
    await onFollowUp(s, 1, a!.id);
    expect((await plan()).planned).toBe(2);
    const first = await rowsOf(s.campaign.id);
    const s1 = first.find((r) => r.campaignLeadId === s.leads[0]!.cl.id)!;
    const s2 = first.find((r) => r.stepId === s.steps[1]!.id)!;
    expect([s1.accountId, s2.accountId]).toEqual([a!.id, a!.id]);
    expect(s1.renderedBody).toContain("Alice");

    await P().emailAccount.update({ where: { id: b!.id }, data: { lifecycle: "ACTIVE" } });
    await P().emailAccount.update({ where: { id: a!.id }, data: { lifecycle: "PAUSED" } });
    const r = await plan();
    expect(r).toMatchObject({ rerouted: 1, planned: 0 });
    const moved = await P().scheduledMessage.findUniqueOrThrow({ where: { id: s1.id } });
    expect(moved).toMatchObject({ accountId: b!.id, status: "SCHEDULED" });
    expect(moved.renderedBody).toContain("Bob");
    expect(moved.renderedBody).not.toContain("Alice");
    const kept = await P().scheduledMessage.findUniqueOrThrow({ where: { id: s2.id } });
    expect(kept).toMatchObject({ accountId: a!.id, status: "SCHEDULED" });
  });

  test("pickAccount null is 'not now': no row, no error, planned on a later tick", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 2, accounts: [{ lifecycle: "PAUSED" }] });
    await queue(s);
    expect(await plan()).toMatchObject({ planned: 0, skipped: 0 });
    expect(await rowsOf(s.campaign.id)).toHaveLength(0);
    expect((await clOf(s.leads[0]!.cl.id)).state).toBe("QUEUED");
    await P().emailAccount.update({
      where: { id: s.accounts[0]!.id },
      data: { lifecycle: "ACTIVE" },
    });
    expect((await plan()).planned).toBe(2);
  });

  test("a QUEUED lead entering a subsequence is routed like step 1; its first SENT step makes the sender sticky", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 1, accounts: [{}, {}] });
    await queue(s);
    const sub = await P().subsequence.create({
      data: {
        campaignId: s.campaign.id,
        name: "s",
        trigger: { kind: "ACTIVITY", activity: "opened" },
        activatedAt: ago(MIN),
      },
    });
    const ss1 = await P().sequenceStep.create({
      data: { campaignId: s.campaign.id, subsequenceId: sub.id, order: 1, delayValue: 0 },
    });
    await P().stepVariant.create({
      data: { stepId: ss1.id, label: "A", subject: "Sub", body: "x" },
    });
    const ss2 = await P().sequenceStep.create({
      data: { campaignId: s.campaign.id, subsequenceId: sub.id, order: 2, delayValue: 1 },
    });
    await P().stepVariant.create({
      data: { stepId: ss2.id, label: "A", subject: "Sub2", body: "y" },
    });
    const id = s.leads[0]!.cl.id;
    await moveToSubsequence(P(), fixedClock(ago(MIN)), s.ws, null, id, sub.id);
    expect(await clOf(id)).toMatchObject({
      state: "ACTIVE",
      accountId: null,
      currentStepId: ss1.id,
    });
    expect((await plan()).planned).toBe(1);
    const [row] = await rowsOf(s.campaign.id);
    expect(s.accounts.map((a) => a.id)).toContain(row!.accountId);
    await tx(async (t) => {
      await t.scheduledMessage.update({
        where: { id: row!.id },
        data: { status: "SENT", sentAt: T },
      });
      await advanceLead(t, fixedClock(T), { campaignLeadId: id, stepId: ss1.id, sentAt: T });
    });
    expect(await clOf(id)).toMatchObject({ accountId: row!.accountId, currentStepId: ss2.id });
    expect((await clOf(id)).nextDueAt).toEqual(new Date(T.getTime() + 1440 * MIN));
  });
});

describe("gate M-7", () => {
  test("a SCHEDULED row an archive skipped (claim held it) is cancelled by the next planner tick", async () => {
    const s = await seedCampaign(P(), { at: T, rows: 1, accounts: [{}] });
    const live = await seedCampaign(P(), { at: T, rows: 1, accounts: [{}] });
    await P().campaign.update({ where: { id: s.campaign.id }, data: { status: "ARCHIVED" } });
    await plan();
    expect((await rowsOf(s.campaign.id)).map((r) => r.status)).toEqual(["CANCELLED"]);
    expect((await rowsOf(live.campaign.id)).map((r) => r.status)).toEqual(["SCHEDULED"]);
  });
});

describe("planDue: no duplicates", () => {
  test("revive-not-duplicate re-plan", async () => {
    const s = await seedCampaign(P(), {
      at: T,
      leads: 5,
      steps: 2,
      accounts: [{ dailyLimit: 50 }],
    });
    const a = s.accounts[0]!.id;
    for (let i = 0; i < 5; i++) await onFollowUp(s, i, a);
    const statuses = ["CANCELLED", "SENT", "SENDING", "UNCERTAIN", "HELD"] as const;
    const step2: ScheduledMessage[] = [];
    for (const [i, status] of statuses.entries())
      step2.push(
        await planRow(P(), {
          workspaceId: s.ws,
          campaignId: s.campaign.id,
          campaignLeadId: s.leads[i]!.cl.id,
          stepId: s.steps[1]!.id,
          variantId: s.steps[1]!.variant.id,
          accountId: a,
          dueAt: ago(10 * MIN),
          status,
          ...(status === "UNCERTAIN" && { uncertainAt: ago(5 * MIN) }),
        }),
      );
    const before = await rowsOf(s.campaign.id);
    const r = await plan();
    expect(r).toMatchObject({ planned: 0, revived: 1 });
    const after = await rowsOf(s.campaign.id);
    expect(after).toHaveLength(before.length);
    const revived = after.find((x) => x.id === step2[0]!.id)!;
    expect(revived).toMatchObject({ status: "SCHEDULED", dueAt: T, error: null, claimToken: null });
    for (const old of step2.slice(1)) {
      const now = after.find((x) => x.id === old.id)!;
      expect([now.status, now.updatedAt]).toEqual([old.status, old.updatedAt]);
    }
  });

  test("formerly uncertain row is never revived", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 1, steps: 2 });
    await onFollowUp(s, 0, s.accounts[0]!.id);
    const r = await planRow(P(), {
      workspaceId: s.ws,
      campaignId: s.campaign.id,
      campaignLeadId: s.leads[0]!.cl.id,
      stepId: s.steps[1]!.id,
      accountId: s.accounts[0]!.id,
      dueAt: ago(MIN),
      status: "CANCELLED",
      uncertainAt: ago(60 * MIN),
    });
    for (let i = 0; i < 3; i++) expect(await plan()).toMatchObject({ planned: 0, revived: 0 });
    const now = await P().scheduledMessage.findUniqueOrThrow({ where: { id: r.id } });
    expect(now).toMatchObject({ status: "CANCELLED", uncertainAt: ago(60 * MIN) });
    expect(await rowsOf(s.campaign.id)).toHaveLength(2);
  });

  test("failed current step is not re-processed", async () => {
    const s = await seedCampaign(P(), {
      at: T,
      leads: 2,
      steps: 2,
      accounts: [{ dailyLimit: 50 }],
    });
    const a = s.accounts[0]!.id;
    await onFollowUp(s, 0, a, { due: ago(60 * MIN) }); // due first: it would take the only batch slot
    await onFollowUp(s, 1, a, { due: ago(MIN) });
    await planRow(P(), {
      workspaceId: s.ws,
      campaignId: s.campaign.id,
      campaignLeadId: s.leads[0]!.cl.id,
      stepId: s.steps[1]!.id,
      accountId: a,
      dueAt: ago(MIN),
      status: "FAILED",
    });
    const v2 = s.steps[1]!.variant.id;
    for (let i = 0; i < 3; i++) {
      await plan({ batch: 1 });
      expect(
        (await P().scheduledMessage.findMany({ where: { campaignLeadId: s.leads[0]!.cl.id } })).map(
          (r) => r.status,
        ),
      ).toEqual(expect.arrayContaining(["SENT", "FAILED"]));
    }
    // the healthy lead behind it got its row on the first tick; the failed one was never touched
    expect((await P().stepVariant.findUniqueOrThrow({ where: { id: v2 } })).assigned).toBe(1);
    expect(await P().campaignDailyUsage.count()).toBe(0);
    expect(
      await P().scheduledMessage.count({
        where: { campaignLeadId: s.leads[1]!.cl.id, stepId: s.steps[1]!.id },
      }),
    ).toBe(1);
  });

  test("upsert guard: only a plain CANCELLED row is revived, everything else is left alone", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 7 });
    const a = s.accounts[0]!.id;
    const cases = [
      ["CANCELLED", null, true],
      ["CANCELLED", ago(MIN), false],
      ["SCHEDULED", null, false],
      ["SENDING", null, false],
      ["SENT", null, false],
      ["FAILED", null, false],
      ["HELD", ago(MIN), false],
    ] as const;
    for (const [i, [status, uncertainAt, revives]] of cases.entries()) {
      const c = s.leads[i]!.cl;
      const old = await planRow(P(), {
        workspaceId: s.ws,
        campaignId: s.campaign.id,
        campaignLeadId: c.id,
        stepId: s.steps[0]!.id,
        accountId: a,
        dueAt: ago(MIN),
        status,
        uncertainAt,
        renderedSubject: "old",
        attempts: 3,
        claimErrors: 4,
      });
      const got = await tx((t) =>
        upsertScheduled(t, {
          workspaceId: s.ws,
          campaignId: s.campaign.id,
          campaignLeadId: c.id,
          stepId: s.steps[0]!.id,
          variantId: s.steps[0]!.variant.id,
          accountId: a,
          subject: "new",
          body: "b",
          text: "t",
          now: T,
        }),
      );
      const now = await P().scheduledMessage.findUniqueOrThrow({ where: { id: old.id } });
      if (revives) {
        expect(got).toEqual({ id: old.id, revived: true });
        // gate M-8: a revived row starts with fresh retry and claim-error budgets
        expect(now).toMatchObject({
          status: "SCHEDULED",
          renderedSubject: "new",
          attempts: 0,
          claimErrors: 0,
        });
      } else {
        expect(got).toBeNull();
        expect([now.status, now.renderedSubject, now.uncertainAt]).toEqual([
          status,
          "old",
          uncertainAt,
        ]);
      }
    }
    expect(await P().scheduledMessage.count()).toBe(cases.length);
  });

  test("concurrent planners create exactly one row per lead", async () => {
    const s = await seedCampaign(P(), {
      at: T,
      leads: 20,
      accounts: [{ dailyLimit: 50 }, { dailyLimit: 50 }],
    });
    await queue(s);
    const [p1, p2] = [client(), client()];
    // controlled interleave: planner 1 holds its campaign transaction open until planner 2 is seen waiting on the
    // per-campaign advisory lock (726003), then both finish
    let waited = false;
    let inside!: () => void;
    const entered = new Promise<void>((res) => (inside = res));
    const hook = async (t: Prisma.TransactionClient) => {
      inside(); // planner 2 starts only now, while planner 1 holds the lock
      for (let i = 0; i < 600 && !waited; i++) {
        const w = await P().$queryRaw<unknown[]>`
          SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND classid = 726003`;
        if (w.length) waited = true;
        else await new Promise((r) => setTimeout(r, 50));
      }
      await t.$queryRaw`SELECT 1`;
    };
    const r = await Promise.all([
      plan({ txHook: hook }, fixedClock(T), p1),
      entered.then(() => plan({}, fixedClock(T), p2)),
    ]);
    expect(waited).toBe(true);
    expect(r[0].planned + r[1].planned).toBe(20);
    expect(r[0].revived + r[1].revived).toBe(0);
    const rows = await rowsOf(s.campaign.id);
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((x) => x.campaignLeadId)).size).toBe(20);
    expect(
      (await P().stepVariant.findUniqueOrThrow({ where: { id: s.steps[0]!.variant.id } })).assigned,
    ).toBe(20);
    expect((await P().campaignDailyUsage.findMany()).map((u) => u.newLeads)).toEqual([20]);
  });

  test("planner deadlock retry", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 4, accounts: [{ dailyLimit: 50 }] });
    await queue(s);
    let calls = 0;
    const r = await plan({
      txHook: async () => {
        if (++calls === 1) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      },
    });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(r).toMatchObject({ planned: 4 });
    expect(await rowsOf(s.campaign.id)).toHaveLength(4);
    expect((await P().campaignDailyUsage.findMany()).map((u) => u.newLeads)).toEqual([4]);
    expect(
      (await P().stepVariant.findUniqueOrThrow({ where: { id: s.steps[0]!.variant.id } })).assigned,
    ).toBe(4);
  });

  test("skip-on-cancel: a row cancelled through skipStep is never revived (C1)", async () => {
    const s = await seedCampaign(P(), {
      at: T,
      leads: 1,
      steps: 3,
      accounts: [{ dailyLimit: 50 }],
    });
    await onFollowUp(s, 0, s.accounts[0]!.id);
    await plan();
    const row = (await rowsOf(s.campaign.id)).find((r) => r.stepId === s.steps[1]!.id);
    expect(row).toMatchObject({ stepId: s.steps[1]!.id, status: "SCHEDULED" });
    await tx((t) => skipStep(t, fixedClock(T), s.leads[0]!.cl.id, s.steps[1]!.id));
    for (let i = 0; i < 3; i++) await plan({}, fixedClock(new Date(T.getTime() + i * MIN)));
    expect((await P().scheduledMessage.findUniqueOrThrow({ where: { id: row!.id } })).status).toBe(
      "CANCELLED",
    );
    expect((await clOf(s.leads[0]!.cl.id)).currentStepId).toBe(s.steps[2]!.id);
  });
});

describe("current step and subsequences", () => {
  async function withSub(s: Seeded, trigger: object, over: Record<string, unknown> = {}) {
    const sub = await P().subsequence.create({
      data: {
        campaignId: s.campaign.id,
        name: "sub",
        trigger,
        activatedAt: ago(60 * MIN),
        ...over,
      },
    });
    const st = await P().sequenceStep.create({
      data: { campaignId: s.campaign.id, subsequenceId: sub.id, order: 1, delayValue: 0 },
    });
    const v = await P().stepVariant.create({
      data: { stepId: st.id, label: "A", subject: "S", body: "b" },
    });
    return { sub, step: st, variant: v };
  }

  test("entering a subsequence cancels the main-sequence row", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 1, steps: 2 });
    await onFollowUp(s, 0, s.accounts[0]!.id);
    const { sub, step } = await withSub(s, { kind: "LEAD_STATUS", interest: [1] });
    await plan();
    const main = (await rowsOf(s.campaign.id)).find((r) => r.stepId === s.steps[1]!.id)!;
    expect(main.status).toBe("SCHEDULED");
    await updateLead(P(), fixedClock(T), s.ws, s.leads[0]!.lead.id, { interestStatus: 1 });
    expect((await P().scheduledMessage.findUniqueOrThrow({ where: { id: main.id } })).status).toBe(
      "CANCELLED",
    );
    expect(await clOf(s.leads[0]!.cl.id)).toMatchObject({
      subsequenceId: sub.id,
      currentStepId: step.id,
      state: "ACTIVE",
    });
    const opts = { limit: 5, bootId: "b", stalenessSec: 300, sendableProviders: ALL };
    expect(await claimDue(P(), fixedClock(T), opts)).toHaveLength(0);
    await plan();
    const subRow = (await rowsOf(s.campaign.id)).find((r) => r.stepId === step.id)!;
    expect(subRow).toMatchObject({ status: "SCHEDULED", accountId: s.accounts[0]!.id }); // sticky
    const claimed = await claimDue(P(), fixedClock(T), opts);
    expect(claimed.map((c) => c.id)).toEqual([subRow.id]);
  });

  test("interest 2 completes the lead", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 2, steps: 2 });
    await onFollowUp(s, 0, s.accounts[0]!.id);
    await onFollowUp(s, 1, s.accounts[0]!.id);
    await withSub(s, { kind: "LEAD_STATUS", interest: [1] });
    await plan();
    await updateLead(P(), fixedClock(T), s.ws, s.leads[0]!.lead.id, { interestStatus: 2 });
    expect(await clOf(s.leads[0]!.cl.id)).toMatchObject({
      state: "COMPLETED",
      stopReason: "MANUAL",
    });
    const rows = await P().scheduledMessage.findMany({
      where: { campaignLeadId: s.leads[0]!.cl.id, stepId: s.steps[1]!.id },
    });
    expect(rows.map((r) => r.status)).toEqual(["CANCELLED"]);

    await updateLead(P(), fixedClock(T), s.ws, s.leads[1]!.lead.id, { interestStatus: -1 });
    expect(await clOf(s.leads[1]!.cl.id)).toMatchObject({
      state: "STOPPED",
      stopReason: "SUPPRESSED",
    });
    expect(await P().suppression.findMany({ where: { workspaceId: s.ws } })).toEqual([
      expect.objectContaining({ reason: "NOT_INTERESTED" }),
    ]);
    // 0 has no effect; a subsequence activated after the change does not count
    const s2 = await seedCampaign(P(), { at: T, leads: 1, steps: 2, workspaceId: s.ws });
    await onFollowUp(s2, 0, s2.accounts[0]!.id);
    await withSub(
      s2,
      { kind: "LEAD_STATUS", interest: [3] },
      { activatedAt: new Date(T.getTime() + MIN) },
    );
    await updateLead(P(), fixedClock(T), s.ws, s2.leads[0]!.lead.id, { interestStatus: 0 });
    expect((await clOf(s2.leads[0]!.cl.id)).state).toBe("ACTIVE");
    await updateLead(P(), fixedClock(T), s.ws, s2.leads[0]!.lead.id, { interestStatus: 3 });
    expect(await clOf(s2.leads[0]!.cl.id)).toMatchObject({
      state: "COMPLETED",
      subsequenceId: null,
    });
  });

  test("subsequence re-entry: a plain cancelled row is revived in place, a sent subsequence is never re-entered", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 1, steps: 2 });
    await onFollowUp(s, 0, s.accounts[0]!.id);
    const x = await withSub(s, { kind: "ACTIVITY", activity: "opened" });
    const y = await withSub(s, { kind: "ACTIVITY", activity: "clicked" });
    const id = s.leads[0]!.cl.id;
    const enter = (sub: string) => tx((t) => enterSubsequence(t, fixedClock(ago(MIN)), id, sub));
    expect(await enter(x.sub.id)).toBe(true);
    await plan();
    const xRow = (await rowsOf(s.campaign.id)).find((r) => r.stepId === x.step.id)!;
    expect(await enter(y.sub.id)).toBe(true); // leaving X cancels its open row
    expect((await P().scheduledMessage.findUniqueOrThrow({ where: { id: xRow.id } })).status).toBe(
      "CANCELLED",
    );
    expect(await enter(x.sub.id)).toBe(true); // back to X: allowed, nothing was sent from it
    expect(await enter(x.sub.id)).toBe(false); // already in X: no restart
    const r = await plan();
    expect(r).toMatchObject({ revived: 1, planned: 0 });
    expect((await P().scheduledMessage.findUniqueOrThrow({ where: { id: xRow.id } })).status).toBe(
      "SCHEDULED",
    );
    await P().scheduledMessage.update({
      where: { id: xRow.id },
      data: { status: "SENT", sentAt: T },
    });
    expect(await enter(y.sub.id)).toBe(true);
    expect(await enter(x.sub.id)).toBe(false); // X's step went out once: re-entry is refused
    expect((await clOf(id)).subsequenceId).toBe(y.sub.id);
    await expect(
      moveToSubsequence(P(), fixedClock(T), s.ws, null, id, x.sub.id),
    ).rejects.toMatchObject({
      status: 409,
      message: "subsequence_already_entered",
    });
    expect(
      await P().scheduledMessage.count({ where: { campaignLeadId: id, stepId: x.step.id } }),
    ).toBe(1);
  });

  test("skipStep", async () => {
    const s = await seedCampaign(P(), {
      at: T,
      leads: 2,
      steps: 3,
      accounts: [{ dailyLimit: 50 }],
    });
    await P().sequenceStep.update({
      where: { id: s.steps[2]!.id },
      data: { delayValue: 3, delayUnit: "HOURS" },
    });
    await onFollowUp(s, 0, s.accounts[0]!.id);
    await P().campaignLead.update({
      where: { id: s.leads[1]!.cl.id },
      data: { state: "QUEUED", currentStepId: null },
    });
    await plan();
    await tx((t) => skipStep(t, fixedClock(T), s.leads[0]!.cl.id, s.steps[1]!.id));
    expect(await clOf(s.leads[0]!.cl.id)).toMatchObject({
      currentStepId: s.steps[2]!.id,
      nextDueAt: addDelay(T, 3, "HOURS", "UTC"),
      state: "ACTIVE",
    });
    await tx((t) => skipStep(t, fixedClock(T), s.leads[1]!.cl.id, s.steps[0]!.id));
    expect(await clOf(s.leads[1]!.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "MANUAL" });
    const rows = await rowsOf(s.campaign.id);
    expect(rows.filter((r) => r.status === "SCHEDULED")).toHaveLength(0);
  });

  test("advanceLead", async () => {
    const berlin = { timezone: "Europe/Berlin", days: 62, from: "09:00", to: "17:00" };
    const s = await seedCampaign(P(), { at: T, leads: 2, steps: 2, schedules: [berlin] });
    await P().sequenceStep.update({
      where: { id: s.steps[1]!.id },
      data: { delayValue: 2, delayUnit: "DAYS" },
    });
    const fri16 = new Date("2026-10-23T14:00:00Z"); // Fri 16:00 CEST
    const id = s.leads[0]!.cl.id;
    await tx((t) =>
      advanceLead(t, fixedClock(fri16), {
        campaignLeadId: id,
        stepId: s.steps[0]!.id,
        sentAt: fri16,
      }),
    );
    // +2 days = Sun 16:00 → next window Mon 09:00 local (CET after the 25 Oct switch = 08:00Z)
    expect(await clOf(id)).toMatchObject({
      currentStepId: s.steps[1]!.id,
      nextDueAt: new Date("2026-10-26T08:00:00Z"),
    });
    // stale step: nothing changes
    await tx((t) =>
      advanceLead(t, fixedClock(fri16), {
        campaignLeadId: id,
        stepId: s.steps[0]!.id,
        sentAt: fri16,
      }),
    );
    expect((await clOf(id)).currentStepId).toBe(s.steps[1]!.id);
    // last step without a completed_no_reply subsequence → COMPLETED
    await tx((t) =>
      advanceLead(t, fixedClock(T), { campaignLeadId: id, stepId: s.steps[1]!.id, sentAt: T }),
    );
    expect(await clOf(id)).toMatchObject({ state: "COMPLETED", nextDueAt: null });
    // with one → it enters the subsequence after preDelayMinutes
    const sub = await P().subsequence.create({
      data: {
        campaignId: s.campaign.id,
        name: "nr",
        trigger: { kind: "ACTIVITY", activity: "completed_no_reply" },
        preDelayMinutes: 60,
        activatedAt: ago(MIN),
      },
    });
    const ss = await P().sequenceStep.create({
      data: { campaignId: s.campaign.id, subsequenceId: sub.id, order: 1, delayValue: 0 },
    });
    const id2 = s.leads[1]!.cl.id;
    await P().campaignLead.update({ where: { id: id2 }, data: { currentStepId: s.steps[1]!.id } });
    await tx((t) =>
      advanceLead(t, fixedClock(T), { campaignLeadId: id2, stepId: s.steps[1]!.id, sentAt: T }),
    );
    expect(await clOf(id2)).toMatchObject({
      state: "ACTIVE",
      subsequenceId: sub.id,
      currentStepId: ss.id,
      nextDueAt: new Date(T.getTime() + 60 * MIN),
    });
  });
});

describe("caps", () => {
  test("maxNewLeadsPerDay", async () => {
    const s = await seedCampaign(P(), {
      at: T,
      leads: 20,
      accounts: [{ dailyLimit: 100 }],
      campaign: { maxNewLeadsPerDay: 5 },
    });
    await queue(s);
    expect((await plan()).planned).toBe(5);
    expect((await plan()).planned).toBe(0);
    expect((await P().campaignDailyUsage.findMany()).map((u) => u.newLeads)).toEqual([5]);
    const tomorrow = new Date(T.getTime() + 1440 * MIN);
    await markFresh(P(), [s.accounts[0]!.id], tomorrow);
    expect((await plan({}, fixedClock(tomorrow))).planned).toBe(5);
    await P().campaign.update({ where: { id: s.campaign.id }, data: { maxNewLeadsPerDay: 0 } });
    const later = new Date(T.getTime() + 2 * 1440 * MIN);
    await markFresh(P(), [s.accounts[0]!.id], later);
    expect((await plan({}, fixedClock(later))).planned).toBe(0);
  });

  test("per-company daily limit (campaign and workspace scope); free-mail leads are never grouped", async () => {
    const s = await seedCampaign(P(), {
      at: T,
      leads: 10,
      accounts: [{ dailyLimit: 100 }],
      campaign: { perCompanyDailyLimit: 2 },
    });
    await queue(s);
    for (const [i, { lead }] of s.leads.entries())
      await P().lead.update({
        where: { id: lead.id },
        data:
          i < 5
            ? { companyDomain: "acme.test" }
            : { email: `p${i}@gmail.com`, companyDomain: null },
      });
    expect((await plan()).planned).toBe(7);
    const rows = await P().scheduledMessage.findMany({
      include: { campaignLead: { include: { lead: true } } },
    });
    expect(rows.filter((r) => r.campaignLead.lead.companyDomain === "acme.test")).toHaveLength(2);
    // workspace scope: another campaign, no campaign limit, workspace limit 2 already used by acme today
    await P().workspace.update({ where: { id: s.ws }, data: { perCompanyDailyLimit: 2 } });
    const s2 = await seedCampaign(P(), {
      at: T,
      leads: 1,
      workspaceId: s.ws,
      accounts: [{ dailyLimit: 100 }],
    });
    await queue(s2);
    await P().lead.update({
      where: { id: s2.leads[0]!.lead.id },
      data: { companyDomain: "acme.test" },
    });
    expect((await plan()).planned).toBe(0);
  });

  test("prioritizeNewLeads", async () => {
    for (const prioritize of [false, true]) {
      const s = await seedCampaign(P(), {
        at: T,
        leads: 6,
        steps: 2,
        accounts: [{ dailyLimit: 100 }],
        campaign: { prioritizeNewLeads: prioritize },
      });
      for (let i = 0; i < 3; i++) await onFollowUp(s, i, s.accounts[0]!.id);
      for (let i = 3; i < 6; i++)
        await P().campaignLead.update({
          where: { id: s.leads[i]!.cl.id },
          data: { state: "QUEUED", currentStepId: null },
        });
      await plan({ batch: 3 });
      const planned = (await rowsOf(s.campaign.id)).filter((r) => r.status === "SCHEDULED");
      const want = prioritize ? s.steps[0]!.id : s.steps[1]!.id;
      expect(planned.map((r) => r.stepId)).toEqual([want, want, want]);
    }
  });

  test("INVALID, RISKY and CATCH_ALL leads, deleted and suppressed ones are stopped, never planned", async () => {
    for (const allowRisky of [false, true])
      for (const allowCatchAll of [false, true]) {
        const s = await seedCampaign(P(), {
          at: T,
          leads: 6,
          accounts: [{ dailyLimit: 100 }],
          campaign: { allowRisky, allowCatchAll },
        });
        await queue(s);
        const L = s.leads.map((l) => l.lead.id);
        await P().lead.update({ where: { id: L[0] }, data: { verificationStatus: "INVALID" } });
        await P().lead.update({ where: { id: L[1] }, data: { verificationStatus: "RISKY" } });
        await P().lead.update({ where: { id: L[2] }, data: { verificationStatus: "CATCH_ALL" } });
        await P().lead.update({ where: { id: L[3] }, data: { deletedAt: T } });
        await P().suppression.create({
          data: {
            workspaceId: s.ws,
            kind: "EMAIL",
            value: s.leads[4]!.lead.email,
            valueHash: hashValue(s.leads[4]!.lead.email),
            reason: "MANUAL",
          },
        });
        await plan();
        const st = await Promise.all(s.leads.map((l) => clOf(l.cl.id)));
        expect(st.map((c) => [c.state, c.stopReason])).toEqual([
          ["STOPPED", "SKIPPED"],
          allowRisky ? ["ACTIVE", null] : ["STOPPED", "SKIPPED"],
          allowCatchAll ? ["ACTIVE", null] : ["STOPPED", "SKIPPED"],
          ["STOPPED", "SKIPPED"],
          ["STOPPED", "SUPPRESSED"],
          ["ACTIVE", null],
        ]);
        expect(await rowsOf(s.campaign.id)).toHaveLength(
          1 + Number(allowRisky) + Number(allowCatchAll),
        );
      }
  });

  test("G-I1: leads waiting for verification never use up the page budget", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 22, accounts: [{ dailyLimit: 100 }] });
    await queue(s);
    const ordered = (
      await P().campaignLead.findMany({
        where: { campaignId: s.campaign.id },
        orderBy: { id: "asc" },
      })
    ).map((c) => c.leadId);
    // 21 pending leads ahead of one plannable lead: more than batch (2) x MAX_PAGES (10)
    await P().lead.updateMany({
      where: { id: { in: ordered.slice(0, 21) } },
      data: { verificationStatus: "PENDING_JOB" },
    });
    expect((await plan({ batch: 2 })).planned).toBe(1);
    const rows = await rowsOf(s.campaign.id);
    expect(rows).toHaveLength(1);
    const cls = await P().campaignLead.findMany({ where: { campaignId: s.campaign.id } });
    expect(cls.filter((c) => c.state === "QUEUED")).toHaveLength(21);
  });

  test("paused, stopped and completed leads get nothing", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 3, accounts: [{ dailyLimit: 100 }] });
    const states = ["PAUSED", "STOPPED", "COMPLETED"] as const;
    for (const [i, state] of states.entries())
      await P().campaignLead.update({
        where: { id: s.leads[i]!.cl.id },
        data: { state, nextDueAt: ago(MIN) },
      });
    expect((await plan()).planned).toBe(0);
    expect(await rowsOf(s.campaign.id)).toHaveLength(0);
  });

  test("variant balancing", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 14, accounts: [{ dailyLimit: 100 }] });
    await queue(s);
    const st = s.steps[0]!;
    await P().stepVariant.create({ data: { stepId: st.id, label: "B", subject: "B", body: "b" } });
    expect((await plan({ batch: 10 })).planned).toBe(10);
    const by = async () =>
      Object.fromEntries(
        (
          await P().stepVariant.findMany({ where: { stepId: st.id }, orderBy: { label: "asc" } })
        ).map((v) => [v.label, v.assigned]),
      );
    expect(await by()).toEqual({ A: 5, B: 5 });
    const c = await P().stepVariant.create({
      data: { stepId: st.id, label: "C", subject: "C", body: "c" },
    });
    expect((await plan()).planned).toBe(4);
    expect(await by()).toEqual({ A: 5, B: 5, C: 4 });
    expect(await P().scheduledMessage.count({ where: { variantId: c.id } })).toBe(4);
  });

  describe("abResetDaily", () => {
    const setup = async (abResetDaily: boolean) => {
      const s = await seedCampaign(P(), {
        at: T,
        leads: 2,
        accounts: [{ dailyLimit: 100 }],
        campaign: { abResetDaily },
      });
      await queue(s);
      const a = s.steps[0]!.variant;
      const b = await P().stepVariant.create({
        data: { stepId: s.steps[0]!.id, label: "B", subject: "B", body: "b" },
      });
      await P().stepVariant.update({
        where: { id: a.id },
        data: { assigned: 500, assignedToday: 3, assignedDay: new Date("2026-10-20") },
      });
      await P().stepVariant.update({
        where: { id: b.id },
        data: { assignedToday: 3, assignedDay: new Date("2026-10-20") },
      });
      return { s, a, b };
    };
    const used = async (s: Seeded) => (await rowsOf(s.campaign.id)).map((r) => r.variantId).sort();

    test("balances on today's counters: the next two leads go one to each variant", async () => {
      const { s, a, b } = await setup(true);
      expect((await plan()).planned).toBe(2);
      expect(await used(s)).toEqual([a.id, b.id].sort());
      const v = await P().stepVariant.findMany({ where: { stepId: s.steps[0]!.id } });
      expect(Object.fromEntries(v.map((x) => [x.label, [x.assigned, x.assignedToday]]))).toEqual({
        A: [501, 4],
        B: [1, 4],
      });
    });

    test("without the reset both go to the emptier lifetime variant", async () => {
      const { s, b } = await setup(false);
      expect((await plan()).planned).toBe(2);
      expect(await used(s)).toEqual([b.id, b.id]);
    });

    test("a new day in the workspace timezone restarts the counters", async () => {
      const { s, a, b } = await setup(true);
      await P().workspace.update({ where: { id: s.ws }, data: { timezone: "Pacific/Kiritimati" } });
      // 10:00Z is 00:00 on the 21st in Kiritimati (UTC+14): the stored 20th is yesterday there, both counters read 0 and restart
      expect((await plan()).planned).toBe(2);
      expect(await used(s)).toEqual([a.id, b.id].sort());
      const v = await P().stepVariant.findMany({ where: { stepId: s.steps[0]!.id } });
      expect(v.map((x) => [x.assignedToday, x.assignedDay?.toISOString().slice(0, 10)])).toEqual([
        [1, "2026-10-21"],
        [1, "2026-10-21"],
      ]);
    });
  });

  test("overdue backlog after downtime is planned only up to the sticky account's remaining quota", async () => {
    const s = await seedCampaign(P(), {
      at: T,
      leads: 12,
      steps: 2,
      accounts: [{ dailyLimit: 5 }],
    });
    for (let i = 0; i < 12; i++)
      await onFollowUp(s, i, s.accounts[0]!.id, { due: ago(7 * 1440 * MIN) });
    expect((await plan()).planned).toBe(5);
    expect((await plan()).planned).toBe(0);
    expect(
      new Set(
        (await rowsOf(s.campaign.id))
          .filter((r) => r.status === "SCHEDULED")
          .map((r) => r.dueAt.getTime()),
      ),
    ).toEqual(new Set([T.getTime()]));
  });

  test("a subsequence's dailyLimit caps today's subsequence rows", async () => {
    const s = await seedCampaign(P(), {
      at: T,
      leads: 4,
      steps: 2,
      accounts: [{ dailyLimit: 100 }],
    });
    const sub = await P().subsequence.create({
      data: {
        campaignId: s.campaign.id,
        name: "s",
        trigger: { kind: "ACTIVITY", activity: "opened" },
        dailyLimit: 2,
        activatedAt: ago(MIN),
      },
    });
    const ss = await P().sequenceStep.create({
      data: { campaignId: s.campaign.id, subsequenceId: sub.id, order: 1, delayValue: 0 },
    });
    await P().stepVariant.create({ data: { stepId: ss.id, label: "A", subject: "S", body: "b" } });
    for (let i = 0; i < 4; i++) {
      await onFollowUp(s, i, s.accounts[0]!.id);
      await tx((t) => enterSubsequence(t, fixedClock(ago(MIN)), s.leads[i]!.cl.id, sub.id));
    }
    expect((await plan()).planned).toBe(2);
  });
});

describe("render", () => {
  test("Re: subject from the variant actually sent", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 1, steps: 2 });
    const b = await P().stepVariant.create({
      data: { stepId: s.steps[0]!.id, label: "B", subject: "B-subj", body: "x" },
    });
    await P()
      .$executeRaw`UPDATE "StepVariant" SET subject = '' WHERE id = ${s.steps[1]!.variant.id}`;
    await onFollowUp(s, 0, s.accounts[0]!.id, { variantId: b.id, subject: "B-subj" });
    await plan();
    const row = (await rowsOf(s.campaign.id)).find((r) => r.stepId === s.steps[1]!.id)!;
    expect(row.renderedSubject).toBe("Re: B-subj");
  });

  test("the stored render equals renderForLead, carries the footer, keeps subjects single-line and resolves custom-field fallbacks", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 2, accounts: [{}] });
    await queue(s);
    const [one, other] = s.leads;
    await P().lead.update({
      where: { id: one!.lead.id },
      data: { firstName: "Ann\r\nBcc: x@evil.test" },
    });
    await P().lead.update({
      where: { id: other!.lead.id },
      data: { customFields: { region: "EU" } },
    });
    await P().campaignLead.update({ where: { id: other!.cl.id }, data: { state: "STOPPED" } });
    const v = await P().stepVariant.update({
      where: { id: s.steps[0]!.variant.id },
      data: {
        subject: "Hi {{firstName}}",
        body: "<p>Hello {{firstName}}, {{region | friend}}</p>",
      },
    });
    expect(await plan()).toMatchObject({ planned: 1, skipped: 0 });
    const [r] = await rowsOf(s.campaign.id);
    expect(r!.renderedSubject).toBe("Hi Ann Bcc: x@evil.test");
    expect(r!.renderedSubject).not.toMatch(/[\r\n]/);
    expect(r!.renderedBody).toContain("friend");
    expect(r!.renderedBody).toContain("1 Main St");
    expect(r!.renderedText).toContain("1 Main St");
    expect(r!.renderedText).toContain("Unsubscribe: https://app.example.com/u/");
    const want = renderForLead({
      campaign: s.campaign,
      step: s.steps[0]!,
      variant: v,
      lead: await P().lead.findUniqueOrThrow({ where: { id: one!.lead.id } }),
      account: s.accounts[0]!,
      workspace: await P().workspace.findUniqueOrThrow({ where: { id: s.ws } }),
      env: ENV,
      customKeys: ["region"],
    });
    expect([r!.renderedSubject, r!.renderedBody, r!.renderedText]).toEqual([
      want.subject,
      want.html,
      want.text,
    ]);
    expect(want.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  test("text-only: no html, the body column holds the text", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 1, campaign: { textOnly: true } });
    await queue(s);
    await plan();
    const [r] = await rowsOf(s.campaign.id);
    expect(r!.renderedBody).toBe(r!.renderedText);
    expect(r!.renderedBody).not.toContain("<");
  });

  test("render problems read as clear messages, never a crash", () => {
    expect(renderProblem(new Error("physical_address_required"))).toMatchObject({
      code: "physical_address_required",
    });
    expect(renderProblem(new Error("invalid_account_email"))).toMatchObject({
      code: "invalid_account_email",
    });
    expect(renderProblem(new TemplateError('Unknown variable "x"'))).toMatchObject({
      code: "template_invalid",
    });
    expect(renderProblem(new Error("boom"))).toBeNull();
    for (const code of ["physical_address_required", "invalid_account_email"])
      expect(renderProblem(new Error(code))!.message.length).toBeGreaterThan(10);
  });
});

describe("isolation, windows and completion", () => {
  test("one bad campaign or lead does not stop the planner", async () => {
    const x = await seedCampaign(P(), {
      at: T,
      leads: 2,
      steps: 2,
      accounts: [{ dailyLimit: 100 }],
    });
    const y = await seedCampaign(P(), { at: T, leads: 2, accounts: [{ dailyLimit: 100 }] });
    const z = await seedCampaign(P(), { at: T, leads: 2, accounts: [{ dailyLimit: 100 }] });
    await queue(y);
    await queue(z);
    await P().campaignLead.update({
      where: { id: x.leads[0]!.cl.id },
      data: { state: "QUEUED", currentStepId: null },
    });
    await onFollowUp(x, 1, x.accounts[0]!.id); // healthy follow-up
    await P()
      .$executeRaw`UPDATE "StepVariant" SET body = 'Hi {{nosuchvar}}' WHERE id = ${x.steps[0]!.variant.id}`;
    const r = await plan({
      txHook: async (_t, campaignId) => {
        if (campaignId === z.campaign.id) throw new Error("boom");
      },
    });
    expect(r.skipped).toBe(1);
    expect((await rowsOf(y.campaign.id)).length).toBe(2);
    expect(
      (await rowsOf(x.campaign.id)).filter((r) => r.status === "SCHEDULED").map((r) => r.stepId),
    ).toEqual([x.steps[1]!.id]);
    expect(await rowsOf(z.campaign.id)).toHaveLength(0);
    expect(await clOf(x.leads[0]!.cl.id)).toMatchObject({
      state: "QUEUED",
      nextDueAt: new Date(T.getTime() + 60 * MIN),
    });
  });

  test("outside the window, with an empty-days schedule, before startAt or without an address nothing is planned and nothing throws", async () => {
    const cases = [
      { schedules: [{ timezone: "UTC", days: 0, from: "09:00", to: "17:00" }] },
      { schedules: [{ timezone: "UTC", days: 127, from: "11:00", to: "12:00" }] },
      { schedules: [] },
      { campaign: { startAt: new Date(T.getTime() + MIN) } },
      { workspace: { physicalAddress: "  " } },
    ];
    for (const c of cases) {
      const s = await seedCampaign(P(), { at: T, leads: 1, ...c });
      await queue(s);
      expect((await plan()).planned).toBe(0);
    }
    // advanceLead never fails the SENT transaction over an unopenable schedule
    const s = await seedCampaign(P(), {
      at: T,
      leads: 1,
      steps: 2,
      schedules: [{ timezone: "UTC", days: 0, from: "09:00", to: "17:00" }],
    });
    await tx((t) =>
      advanceLead(t, fixedClock(T), {
        campaignLeadId: s.leads[0]!.cl.id,
        stepId: s.steps[0]!.id,
        sentAt: T,
      }),
    );
    expect((await clOf(s.leads[0]!.cl.id)).nextDueAt).toEqual(new Date(T.getTime() + 1440 * MIN));
  });

  test("completion", async () => {
    const done = await seedCampaign(P(), { at: T, leads: 2 });
    await P().campaignLead.updateMany({
      where: { campaignId: done.campaign.id },
      data: { state: "COMPLETED" },
    });
    await P().campaignLead.update({
      where: { id: done.leads[1]!.cl.id },
      data: { state: "STOPPED" },
    });
    const ever = await seedCampaign(P(), { at: T, leads: 1, campaign: { evergreen: true } });
    await P().campaignLead.updateMany({
      where: { campaignId: ever.campaign.id },
      data: { state: "COMPLETED" },
    });
    const busy = await seedCampaign(P(), { at: T, leads: 1 });
    await P().campaignLead.updateMany({
      where: { campaignId: busy.campaign.id },
      data: { state: "COMPLETED" },
    });
    await planRow(P(), {
      workspaceId: busy.ws,
      campaignId: busy.campaign.id,
      campaignLeadId: busy.leads[0]!.cl.id,
      stepId: busy.steps[0]!.id,
      accountId: busy.accounts[0]!.id,
      dueAt: T,
      status: "SENDING",
    });
    const ended = await seedCampaign(P(), { at: T, rows: 2, campaign: { endAt: ago(MIN) } });
    const r = await plan();
    expect(r.completed).toBe(2);
    const status = async (id: string) =>
      (await P().campaign.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(done.campaign.id)).toBe("COMPLETED");
    expect(await status(ever.campaign.id)).toBe("ACTIVE");
    expect(await status(busy.campaign.id)).toBe("ACTIVE");
    expect(await status(ended.campaign.id)).toBe("COMPLETED");
    expect((await rowsOf(ended.campaign.id)).map((x) => x.status)).toEqual([
      "CANCELLED",
      "CANCELLED",
    ]);
  });

  test("housekeeping cancels SCHEDULED rows that are not the lead's current step or whose lead is finished", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 3, steps: 2, rows: 3 });
    await P().campaignLead.update({
      where: { id: s.leads[0]!.cl.id },
      data: { currentStepId: s.steps[1]!.id, nextDueAt: new Date(T.getTime() + 1440 * MIN) },
    });
    await P().campaignLead.update({ where: { id: s.leads[1]!.cl.id }, data: { state: "STOPPED" } });
    await plan();
    const st = Object.fromEntries(
      (await rowsOf(s.campaign.id)).map((r) => [r.campaignLeadId, r.status]),
    );
    expect(st).toEqual({
      [s.leads[0]!.cl.id]: "CANCELLED",
      [s.leads[1]!.cl.id]: "CANCELLED",
      [s.leads[2]!.cl.id]: "SCHEDULED",
    });
  });
});

describe("forward progress (C-1, I5)", () => {
  test("prioritizeNewLeads with the new-lead limit reached still plans the due follow-up", async () => {
    const s = await seedCampaign(P(), {
      at: T,
      leads: 5,
      steps: 2,
      accounts: [{ dailyLimit: 100 }],
      campaign: { prioritizeNewLeads: true, maxNewLeadsPerDay: 1 },
    });
    await onFollowUp(s, 4, s.accounts[0]!.id);
    for (let i = 0; i < 4; i++)
      await P().campaignLead.update({
        where: { id: s.leads[i]!.cl.id },
        data: { state: "QUEUED", currentStepId: null },
      });
    expect((await plan({ batch: 3 })).planned).toBe(2);
    const follow = await P().scheduledMessage.findMany({
      where: { campaignLeadId: s.leads[4]!.cl.id, stepId: s.steps[1]!.id },
    });
    expect(follow.map((r) => r.status)).toEqual(["SCHEDULED"]);
    expect((await P().campaignDailyUsage.findMany()).map((u) => u.newLeads)).toEqual([1]);
  });

  test("a sticky account out of quota does not starve other leads", async () => {
    const s = await seedCampaign(P(), {
      at: T,
      leads: 5,
      steps: 2,
      accounts: [{ dailyLimit: 5 }, { dailyLimit: 5 }],
    });
    const [a, b] = s.accounts.map((x) => x.id) as [string, string];
    await P().accountDailyUsage.create({
      data: { accountId: a, day: new Date("2026-10-20"), sent: 5 },
    });
    for (let i = 0; i < 4; i++) await onFollowUp(s, i, a, { due: ago(60 * MIN) }); // due first
    await onFollowUp(s, 4, b, { due: ago(MIN) });
    expect((await plan({ batch: 3 })).planned).toBe(1);
    const rows = await P().scheduledMessage.findMany({ where: { stepId: s.steps[1]!.id } });
    expect(rows.map((r) => [r.campaignLeadId, r.accountId])).toEqual([[s.leads[4]!.cl.id, b]]);
  });

  test("an ESP do_not_send lead is backed off, not re-selected every tick, and others are planned", async () => {
    const s = await seedCampaign(P(), {
      at: T,
      leads: 2,
      accounts: [{ dailyLimit: 100 }],
      campaign: {
        espRoutingRules: [{ action: "do_not_send", recipientEsp: "google", senderEsp: "all" }],
      },
    });
    await queue(s);
    const [g, other] = [...s.leads].sort((x, y) => (x.cl.id < y.cl.id ? -1 : 1));
    await P().lead.update({ where: { id: g!.lead.id }, data: { espType: "GOOGLE" } });
    expect((await plan({ batch: 1 })).planned).toBe(1);
    expect(await P().scheduledMessage.count({ where: { campaignLeadId: other!.cl.id } })).toBe(1);
    expect(await clOf(g!.cl.id)).toMatchObject({
      state: "QUEUED",
      nextDueAt: new Date(T.getTime() + 60 * MIN),
    });
  });
});

describe("edits (Review Focus 3)", () => {
  test("deleting main step 1 moves its waiting leads to the new step 1, where rotation still routes them", async () => {
    const s = await seedCampaign(P(), {
      at: T,
      leads: 3,
      steps: 2,
      accounts: [{ dailyLimit: 100 }],
    });
    await queue(s);
    await plan({ batch: 2 }); // two leads ACTIVE on step 1 with an unsent row, one still QUEUED (no step yet)
    await P().campaignLead.updateMany({
      where: { campaignId: s.campaign.id, currentStepId: s.steps[0]!.id },
      data: { state: "QUEUED" },
    });
    await deleteStep(P(), s.ws, null, s.steps[0]!.id);
    expect(
      (await P().sequenceStep.findUniqueOrThrow({ where: { id: s.steps[1]!.id } })).order,
    ).toBe(1);
    for (const l of s.leads) {
      const c = await clOf(l.cl.id);
      expect(c.state).toBe("QUEUED");
      expect([null, s.steps[1]!.id]).toContain(c.currentStepId);
    }
    expect((await rowsOf(s.campaign.id)).filter((r) => r.status === "SCHEDULED")).toHaveLength(0);
    expect((await plan()).planned).toBe(3);
    const rows = (await rowsOf(s.campaign.id)).filter((r) => r.status === "SCHEDULED");
    expect(rows.map((r) => r.stepId)).toEqual(Array(3).fill(s.steps[1]!.id));
    expect(rows.every((r) => r.accountId === s.accounts[0]!.id)).toBe(true);
  });

  test("re-rendering a few thousand SCHEDULED rows after a variant edit completes", async () => {
    const N = 3000;
    const s = await seedCampaign(P(), { at: T, leads: 1, accounts: [{ dailyLimit: 100 }] });
    const tag = randomBytes(3).toString("hex");
    await P().lead.createMany({
      data: Array.from({ length: N }, (_, i) => ({
        id: `bulk-${tag}-${i}`,
        workspaceId: s.ws,
        email: `b${i}-${tag}@bulk.test`,
        customFields: { region: `r${i}` },
      })),
    });
    await P().campaignLead.createMany({
      data: Array.from({ length: N }, (_, i) => ({
        id: `bcl-${tag}-${i}`,
        workspaceId: s.ws,
        campaignId: s.campaign.id,
        leadId: `bulk-${tag}-${i}`,
        state: "ACTIVE" as const,
        currentStepId: s.steps[0]!.id,
      })),
    });
    await P().scheduledMessage.createMany({
      data: Array.from({ length: N }, (_, i) => ({
        workspaceId: s.ws,
        campaignId: s.campaign.id,
        campaignLeadId: `bcl-${tag}-${i}`,
        stepId: s.steps[0]!.id,
        variantId: s.steps[0]!.variant.id,
        accountId: s.accounts[0]!.id,
        dueAt: T,
        idempotencyKey: `bcl-${tag}-${i}:${s.steps[0]!.id}`,
        renderedSubject: "Hi",
        renderedBody: "x",
        renderedText: "x",
      })),
    });
    const t0 = Date.now();
    await updateVariant(P(), s.ws, null, s.steps[0]!.variant.id, {
      subject: "Fixed {{region}}",
    });
    const took = Date.now() - t0;
    const rows = await P().scheduledMessage.findMany({ where: { campaignId: s.campaign.id } });
    expect(rows).toHaveLength(N);
    expect(
      rows.every((r) => r.status === "SCHEDULED" && r.renderedSubject.startsWith("Fixed r")),
    ).toBe(true);
    expect(took).toBeLessThan(30_000);
  }, 120_000);
  test("updateVariant re-renders SCHEDULED rows in place and leaves SENT rows alone", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 2, accounts: [{ dailyLimit: 100 }] });
    await queue(s);
    await plan();
    const [r1, r2] = await rowsOf(s.campaign.id);
    await P().scheduledMessage.update({ where: { id: r2!.id }, data: { status: "SENT" } });
    await updateVariant(P(), s.ws, null, s.steps[0]!.variant.id, { subject: "Fixed" });
    const now1 = await P().scheduledMessage.findUniqueOrThrow({ where: { id: r1!.id } });
    expect(now1).toMatchObject({ status: "SCHEDULED", renderedSubject: "Fixed" });
    expect(
      (await P().scheduledMessage.findUniqueOrThrow({ where: { id: r2!.id } })).renderedSubject,
    ).toBe("Hi");
  });

  test("deleteStep: 409 while a row is in flight; otherwise rows cancelled and leads move on with nextDueAt kept", async () => {
    const s = await seedCampaign(P(), {
      at: T,
      leads: 2,
      steps: 3,
      accounts: [{ dailyLimit: 100 }],
    });
    const due = ago(5 * MIN);
    await onFollowUp(s, 0, s.accounts[0]!.id, { due });
    await onFollowUp(s, 1, s.accounts[0]!.id, { due });
    await plan();
    const step2 = (await rowsOf(s.campaign.id)).filter((r) => r.stepId === s.steps[1]!.id);
    expect(step2).toHaveLength(2);
    await P().scheduledMessage.update({ where: { id: step2[0]!.id }, data: { status: "HELD" } });
    await expect(deleteStep(P(), s.ws, null, s.steps[1]!.id)).rejects.toMatchObject({
      status: 409,
    });
    await P().scheduledMessage.update({
      where: { id: step2[0]!.id },
      data: { status: "SCHEDULED" },
    });
    await deleteStep(P(), s.ws, null, s.steps[1]!.id);
    for (const r of step2)
      expect((await P().scheduledMessage.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(
        "CANCELLED",
      );
    for (const l of s.leads)
      expect(await clOf(l.cl.id)).toMatchObject({
        currentStepId: s.steps[2]!.id,
        nextDueAt: due,
        state: "ACTIVE",
      });
  });

  test("updateStep delay change re-times the leads waiting on that step", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 1, steps: 2 });
    await onFollowUp(s, 0, s.accounts[0]!.id, { due: new Date(T.getTime() + 1440 * MIN) });
    await updateStep(P(), s.ws, null, s.steps[1]!.id, { delayValue: 3, delayUnit: "DAYS" });
    // step 1 went out a day before T: due 3 days after that
    expect((await clOf(s.leads[0]!.cl.id)).nextDueAt).toEqual(
      new Date(T.getTime() + 2 * 1440 * MIN),
    );
  });
});
