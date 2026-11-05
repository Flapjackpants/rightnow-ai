import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "@rightnow/db/test-db";
import { getFakeProvider, parseRaw } from "@rightnow/providers";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { fixedClock } from "../src/clock";
import { forwardHtml } from "../src/mail/forward";
import { runNextJob } from "../src/jobs";

process.env.FAKE_MAIL_DIR = mkdtempSync(join(tmpdir(), "forward-"));
let db: Awaited<ReturnType<typeof createTestDb>>;
const P = () => db.prisma;
const now = new Date("2026-10-20T10:00:00Z");
const clock = fixedClock(now);
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.drop());

async function setup(opts: { attempts?: number; cap?: number; text?: string } = {}) {
  const tag = randomBytes(5).toString("hex");
  const ws = (await P().workspace.create({ data: { name: "W", slug: `f-${tag}` } })).id;
  const a = await P().emailAccount.create({
    data: {
      workspaceId: ws,
      provider: "SMTP",
      email: `me-${tag}@send.test`,
      fromName: "Me",
      firstName: "Me",
      lastName: "Self",
      capTier: "SMTP",
      providerCap: opts.cap ?? 100,
    },
  });
  const lead = await P().lead.create({ data: { workspaceId: ws, email: `lead-${tag}@lead.test` } });
  const t = await P().thread.create({
    data: {
      workspaceId: ws,
      accountId: a.id,
      leadId: lead.id,
      subject: "Question",
      lastMessageAt: now,
      lastInboundAt: now,
    },
  });
  await P().message.create({
    data: {
      workspaceId: ws,
      accountId: a.id,
      threadId: t.id,
      rfcMessageId: `<${tag}@lead.test>`,
      direction: "IN",
      kind: "REPLY",
      folder: "INBOX",
      fromEmail: lead.email,
      to: [a.email],
      subject: "Re: Question",
      text: opts.text ?? "Interested in a call",
      sentAt: now,
    },
  });
  const job = await P().backgroundJob.create({
    data: {
      workspaceId: ws,
      kind: "thread_forward",
      input: { threadId: t.id, to: `owner-${tag}@x.io` },
      attempts: opts.attempts ?? 0,
    },
  });
  const providerFor = vi.fn(async () => getFakeProvider(a.email));
  const run = () => runNextJob(P(), clock, new AbortController().signal, { env: {}, providerFor });
  return { ws, a, lead, t, job, providerFor, run, to: `owner-${tag}@x.io` };
}

test("forwards once only to the owner with the quoted reply", async () => {
  const s = await setup();
  expect(await s.run()).toBe(s.job.id);
  const raw = await getFakeProvider(s.a.email).sentRaw();
  expect(raw).toHaveLength(1);
  const msg = await parseRaw(raw[0]!, { providerMessageId: "x", folder: "SENT" });
  expect(msg.to.map((x) => x.email)).toEqual([s.to]);
  expect(msg.to.map((x) => x.email)).not.toContain(s.lead.email);
  expect(msg.subject).toMatch(/^Fwd:/);
  expect(msg.text).toContain("Interested in a call");
  expect((await P().backgroundJob.findUniqueOrThrow({ where: { id: s.job.id } })).status).toBe(
    "DONE",
  );
});

test("a stale requeued attempt fails before calling a provider", async () => {
  const s = await setup({ attempts: 1 });
  await s.run();
  expect(await P().backgroundJob.findUniqueOrThrow({ where: { id: s.job.id } })).toMatchObject({
    status: "FAILED",
    error: "forward_uncertain",
  });
  expect(s.providerFor).not.toHaveBeenCalled();
});

test("an ambiguous provider outcome fails and is never retried", async () => {
  const s = await setup();
  getFakeProvider(s.a.email).failNext("timeout_after_write");
  await s.run();
  expect(await P().backgroundJob.findUniqueOrThrow({ where: { id: s.job.id } })).toMatchObject({
    status: "FAILED",
    error: "send_uncertain",
  });
  expect(await getFakeProvider(s.a.email).sentRaw()).toHaveLength(1);
  expect(await s.run()).toBeNull();
  expect(await getFakeProvider(s.a.email).sentRaw()).toHaveLength(1);
});

test("half the provider cap prevents a forward", async () => {
  const s = await setup({ cap: 2 });
  await P().accountDailyUsage.create({
    data: { accountId: s.a.id, day: new Date("2026-10-20T00:00:00Z"), sent: 1 },
  });
  await s.run();
  expect(await P().backgroundJob.findUniqueOrThrow({ where: { id: s.job.id } })).toMatchObject({
    status: "FAILED",
    error: "provider_cap",
  });
  expect(await getFakeProvider(s.a.email).sentRaw()).toHaveLength(0);
});

test("another workspace's thread is unavailable", async () => {
  const s = await setup();
  const other = await setup();
  await P().backgroundJob.update({
    where: { id: s.job.id },
    data: { input: { threadId: other.t.id, to: s.to } },
  });
  await s.run();
  expect(await P().backgroundJob.findUniqueOrThrow({ where: { id: s.job.id } })).toMatchObject({
    status: "FAILED",
    error: "Not found",
  });
  expect(await getFakeProvider(s.a.email).sentRaw()).toHaveLength(0);
});

test("forward html escapes values, caps text, and renders empty text", () => {
  const base = {
    fromEmail: 'a&"<b>@x.test',
    fromName: "<Name>",
    subject: "<script>",
    sentAt: now,
    text: "<b>hello</b>\nagain",
  };
  const html = forwardHtml(base);
  expect(html).toContain("&lt;b&gt;hello&lt;/b&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("<br>");
  expect(forwardHtml({ ...base, text: "" })).toContain("(no text)");
  expect(forwardHtml({ ...base, text: "x".repeat(200_001) })).not.toContain("x".repeat(200_001));
});
