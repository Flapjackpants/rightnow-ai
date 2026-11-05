import { createTestDb, expectIsolated } from "@rightnow/db/test-db";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  enrollLeads,
  moveToSubsequence,
  pauseCampaignLead,
  removeCampaignLead,
  removeFromSubsequence,
  resumeCampaignLead,
} from "../src/campaigns/enroll";
import { launchCampaign, type LaunchDeps } from "../src/campaigns/launch";
import { campaignLeadStatus } from "../src/campaigns/lead-status";
import { duplicateCampaign, exportCampaign, importCampaign } from "../src/campaigns/portable";
import { PRESETS } from "../src/campaigns/schema";
import {
  addStep,
  addVariant,
  campaignContentIssues,
  createSubsequence,
  deleteStep,
  deleteVariant,
  reorderSteps,
  setSubsequenceActive,
  updateStep,
  updateVariant,
} from "../src/campaigns/sequence";
import {
  type CampaignError,
  createCampaign,
  setCampaignAccounts,
  setSchedules,
} from "../src/campaigns/service";
import { fixedClock } from "../src/clock";
import { addBlocklist } from "../src/leads/blocklist";
import { addToList, createList } from "../src/leads/lists";
import { createLead, listLeads } from "../src/leads/service";

let db: Awaited<ReturnType<typeof createTestDb>>;
let ws: string;
let other: string;
const clock = fixedClock(new Date("2026-10-20T10:00:00Z"));
const P = () => db.prisma;
let n = 0;
const camp = async (over: Record<string, unknown> = {}, w = ws) =>
  (await createCampaign(P(), w, null, { name: `c${++n}`, ...over })).id;
const step = (c: string, delayValue = 1, extra: Record<string, unknown> = {}) =>
  addStep(P(), ws, null, c, { delayValue, ...extra });
const variant = (s: string, subject = "Hi {{firstName}}", body = "Hello {{firstName}}") =>
  addVariant(P(), ws, null, s, { subject, body });
const lead = async (email = `l${++n}@acme.test`, w = ws, extra: Record<string, unknown> = {}) =>
  (await createLead(P(), w, null, { email, ...extra })).id;
const enroll = (c: string, p: Parameters<typeof enrollLeads>[4]) =>
  enrollLeads(P(), clock, ws, c, p);
const fail = async (p: Promise<unknown>) =>
  (await p.then(
    () => null,
    (e: unknown) => e,
  )) as CampaignError;
const cls = (c: string) => P().campaignLead.findMany({ where: { campaignId: c } });
const codes = (x: CampaignError) =>
  (x.body as { issues: { code: string }[] }).issues.map((i) => i.code);
const deps = (over: Partial<LaunchDeps> = {}): LaunchDeps => ({
  appUrl: "https://mail.example.com",
  sendable: ["SMTP", "GMAIL", "MICROSOFT"],
  contentIssues: (id, w) => campaignContentIssues(P(), id, w),
  ...over,
});
const account = (w = ws) =>
  P().emailAccount.create({
    data: {
      workspaceId: w,
      provider: "SMTP",
      email: `x${++n}@send.test`,
      fromName: "F",
      firstName: "F",
      lastName: "L",
      capTier: "SMTP",
      providerCap: 100,
    },
  });

beforeAll(async () => {
  db = await createTestDb();
  ws = (
    await P().workspace.create({
      data: { name: "w", slug: "w-seq", physicalAddress: "1 Main St" },
    })
  ).id;
  other = (await P().workspace.create({ data: { name: "o", slug: "o-seq" } })).id;
});
afterAll(() => db.drop());

describe("steps and variants", () => {
  test("step 1 of the main sequence is forced to delay 0; reorder and delete keep that", async () => {
    const c = await camp();
    const a = await step(c, 5);
    const b = await step(c, 3);
    expect(a).toMatchObject({ order: 1, delayValue: 0 });
    expect(b).toMatchObject({ order: 2, delayValue: 3 });
    await reorderSteps(P(), ws, null, c, null, [b.id, a.id]);
    const after = await P().sequenceStep.findMany({
      where: { campaignId: c },
      orderBy: { order: "asc" },
    });
    expect(after.map((s) => [s.id, s.order, s.delayValue])).toEqual([
      [b.id, 1, 0],
      [a.id, 2, 0],
    ]);
    await updateStep(P(), ws, null, a.id, { delayValue: 2, delayUnit: "HOURS" });
    await deleteStep(P(), ws, null, b.id); // hard delete: nothing references it
    expect(await P().sequenceStep.findUnique({ where: { id: b.id } })).toBeNull();
    expect(await P().sequenceStep.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      order: 1,
      delayValue: 0,
    });
    expect((await fail(reorderSteps(P(), ws, null, c, null, ["x"])))?.status).toBe(400);
  });

  test("a step a lead points at is soft-deleted", async () => {
    const c = await camp();
    const s = await step(c);
    await enroll(c, { leadIds: [await lead()] });
    await P().campaignLead.updateMany({ where: { campaignId: c }, data: { currentStepId: s.id } });
    await deleteStep(P(), ws, null, s.id);
    const row = await P().sequenceStep.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.deletedAt).not.toBeNull();
  });

  test("cumulative delay over 366 days is a 400", async () => {
    const c = await camp();
    await step(c, 0);
    await step(c, 200);
    expect(await fail(step(c, 167))).toMatchObject({ status: 400, message: "sequence_too_long" });
    await step(c, 166); // exactly 366 days
    expect(await P().sequenceStep.count({ where: { campaignId: c } })).toBe(3);
  });

  test("26 variants are fine, the 27th is a 400; labels A..Z; freed labels are reused", async () => {
    const c = await camp();
    const s = await step(c);
    const vs = [];
    for (let i = 0; i < 26; i++) vs.push(await variant(s.id));
    expect(vs.map((v) => v.label).join("")).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(await fail(variant(s.id))).toMatchObject({ status: 400, message: "variant_limit" });
    await deleteVariant(P(), ws, null, vs[3]!.id);
    expect((await variant(s.id)).label).toBe("D");
  });

  test("templates are validated against lead fields plus the campaign's custom fields", async () => {
    const c = await camp();
    const s = await step(c);
    const v = await variant(s.id);
    const e = await fail(updateVariant(P(), ws, null, v.id, { body: "{{frstName}}" }));
    expect(e).toMatchObject({ status: 400, message: "template_invalid" });
    expect((e.body as { issues: { code: string }[] }).issues[0]!.code).toBe("unknown_variable");
    expect(
      await fail(addVariant(P(), ws, null, s.id, { subject: "{{nope}}", body: "x" })),
    ).toMatchObject({ status: 400 });
    // a custom field becomes valid once an enrolled lead carries it
    expect(await fail(updateVariant(P(), ws, null, v.id, { body: "{{plan}}" }))).toMatchObject({
      status: 400,
    });
    await enroll(c, { leadIds: [await lead(undefined, ws, { customFields: { plan: "pro" } })] });
    expect((await updateVariant(P(), ws, null, v.id, { body: "On {{plan}}" })).body).toBe(
      "On {{plan}}",
    );
  });

  test("the last active variant cannot be deactivated or deleted", async () => {
    const c = await camp();
    const s = await step(c);
    const a = await variant(s.id);
    const b = await variant(s.id);
    await deleteVariant(P(), ws, null, a.id);
    expect(await fail(deleteVariant(P(), ws, null, b.id))).toMatchObject({
      status: 400,
      message: "last_active_variant",
    });
    expect(await fail(updateVariant(P(), ws, null, b.id, { active: false }))).toMatchObject({
      status: 400,
    });
  });

  test("another workspace cannot touch steps or variants", async () => {
    const c = await camp();
    const s = await step(c);
    const v = await variant(s.id);
    expect((await fail(addStep(P(), other, null, c, { delayValue: 1 })))?.status).toBe(404);
    expect((await fail(updateVariant(P(), other, null, v.id, { weight: 2 })))?.status).toBe(404);
    expect((await fail(deleteStep(P(), other, null, s.id)))?.status).toBe(404);
  });
});

describe("subsequences", () => {
  test("create validates the trigger and the limit, activation stamps activatedAt", async () => {
    const c = await camp({ dailyLimit: 50 });
    const t = { kind: "LEAD_STATUS", interest: [1, 2] };
    expect(
      await fail(
        createSubsequence(P(), ws, null, c, {
          name: "s",
          trigger: { kind: "LEAD_STATUS", interest: [7] },
        }),
      ),
    ).toBeTruthy();
    expect(
      await fail(createSubsequence(P(), ws, null, c, { name: "s", trigger: t, dailyLimit: 60 })),
    ).toMatchObject({ message: "daily_limit_above_campaign" });
    const s = await createSubsequence(P(), ws, null, c, {
      name: "s",
      trigger: t,
      preDelayMinutes: 30,
      dailyLimit: 10,
    });
    const off = await setSubsequenceActive(P(), ws, null, s.id, false);
    expect(off.active).toBe(false);
    const on = await setSubsequenceActive(P(), ws, null, s.id, true);
    expect(on.activatedAt!.getTime()).toBeGreaterThanOrEqual(off.activatedAt!.getTime());
    for (const trigger of [
      { kind: "ACTIVITY", activity: "opened" },
      { kind: "REPLY_KEYWORD", phrases: ["pricing"] },
    ])
      await createSubsequence(P(), ws, null, c, { name: "t", trigger });
  });

  test("moving a lead updates the CampaignLead (pre-delay applied) and leaving stops it", async () => {
    const c = await camp();
    const sub = await createSubsequence(P(), ws, null, c, {
      name: "s",
      trigger: { kind: "ACTIVITY", activity: "opened" },
      preDelayMinutes: 60,
    });
    await enroll(c, { leadIds: [await lead()] });
    const [cl] = await cls(c);
    expect(await fail(moveToSubsequence(P(), clock, ws, null, cl!.id, sub.id))).toMatchObject({
      message: "subsequence_has_no_steps",
    });
    expect((await fail(moveToSubsequence(P(), clock, other, null, cl!.id, sub.id)))?.status).toBe(
      404,
    );
    const st = await step(c, 1, { subsequenceId: sub.id });
    const moved = await moveToSubsequence(P(), clock, ws, null, cl!.id, sub.id);
    expect(moved).toMatchObject({ subsequenceId: sub.id, state: "ACTIVE", currentStepId: st.id });
    expect(moved.nextDueAt!.toISOString()).toBe("2026-10-20T11:00:00.000Z");
    expect(await removeFromSubsequence(P(), clock, ws, null, cl!.id)).toMatchObject({
      subsequenceId: null,
      state: "STOPPED",
      stopReason: "MANUAL",
    });
  });
});

describe("enrollment", () => {
  test("conflict with another ACTIVE campaign, allowDuplicates, suppression, repeat", async () => {
    const [a, b] = [await camp(), await camp()];
    await P().campaign.update({ where: { id: a }, data: { status: "ACTIVE" } });
    const [l1, l2, l3] = [await lead(), await lead(), await lead("jo@blocked.test")];
    await enroll(a, { leadIds: [l1] });
    await addBlocklist(P(), ws, null, ["blocked.test"]);
    const r = await enroll(b, { leadIds: [l1, l2, l3, "missing"] });
    expect(r).toEqual({
      enrolled: 1,
      skipped: {
        in_other_active_campaign: 1,
        already_in_campaign: 0,
        suppressed: 1,
        deleted: 1,
        excluded_region: 0,
      },
    });
    expect((await enroll(b, { leadIds: [l2] })).skipped.already_in_campaign).toBe(1);
    expect(await enroll(b, { leadIds: [l1], allowDuplicates: true })).toMatchObject({
      enrolled: 1,
    });
    const d = await camp(); // a DRAFT campaign is no conflict
    expect((await enroll(d, { leadIds: [l2] })).enrolled).toBe(1);
  });

  test("a stopped lead in another ACTIVE campaign does not conflict", async () => {
    const [a, b] = [await camp(), await camp()];
    await P().campaign.update({ where: { id: a }, data: { status: "ACTIVE" } });
    const l = await lead();
    await enroll(a, { leadIds: [l] });
    await removeCampaignLead(P(), clock, ws, null, (await cls(a))[0]!.id);
    expect((await enroll(b, { leadIds: [l] })).enrolled).toBe(1);
  });

  test("concurrent enrollments of the same leads into B and C leave exactly one CampaignLead each", async () => {
    const [b, c] = [await camp(), await camp()];
    for (const x of [b, c])
      await P().campaign.update({ where: { id: x }, data: { status: "ACTIVE" } });
    const ids = await Promise.all(Array.from({ length: 30 }, () => lead()));
    const rs = await Promise.all([enroll(b, { leadIds: ids }), enroll(c, { leadIds: ids })]);
    expect(rs.map((r) => r.enrolled).sort((x, y) => x - y)).toEqual([0, 30]);
    expect(await P().campaignLead.count({ where: { leadId: { in: ids } } })).toBe(30);
  });

  test("from a list and from a filter; one source only; archived and foreign targets refused", async () => {
    const c = await camp();
    const list = await createList(P(), ws, null, "L");
    const ids = [
      await lead(undefined, ws, { tags: ["t1"] }),
      await lead(undefined, ws, { tags: ["t1"] }),
      await lead(),
    ];
    await addToList(P(), ws, null, list.id, ids.slice(0, 2));
    expect((await enroll(c, { listId: list.id })).enrolled).toBe(2);
    const c2 = await camp();
    expect((await enroll(c2, { filter: { tag: "t1" } })).enrolled).toBe(2);
    expect(await fail(enroll(c2, { listId: list.id, leadIds: ids }))).toMatchObject({
      message: "one_source_required",
    });
    expect(await fail(enroll(c2, { listId: "nope" }))).toMatchObject({ status: 400 });
    expect((await fail(enrollLeads(P(), clock, other, c2, { leadIds: ids })))?.status).toBe(404);
    const foreign = await lead(undefined, other); // another workspace's lead is never enrolled
    expect((await enroll(c2, { leadIds: [foreign] })).skipped.deleted).toBe(1);
    await P().campaign.update({ where: { id: c2 }, data: { status: "ARCHIVED" } });
    expect(await fail(enroll(c2, { leadIds: ids }))).toMatchObject({ status: 409 });
  });

  test("pause, resume and remove a CampaignLead", async () => {
    const c = await camp();
    await enroll(c, { leadIds: [await lead()] });
    const [cl] = await cls(c);
    expect(await pauseCampaignLead(P(), ws, null, cl!.id)).toMatchObject({ state: "PAUSED" });
    expect((await fail(pauseCampaignLead(P(), ws, null, cl!.id)))?.status).toBe(409);
    expect(await resumeCampaignLead(P(), ws, null, cl!.id)).toMatchObject({ state: "QUEUED" });
    expect(await removeCampaignLead(P(), clock, ws, null, cl!.id)).toMatchObject({
      state: "STOPPED",
      stopReason: "MANUAL",
    });
    expect((await fail(removeCampaignLead(P(), clock, other, null, cl!.id)))?.status).toBe(404);
  });

  test("isolation", async () => {
    await expectIsolated({
      prisma: P(),
      seed: async (w) => {
        const c = await createCampaign(P(), w, null, { name: "i" });
        const l = await createLead(P(), w, null, { email: "iso@acme.test" });
        await enrollLeads(P(), clock, w, c.id, { leadIds: [l.id] });
      },
      read: (w) => P().campaignLead.findMany({ where: { workspaceId: w } }),
    });
  });
});

describe("statuses and suppression", () => {
  const rows = [
    ["QUEUED", null, "Active"],
    ["ACTIVE", null, "Active"],
    ["PAUSED", null, "Paused"],
    ["PAUSED", "SEND_FAILED", "Paused"],
    ["PAUSED", "ACCOUNT_UNASSIGNED", "Paused"],
    ["COMPLETED", null, "Completed"],
    ["STOPPED", "REPLIED", "Completed"],
    ["STOPPED", "AUTO_REPLIED", "Completed"],
    ["STOPPED", "COMPANY_REPLIED", "Completed"],
    ["STOPPED", "MANUAL", "Completed"],
    ["STOPPED", "BOUNCED", "Bounced"],
    ["STOPPED", "UNSUBSCRIBED", "Unsubscribed"],
    ["STOPPED", "COMPLAINED", "Unsubscribed"],
    ["STOPPED", "SUPPRESSED", "Skipped"],
    ["STOPPED", "SKIPPED", "Skipped"],
    ["STOPPED", "SEND_FAILED", "Skipped"],
  ] as const;

  test("campaignLeadStatus covers the table, and the list filter agrees with it", async () => {
    const c = await camp();
    for (const [state, stopReason, status] of rows)
      expect(campaignLeadStatus({ state, stopReason })).toBe(status);
    for (const [state, stopReason] of rows)
      await P().campaignLead.create({
        data: { workspaceId: ws, campaignId: c, leadId: await lead(), state, stopReason },
      });
    const all = ["Active", "Paused", "Completed", "Bounced", "Unsubscribed", "Skipped"] as const;
    for (const status of all) {
      const got = await listLeads(P(), ws, { campaignId: c, status, take: 100 });
      expect(got.total).toBe(rows.filter((r) => r[2] === status).length);
    }
  });

  test("addBlocklist stops the open CampaignLeads of that domain, in every campaign", async () => {
    const [a, b] = [await camp(), await camp()];
    const jo = await lead("jo@acme-block.test");
    const ann = await lead("ann@keep.test");
    await enroll(a, { leadIds: [jo, ann] });
    await enroll(b, { leadIds: [jo] });
    await addBlocklist(P(), ws, null, ["acme-block.test"]);
    const stopped = await P().campaignLead.findMany({ where: { leadId: jo } });
    expect(stopped.map((s) => [s.state, s.stopReason])).toEqual([
      ["STOPPED", "SUPPRESSED"],
      ["STOPPED", "SUPPRESSED"],
    ]);
    expect((await P().campaignLead.findFirstOrThrow({ where: { leadId: ann } })).state).toBe(
      "QUEUED",
    );
    await addBlocklist(P(), ws, null, ["ann@keep.test"]);
    expect((await P().campaignLead.findFirstOrThrow({ where: { leadId: ann } })).stopReason).toBe(
      "SUPPRESSED",
    );
  });
});

describe("portable", () => {
  async function built() {
    const c = await camp({ name: "Src", dailyLimit: 40, cc: ["cc@x.test"], textOnly: true });
    await setSchedules(P(), ws, null, c, { schedules: [{ name: "o", ...PRESETS.officeHours }] });
    const s1 = await step(c, 0);
    const s2 = await step(c, 3);
    for (const s of [s1, s2]) {
      await variant(s.id, "Hi {{firstName}}", "Body {{companyName}}");
      await addVariant(P(), ws, null, s.id, { subject: "B", body: "b", weight: 3 });
    }
    const sub = await createSubsequence(P(), ws, null, c, {
      name: "S",
      trigger: { kind: "REPLY_KEYWORD", phrases: ["price"] },
      preDelayMinutes: 15,
    });
    await variant((await step(c, 2, { subsequenceId: sub.id })).id);
    await enroll(c, { leadIds: [await lead()] });
    await setCampaignAccounts(P(), ws, null, c, [(await account()).id]);
    return c;
  }

  test("export has no ids, leads or accounts; import deep-equals it as a DRAFT", async () => {
    const c = await built();
    const doc = await exportCampaign(P(), ws, c);
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/c[a-z0-9]{24}/); // no cuid anywhere
    expect(doc).not.toHaveProperty("accountIds");
    const copy = await importCampaign(P(), ws, null, JSON.parse(text));
    expect(copy.status).toBe("DRAFT");
    expect(await exportCampaign(P(), ws, copy.id)).toEqual(doc);
    expect(await P().campaignLead.count({ where: { campaignId: copy.id } })).toBe(0);
    expect(await P().campaignAccount.count({ where: { campaignId: copy.id } })).toBe(0);
    const logged = await P().auditLog.count({
      where: { workspaceId: ws, action: "campaign.import" },
    });
    expect(logged).toBeGreaterThan(0);
  });

  test("import is strict and re-maps account ids only inside the workspace", async () => {
    const c = await built();
    const doc = await exportCampaign(P(), ws, c);
    for (const bad of [
      { ...doc, version: 2 },
      { ...doc, extra: 1 },
      { ...doc, campaign: { ...doc.campaign, name: "" } },
      { ...doc, steps: [{ ...doc.steps[0]!, delayUnit: "WEEKS" }] },
      { ...doc, steps: [doc.steps[0]!, { ...doc.steps[1]!, delayValue: 400, delayUnit: "DAYS" }] },
      { ...doc, campaign: { ...doc.campaign, unsubscribeHeader: false } },
    ])
      expect(await fail(importCampaign(P(), ws, null, bad))).toBeTruthy();
    const foreign = await account(other);
    expect(
      await fail(importCampaign(P(), ws, null, { ...doc, accountIds: [foreign.id] })),
    ).toMatchObject({ message: "unknown_account" });
    const mine = (await P().campaignAccount.findFirstOrThrow({ where: { campaignId: c } }))
      .accountId;
    const ok = await importCampaign(P(), ws, null, { ...doc, accountIds: [mine] });
    expect(await P().campaignAccount.count({ where: { campaignId: ok.id } })).toBe(1);
  });

  test("duplicate is a DRAFT named '(copy)' with the structure and no leads or accounts", async () => {
    const c = await built();
    const d = await duplicateCampaign(P(), ws, null, c);
    expect(d).toMatchObject({ status: "DRAFT", name: "Src (copy)", dailyLimit: 40 });
    expect(await P().campaignLead.count({ where: { campaignId: d.id } })).toBe(0);
    expect(await P().campaignAccount.count({ where: { campaignId: d.id } })).toBe(0);
    expect(await P().campaignSchedule.count({ where: { campaignId: d.id } })).toBe(1);
    const [a, b] = [await exportCampaign(P(), ws, c), await exportCampaign(P(), ws, d.id)];
    expect({ ...b, campaign: { ...b.campaign, name: "Src" } }).toEqual(a);
    expect((await fail(duplicateCampaign(P(), other, null, c)))?.status).toBe(404);
    expect((await fail(exportCampaign(P(), other, c)))?.status).toBe(404);
  });
});

describe("launch", () => {
  test("content issues come back all at once; the success path launches", async () => {
    const c = await camp();
    await setCampaignAccounts(P(), ws, null, c, [(await account()).id]);
    await setSchedules(P(), ws, null, c, { schedules: [{ name: "o", ...PRESETS.officeHours }] });
    const launch = () => fail(launchCampaign(P(), clock, deps(), ws, c, null));
    expect(codes(await launch()).sort()).toEqual(["no_leads", "no_steps"]);

    const s = await step(c);
    const v = await variant(s.id);
    await step(c, 2); // a second step with no variant
    // bypass validation with SQL: a template that no longer passes
    await P().$executeRaw`UPDATE "StepVariant" SET body = '{{bogus}}' WHERE id = ${v.id}`;
    expect(codes(await launch()).sort()).toEqual([
      "no_leads",
      "step_without_variant",
      "template_error",
    ]);
    await P().$executeRaw`UPDATE "StepVariant" SET body = 'ok' WHERE id = ${v.id}`;
    await P().sequenceStep.deleteMany({ where: { campaignId: c, order: 2 } });
    await enroll(c, { leadIds: [await lead(), await lead()] });
    await P().$executeRaw`UPDATE "StepVariant" SET active = false WHERE id = ${v.id}`;
    expect(codes(await launch())).toContain("no_steps");
    await P().$executeRaw`UPDATE "StepVariant" SET active = true WHERE id = ${v.id}`;

    const r = await launchCampaign(P(), clock, deps(), ws, c, null);
    expect(r.status).toBe("ACTIVE");
    expect((await cls(c)).map((x) => x.state)).toEqual(["QUEUED", "QUEUED"]);
  });
});
