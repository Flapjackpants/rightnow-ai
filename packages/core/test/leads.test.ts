import { createHash } from "node:crypto";
import { Prisma } from "@rightnow/db/client";
import { createTestDb, expectIsolated } from "@rightnow/db/test-db";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fixedClock } from "../src/clock";
import { companyDomainOf } from "../src/leads/domain";
import {
  bulkLeads,
  createLabel,
  createLead,
  deleteLabel,
  eventMetaRedaction,
  gdprDeleteLead,
  getLead,
  listLabels,
  listLeads,
  mergeLeads,
  softDeleteLead,
  updateLabel,
  updateLead,
} from "../src/leads/service";
import { isSuppressed } from "../src/leads/suppression";
import { planRow, seedCampaign } from "./campaign-fixture";

let db: Awaited<ReturnType<typeof createTestDb>>;
let ws: string;
let other: string;
const T0 = new Date("2026-10-20T10:00:00Z");
const clock = fixedClock(T0);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
let n = 0;
const mk = (over: Record<string, unknown> = {}) =>
  createLead(db.prisma, ws, null, { email: `l${++n}@acme.test`, ...over });
const audits = (action: string) =>
  db.prisma.auditLog.findMany({ where: { workspaceId: ws, action } });

beforeAll(async () => {
  db = await createTestDb();
  ws = (await db.prisma.workspace.create({ data: { name: "W", slug: "w-leads" } })).id;
  other = (await db.prisma.workspace.create({ data: { name: "O", slug: "o-leads" } })).id;
});
afterAll(() => db.drop());

describe("lead create", () => {
  test("lowercases email; duplicates 409 until soft-deleted; other workspace is independent", async () => {
    const a = await createLead(db.prisma, ws, null, { email: "A@X.test" });
    expect(a.email).toBe("a@x.test");
    await expect(createLead(db.prisma, ws, null, { email: "a@x.test" })).rejects.toMatchObject({
      status: 409,
      message: "lead_exists",
    });
    await createLead(db.prisma, other, null, { email: "a@x.test" });
    await expect(softDeleteLead(db.prisma, clock, other, a.id)).rejects.toMatchObject({
      status: 404,
    });
    await softDeleteLead(db.prisma, clock, ws, a.id);
    await expect(getLead(db.prisma, ws, a.id)).rejects.toMatchObject({ status: 404 });
    await createLead(db.prisma, ws, null, { email: "a@x.test" });
    expect((await audits("lead.delete")).length).toBe(1);
  });

  test("company domain: free mail gives null, otherwise the email domain", async () => {
    expect(companyDomainOf("jo@acme.test")).toBe("acme.test");
    expect(companyDomainOf("jo@gmail.com")).toBeNull();
    expect((await mk({ email: "co@acme.test" })).companyDomain).toBe("acme.test");
    expect((await mk({ email: "co@gmail.com" })).companyDomain).toBeNull();
  });

  test("rejects unknown keys and an owner outside the workspace", async () => {
    await expect(mk({ workspaceId: other })).rejects.toThrow();
    await expect(mk({ ownerId: "nobody" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("lead update", () => {
  test("interest stamps lastInterestChangeAt and audits; bad values are rejected; foreign is 404", async () => {
    const l = await mk();
    const u = await updateLead(db.prisma, clock, ws, l.id, { interestStatus: 1 });
    expect(u.lastInterestChangeAt).toEqual(T0);
    expect((await audits("lead.update")).some((a) => a.target === l.id)).toBe(true);
    await expect(updateLead(db.prisma, clock, ws, l.id, { interestStatus: 7 })).rejects.toThrow();
    await expect(
      updateLead(db.prisma, clock, ws, l.id, { customFields: { a: {} } }),
    ).rejects.toThrow();
    await expect(
      updateLead(db.prisma, clock, other, l.id, { firstName: "x" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("not interested suppresses", async () => {
    const l = await mk({ email: "ni@acme.test" });
    await updateLead(db.prisma, clock, ws, l.id, { interestStatus: -1 });
    const s = await db.prisma.suppression.findFirst({
      where: { workspaceId: ws, valueHash: sha("ni@acme.test") },
    });
    expect(s).toMatchObject({ reason: "NOT_INTERESTED", source: "status", kind: "EMAIL" });
    expect(await isSuppressed(db.prisma, ws, "NI@acme.test")).toBe(true);
    expect(await isSuppressed(db.prisma, other, "ni@acme.test")).toBe(false);
  });
});

describe("lead list", () => {
  test("is workspace scoped", async () => {
    await expectIsolated({
      prisma: db.prisma,
      seed: async (w) => {
        await createLead(db.prisma, w, null, { email: "iso@acme.test" });
      },
      read: async (w) => (await listLeads(db.prisma, w, {})).leads,
    });
  });

  test("openedNoReply, custom contains, tag", async () => {
    const w = (await db.prisma.workspace.create({ data: { name: "F", slug: "w-filter" } })).id;
    const c = (email: string, data: Record<string, unknown>) =>
      db.prisma.lead.create({ data: { workspaceId: w, email, ...data } });
    const a = await c("a@acme.test", {
      opens: 2,
      replies: 0,
      customFields: { city: "Berlin" },
      tags: ["t"],
    });
    await c("b@acme.test", { opens: 2, replies: 1 });
    await c("c@acme.test", { opens: 0 });
    const ids = async (q: object) => (await listLeads(db.prisma, w, q)).leads.map((l) => l.id);
    expect(await ids({ openedNoReply: true })).toEqual([a.id]);
    expect(await ids({ custom: { key: "city", contains: "ber" } })).toEqual([a.id]);
    expect(await ids({ customKey: "city", customContains: "ber" })).toEqual([a.id]);
    expect(await ids({ tag: "t" })).toEqual([a.id]);
    expect(await ids({ q: "B@ACME" })).toHaveLength(1);
  });

  test("cursor pagination: 50/50/20 with no repeats", async () => {
    const w = (await db.prisma.workspace.create({ data: { name: "P", slug: "w-page" } })).id;
    await db.prisma.lead.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({ workspaceId: w, email: `p${i}@acme.test` })),
    });
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | undefined;
    do {
      const r = await listLeads(db.prisma, w, { take: 50, cursor });
      sizes.push(r.leads.length);
      seen.push(...r.leads.map((l) => l.id));
      cursor = r.nextCursor ?? undefined;
    } while (cursor);
    expect(sizes).toEqual([50, 50, 20]);
    expect(new Set(seen).size).toBe(120);
    await expect(listLeads(db.prisma, w, { take: 101 })).rejects.toThrow();
  });

  test("server-side sort: 3 pages come back globally ordered, nulls last, no repeats or gaps", async () => {
    const w = (await db.prisma.workspace.create({ data: { name: "S", slug: "w-sort" } })).id;
    const pad = (n: number) => String(n).padStart(3, "0");
    await db.prisma.lead.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        workspaceId: w,
        email: `s${pad((i * 37) % 120)}@acme.test`,
        lastName: i % 7 === 0 ? null : `ln${pad(i % 17)}`,
        companyName: i % 11 === 0 ? null : `co${pad(i % 13)}`,
        interestStatus: i % 5 === 0 ? null : (i % 9) - 4,
        createdAt: new Date(T0.getTime() + ((i * 53) % 120) * 1000),
      })),
    });
    const cols = ["email", "createdAt", "lastName", "companyName", "interestStatus"] as const;
    for (const sort of cols)
      for (const dir of ["asc", "desc"] as const) {
        const seen: { id: string; v: unknown }[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const r = await listLeads(db.prisma, w, { take: 50, cursor, sort, dir });
          seen.push(...r.leads.map((l) => ({ id: l.id, v: (l as Record<string, unknown>)[sort] })));
          cursor = r.nextCursor ?? undefined;
          pages++;
        } while (cursor);
        const label = `${sort} ${dir}`;
        expect(pages, label).toBe(3);
        expect(new Set(seen.map((x) => x.id)).size, label).toBe(120);
        const vals = seen.map((x) => (x.v === null ? null : x.v instanceof Date ? +x.v : x.v));
        const firstNull = vals.indexOf(null);
        const present = firstNull < 0 ? vals : vals.slice(0, firstNull);
        expect(
          vals.slice(present.length).every((v) => v === null),
          `${label} nulls last`,
        ).toBe(true);
        const sorted = [...present].sort((a, b) => (a! < b! ? -1 : a! > b! ? 1 : 0));
        expect(present, label).toEqual(dir === "asc" ? sorted : sorted.reverse());
      }
  });

  test("an unknown sort column is rejected", async () => {
    await expect(listLeads(db.prisma, ws, { sort: "passwordHash" as never })).rejects.toThrow();
    await expect(listLeads(db.prisma, ws, { dir: "sideways" as never })).rejects.toThrow();
  });
});

describe("bulk", () => {
  async function users(count: number) {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `u${++n}`;
      await db.prisma.user.create({ data: { id, name: id, email: `${id}@x.io` } });
      await db.prisma.member.create({
        data: { id: `m${id}`, workspaceId: ws, userId: id, role: "member" },
      });
      ids.push(id);
    }
    return ids;
  }

  test("assign_round_robin cycles users in id order; ghosts, 1001 ids and foreign workspaces are refused", async () => {
    const [u1, u2] = await users(2);
    const leads = await Promise.all([1, 2, 3, 4, 5].map(() => mk()));
    const ids = leads.map((l) => l.id);
    const r = await bulkLeads(db.prisma, clock, ws, {
      ids,
      action: "assign_round_robin",
      value: [u1, u2],
    });
    expect(r.affected).toBe(5);
    const rows = await db.prisma.lead.findMany({
      where: { id: { in: ids } },
      orderBy: { id: "asc" },
    });
    expect(rows.map((l) => l.ownerId)).toEqual([u1, u2, u1, u2, u1]);
    await expect(
      bulkLeads(db.prisma, clock, ws, { ids, action: "assign_round_robin", value: ["ghost"] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      bulkLeads(db.prisma, clock, ws, {
        ids: Array.from({ length: 1001 }, (_, i) => `x${i}`),
        action: "delete",
      }),
    ).rejects.toThrow();
    expect((await bulkLeads(db.prisma, clock, other, { ids, action: "delete" })).affected).toBe(0);
    expect(await db.prisma.lead.count({ where: { id: { in: ids }, deletedAt: null } })).toBe(5);
  });

  test("tags, interest and delete", async () => {
    const l = await mk({ tags: ["a", "b"] });
    const ids = [l.id];
    await bulkLeads(db.prisma, clock, ws, { ids, action: "add_tags", value: ["b", "c"] });
    expect((await getLead(db.prisma, ws, l.id)).tags.sort()).toEqual(["a", "b", "c"]);
    await bulkLeads(db.prisma, clock, ws, { ids, action: "remove_tags", value: ["a"] });
    expect((await getLead(db.prisma, ws, l.id)).tags.sort()).toEqual(["b", "c"]);
    await bulkLeads(db.prisma, clock, ws, { ids, action: "set_interest", value: -1 });
    expect(await isSuppressed(db.prisma, ws, l.email)).toBe(true);
    await bulkLeads(db.prisma, clock, ws, { ids, action: "delete" });
    await expect(getLead(db.prisma, ws, l.id)).rejects.toMatchObject({ status: 404 });
    expect((await audits("lead.bulk")).length).toBeGreaterThan(0);
  });
});

describe("merge", () => {
  test("repoints referrals, avoids self-reference, and inherits a safe referrer", async () => {
    const parent = await mk();
    const keep = await mk();
    const from = await mk();
    const child = await mk();
    await db.prisma.lead.update({ where: { id: from.id }, data: { referredById: parent.id } });
    await db.prisma.lead.update({ where: { id: keep.id }, data: { referredById: from.id } });
    await db.prisma.lead.update({ where: { id: child.id }, data: { referredById: from.id } });
    await mergeLeads(db.prisma, clock, ws, { keepId: keep.id, mergeId: from.id });
    expect((await db.prisma.lead.findUniqueOrThrow({ where: { id: keep.id } })).referredById).toBe(
      parent.id,
    );
    expect((await db.prisma.lead.findUniqueOrThrow({ where: { id: child.id } })).referredById).toBe(
      keep.id,
    );
    expect(await getLead(db.prisma, ws, child.id)).toMatchObject({
      referredById: keep.id,
      referredBy: { id: keep.id, email: keep.email },
    });
    await expect(getLead(db.prisma, other, child.id)).rejects.toMatchObject({ status: 404 });
  });
  test("merge never copies a referrer that would point at the kept lead", async () => {
    const keep = await mk();
    const from = await mk();
    await db.prisma.lead.update({ where: { id: from.id }, data: { referredById: keep.id } });
    await mergeLeads(db.prisma, clock, ws, { keepId: keep.id, mergeId: from.id });
    expect((await getLead(db.prisma, ws, keep.id)).referredById).toBeNull();
  });
  test("getLead hides a referrer belonging to another workspace", async () => {
    const foreign = await db.prisma.lead.create({
      data: { workspaceId: other, email: "foreign-ref@acme.test" },
    });
    const local = await mk();
    await db.prisma.lead.update({ where: { id: local.id }, data: { referredById: foreign.id } });
    expect((await getLead(db.prisma, ws, local.id)).referredBy).toBeNull();
  });
  test("keep wins, blanks filled, unions, counters summed, merged soft-deleted", async () => {
    const keep = await mk({ firstName: "A", tags: ["x"], customFields: { k: 1 } });
    const from = await mk({
      firstName: "B",
      phone: "1",
      tags: ["y"],
      customFields: { k: 2, j: 3 },
    });
    await db.prisma.lead.update({ where: { id: keep.id }, data: { opens: 1 } });
    await db.prisma.lead.update({ where: { id: from.id }, data: { opens: 2 } });
    const list = await db.prisma.leadList.create({ data: { workspaceId: ws, name: "L" } });
    await db.prisma.leadListMember.create({ data: { listId: list.id, leadId: from.id } });
    await expect(
      mergeLeads(db.prisma, clock, other, { keepId: keep.id, mergeId: from.id }),
    ).rejects.toMatchObject({ status: 404 });
    const m = await mergeLeads(db.prisma, clock, ws, { keepId: keep.id, mergeId: from.id });
    expect(m).toMatchObject({ firstName: "A", phone: "1", tags: ["x", "y"], opens: 3 });
    expect(m.customFields).toEqual({ k: 1, j: 3 });
    const gone = await db.prisma.lead.findUniqueOrThrow({ where: { id: from.id } });
    expect(gone.deletedAt).toEqual(T0);
    expect(gone.mergedIntoId).toBe(keep.id);
    expect((await db.prisma.leadListMember.findMany({ where: { leadId: keep.id } })).length).toBe(
      1,
    );
    expect((await audits("lead.merge")).filter((a) => a.target === keep.id)).toHaveLength(1);
  });
});

describe("gdpr delete", () => {
  test("deleting a referrer clears the referred lead link", async () => {
    const parent = await mk();
    const child = await mk();
    await db.prisma.lead.update({ where: { id: child.id }, data: { referredById: parent.id } });
    await gdprDeleteLead(db.prisma, clock, ws, parent.id);
    expect(
      (await db.prisma.lead.findUniqueOrThrow({ where: { id: child.id } })).referredById,
    ).toBeNull();
  });
  test("leaves no address behind, keeps the hashed suppression, email can be re-added", async () => {
    const l = await mk({ email: "jo@acme.test" });
    await db.prisma.suppression.create({
      data: {
        workspaceId: ws,
        kind: "EMAIL",
        value: "jo@acme.test",
        valueHash: sha("jo@acme.test"),
        reason: "MANUAL",
      },
    });
    await updateLead(db.prisma, clock, ws, l.id, { firstName: "Jo" });
    await expect(gdprDeleteLead(db.prisma, clock, other, l.id)).rejects.toMatchObject({
      status: 404,
    });
    await gdprDeleteLead(db.prisma, clock, ws, l.id, null);
    const dump = JSON.stringify([
      await db.prisma.lead.findMany({ where: { workspaceId: ws } }),
      await db.prisma.suppression.findMany({ where: { workspaceId: ws } }),
      await db.prisma.auditLog.findMany({ where: { workspaceId: ws } }),
    ]);
    expect(dump).not.toContain("jo@acme.test");
    const s = await db.prisma.suppression.findFirstOrThrow({
      where: { workspaceId: ws, valueHash: sha("jo@acme.test") },
    });
    expect(s).toMatchObject({ value: null, reason: "GDPR_ERASURE" }); // D20: an existing suppression is upgraded
    expect(await isSuppressed(db.prisma, ws, "jo@acme.test")).toBe(true);
    await mk({ email: "jo@acme.test" });
    const g = (await audits("lead.gdpr_delete")).find(
      (a) => (a.meta as { hashes: string[] }).hashes[0] === sha("jo@acme.test"),
    );
    expect(g!.meta).toEqual({ hashes: [sha("jo@acme.test")] });
  });

  test("a new erasure suppression has reason GDPR_ERASURE", async () => {
    const l = await mk({ email: "new@acme.test" });
    await gdprDeleteLead(db.prisma, clock, ws, l.id);
    expect(
      await db.prisma.suppression.findFirstOrThrow({
        where: { workspaceId: ws, valueHash: sha("new@acme.test") },
      }),
    ).toMatchObject({ reason: "GDPR_ERASURE", value: null });
  });

  test("erases soft-deleted duplicates and merged rows (I10)", async () => {
    const dead = await mk({ email: "jo2@acme.test" });
    await softDeleteLead(db.prisma, clock, ws, dead.id);
    const live = await mk({ email: "jo2@acme.test" });
    const old = await mk({ email: "old2@acme.test" });
    await mergeLeads(db.prisma, clock, ws, { keepId: live.id, mergeId: old.id });
    const r = await gdprDeleteLead(db.prisma, clock, ws, live.id);
    expect(r.deleted).toBe(3);
    expect(await db.prisma.lead.count({ where: { id: { in: [dead.id, live.id, old.id] } } })).toBe(
      0,
    );
    const sup = await db.prisma.suppression.findMany({
      where: { workspaceId: ws, valueHash: { in: [sha("jo2@acme.test"), sha("old2@acme.test")] } },
    });
    expect(sup.map((s) => s.value)).toEqual([null, null]);
  });

  test("409 send_in_progress while a send is in flight; SENT, HELD and SCHEDULED rows do not block", async () => {
    const { campaign, accounts, steps } = await seedCampaign(db.prisma, {
      at: T0,
      workspaceId: ws,
      accounts: [{}],
    });
    const row = async (
      email: string,
      status: "SENDING" | "UNCERTAIN" | "SENT" | "HELD" | "SCHEDULED",
    ) => {
      const l = await mk({ email });
      const cl = await db.prisma.campaignLead.create({
        data: { workspaceId: ws, campaignId: campaign.id, leadId: l.id, state: "ACTIVE" },
      });
      await planRow(db.prisma, {
        workspaceId: ws,
        campaignId: campaign.id,
        campaignLeadId: cl.id,
        stepId: steps[0]!.id,
        accountId: accounts[0]!.id,
        dueAt: T0,
        status,
      });
      return l;
    };
    for (const status of ["SENDING", "UNCERTAIN"] as const) {
      const l = await row(`busy-${status}@acme.test`, status);
      await expect(gdprDeleteLead(db.prisma, clock, ws, l.id)).rejects.toMatchObject({
        status: 409,
        message: "send_in_progress",
      });
      expect(await db.prisma.lead.count({ where: { id: l.id } })).toBe(1);
      expect(await db.prisma.suppression.count({ where: { valueHash: sha(l.email) } })).toBe(0);
      const other = await mk({ email: `merge-${status}@acme.test` });
      await expect(
        mergeLeads(db.prisma, clock, ws, { keepId: other.id, mergeId: l.id }),
      ).rejects.toMatchObject({ status: 409, message: "send_in_progress" });
    }
    for (const status of ["SENT", "HELD", "SCHEDULED"] as const) {
      const l = await row(`free-${status}@acme.test`, status);
      await gdprDeleteLead(db.prisma, clock, ws, l.id);
      expect(await db.prisma.lead.count({ where: { id: l.id } })).toBe(0);
      // the lead's rows cascade away with it; a SCHEDULED one can therefore never be sent
      expect(
        await db.prisma.scheduledMessage.count({ where: { campaignLead: { leadId: l.id } } }),
      ).toBe(0);
    }
    expect(
      await db.prisma.scheduledMessage.count({
        where: { campaignId: campaign.id, status: "SCHEDULED" },
      }),
    ).toBe(0);
  });
});

describe("gdpr erasure residue (I4, A1)", () => {
  test("no table holds the address afterwards, BackgroundJob and other leads' Event meta included", async () => {
    const addr = "resi@acme.test";
    const l = await mk({ email: addr });
    const o = await mk({ email: "kept-r@acme.test" });
    const event = (type: "BOUNCE_HARD" | "CLICK" | "OPEN", leadId: string, meta: object) =>
      db.prisma.event.create({
        data: { workspaceId: ws, type, occurredAt: T0, leadId, meta, dedupeKey: `resi:${++n}` },
      });
    const bounce = await event("BOUNCE_HARD", o.id, { recipient: addr, status: "5.1.1" });
    const click = await event("CLICK", o.id, {
      url: `https://x.test/?e=${encodeURIComponent(addr)}`,
    });
    await event("OPEN", l.id, {});
    const job = (
      status: "DONE" | "FAILED" | "PENDING" | "RUNNING",
      input: object,
      result?: object,
    ) =>
      db.prisma.backgroundJob.create({
        data: { workspaceId: ws, kind: "leads_bulk", status, input, result },
      });
    const filter = { filter: { q: addr }, action: "add_tags", value: ["x"] };
    await job("DONE", filter, { affected: 1 });
    await job("FAILED", { leadIds: [l.id] }, { note: addr });
    const pendingJob = await job("PENDING", filter);
    const running = await job("RUNNING", filter);
    const unrelated = await job("DONE", { filter: { q: "nobody" } });
    const hook = await db.prisma.webhook.create({
      data: { workspaceId: ws, url: "https://h.test/", events: ["all_events"], secretEnc: "x" },
    });
    await db.prisma.webhookDelivery.create({
      data: {
        workspaceId: ws,
        webhookId: hook.id,
        eventId: `resi-${++n}`,
        eventType: "reply_received",
        payload: { reply_text: `cc ${addr}` },
        nextAttemptAt: T0,
      },
    });
    await gdprDeleteLead(db.prisma, clock, ws, l.id);
    const tables = await db.prisma.$queryRaw<{ t: string }[]>`
      SELECT table_name AS t FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`;
    const left: string[] = [];
    for (const { t } of tables) {
      const [r] = await db.prisma.$queryRawUnsafe<{ c: number }[]>(
        `SELECT count(*)::int AS c FROM "${t}" x WHERE x::text ILIKE $1 OR x::text ILIKE $2`,
        `%${addr}%`,
        `%${encodeURIComponent(addr)}%`,
      );
      if (r!.c) left.push(t);
    }
    expect(left).toEqual([]);
    // the other lead's events stay, redacted; a running job keeps its row; an unrelated job is untouched
    expect(await db.prisma.event.findUniqueOrThrow({ where: { id: bounce.id } })).toMatchObject({
      leadId: o.id,
      meta: {},
    });
    expect(await db.prisma.event.count({ where: { id: click.id } })).toBe(1);
    expect(
      await db.prisma.backgroundJob.findUniqueOrThrow({ where: { id: running.id } }),
    ).toMatchObject({
      status: "RUNNING",
      input: {},
    });
    expect(await db.prisma.backgroundJob.count({ where: { id: pendingJob.id } })).toBe(1);
    expect(await db.prisma.backgroundJob.count({ where: { id: unrelated.id } })).toBe(1);
  });

  test("the Event meta sweep is an index scan, not a scan of every workspace event", async () => {
    const plan = await db.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      return tx.$queryRaw<{ "QUERY PLAN": string }[]>(
        Prisma.sql`EXPLAIN ${eventMetaRedaction(ws, ["%a@b.test%"])}`,
      );
    });
    const text = plan.map((r) => r["QUERY PLAN"]).join(" | ");
    expect(text).not.toMatch(/Seq Scan on "Event"/);
    // the type list is part of the index condition: only bounce/complaint/click rows of the workspace are read
    expect(text).toMatch(/Index Cond: .*"workspaceId" = .* AND \(type = ANY/);
  });
});

describe("tenant isolation and concurrency", () => {
  async function user(w: string) {
    const id = `iu${++n}`;
    await db.prisma.user.create({ data: { id, name: id, email: `${id}@x.io` } });
    await db.prisma.member.create({
      data: { id: `m${id}`, workspaceId: w, userId: id, role: "member" },
    });
    return id;
  }
  const foreignLead = (email: string, data: object = {}) =>
    db.prisma.lead.create({ data: { workspaceId: other, email, ...data } });

  test("bulk actions with foreign ids touch nothing, raw-SQL paths included", async () => {
    const f = await foreignLead(`f${++n}@acme.test`, { tags: ["keep"] });
    const mine = await user(ws);
    const ids = [f.id];
    for (const [action, value] of [
      ["set_owner", mine],
      ["assign_round_robin", [mine]],
      ["set_interest", -1],
      ["add_tags", ["x"]],
      ["remove_tags", ["keep"]],
      ["delete", null],
    ] as const) {
      const r = await bulkLeads(db.prisma, clock, ws, { ids, action, value });
      expect(r.affected, action).toBe(0);
    }
    const after = await db.prisma.lead.findUniqueOrThrow({ where: { id: f.id } });
    expect(after).toMatchObject({
      ownerId: null,
      interestStatus: null,
      tags: ["keep"],
      deletedAt: null,
    });
    expect(await isSuppressed(db.prisma, ws, f.email)).toBe(false);
    expect(await isSuppressed(db.prisma, other, f.email)).toBe(false);
  });

  test("a member of another workspace cannot be an owner", async () => {
    const alien = await user(other);
    const l = await mk();
    await expect(mk({ ownerId: alien })).rejects.toMatchObject({ status: 400 });
    await expect(updateLead(db.prisma, clock, ws, l.id, { ownerId: alien })).rejects.toMatchObject({
      status: 400,
    });
    for (const [action, value] of [
      ["set_owner", alien],
      ["assign_round_robin", [alien]],
    ] as const)
      await expect(
        bulkLeads(db.prisma, clock, ws, { ids: [l.id], action, value }),
      ).rejects.toMatchObject({ status: 400, message: "unknown_owner" });
  });

  test("merge with a foreign mergeId is 404 and changes nothing", async () => {
    const keep = await mk();
    const f = await foreignLead(`f${++n}@acme.test`);
    await expect(
      mergeLeads(db.prisma, clock, ws, { keepId: keep.id, mergeId: f.id }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await db.prisma.lead.count({ where: { id: { in: [keep.id, f.id] }, deletedAt: null } }),
    ).toBe(2);
  });

  test("gdpr leaves a foreign lead with the same email untouched", async () => {
    const email = `same${++n}@acme.test`;
    const mine = await mk({ email });
    const f = await foreignLead(email);
    await gdprDeleteLead(db.prisma, clock, ws, mine.id);
    expect(await db.prisma.lead.count({ where: { id: f.id } })).toBe(1);
    expect(await isSuppressed(db.prisma, other, email)).toBe(false);
    expect(await isSuppressed(db.prisma, ws, email)).toBe(true);
  });

  test("a foreign listId returns nothing", async () => {
    const f = await foreignLead(`f${++n}@acme.test`);
    const list = await db.prisma.leadList.create({ data: { workspaceId: other, name: "FL" } });
    await db.prisma.leadListMember.create({ data: { listId: list.id, leadId: f.id } });
    await mk();
    expect((await listLeads(db.prisma, ws, { listId: list.id })).leads).toEqual([]);
    expect((await listLeads(db.prisma, other, { listId: list.id })).leads.length).toBe(1);
    await expect(getLead(db.prisma, ws, f.id)).rejects.toMatchObject({ status: 404 });
  });

  test("concurrent merges A<-B and B<-A: exactly one wins, one lead stays live", async () => {
    const a = await mk();
    const b = await mk();
    const r = await Promise.allSettled([
      mergeLeads(db.prisma, clock, ws, { keepId: a.id, mergeId: b.id }),
      mergeLeads(db.prisma, clock, ws, { keepId: b.id, mergeId: a.id }),
    ]);
    expect(r.filter((x) => x.status === "fulfilled").length).toBe(1);
    expect(
      await db.prisma.lead.count({ where: { id: { in: [a.id, b.id] }, deletedAt: null } }),
    ).toBe(1);
  });

  test("1000-lead bulk operations finish inside the transaction timeout", async () => {
    const w = (await db.prisma.workspace.create({ data: { name: "B", slug: "w-bulk1000" } })).id;
    const owners = [await user(w), await user(w)];
    await db.prisma.lead.createMany({
      data: Array.from({ length: 1000 }, (_, i) => ({ workspaceId: w, email: `b${i}@acme.test` })),
    });
    const ids = (
      await db.prisma.lead.findMany({ where: { workspaceId: w }, select: { id: true } })
    ).map((l) => l.id);
    const t0 = Date.now();
    for (const [action, value] of [
      ["assign_round_robin", owners],
      ["set_interest", -1],
      ["add_tags", ["t"]],
      ["remove_tags", ["t"]],
      ["delete", null],
    ] as const)
      expect((await bulkLeads(db.prisma, clock, w, { ids, action, value })).affected, action).toBe(
        1000,
      );
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(
      await db.prisma.suppression.count({ where: { workspaceId: w, reason: "NOT_INTERESTED" } }),
    ).toBe(1000);
  });
});

describe("labels", () => {
  test("crud, rename propagates to leads, delete strips it, workspace scoped", async () => {
    const lab = await createLabel(db.prisma, ws, null, { name: "Hot", color: "#ff0000" });
    await expect(
      createLabel(db.prisma, ws, null, { name: "Hot", color: "#00ff00" }),
    ).rejects.toMatchObject({ status: 409 });
    const l = await mk({ labels: ["Hot"] });
    await expect(updateLabel(db.prisma, other, lab.id, { color: "#00ff00" })).rejects.toMatchObject(
      { status: 404 },
    );
    await updateLabel(db.prisma, ws, lab.id, { name: "Warm" });
    expect((await getLead(db.prisma, ws, l.id)).labels).toEqual(["Warm"]);
    expect((await listLabels(db.prisma, other)).length).toBe(0);
    await expect(deleteLabel(db.prisma, other, lab.id)).rejects.toMatchObject({ status: 404 });
    await deleteLabel(db.prisma, ws, lab.id);
    expect((await getLead(db.prisma, ws, l.id)).labels).toEqual([]);
  });

  test("a webhook event name is reserved (R23)", async () => {
    const reserved = { status: 400, message: "label_name_reserved" };
    await expect(
      createLabel(db.prisma, ws, null, { name: "email_sent", color: "#ff0000" }),
    ).rejects.toMatchObject(reserved);
    await expect(
      createLabel(db.prisma, ws, null, { name: "Email_Sent", color: "#ff0000" }),
    ).rejects.toMatchObject(reserved);
    const lab = await createLabel(db.prisma, ws, null, { name: "Fine", color: "#ff0000" });
    await expect(
      updateLabel(db.prisma, ws, lab.id, { name: "lead_interested" }),
    ).rejects.toMatchObject(reserved);
  });
});
