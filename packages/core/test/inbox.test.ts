import { randomBytes } from "node:crypto";
import type { EmailAccount, Prisma } from "@rightnow/db/client";
import { createTestDb } from "@rightnow/db/test-db";
import type { RemoteMessage } from "@rightnow/providers";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fixedClock } from "../src/clock";
import { gdprDeleteLead, mergeLeads } from "../src/leads/service";
import { isSuppressed, suppress } from "../src/leads/suppression";
import { classify } from "../src/mail/classify";
import {
  attachLead,
  bulkThreads,
  createLeadFromThread,
  deleteThread,
  getThread,
  listThreads,
  readAll,
  unreadCount,
  updateThread,
} from "../src/mail/inbox";
import { ingestMessage } from "../src/mail/ingest";
import { createNote, renderMacro, createMacro } from "../src/mail/inbox-library";
import { applyInbound } from "../src/mail/stoprules";
import { seedCampaign } from "./campaign-fixture";

let db: Awaited<ReturnType<typeof createTestDb>>;
const P = () => db.prisma;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.drop());

const T = new Date("2026-10-20T10:00:00Z");
const DAY = 86_400_000;
const clock = fixedClock(T);
const at = (ms: number) => new Date(T.getTime() + ms);
let n = 0;

/** A workspace with one mailbox. */
async function world() {
  const tag = randomBytes(4).toString("hex");
  const w = await P().workspace.create({ data: { name: "W", slug: `w-${tag}` } });
  const a = await mailbox(w.id, `me-${tag}@send.test`);
  return { ws: w.id, a };
}
const mailbox = (workspaceId: string, email: string) =>
  P().emailAccount.create({
    data: {
      workspaceId,
      provider: "SMTP",
      email,
      fromName: "Me",
      firstName: "Me",
      lastName: "Self",
      capTier: "SMTP",
      providerCap: 100,
    },
  });
const lead = (ws: string, o: Partial<Prisma.LeadUncheckedCreateInput> = {}) =>
  P().lead.create({
    data: { workspaceId: ws, email: `l${++n}-${randomBytes(3).toString("hex")}@lead.test`, ...o },
  });

type ThreadOpts = {
  leadId?: string | null;
  campaignId?: string | null;
  subject?: string;
  at?: Date;
  inbound?: boolean;
  kind?: "REPLY" | "BOUNCE" | "COMPLAINT";
  text?: string;
  from?: string;
  fromName?: string | null;
  out?: boolean;
} & Partial<Prisma.ThreadUncheckedCreateInput>;

/** A thread with an inbound message (default) and/or one of ours, written directly. */
async function thread(ws: string, a: EmailAccount, o: ThreadOpts = {}) {
  const {
    leadId,
    campaignId,
    subject,
    inbound = true,
    kind = "REPLY",
    text,
    from,
    fromName,
    out,
    at: when,
    ...rest
  } = o;
  const sentAt = when ?? at(++n * 1000);
  const t = await P().thread.create({
    data: {
      workspaceId: ws,
      accountId: a.id,
      subject: subject ?? `Subject ${n}`,
      leadId: leadId ?? null,
      campaignId: campaignId ?? null,
      lastMessageAt: sentAt,
      ...(inbound && { lastInboundAt: sentAt, lastInboundKind: kind }),
      ...rest,
    },
  });
  const base = {
    workspaceId: ws,
    accountId: a.id,
    threadId: t.id,
    subject: t.subject,
    sentAt,
    references: [],
  };
  if (inbound)
    await P().message.create({
      data: {
        ...base,
        rfcMessageId: `<in${++n}@x.test>`,
        direction: "IN",
        folder: "INBOX",
        fromEmail: from ?? "someone@x.test",
        fromName: fromName ?? null,
        to: [a.email],
        cc: [],
        kind,
        text: text ?? "hello there",
        leadId: leadId ?? null,
      },
    });
  if (out)
    await P().message.create({
      data: {
        ...base,
        rfcMessageId: `<out${++n}@x.test>`,
        direction: "OUT",
        folder: "SENT",
        fromEmail: a.email,
        to: ["someone@x.test"],
        cc: [],
        kind: "OUTBOUND",
        text: "ours",
      },
    });
  return t;
}
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe("views and filters", () => {
  test("each view returns exactly the seeded threads", async () => {
    const { ws, a } = await world();
    const live = await lead(ws);
    const gone = await lead(ws, { deletedAt: T });
    const primary = await thread(ws, a, { leadId: live.id, isRead: false });
    const stranger = await thread(ws, a, { reminderAt: at(DAY) });
    const bounce = await thread(ws, a, { leadId: live.id, kind: "BOUNCE" });
    const deletedLead = await thread(ws, a, { leadId: gone.id });
    const sentOnly = await thread(ws, a, { leadId: live.id, inbound: false, out: true });
    await thread(ws, a, { leadId: live.id, deletedAt: T }); // never listed
    const view = async (v: string) => ids(await listThreads(P(), ws, { view: v as "all" }));

    expect(await view("primary")).toEqual(ids([primary]));
    expect(await view("others")).toEqual(ids([stranger, bounce, deletedLead]));
    expect(await view("triage")).toEqual(ids([stranger, deletedLead]));
    expect(await view("unread")).toEqual(ids([primary]));
    expect(await view("reminders")).toEqual(ids([stranger]));
    expect(await view("sent")).toEqual(ids([sentOnly]));
    expect(await view("all")).toEqual(ids([primary, stranger, bounce, deletedLead, sentOnly]));
    expect(await listThreads(P(), ws)).toHaveLength(1); // default view is primary
  });

  test("PA #6: the list carries a 200-char snippet of the last message, never its html or full text", async () => {
    const { ws, a } = await world();
    await thread(ws, a, { text: "x".repeat(5000) });
    const [t] = await listThreads(P(), ws, { view: "all" });
    const m = t!.messages[0]!;
    expect(m.snippet).toBe("x".repeat(200));
    expect(m).not.toHaveProperty("html");
    expect(m).not.toHaveProperty("text");
  });

  test("the scheduled view lists threads of leads with rows waiting", async () => {
    const s = await seedCampaign(P(), { at: T, rows: 2, accounts: [{}] });
    const [l1, l2] = s.leads;
    const waiting = await thread(s.ws, s.accounts[0]!, { leadId: l1!.lead.id });
    await thread(s.ws, s.accounts[0]!, { leadId: l2!.lead.id });
    await P().scheduledMessage.update({ where: { id: s.rows[1]!.id }, data: { status: "SENT" } });
    expect(ids(await listThreads(P(), s.ws, { view: "scheduled" }))).toEqual(ids([waiting]));
  });

  test("filters combine: account, campaign, hasAttachment, date, category, lead interest and label", async () => {
    const { ws, a } = await world();
    const b = await mailbox(ws, `b-${randomBytes(3).toString("hex")}@send.test`);
    const l = await lead(ws, { interestStatus: 1, labels: ["vip"] });
    const hit = await thread(ws, a, {
      leadId: l.id,
      campaignId: "c1",
      hasAttachment: true,
      at: at(5 * DAY),
      category: "INTERESTED",
    });
    await thread(ws, b, { leadId: l.id, campaignId: "c1", hasAttachment: true, at: at(5 * DAY) });
    await thread(ws, a, { leadId: l.id, campaignId: "c2", hasAttachment: true, at: at(5 * DAY) });
    await thread(ws, a, { leadId: l.id, campaignId: "c1", hasAttachment: false, at: at(5 * DAY) });
    await thread(ws, a, { leadId: l.id, campaignId: "c1", hasAttachment: true, at: at(-5 * DAY) });
    const f = {
      view: "all" as const,
      accountId: a.id,
      campaignId: "c1",
      hasAttachment: true,
      after: at(DAY),
      before: at(9 * DAY),
    };
    expect(ids(await listThreads(P(), ws, f))).toEqual(ids([hit])); // each of the four decoys fails one filter
    expect(ids(await listThreads(P(), ws, { ...f, category: "INTERESTED" }))).toEqual(ids([hit]));
    expect(
      ids(
        await listThreads(P(), ws, {
          ...f,
          interestStatus: 1,
          leadLabel: "vip",
          category: "INTERESTED",
        }),
      ),
    ).toEqual(ids([hit]));
    expect(await listThreads(P(), ws, { ...f, leadLabel: "other" })).toHaveLength(0);
  });

  test("q matches subject, sender and body text; wildcards are literal", async () => {
    const { ws, a } = await world();
    const byBody = await thread(ws, a, { text: "Could you send the pricing sheet?" });
    const bySender = await thread(ws, a, { from: "dana.smith@acme.test" });
    const pct = await thread(ws, a, { text: "we are 100% in" });
    const q = async (x: string) => ids(await listThreads(P(), ws, { view: "all", q: x }));
    expect(await q("PRICING")).toEqual(ids([byBody]));
    expect(await q("dana.smith")).toEqual(ids([bySender]));
    expect(await q("100%")).toEqual(ids([pct]));
    expect(await q("%")).toEqual(ids([pct]));
    expect(await listThreads(P(), ws, { view: "all", from: "acme.test" })).toHaveLength(1);
    expect(await listThreads(P(), ws, { view: "all", to: a.email })).toHaveLength(3);
  });

  test("cursor paging returns no duplicates across pages, ties included", async () => {
    const { ws, a } = await world();
    const when = [0, 0, 1, 1, 2].map((d) => at(d * 1000));
    for (const w of when) await thread(ws, a, { at: w });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await listThreads(P(), ws, { view: "all", limit: 2, cursor });
      seen.push(...page.map((t) => t.id));
      const last = page.at(-1);
      if (page.length < 2) break;
      cursor = `${last!.lastMessageAt.toISOString()}|${last!.id}`;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect((await listThreads(P(), ws, { view: "all" })).map((t) => t.id)).toEqual(seen);
  });
});

describe("state changes", () => {
  test("unread count and read-all", async () => {
    const { ws, a } = await world();
    const l = await lead(ws);
    const p1 = await thread(ws, a, { leadId: l.id, isRead: false });
    await thread(ws, a, { leadId: l.id, isRead: false });
    await thread(ws, a, { isRead: false, reminderAt: at(-1000) });
    await thread(ws, a, { leadId: l.id, isRead: true });
    expect(await unreadCount(P(), ws, T)).toEqual({
      primary: 2,
      others: 1,
      triage: 1,
      total: 3,
      remindersDue: 1,
    });
    // PS-INBOX-23: only that thread, never the lead's other threads
    expect(await readAll(P(), ws, p1.id)).toEqual({ updated: 1 });
    expect(await unreadCount(P(), ws, T)).toMatchObject({
      primary: 1,
      others: 1,
      triage: 1,
      total: 2,
    });
    await expect(readAll(P(), ws, "nope")).rejects.toMatchObject({ status: 404 });
  });

  test("the triage count ignores reports, lead threads and read threads", async () => {
    const { ws, a } = await world();
    const l = await lead(ws);
    await thread(ws, a, { isRead: false });
    await thread(ws, a, { isRead: false });
    await thread(ws, a, { leadId: l.id, isRead: false });
    await thread(ws, a, { kind: "BOUNCE", isRead: false });
    await thread(ws, a, { kind: "COMPLAINT", isRead: false });
    await thread(ws, a, { isRead: true });
    expect(await unreadCount(P(), ws, T)).toMatchObject({ triage: 2, total: 5 });
  });

  test("getThread inlines small cid images as data URIs, drops the rest, and names the step and variant", async () => {
    const s = await seedCampaign(P(), { at: T, rows: 1, accounts: [{}] });
    const sm = s.rows[0]!;
    const t = await thread(s.ws, s.accounts[0]!, { campaignId: s.campaign.id, out: true });
    const m = await P().message.findFirstOrThrow({ where: { threadId: t.id } });
    await P().message.update({
      where: { id: m.id },
      data: {
        scheduledMessageId: sm.id,
        html: '<img src="cid:logo.png"><img src="cid:big.png"><img src="cid:none.png">',
      },
    });
    const file = (filename: string, bytes: number) =>
      P().attachment.create({
        data: {
          messageId: m.id,
          filename,
          contentType: "image/png",
          size: bytes,
          data: Buffer.alloc(bytes, 1),
        },
      });
    await file("logo.png", 3);
    await file("big.png", 2 * 1024 * 1024);
    const got = await getThread(P(), s.ws, t.id);
    const html = got.messages[0]!.html!;
    expect(html).toContain('src="data:image/png;base64,AQEB"');
    expect(html.match(/about:blank/g)).toHaveLength(2);
    expect(html).not.toContain("cid:");
    expect(got.origin).toMatchObject({ step: { order: 1 }, variant: { label: "A" } });
  });

  test("query count: the thread list and an opened thread stay at 6 queries or fewer (D51)", async () => {
    const s = await seedCampaign(P(), { at: T, rows: 1, accounts: [{}] });
    const a = s.accounts[0]!;
    const l = s.leads[0]!.lead;
    for (let i = 0; i < 20; i++)
      await thread(s.ws, a, { leadId: l.id, campaignId: s.campaign.id, out: true });
    const open = await thread(s.ws, a, { leadId: l.id, campaignId: s.campaign.id, out: true });
    // ten more messages, each with a cid image and its own attachment
    for (let i = 0; i < 10; i++) {
      const m = await P().message.create({
        data: {
          workspaceId: s.ws,
          accountId: a.id,
          threadId: open.id,
          subject: "s",
          sentAt: at(i),
          references: [],
          rfcMessageId: `<cid${i}@x.test>`,
          direction: "IN",
          folder: "INBOX",
          fromEmail: "x@x.test",
          to: [a.email],
          cc: [],
          kind: "REPLY",
          text: "t",
          html: `<img src="cid:i${i}.png">`,
          leadId: l.id,
        },
      });
      await P().attachment.create({
        data: {
          messageId: m.id,
          filename: `i${i}.png`,
          contentType: "image/png",
          size: 3,
          data: Buffer.alloc(3, 1),
        },
      });
    }
    let q = 0;
    const counted = P().$extends({
      query: {
        $allOperations({ args, query }) {
          q++;
          return query(args);
        },
      },
    }) as never;
    const list = await listThreads(counted, s.ws, { view: "all" });
    expect(list.length).toBeGreaterThan(20);
    expect(q, `list used ${q} queries`).toBeLessThanOrEqual(6);
    q = 0;
    const got = await getThread(counted, s.ws, open.id);
    expect(got.messages.filter((m) => m.html?.startsWith('<img src="data:'))).toHaveLength(10);
    expect(q, `open used ${q} queries`).toBeLessThanOrEqual(6);
  });

  test("local delete hides the thread and the lead stays in its campaign", async () => {
    const s = await seedCampaign(P(), { at: T, rows: 1, accounts: [{}] });
    const l = s.leads[0]!;
    const t = await thread(s.ws, s.accounts[0]!, { leadId: l.lead.id, campaignId: s.campaign.id });
    await deleteThread(P(), clock, s.ws, null, t.id);
    expect(await listThreads(P(), s.ws, { view: "all" })).toHaveLength(0);
    await expect(getThread(P(), s.ws, t.id)).rejects.toMatchObject({ status: 404 });
    await expect(deleteThread(P(), clock, s.ws, null, t.id)).rejects.toMatchObject({ status: 404 });
    expect(await P().campaignLead.findUniqueOrThrow({ where: { id: l.cl.id } })).toMatchObject({
      state: "ACTIVE",
    });
    expect(await P().auditLog.count({ where: { workspaceId: s.ws, action: "inbox.delete" } })).toBe(
      1,
    );
  });

  test("category override is final, audited, and lifts a classifier NOT_INTERESTED suppression", async () => {
    const { ws, a } = await world();
    const l = await lead(ws);
    const t = await thread(ws, a, {
      leadId: l.id,
      category: "NOT_INTERESTED",
      categorySource: "RULE",
    });
    await P().$transaction(async (tx) => {
      await suppress(tx, ws, [{ kind: "EMAIL", value: l.email }], "NOT_INTERESTED", "status");
      await suppress(
        tx,
        ws,
        [{ kind: "EMAIL", value: "other@x.test" }],
        "NOT_INTERESTED",
        "status",
      );
    });
    // FR M3 / D20: a MEMBER (or API key) changes the category, but only an ADMIN lifts the suppression
    const m = await thread(ws, a, {
      leadId: l.id,
      category: "NOT_INTERESTED",
      categorySource: "RULE",
    });
    expect(await updateThread(P(), ws, "u2", m.id, { category: "NEUTRAL" })).toMatchObject({
      category: "NEUTRAL",
    });
    expect(await isSuppressed(P(), ws, l.email)).toBe(true);
    const r = await updateThread(
      P(),
      ws,
      "u1",
      t.id,
      { category: "NEUTRAL", reminderAt: "2026-11-01T00:00:00Z" },
      { admin: true },
    );
    expect(r).toMatchObject({ category: "NEUTRAL", categorySource: "USER" });
    expect(r.reminderAt?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(await isSuppressed(P(), ws, l.email)).toBe(false);
    expect(await isSuppressed(P(), ws, "other@x.test")).toBe(true);
    const log = await P().auditLog.findFirstOrThrow({
      where: { workspaceId: ws, action: "inbox.category_override", actorId: "u1" },
    });
    expect(log.meta).toEqual({ from: "NOT_INTERESTED", to: "NEUTRAL", previousSource: "RULE" });
    // a USER-sourced category created no suppression, so changing it lifts none
    await P().$transaction((tx) =>
      suppress(tx, ws, [{ kind: "EMAIL", value: l.email }], "NOT_INTERESTED", "status"),
    );
    await updateThread(P(), ws, "u1", t.id, { category: "NOT_INTERESTED" });
    await updateThread(P(), ws, "u1", t.id, { category: "INTERESTED" });
    expect(await isSuppressed(P(), ws, l.email)).toBe(true);
    await expect(updateThread(P(), ws, "u1", t.id, { isRead: "x" })).rejects.toThrow();
    // a NOT_INTERESTED with no recorded source was not made by a classifier: nothing is lifted
    const u = await thread(ws, a, { leadId: l.id, category: "NOT_INTERESTED" });
    await updateThread(P(), ws, "u1", u.id, { category: "NEUTRAL" });
    expect(await isSuppressed(P(), ws, l.email)).toBe(true);
  });
});

// A mailbox ingesting mail the way sync does: store, then the stop rules.
const rawMsg = (o: Partial<RemoteMessage>): RemoteMessage => ({
  providerMessageId: `p${++n}`,
  rfcMessageId: `<r${n}-${randomBytes(3).toString("hex")}@x.test>`,
  folder: "INBOX",
  inReplyTo: null,
  references: [],
  from: { email: "nobody@x.test" },
  to: [],
  cc: [],
  subject: "Hello",
  date: T,
  text: "Yes, lets talk on Tuesday.",
  html: null,
  headers: {},
  attachments: [],
  ...o,
});
const sync = (a: EmailAccount, m: RemoteMessage) =>
  P().$transaction(async (tx) => {
    const c = classify(m, { now: T, direction: "IN" });
    const r = await ingestMessage(tx, a, m, c, { historical: false });
    const message = await tx.message.findUniqueOrThrow({ where: { id: r.messageId } });
    await applyInbound(tx, clock, {
      workspaceId: a.workspaceId,
      message,
      classification: c,
      match: r.match,
    });
    return r;
  });

describe("lead attachment and Others", () => {
  test("a reply from a deleted lead lands in Others", async () => {
    const s = await seedCampaign(P(), { at: T, rows: 1, accounts: [{}] });
    const a = s.accounts[0]!;
    const l = s.leads[0]!.lead;
    await P().lead.update({ where: { id: l.id }, data: { deletedAt: T } });
    const t = await thread(s.ws, a, { leadId: l.id });
    expect(ids(await listThreads(P(), s.ws, { view: "others" }))).toEqual(ids([t]));
    expect(await listThreads(P(), s.ws, { view: "primary" })).toHaveLength(0);
  });

  test("attach-lead moves the thread to Primary, stops the follow-ups and attributes the event (M6)", async () => {
    const s = await seedCampaign(P(), { at: T, steps: 2, rows: 1, accounts: [{}] });
    const a = s.accounts[0]!;
    const { lead: l, cl } = s.leads[0]!;
    await P().campaignLead.update({ where: { id: cl.id }, data: { enrolledAt: at(-2 * DAY) } });
    const r = await sync(
      a,
      rawMsg({
        from: { email: "colleague@other.test" },
        to: [{ email: a.email }],
        subject: "Fwd: hi",
      }),
    );
    expect(await listThreads(P(), s.ws)).toHaveLength(0); // unattributed: Others
    const ev = await P().event.findFirstOrThrow({
      where: { messageId: r.messageId, type: "REPLY" },
    });
    expect(ev.leadId).toBeNull();

    await attachLead(P(), clock, s.ws, "u1", r.threadId, l.id);

    expect(ids(await listThreads(P(), s.ws))).toEqual([r.threadId]);
    expect(await P().campaignLead.findUniqueOrThrow({ where: { id: cl.id } })).toMatchObject({
      state: "STOPPED",
      stopReason: "REPLIED",
    });
    expect(
      (await P().scheduledMessage.findUniqueOrThrow({ where: { id: s.rows[0]!.id } })).status,
    ).toBe("CANCELLED");
    expect(await P().event.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({
      leadId: l.id,
      campaignId: s.campaign.id,
    });
    expect(await P().lead.findUniqueOrThrow({ where: { id: l.id } })).toMatchObject({
      replies: 1,
      lastReplyAt: T,
    });
    expect(await P().message.findUniqueOrThrow({ where: { id: r.messageId } })).toMatchObject({
      leadId: l.id,
    });
    expect(
      await P().auditLog.count({ where: { workspaceId: s.ws, action: "inbox.attach_lead" } }),
    ).toBe(1);
    // attaching again counts nothing twice
    await attachLead(P(), clock, s.ws, "u1", r.threadId, l.id);
    expect((await P().lead.findUniqueOrThrow({ where: { id: l.id } })).replies).toBe(1);
    // another workspace's lead is not found
    const other = await world();
    const foreign = await lead(other.ws);
    await expect(attachLead(P(), clock, s.ws, "u1", r.threadId, foreign.id)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("createLeadFromThread", () => {
  test("a display name longer than the lead fields is cut, not refused", async () => {
    const { ws, a } = await world();
    const t = await thread(ws, a, {
      from: "long@acme.test",
      fromName: `${"f".repeat(150)} ${"l".repeat(150)}`,
    });
    const r = await createLeadFromThread(P(), clock, ws, "u1", t.id);
    expect(await P().lead.findUniqueOrThrow({ where: { id: r.leadId } })).toMatchObject({
      firstName: "f".repeat(100),
      lastName: "l".repeat(100),
    });
  });

  test("a stranger's reply becomes a lead attached to the thread, with no enrollment", async () => {
    const { ws, a } = await world();
    const t = await thread(ws, a, { from: "dana@acme.test", fromName: "Dana Smith" });
    expect(ids(await listThreads(P(), ws))).toHaveLength(0); // still in Others

    const r = await createLeadFromThread(P(), clock, ws, "u1", t.id);

    expect(r.created).toBe(true);
    const l = await P().lead.findUniqueOrThrow({ where: { id: r.leadId } });
    expect(l).toMatchObject({
      email: "dana@acme.test",
      firstName: "Dana",
      lastName: "Smith",
      source: "inbox_triage",
      companyDomain: "acme.test",
    });
    expect(ids(await listThreads(P(), ws))).toEqual([t.id]); // moved to Primary
    expect(await P().campaignLead.count({ where: { workspaceId: ws, leadId: l.id } })).toBe(0);
    expect(
      await P().auditLog.count({ where: { workspaceId: ws, action: "inbox.attach_lead" } }),
    ).toBe(1);
  });

  test("a live lead with that address is reused, and a second call is refused", async () => {
    const { ws, a } = await world();
    const known = await lead(ws, { email: "known@acme.test" });
    const t = await thread(ws, a, { from: "known@acme.test" });
    expect(await createLeadFromThread(P(), clock, ws, "u1", t.id)).toEqual({
      leadId: known.id,
      created: false,
    });
    expect(await P().lead.count({ where: { workspaceId: ws, email: "known@acme.test" } })).toBe(1);
    await expect(createLeadFromThread(P(), clock, ws, "u1", t.id)).rejects.toMatchObject({
      status: 409,
      message: "lead_attached",
    });
  });

  test("bounce reports and unsubscribes have no person to add", async () => {
    const { ws, a } = await world();
    const t = await thread(ws, a, { kind: "BOUNCE", from: "dana@acme.test" });
    await expect(createLeadFromThread(P(), clock, ws, "u1", t.id)).rejects.toMatchObject({
      status: 400,
      message: "not_a_person",
    });
    const noInbound = await thread(ws, a, { inbound: false, out: true });
    await expect(createLeadFromThread(P(), clock, ws, "u1", noInbound.id)).rejects.toMatchObject({
      status: 400,
      message: "not_a_person",
    });
    expect(await P().lead.count({ where: { workspaceId: ws } })).toBe(0);
  });

  test("a suppressed address or domain is never recreated", async () => {
    const { ws, a } = await world();
    await P().$transaction((tx) =>
      suppress(tx, ws, [{ kind: "EMAIL", value: "spam@blocked.test" }], "NOT_INTERESTED", "status"),
    );
    const t = await thread(ws, a, { from: "spam@blocked.test" });
    await expect(createLeadFromThread(P(), clock, ws, "u1", t.id)).rejects.toMatchObject({
      status: 409,
      message: "suppressed",
    });
    const o = await world();
    await P().$transaction((tx) =>
      suppress(tx, o.ws, [{ kind: "DOMAIN", value: "blocked.test" }], "NOT_INTERESTED", "status"),
    );
    const d = await thread(o.ws, o.a, { from: "anyone@blocked.test" });
    await expect(createLeadFromThread(P(), clock, o.ws, "u1", d.id)).rejects.toMatchObject({
      status: 409,
      message: "suppressed",
    });
    expect(await P().lead.count({ where: { workspaceId: ws } })).toBe(0);
    expect(await P().lead.count({ where: { workspaceId: o.ws } })).toBe(0);
  });

  test("another workspace's thread is not found", async () => {
    const mine = await world();
    const other = await world();
    const t = await thread(other.ws, other.a, { from: "dana@acme.test" });
    await expect(createLeadFromThread(P(), clock, mine.ws, "u1", t.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(await P().lead.count({ where: { workspaceId: mine.ws } })).toBe(0);
  });

  test("a display name containing an address leaves the names empty", async () => {
    const { ws, a } = await world();
    const t = await thread(ws, a, {
      from: "dana@acme.test",
      fromName: "Dana <dana@acme.test>",
    });
    const r = await createLeadFromThread(P(), clock, ws, "u1", t.id);
    expect(await P().lead.findUniqueOrThrow({ where: { id: r.leadId } })).toMatchObject({
      firstName: null,
      lastName: null,
    });
  });
});

describe("same-domain suggestions", () => {
  test("getThread lists up to five live leads of the sender's company, newest contact first", async () => {
    const { ws, a } = await world();
    const other = await world();
    const live = (email: string, lastContactedAt: Date | null = null, o = {}) =>
      lead(ws, { email, companyDomain: "acme.test", lastContactedAt, ...o });
    const recent = await live("a@acme.test", at(-1 * DAY));
    const second = await live("b@acme.test", at(-2 * DAY));
    const third = await live("c@acme.test", at(-3 * DAY));
    const older = await live("d@acme.test", at(-4 * DAY));
    const never = await live("e@acme.test");
    await live("gone@acme.test", at(-1000), { deletedAt: T });
    await lead(other.ws, { email: "x@acme.test", companyDomain: "acme.test" });
    const t = await thread(ws, a, { from: "stranger@acme.test" });

    const got = await getThread(P(), ws, t.id);
    expect(got.domainLeads.map((l) => l.id)).toEqual([
      recent.id,
      second.id,
      third.id,
      older.id,
      never.id,
    ]);
    const more = await live("f@acme.test", at(-5 * DAY));
    const capped = await getThread(P(), ws, t.id);
    expect(capped.domainLeads).toHaveLength(5);
    expect(capped.domainLeads.map((l) => l.id)).toContain(more.id);
    expect(capped.domainLeads.map((l) => l.id)).not.toContain(never.id); // the oldest contact falls off
  });

  test("free-mail senders, sent-only threads and a linked lead get no suggestions", async () => {
    const { ws, a } = await world();
    await lead(ws, { email: "someone@gmail.com", companyDomain: null });
    await lead(ws, { email: "colleague@acme.test", companyDomain: "acme.test" });
    const free = await thread(ws, a, { from: "someone@gmail.com" });
    expect((await getThread(P(), ws, free.id)).domainLeads).toEqual([]);
    const sent = await thread(ws, a, { from: "stranger@acme.test", inbound: false, out: true });
    expect((await getThread(P(), ws, sent.id)).domainLeads).toEqual([]);
    const linked = await lead(ws, { email: "stranger@acme.test" });
    const t = await thread(ws, a, { from: "stranger@acme.test", leadId: linked.id });
    expect((await getThread(P(), ws, t.id)).domainLeads).toEqual([]);
    // a deleted lead is no live link, so the suggestions come back
    const gone = await lead(ws, { email: "gone@acme.test", deletedAt: T });
    const u = await thread(ws, a, { from: "gone@acme.test", leadId: gone.id });
    expect((await getThread(P(), ws, u.id)).domainLeads.map((l) => l.email)).toEqual([
      "colleague@acme.test",
    ]);
  });
});

describe("bulk", () => {
  test("blocklist suppresses the senders but never our own mailbox; read, unread, delete by ids and by filter", async () => {
    const { ws, a } = await world();
    const t1 = await thread(ws, a, { from: "spam1@x.test", out: true });
    const t2 = await thread(ws, a, { from: "spam2@x.test" });
    const keep = await thread(ws, a, { from: "friend@x.test" });
    expect(
      await bulkThreads(P(), clock, ws, "u1", { ids: [t1.id, t2.id], action: "blocklist" }),
    ).toEqual({ affected: 2 });
    expect(await isSuppressed(P(), ws, "spam1@x.test")).toBe(true);
    expect(await isSuppressed(P(), ws, "spam2@x.test")).toBe(true);
    expect(await isSuppressed(P(), ws, "friend@x.test")).toBe(false);
    expect(await isSuppressed(P(), ws, a.email)).toBe(false);

    await bulkThreads(P(), clock, ws, "u1", { ids: [t1.id, t2.id, keep.id], action: "unread" });
    expect(await P().thread.count({ where: { workspaceId: ws, isRead: false } })).toBe(3);
    await bulkThreads(P(), clock, ws, "u1", { filter: { view: "all" }, action: "read" });
    expect(await P().thread.count({ where: { workspaceId: ws, isRead: false } })).toBe(0);
    await bulkThreads(P(), clock, ws, "u1", {
      filter: { view: "all", q: "friend" },
      action: "delete",
    });
    expect(ids(await listThreads(P(), ws, { view: "all" }))).toEqual(ids([t1, t2]));
    // foreign ids are ignored
    const other = await world();
    expect(
      await bulkThreads(P(), clock, other.ws, "u1", { ids: [t1.id], action: "delete" }),
    ).toEqual({ affected: 0 });
    await expect(bulkThreads(P(), clock, ws, "u1", { action: "read" })).rejects.toThrow();
  });

  test("set_interest goes through the lead rules (-1 suppresses)", async () => {
    const { ws, a } = await world();
    const l = await lead(ws);
    const t = await thread(ws, a, { leadId: l.id });
    await expect(
      bulkThreads(P(), clock, ws, "u1", { ids: [t.id], action: "set_interest" }),
    ).rejects.toMatchObject({
      status: 400,
    });
    await bulkThreads(P(), clock, ws, "u1", {
      ids: [t.id],
      action: "set_interest",
      interestStatus: -1,
    });
    expect((await P().lead.findUniqueOrThrow({ where: { id: l.id } })).interestStatus).toBe(-1);
    expect(await isSuppressed(P(), ws, l.email)).toBe(true);
  });
});

describe("notes, macros and erasure (I11)", () => {
  test("gdprDeleteLead removes the lead notes and thread notes; mergeLeads re-points notes", async () => {
    const { ws, a } = await world();
    const gone = await lead(ws);
    const t = await thread(ws, a, { leadId: gone.id });
    await createNote(P(), ws, "u1", { threadId: t.id, body: "on thread" });
    await createNote(P(), ws, "u1", { leadId: gone.id, body: "on lead" });
    const keep = await lead(ws);
    const mergeFrom = await lead(ws);
    await createNote(P(), ws, "u1", { leadId: mergeFrom.id, body: "to move" });
    await mergeLeads(P(), clock, ws, { keepId: keep.id, mergeId: mergeFrom.id });
    expect(await P().note.count({ where: { workspaceId: ws, leadId: keep.id } })).toBe(1);
    expect(await P().note.count({ where: { workspaceId: ws, leadId: mergeFrom.id } })).toBe(0);

    await gdprDeleteLead(P(), clock, ws, gone.id);
    expect(
      await P().note.count({
        where: { workspaceId: ws, OR: [{ leadId: gone.id }, { threadId: t.id }] },
      }),
    ).toBe(0);
    expect(await P().note.count({ where: { workspaceId: ws } })).toBe(1);
    await expect(
      createNote(P(), ws, "u1", { threadId: t.id, leadId: keep.id, body: "x" }),
    ).rejects.toThrow();
  });

  test("a macro renders with the thread lead and sender", async () => {
    const { ws, a } = await world();
    const l = await lead(ws, { firstName: "Dana", customFields: { plan: "Pro" } });
    const t = await thread(ws, a, { leadId: l.id });
    const m = await createMacro(P(), ws, "u1", {
      name: "hi",
      body: "Hi {{firstName}}, on {{plan}} - {{sendingAccountFirstName}}",
    });
    expect(await renderMacro(P(), ws, m.id, t.id)).toEqual({
      text: "Hi Dana, on Pro - Me",
      html: expect.stringContaining("Hi Dana, on Pro - Me"),
    });
    await expect(createMacro(P(), ws, "u1", { name: "hi", body: "again" })).rejects.toMatchObject({
      status: 409,
    });
  });

  test("owner variables render for a member and stay empty without an owner", async () => {
    const { ws, a } = await world();
    const l = await lead(ws, { firstName: "Dana" });
    const t = await thread(ws, a, { leadId: l.id });
    const m = await createMacro(P(), ws, "u1", {
      name: "owner",
      body: "{{ownerName}} / {{ownerEmail}}",
    });
    expect((await renderMacro(P(), ws, m.id, t.id)).text).toBe(" / ");
    const u = await P().user.create({
      data: { id: `owner-${t.id}`, name: "Alex", email: `alex-${t.id}@x.io` },
    });
    await P().member.create({
      data: { id: `member-${t.id}`, workspaceId: ws, userId: u.id, role: "member" },
    });
    await P().lead.update({ where: { id: l.id }, data: { ownerId: u.id } });
    expect((await renderMacro(P(), ws, m.id, t.id)).text).toBe(`Alex / ${u.email}`);
  });
});
