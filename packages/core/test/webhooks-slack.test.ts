import { createTestDb } from "@rightnow/db/test-db";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { fixedClock } from "../src/clock";
import { decrypt } from "../src/crypto";
import { deliverDue, sign } from "../src/webhooks/deliver";
import { buildPayload } from "../src/webhooks/payload";
import { createWebhook, getWebhook, testWebhook, updateWebhook } from "../src/webhooks/service";
import { isSlackUrl, slackText, SLACK_URL_MASK } from "../src/webhooks/slack";
import { seedCampaign } from "./campaign-fixture";
import { testEnv } from "./accounts-fixture";

const request = vi.fn();
vi.mock("@rightnow/providers", async (original) => ({
  ...(await original<typeof import("@rightnow/providers")>()),
  safeRequest: (...args: unknown[]) => request(...args),
}));
const T = new Date("2026-10-20T10:00:00Z");
const URL1 = "https://hooks.slack.com/services/T1/B1/token-one";
const URL2 = "https://hooks.slack.com/services/T1/B1/token-two";
const OUT = { allowPrivate: false, resolve: async () => ["1.1.1.1"] };
let db: Awaited<ReturnType<typeof createTestDb>>;
let n = 0;
const world = async () => seedCampaign(db.prisma, { at: T, leads: 1 });
const error = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error) => e.message,
  );
const hook = (ws: string, input: object = {}) =>
  createWebhook(
    db.prisma,
    ws,
    "u1",
    { url: URL1, events: ["email_sent"], format: "slack", ...input },
    OUT,
  );

beforeAll(async () => {
  testEnv();
  db = await createTestDb();
});
beforeEach(async () => {
  request.mockReset();
  request.mockResolvedValue({ status: 200, latencyMs: 1, headers: {} });
  await db.prisma.webhookDelivery.updateMany({
    where: { status: { in: ["PENDING", "SENDING"] } },
    data: { status: "FAILED" },
  });
});
afterAll(async () => {
  await db.drop();
});

test.each([
  [URL1, true],
  ["http://hooks.slack.com/services/a", false],
  ["https://hooks.slack.com.evil.test/services/a", false],
  ["https://hooks.slack.com/other/a", false],
  ["https://user@hooks.slack.com/services/a", false],
])("isSlackUrl %s", (url, wanted) => expect(isSlackUrl(url)).toBe(wanted));

test.each([
  [
    { event_type: "lead_interested", lead_email: "a@b.test", company_name: "Acme" },
    ":fire: Interested reply from a@b.test (Acme)",
  ],
  [
    { event_type: "lead_meeting_booked", lead_email: "a@b.test" },
    ":calendar: Meeting requested by a@b.test",
  ],
  [
    {
      event_type: "reply_received",
      lead_email: "a@b.test",
      unibox_url: "https://app.test/inbox",
      reply_text_snippet: "Hello",
    },
    ":speech_balloon: Reply from a@b.test <https://app.test/inbox|Open in inbox>\n> Hello",
  ],
  [
    { event_type: "account_error", email_account: "box@b.test", reason: "auth" },
    ":warning: Mailbox problem: box@b.test (auth)",
  ],
  [
    { event_type: "quota_reached", email_account: "box@b.test", campaign_name: "Sales" },
    ":hourglass_flowing_sand: Daily quota reached: box@b.test on Sales",
  ],
  [{ event_type: "custom", email_account: "box@b.test" }, "custom: box@b.test"],
  [{ event_type: "custom" }, "custom: workspace"],
  [
    {
      event_type: "escalation_overdue",
      lead_email: "a@b.test",
      alert_count: 2,
      task_title: "Call <lead>",
      unibox_url: "https://app.test/inbox",
    },
    ":rotating_light: No answer yet from your team: a@b.test, alert 2 <https://app.test/inbox|Open in inbox>\n> Call &lt;lead&gt;",
  ],
])("slackText formats %j", (payload, wanted) => expect(slackText(payload)).toBe(wanted));

test("escapes payload strings, limits snippets, ignores non-strings and unsafe links", () => {
  const attack = "<!channel> & <http://evil|x>";
  expect(
    slackText({
      event_type: "reply_received",
      lead_email: "a",
      company_name: attack,
      reply_text_snippet: attack,
      unibox_url: "javascript:bad",
    }),
  ).toBe(
    ":speech_balloon: Reply from a (&lt;!channel&gt; &amp; &lt;http://evil|x&gt;)\n> &lt;!channel&gt; &amp; &lt;http://evil|x&gt;",
  );
  expect(
    slackText({
      event_type: "reply_received",
      lead_email: { bad: true },
      reply_text_snippet: "x".repeat(500),
    }),
  ).toBe(":speech_balloon: Reply from \n> " + "x".repeat(200));
});

test("create masks URL, encrypts token, and keeps it out of API responses", async () => {
  const w = await world();
  const h = await hook(w.ws);
  const row = await db.prisma.webhook.findUniqueOrThrow({ where: { id: h.id } });
  expect(row).toMatchObject({ url: SLACK_URL_MASK, format: "slack" });
  expect(decrypt(row.urlEnc!)).toBe(URL1);
  expect(h).not.toHaveProperty("urlEnc");
  expect(JSON.stringify([h, await getWebhook(db.prisma, w.ws, h.id)])).not.toContain("token-one");
  expect(
    JSON.stringify(await db.prisma.auditLog.findMany({ where: { workspaceId: w.ws } })),
  ).not.toContain("token-one");
});

test("rejects invalid Slack URL, headers and format changes; mask keeps encrypted URL", async () => {
  const w = await world();
  expect(await error(hook(w.ws, { url: "https://evil.test/services/a" }))).toBe(
    "invalid_slack_url",
  );
  expect(await error(hook(w.ws, { headers: { "X-Test": "x" } }))).toBe("headers_not_allowed");
  const h = await hook(w.ws);
  expect(await error(updateWebhook(db.prisma, w.ws, "u1", h.id, { format: "json" }, OUT))).toBe(
    "format_fixed",
  );
  expect(
    await error(updateWebhook(db.prisma, w.ws, "u1", h.id, { headers: { "X-Test": "x" } }, OUT)),
  ).toBe("headers_not_allowed");
  expect(
    await error(updateWebhook(db.prisma, w.ws, "u1", h.id, { url: "https://bad.test/" }, OUT)),
  ).toBe("invalid_slack_url");
  await updateWebhook(db.prisma, w.ws, "u1", h.id, { url: SLACK_URL_MASK }, OUT);
  expect(
    decrypt((await db.prisma.webhook.findUniqueOrThrow({ where: { id: h.id } })).urlEnc!),
  ).toBe(URL1);
  await updateWebhook(db.prisma, w.ws, "u1", h.id, { url: URL2 }, OUT);
  expect(
    decrypt((await db.prisma.webhook.findUniqueOrThrow({ where: { id: h.id } })).urlEnc!),
  ).toBe(URL2);
});

test("Slack delivery posts only text to the real URL, signs transformed body, retries without token leakage", async () => {
  const w = await world();
  const h = await hook(w.ws);
  const d = await db.prisma.webhookDelivery.create({
    data: {
      workspaceId: w.ws,
      webhookId: h.id,
      eventId: `e${++n}`,
      eventType: "reply_received",
      payload: { event_type: "reply_received", lead_email: "a@b.test" },
      nextAttemptAt: T,
      createdAt: T,
    },
  });
  request.mockResolvedValueOnce({ status: 500, latencyMs: 1, headers: {} });
  expect(await deliverDue(db.prisma, fixedClock(T), { ...OUT, maxMs: 0 })).toEqual({
    delivered: 0,
    failed: 1,
  });
  const [url, opts] = request.mock.calls[0]!;
  expect(url).toBe(URL1);
  expect(opts.body).toBe(JSON.stringify({ text: ":speech_balloon: Reply from a@b.test" }));
  expect(Object.keys(JSON.parse(opts.body))).toEqual(["text"]);
  expect(opts.headers["x-rightnow-signature"]).toBe(sign(h.secret, T.getTime() / 1000, opts.body));
  const row = await db.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } });
  expect(row.status).toBe("PENDING");
  expect(
    JSON.stringify(
      [row, await db.prisma.webhook.findUniqueOrThrow({ where: { id: h.id } })].map((x) => ({
        ...x,
        urlEnc: undefined,
      })),
    ),
  ).not.toContain("token-one");
  expect(row.lastError).toBe("http_500");
  expect(
    JSON.stringify(await db.prisma.auditLog.findMany({ where: { workspaceId: w.ws } })),
  ).not.toContain("token-one");
  expect(
    (await db.prisma.webhook.findUniqueOrThrow({ where: { id: h.id } })).lastError,
  ).not.toContain("token-one");
});

test("json delivery body and signature remain unchanged; Slack testWebhook posts text", async () => {
  const w = await world();
  const json = await createWebhook(
    db.prisma,
    w.ws,
    "u1",
    { url: "http://hook.test/h", events: ["email_sent"] },
    OUT,
  );
  await db.prisma.webhookDelivery.create({
    data: {
      workspaceId: w.ws,
      webhookId: json.id,
      eventId: `e${++n}`,
      eventType: "email_sent",
      payload: { event_type: "email_sent", value: 1 },
      nextAttemptAt: T,
      createdAt: T,
    },
  });
  await deliverDue(db.prisma, fixedClock(T), { ...OUT, maxMs: 0 });
  const opts = request.mock.calls[0]![1];
  expect(opts.body).toBe(
    JSON.stringify(
      (await db.prisma.webhookDelivery.findFirstOrThrow({ where: { webhookId: json.id } })).payload,
    ),
  );
  expect(opts.headers["x-rightnow-signature"]).toBe(
    sign(json.secret, T.getTime() / 1000, opts.body),
  );
  request.mockClear();
  const slack = await hook(w.ws);
  expect((await testWebhook(db.prisma, fixedClock(T), w.ws, slack.id, OUT)).status).toBe(200);
  expect(request.mock.calls[0]![0]).toBe(URL1);
  expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual({ text: "test: workspace" });
});

test("account error payload includes reason", async () => {
  const w = await world();
  const event = await db.prisma.event.create({
    data: {
      workspaceId: w.ws,
      type: "ACCOUNT_ERROR",
      occurredAt: T,
      dedupeKey: `slack:${++n}`,
      accountId: w.accounts[0]!.id,
      meta: { reason: "auth failed" },
    },
  });
  expect((await buildPayload(db.prisma, event, "https://app.test"))?.reason).toBe("auth failed");
});
