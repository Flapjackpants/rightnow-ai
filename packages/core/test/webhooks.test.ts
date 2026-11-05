import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { EventType, Prisma, PrismaClient } from "@rightnow/db/client";
import { createPrisma } from "@rightnow/db/create";
import { createTestDb } from "@rightnow/db/test-db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { dispatchEvents } from "../src/automations/engine";
import { createRule, updateRule } from "../src/automations/rules";
import { fixedClock } from "../src/clock";
import { decrypt } from "../src/crypto";
import { gdprDeleteLead } from "../src/leads/service";
import { purgeRetention } from "../src/retention";
import { BACKOFF_SEC, deliverDue, insertDeliveries, sign } from "../src/webhooks/deliver";
import { webhookEventName } from "../src/webhooks/events";
import { buildPayload } from "../src/webhooks/payload";
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listDeliveries,
  listWebhooks,
  redeliver,
  resumeWebhook,
  rotateSecret,
  testWebhook,
  updateWebhook,
  webhookOverview,
} from "../src/webhooks/service";
import { testEnv } from "./accounts-fixture";
import { seedCampaign } from "./campaign-fixture";

// the dispatcher's insertDeliveries, wrapped so a test can hold it (the real one runs unless a test replaces it)
vi.mock("../src/webhooks/deliver", async (orig) => {
  const m = await orig<typeof import("../src/webhooks/deliver")>();
  return { ...m, insertDeliveries: vi.fn(m.insertDeliveries) };
});

let db: Awaited<ReturnType<typeof createTestDb>>;
const P = () => db.prisma;
const extra: PrismaClient[] = [];
const client = () => {
  const p = createPrisma(db.url, 5);
  extra.push(p);
  return p;
};

type Hit = {
  eventId: string;
  sig: string;
  ts: string;
  body: string;
  headers: http.IncomingHttpHeaders;
  path: string;
  at: number;
};
type Answer = { status: number; headers?: Record<string, string>; hold?: Promise<void> };
let hits: Hit[] = [];
let answer: (h: Hit, i: number) => Answer = () => ({ status: 200 });
let server: http.Server;
let port = 0;
const URL_ = () => `http://hook.test:${port}/h`;
const OUT = { allowPrivate: true, resolve: async () => ["127.0.0.1"] };

beforeAll(async () => {
  testEnv();
  db = await createTestDb();
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const h: Hit = {
        eventId: String(req.headers["x-rightnow-event-id"]),
        sig: String(req.headers["x-rightnow-signature"]),
        ts: String(req.headers["x-rightnow-timestamp"]),
        body,
        headers: req.headers,
        path: String(req.url),
        at: Date.now(),
      };
      hits.push(h);
      const a = answer(h, hits.length - 1);
      await a.hold;
      res.writeHead(a.status, a.headers);
      res.end("x".repeat(100));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
const { insertDeliveries: realHook } =
  await vi.importActual<typeof import("../src/webhooks/deliver")>("../src/webhooks/deliver");
afterEach(() => {
  vi.mocked(insertDeliveries).mockImplementation(realHook);
});
// deliverDue scans every workspace: an earlier test's leftovers must not be sent
beforeEach(async () => {
  hits = [];
  answer = () => ({ status: 200 });
  await P().webhookDelivery.updateMany({
    where: { status: { in: ["PENDING", "SENDING"] } },
    data: { status: "FAILED" },
  });
  await P().event.updateMany({ where: { dispatchedAt: null }, data: { dispatchedAt: T } });
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await Promise.all(extra.map((p) => p.$disconnect()));
  await db.drop();
});

const T = new Date("2026-10-20T10:00:00Z");
const S = 1000;
let n = 0;
const err = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { status?: number; message?: string }) => ({ status: e.status, message: e.message }),
  );
const world = async (
  o: Parameters<typeof seedCampaign>[1] extends infer X ? Partial<X> : never = {},
) => {
  const s = await seedCampaign(P(), { at: T, leads: 1, ...o });
  return { ...s, lead: s.leads[0]?.lead as (typeof s.leads)[number]["lead"] };
};
type W = Awaited<ReturnType<typeof world>>;
const hook = (w: Pick<W, "ws">, events: string[], extraIn: object = {}) =>
  createWebhook(P(), w.ws, "u1", { url: URL_(), events, ...extraIn }, OUT);
const ev = (w: Pick<W, "ws">, type: EventType, o: Partial<Prisma.EventUncheckedCreateInput> = {}) =>
  P().event.create({
    data: { workspaceId: w.ws, type, occurredAt: T, dedupeKey: `wh:${++n}`, ...o },
  });
const accepted = (w: W, o: Partial<Prisma.EventUncheckedCreateInput> = {}) =>
  ev(w, "ACCEPTED", {
    leadId: w.lead.id,
    campaignId: w.campaign.id,
    accountId: w.accounts[0]!.id,
    ...o,
  });
async function drain(clock = fixedClock(T)) {
  const t = { events: 0, deliveries: 0 };
  for (;;) {
    const r = await dispatchEvents(P(), clock, { maxMs: 0 });
    if (!r.events) return t;
    t.events += r.events;
    t.deliveries += r.deliveries;
  }
}
const deliver = (clock: { now(): Date }, p: PrismaClient = P()) =>
  deliverDue(p, clock, { ...OUT, maxMs: 0 });
const rows = (webhookId: string) =>
  P().webhookDelivery.findMany({ where: { webhookId }, orderBy: { createdAt: "asc" } });
/** A PENDING delivery inserted directly (no dispatcher). */
const pending = (
  w: Pick<W, "ws">,
  webhookId: string,
  o: Partial<Prisma.WebhookDeliveryUncheckedCreateInput> = {},
) =>
  P().webhookDelivery.create({
    data: {
      workspaceId: w.ws,
      webhookId,
      eventId: `e${++n}`,
      eventType: "email_sent",
      payload: { event_id: `e${n}` },
      nextAttemptAt: T,
      createdAt: T,
      ...o,
    },
  });

describe("signature", () => {
  test("sign() is t=<t>,v1=<hex HMAC-SHA256(secret, '<t>.<body>')>", () => {
    const want = createHmac("sha256", "whsec_x").update('1700000000.{"a":1}').digest("hex");
    expect(want).toBe("b3438763ab46d9634b9844c8722818eaf523f803db1327484c6067462a5fd6d1");
    expect(sign("whsec_x", 1700000000, '{"a":1}')).toBe(`t=1700000000,v1=${want}`);
  });

  test("a delivery's signature verifies against the raw body; a redelivery 20 h later carries a fresh t", async () => {
    const w = await world();
    const { secret, id } = await hook(w, ["email_sent"]);
    const e = await accepted(w);
    await drain();
    const clock = fixedClock(T);
    expect(await deliver(clock)).toEqual({ delivered: 1, failed: 0 });
    const h = hits[0]!;
    expect(h.eventId).toBe(e.id);
    expect(h.ts).toBe(String(T.getTime() / S));
    expect(h.sig).toBe(sign(secret, T.getTime() / S, h.body));
    expect(h.headers["user-agent"]).toBe("rightnow-webhooks/1");
    expect(h.headers["content-type"]).toBe("application/json");
    const [d] = await rows(id);
    clock.advance(20 * 3600 * S);
    await redeliver(P(), w.ws, "u1", d!.id);
    await deliver(clock);
    const t2 = (T.getTime() + 20 * 3600 * S) / S;
    expect(hits[1]!.ts).toBe(String(t2));
    expect(hits[1]!.sig).toBe(sign(secret, t2, hits[1]!.body));
    expect(hits[1]!.body).toBe(h.body);
    expect(
      JSON.stringify(
        (await P().webhookDelivery.findUniqueOrThrow({ where: { id: d!.id } })).payload,
      ),
    ).not.toMatch(/v1=|"t"/);
  });

  test("rotate-secret takes effect at once", async () => {
    const w = await world();
    const { id } = await hook(w, ["email_sent"]);
    const { secret } = await rotateSecret(P(), w.ws, "u1", id);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    await accepted(w);
    await drain();
    await deliver(fixedClock(T));
    expect(hits[0]!.sig).toBe(sign(secret, T.getTime() / S, hits[0]!.body));
    expect(
      await P().auditLog.count({ where: { workspaceId: w.ws, action: "webhook.rotate_secret" } }),
    ).toBe(1);
  });
});

describe("create", () => {
  test("the secret is returned once; GET has hasSecret and header names only; secrets are encrypted", async () => {
    const w = await world();
    const r = await hook(w, ["email_sent"], {
      name: "n8n",
      headers: { Authorization: "Bearer tok" },
    });
    expect(r.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const g = await getWebhook(P(), w.ws, r.id);
    expect(g).toMatchObject({
      id: r.id,
      name: "n8n",
      url: URL_(),
      events: ["email_sent"],
      hasSecret: true,
      headerNames: ["Authorization"],
      status: "ACTIVE",
    });
    expect(g).not.toHaveProperty("secret");
    expect(g).not.toHaveProperty("secretEnc");
    expect(g).not.toHaveProperty("headersEnc");
    expect((await listWebhooks(P(), w.ws)).map((x) => x.id)).toEqual([r.id]);
    const row = await P().webhook.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.secretEnc).not.toContain(r.secret);
    expect(row.headersEnc).not.toContain("tok");
    expect(decrypt(row.secretEnc)).toBe(r.secret);
    expect(
      await P().auditLog.count({
        where: { workspaceId: w.ws, action: "webhook.create", target: r.id },
      }),
    ).toBe(1);
  });

  test.each([
    [{ headers: { Host: "x" } }, "invalid_header"],
    [{ headers: { "X-RightNow-Signature": "x" } }, "invalid_header"],
    [{ headers: { "content-length": "1" } }, "invalid_header"],
    [{ headers: { "X-Ok": "a\r\nb" } }, "invalid_header"],
    [{ headers: { "bad name": "a" } }, "invalid_header"],
    [{ url: "ftp://hook.test/x" }, "invalid_url"],
    [{ url: "http://u:p@hook.test/x" }, "invalid_url"],
    [{ events: ["nope"] }, "unknown_event"],
    [{ events: [] }, null],
  ])("%j → 400 %s", async (patch, code) => {
    const w = await world({ leads: 0 });
    const r = await err(
      createWebhook(P(), w.ws, "u1", { url: URL_(), events: ["email_sent"], ...patch }, OUT),
    );
    expect(r?.status).toBe(400);
    if (code) expect(r?.message).toBe(code);
  });

  test("a URL resolving to 10.0.0.5 → 400 webhook_host_not_public (and metadata even with the flag)", async () => {
    const w = await world({ leads: 0 });
    const ten = { allowPrivate: false, resolve: async () => ["10.0.0.5"] };
    expect(
      await err(
        createWebhook(P(), w.ws, "u1", { url: "https://x.test/h", events: ["email_sent"] }, ten),
      ),
    ).toEqual({ status: 400, message: "webhook_host_not_public" });
    const md = { allowPrivate: true, resolve: async () => ["169.254.169.254"] };
    expect(
      await err(
        createWebhook(P(), w.ws, "u1", { url: "https://x.test/h", events: ["email_sent"] }, md),
      ),
    ).toEqual({ status: 400, message: "webhook_host_not_public" });
    const { id } = await hook(w, ["email_sent"]);
    expect(await err(updateWebhook(P(), w.ws, "u1", id, { url: "https://x.test/h" }, ten))).toEqual(
      { status: 400, message: "webhook_host_not_public" },
    );
  });

  test("label names, all_events and a workspace campaign are accepted; a foreign campaign is invalid_reference", async () => {
    const w = await world({ leads: 0 });
    const o = await world({ leads: 0 });
    await P().leadLabel.create({ data: { workspaceId: w.ws, name: "Hot", color: "red" } });
    expect((await hook(w, ["Hot", "all_events"], { campaignId: w.campaign.id })).events).toEqual([
      "Hot",
      "all_events",
    ]);
    expect(await err(hook(w, ["email_sent"], { campaignId: o.campaign.id }))).toEqual({
      status: 400,
      message: "invalid_reference",
    });
    expect(await err(hook(o, ["Hot"]))).toEqual({ status: 400, message: "unknown_event" });
  });

  test("I3: an API key needs inbox:read for reply events or all_events", async () => {
    const w = await world({ leads: 0 });
    const key = { scopes: ["webhooks:write", "leads:read"] };
    for (const events of [["reply_received"], ["auto_reply_received"], ["all_events"]])
      expect(await err(createWebhook(P(), w.ws, null, { url: URL_(), events }, OUT, key))).toEqual({
        status: 403,
        message: "scope_required:inbox:read",
      });
    const { id } = await createWebhook(
      P(),
      w.ws,
      null,
      { url: URL_(), events: ["email_sent"] },
      OUT,
      key,
    );
    expect(
      await err(updateWebhook(P(), w.ws, null, id, { events: ["all_events"] }, OUT, key)),
    ).toEqual({ status: 403, message: "scope_required:inbox:read" });
    await createWebhook(P(), w.ws, null, { url: URL_(), events: ["all_events"] }, OUT, {
      scopes: ["webhooks:write", "inbox:read", "leads:read"],
    });
  });

  test("M4: an API key needs leads:read for any event that carries lead fields", async () => {
    const w = await world({ leads: 0 });
    const key = { scopes: ["webhooks:write", "inbox:read"] };
    for (const events of [["email_sent"], ["lead_interested"], ["reply_received"], ["all_events"]])
      expect(await err(createWebhook(P(), w.ws, null, { url: URL_(), events }, OUT, key))).toEqual({
        status: 403,
        message: "scope_required:leads:read",
      });
    const { id } = await createWebhook(
      P(),
      w.ws,
      null,
      { url: URL_(), events: ["account_error", "campaign_completed", "quota_reached"] },
      OUT,
      key,
    );
    expect(
      await err(updateWebhook(P(), w.ws, null, id, { events: ["email_bounced"] }, OUT, key)),
    ).toEqual({ status: 403, message: "scope_required:leads:read" });
    await updateWebhook(P(), w.ws, null, id, { events: ["email_bounced"] }, OUT, {
      scopes: [...key.scopes, "leads:read"],
    });
  });

  test("I3: a URL moved to another origin with stored headers needs new headers; the secret stays", async () => {
    const w = await world({ leads: 0 });
    const { id, secret } = await hook(w, ["email_sent"], { headers: { "X-Token": "t1" } });
    const before = (await P().webhook.findUniqueOrThrow({ where: { id } })).secretEnc;
    const moved = "https://93.184.216.35/elsewhere";
    expect(await err(updateWebhook(P(), w.ws, "u1", id, { url: moved }, OUT))).toEqual({
      status: 400,
      message: "headers_required",
    });
    // the same origin, another path: the headers stay
    const cur = (await P().webhook.findUniqueOrThrow({ where: { id } })).url;
    const same = new URL("/other", cur).toString();
    expect(await updateWebhook(P(), w.ws, "u1", id, { url: same }, OUT)).toMatchObject({
      url: same,
      headerNames: ["X-Token"],
    });
    expect(
      await updateWebhook(P(), w.ws, "u1", id, { url: moved, headers: null }, OUT),
    ).toMatchObject({
      url: moved,
      headerNames: [],
    });
    expect((await P().webhook.findUniqueOrThrow({ where: { id } })).secretEnc).toBe(before);
    expect(secret).toMatch(/^whsec_/);
  });

  test("update, delete and isolation", async () => {
    const w = await world({ leads: 0 });
    const o = await world({ leads: 0 });
    const { id } = await hook(w, ["email_sent"], { headers: { "X-A": "1" } });
    const u = await updateWebhook(P(), w.ws, "u1", id, { name: "x", headers: { "X-B": "2" } }, OUT);
    expect(u).toMatchObject({ name: "x", headerNames: ["X-B"] });
    expect(await err(getWebhook(P(), o.ws, id))).toMatchObject({ status: 404 });
    expect(await err(updateWebhook(P(), o.ws, "u1", id, { name: "y" }, OUT))).toMatchObject({
      status: 404,
    });
    expect(await err(deleteWebhook(P(), o.ws, "u1", id))).toMatchObject({ status: 404 });
    expect(await err(listDeliveries(P(), o.ws, id, {}))).toMatchObject({ status: 404 });
    await deleteWebhook(P(), w.ws, "u1", id);
    expect(await P().webhook.count({ where: { id } })).toBe(0);
  });
});

describe("payload", () => {
  test("webhookEventName maps the Fixed names table", () => {
    const f = (type: EventType, meta: object = {}) => webhookEventName({ type, meta });
    expect(f("ACCEPTED")).toBe("email_sent");
    expect(f("OPEN")).toBe("email_opened");
    expect(f("OPEN", { machine: true })).toBeNull();
    expect(f("CLICK")).toBe("email_link_clicked");
    expect(f("CLICK", { scanner: true })).toBeNull();
    expect(f("REPLY")).toBe("reply_received");
    expect(f("AUTO_REPLY")).toBe("auto_reply_received");
    expect(f("BOUNCE_HARD")).toBe("email_bounced");
    expect(f("BOUNCE_SOFT")).toBe("email_bounced");
    expect(f("UNSUBSCRIBE")).toBe("lead_unsubscribed");
    expect(f("ACCOUNT_ERROR")).toBe("account_error");
    expect(f("CAMPAIGN_COMPLETED")).toBe("campaign_completed");
    expect(f("DEAL_WON")).toBe("deal_won");
    expect(f("DEAL_LOST")).toBe("deal_lost");
    expect(f("QUOTA_REACHED")).toBe("quota_reached");
    expect(f("LABEL_ADDED", { label: "Hot" })).toBe("Hot");
    expect(webhookEventName({ type: "LABEL_ADDED", meta: {} }, "Cold")).toBe("Cold");
    const interest: [number | null, string][] = [
      [null, "lead_neutral"],
      [0, "lead_out_of_office"],
      [1, "lead_interested"],
      [2, "lead_meeting_booked"],
      [3, "lead_meeting_completed"],
      [4, "lead_closed"],
      [-1, "lead_not_interested"],
      [-2, "lead_wrong_person"],
      [-3, "lead_lost"],
      [-4, "lead_no_show"],
    ];
    for (const [to, name] of interest) expect(f("INTEREST_CHANGED", { to })).toBe(name);
    for (const t of [
      "SEND_FAILED",
      "BOUNCE_UNKNOWN",
      "COMPLAINT",
      "OPPORTUNITY",
      "MEETING",
    ] as EventType[])
      expect(f(t)).toBeNull();
  });

  test("a REPLY on step 2, variant B carries the documented fields", async () => {
    const w = await world({ steps: 2, workspace: { name: "Acme" } });
    await P().lead.update({
      where: { id: w.lead.id },
      data: { firstName: "Ann", customFields: { plan: "pro", first_name: "spoof" } },
    });
    const step2 = w.steps[1]!;
    const vB = await P().stepVariant.create({
      data: { stepId: step2.id, label: "B", subject: "S", body: "B" },
    });
    const sm = await P().scheduledMessage.create({
      data: {
        workspaceId: w.ws,
        campaignId: w.campaign.id,
        campaignLeadId: w.leads[0]!.cl.id,
        stepId: step2.id,
        variantId: vB.id,
        accountId: w.accounts[0]!.id,
        dueAt: T,
        idempotencyKey: `k${++n}`,
        status: "SENT",
        renderedSubject: "Hello Ann",
        renderedText: "Bye https://app.example.com/u/abc.DEF_1-2 end",
        renderedBody: '<a href="https://app.example.com/u/abc.DEF_1-2">unsubscribe</a>',
      },
    });
    const th = await P().thread.create({
      data: {
        workspaceId: w.ws,
        accountId: w.accounts[0]!.id,
        subject: "Re: Hello Ann",
        leadId: w.lead.id,
        lastMessageAt: T,
      },
    });
    const text = `  Sounds   good.\n${"y".repeat(300)}`;
    const m = await P().message.create({
      data: {
        workspaceId: w.ws,
        accountId: w.accounts[0]!.id,
        threadId: th.id,
        rfcMessageId: `<r${n}@x>`,
        direction: "IN",
        folder: "INBOX",
        fromEmail: w.lead.email,
        to: [w.accounts[0]!.email],
        subject: "Re: Hello Ann",
        text,
        html: "<p>Sounds good.</p>",
        sentAt: T,
        kind: "REPLY",
      },
    });
    const e = await ev(w, "REPLY", {
      leadId: w.lead.id,
      campaignId: w.campaign.id,
      accountId: w.accounts[0]!.id,
      stepId: step2.id,
      variantId: vB.id,
      scheduledMessageId: sm.id,
      messageId: m.id,
    });
    const p = await P().$transaction((tx) => buildPayload(tx, e, "https://app.example.com"));
    expect(p).toEqual({
      event_id: e.id,
      timestamp: T.toISOString(),
      event_type: "reply_received",
      workspace: w.ws,
      campaign_id: w.campaign.id,
      campaign_name: w.campaign.name,
      plan: "pro",
      lead_email: w.lead.email,
      first_name: "Ann",
      last_name: null,
      company_name: null,
      company_domain: null,
      job_title: null,
      website: null,
      industry: null,
      phone: null,
      personalization: null,
      country: null,
      region: null,
      email_account: w.accounts[0]!.email,
      unibox_url: `https://app.example.com/inbox?thread=${th.id}`,
      step: 2,
      variant: 2,
      is_first: false,
      email_id: sm.id,
      email_subject: "Hello Ann",
      email_text: "Bye [unsubscribe link] end",
      email_html: '<a href="[unsubscribe link]">unsubscribe</a>',
      reply_subject: "Re: Hello Ann",
      reply_text: text,
      reply_html: "<p>Sounds good.</p>",
      reply_text_snippet: `Sounds good. ${"y".repeat(187)}`,
    });
    expect((p!.reply_text_snippet as string).length).toBe(200);
  });

  test("INTEREST_CHANGED, LABEL_ADDED names; a machine OPEN gives no payload and no delivery", async () => {
    const w = await world();
    await hook(w, ["all_events"]);
    const b = (e: Awaited<ReturnType<typeof ev>>) =>
      P().$transaction((tx) => buildPayload(tx, e, "https://a.test"));
    expect(
      (await b(await ev(w, "INTEREST_CHANGED", { leadId: w.lead.id, meta: { to: -4 } })))
        ?.event_type,
    ).toBe("lead_no_show");
    expect(
      (await b(await ev(w, "INTEREST_CHANGED", { leadId: w.lead.id, meta: { to: null } })))
        ?.event_type,
    ).toBe("lead_neutral");
    expect(
      (await b(await ev(w, "LABEL_ADDED", { leadId: w.lead.id, meta: { label: "Hot" } })))
        ?.event_type,
    ).toBe("Hot");
    await P().event.updateMany({ where: { workspaceId: w.ws }, data: { dispatchedAt: T } });
    const open = await ev(w, "OPEN", { leadId: w.lead.id, meta: { machine: true } });
    expect(await b(open)).toBeNull();
    expect(await drain()).toEqual({ events: 1, deliveries: 0 });
  });

  test("a 400 KB html reply: payload ≤ 256 KB with reply_html dropped first, then the text fields", async () => {
    const w = await world();
    const th = await P().thread.create({
      data: { workspaceId: w.ws, accountId: w.accounts[0]!.id, subject: "s", lastMessageAt: T },
    });
    const mk = (text: string, html: string) =>
      P().message.create({
        data: {
          workspaceId: w.ws,
          accountId: w.accounts[0]!.id,
          threadId: th.id,
          rfcMessageId: `<b${++n}@x>`,
          direction: "IN",
          folder: "INBOX",
          fromEmail: w.lead.email,
          subject: "s",
          text,
          html,
          sentAt: T,
          kind: "REPLY",
        },
      });
    const m1 = await mk("short", "h".repeat(400 * 1024));
    const p1 = await P().$transaction(async (tx) =>
      buildPayload(
        tx,
        await ev(w, "REPLY", { leadId: w.lead.id, messageId: m1.id }),
        "https://a.test",
      ),
    );
    expect(p1).not.toHaveProperty("reply_html");
    expect(p1!.reply_text).toBe("short");
    expect(Buffer.byteLength(JSON.stringify(p1))).toBeLessThanOrEqual(256 * 1024);
    const m2 = await mk("t".repeat(300 * 1024), "h");
    const p2 = await P().$transaction(async (tx) =>
      buildPayload(
        tx,
        await ev(w, "REPLY", { leadId: w.lead.id, messageId: m2.id }),
        "https://a.test",
      ),
    );
    expect(p2).not.toHaveProperty("reply_html");
    expect(p2).not.toHaveProperty("reply_text");
    expect(p2!.reply_text_snippet).toBe("t".repeat(200));
  });
});

describe("send_webhook action", () => {
  test("appUrl passed to dispatchEvents builds the payload links, not getEnv().APP_URL (T00-A)", async () => {
    const w = await world();
    const W = await hook(w, ["reply_received"]);
    const th = await P().thread.create({
      data: {
        workspaceId: w.ws,
        accountId: w.accounts[0]!.id,
        subject: "s",
        leadId: w.lead.id,
        lastMessageAt: T,
      },
    });
    const m = await P().message.create({
      data: {
        workspaceId: w.ws,
        accountId: w.accounts[0]!.id,
        threadId: th.id,
        rfcMessageId: `<a${++n}@x>`,
        direction: "IN",
        folder: "INBOX",
        fromEmail: w.lead.email,
        to: [w.accounts[0]!.email],
        subject: "s",
        text: "t",
        sentAt: T,
        kind: "REPLY",
      },
    });
    await ev(w, "REPLY", { leadId: w.lead.id, messageId: m.id });
    await dispatchEvents(P(), fixedClock(T), { maxMs: 0, appUrl: "https://inject.test" });
    const [d] = await rows(W.id);
    expect((d!.payload as { unibox_url: string }).unibox_url).toMatch(/^https:\/\/inject\.test\//);
  });

  test("a rule delivers to W once, also when W is subscribed; a foreign webhookId is invalid_reference", async () => {
    const w = await world();
    const o = await world({ leads: 0 });
    const W = await hook(w, ["email_sent"]);
    await createRule(P(), w.ws, null, {
      name: "r",
      trigger: "reply_received",
      actions: [{ type: "send_webhook", webhookId: W.id }],
    });
    await ev(w, "REPLY", { leadId: w.lead.id });
    await drain();
    expect((await rows(W.id)).map((d) => d.eventType)).toEqual(["reply_received"]);
    await updateWebhook(P(), w.ws, "u1", W.id, { events: ["email_sent", "reply_received"] }, OUT);
    await ev(w, "REPLY", { leadId: w.lead.id });
    await drain();
    expect(await rows(W.id)).toHaveLength(2);
    const OW = await hook(o, ["email_sent"]);
    expect(
      await err(
        createRule(P(), w.ws, null, {
          name: "x",
          trigger: "reply_received",
          actions: [{ type: "send_webhook", webhookId: OW.id }],
        }),
      ),
    ).toEqual({ status: 400, message: "invalid_reference" });
    expect(
      await err(
        createRule(
          P(),
          w.ws,
          null,
          {
            name: "x",
            trigger: "reply_received",
            actions: [{ type: "send_webhook", webhookId: W.id }],
          },
          { scopes: ["automations:write"] },
        ),
      ),
    ).toEqual({ status: 403, message: "scope_required:webhooks:write" });
  });
});

describe("subscription filter", () => {
  test("campaign filter, all_events and label subscriptions; ERROR webhooks get nothing", async () => {
    const w = await world();
    const c2 = await P().campaign.create({ data: { workspaceId: w.ws, name: "C2" } });
    await P().leadLabel.createMany({
      data: [
        { workspaceId: w.ws, name: "Hot", color: "r" },
        { workspaceId: w.ws, name: "Cold", color: "b" },
      ],
    });
    const sent = await hook(w, ["email_sent"], { campaignId: w.campaign.id });
    const all = await hook(w, ["all_events"]);
    const hot = await hook(w, ["Hot"]);
    const off = await hook(w, ["all_events"]);
    await P().webhook.update({ where: { id: off.id }, data: { status: "ERROR" } });
    const a1 = await accepted(w);
    await accepted(w, { campaignId: c2.id });
    await ev(w, "REPLY", { leadId: w.lead.id, campaignId: w.campaign.id });
    await ev(w, "SEND_FAILED", { leadId: w.lead.id, campaignId: w.campaign.id });
    await ev(w, "LABEL_ADDED", { leadId: w.lead.id, meta: { label: "Hot" } });
    await ev(w, "LABEL_ADDED", { leadId: w.lead.id, meta: { label: "Cold" } });
    await drain();
    expect((await rows(sent.id)).map((d) => d.eventId)).toEqual([a1.id]);
    // one batch: the rows share createdAt, so compare as sets
    expect((await rows(all.id)).map((d) => d.eventType).sort()).toEqual([
      "Cold",
      "Hot",
      "email_sent",
      "email_sent",
      "reply_received",
    ]);
    expect((await rows(hot.id)).map((d) => d.eventType)).toEqual(["Hot"]);
    expect(await rows(off.id)).toEqual([]);
    expect((await rows(sent.id))[0]).toMatchObject({
      leadId: w.lead.id,
      status: "PENDING",
      attempts: 0,
      nextAttemptAt: T,
    });
  });
});

test("M6: an Event of a soft-deleted (merged) lead gets no delivery, as it gets no rule run", async () => {
  const w = await world();
  const W = await hook(w, ["all_events"]);
  await P().lead.update({ where: { id: w.lead.id }, data: { deletedAt: T } });
  await accepted(w);
  await ev(w, "ACCOUNT_ERROR", { accountId: w.accounts[0]!.id, meta: { reason: "x" } });
  await drain();
  expect((await rows(W.id)).map((d) => d.eventType)).toEqual(["account_error"]);
});

describe("retries", () => {
  test("500, 500, 200: attempts 1-3 at +60 s and +300 s, DELIVERED, counter back to 0", async () => {
    const w = await world();
    const W = await hook(w, ["email_sent"]);
    await accepted(w);
    await drain();
    const clock = fixedClock(T);
    answer = (_h, i) => ({ status: i < 2 ? 500 : 200 });
    expect(await deliver(clock)).toEqual({ delivered: 0, failed: 1 });
    let [d] = await rows(W.id);
    expect(d).toMatchObject({
      status: "PENDING",
      attempts: 1,
      lastStatus: 500,
      lastError: "http_500",
      nextAttemptAt: new Date(T.getTime() + 60 * S),
      lastAttemptAt: T,
    });
    expect((await P().webhook.findUniqueOrThrow({ where: { id: W.id } })).consecutiveFailures).toBe(
      1,
    );
    expect(await deliver(clock)).toEqual({ delivered: 0, failed: 0 }); // not due yet
    clock.advance(60 * S);
    await deliver(clock);
    [d] = await rows(W.id);
    expect(d).toMatchObject({
      attempts: 2,
      nextAttemptAt: new Date(clock.now().getTime() + 300 * S),
    });
    clock.advance(300 * S);
    expect(await deliver(clock)).toEqual({ delivered: 1, failed: 0 });
    [d] = await rows(W.id);
    expect(d).toMatchObject({
      status: "DELIVERED",
      attempts: 3,
      lastStatus: 200,
      lastError: null,
      deliveredAt: clock.now(),
      leaseUntil: null,
    });
    expect(d!.lastLatencyMs).toBeGreaterThanOrEqual(0);
    expect((await P().webhook.findUniqueOrThrow({ where: { id: W.id } })).consecutiveFailures).toBe(
      0,
    );
    expect(hits).toHaveLength(3);
  });

  test("a 429 with Retry-After: 3600 waits 3600 s and does not count toward auto-disable", async () => {
    const w = await world({ leads: 0 });
    const W = await hook(w, ["email_sent"]);
    const d = await pending(w, W.id);
    answer = () => ({ status: 429, headers: { "retry-after": "3600" } });
    await deliver(fixedClock(T));
    expect(await P().webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({
      status: "PENDING",
      nextAttemptAt: new Date(T.getTime() + 3600 * S),
      lastError: "http_429",
    });
    expect((await P().webhook.findUniqueOrThrow({ where: { id: W.id } })).consecutiveFailures).toBe(
      0,
    );
    // Retry-After is capped at 8 h, and never shortens the backoff
    answer = () => ({ status: 503, headers: { "retry-after": "999999" } });
    const c = fixedClock(new Date(T.getTime() + 3600 * S));
    await deliver(c);
    expect(
      (await P().webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).nextAttemptAt,
    ).toEqual(new Date(c.now().getTime() + 28800 * S));
  });

  test("8 failed attempts → FAILED, never scheduled past ~23.6 h after creation", async () => {
    expect(BACKOFF_SEC).toEqual([60, 300, 1800, 7200, 18000, 28800, 28800]);
    const w = await world({ leads: 0 });
    const W = await hook(w, ["email_sent"]);
    const d = await pending(w, W.id);
    answer = () => ({ status: 500 });
    const clock = fixedClock(T);
    let latest = T;
    for (let i = 1; i <= 8; i++) {
      await deliver(clock);
      const r = await P().webhookDelivery.findUniqueOrThrow({ where: { id: d.id } });
      expect(r.attempts).toBe(i);
      if (r.nextAttemptAt > latest) latest = r.nextAttemptAt;
      expect(r.status).toBe(i < 8 ? "PENDING" : "FAILED");
      clock.advance(r.nextAttemptAt.getTime() - clock.now().getTime());
    }
    expect(latest.getTime() - T.getTime()).toBe(84_960 * S); // 23.6 h
    expect(hits).toHaveLength(8);
    await deliver(fixedClock(new Date(T.getTime() + 2 * 86_400 * S)));
    expect(hits).toHaveLength(8);
  });

  test("a refused host and a network error are failed attempts with their code", async () => {
    const w = await world({ leads: 0 });
    const W = await hook(w, ["email_sent"]);
    const d = await pending(w, W.id);
    await deliverDue(P(), fixedClock(T), {
      allowPrivate: false,
      resolve: async () => ["127.0.0.1"],
      maxMs: 0,
    });
    expect(await P().webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({
      status: "PENDING",
      attempts: 1,
      lastStatus: null,
      lastError: "host_not_public",
    });
    expect(hits).toHaveLength(0);
  });
});

describe("lease", () => {
  test("an expired SENDING lease goes back to PENDING and is delivered once", async () => {
    const w = await world({ leads: 0 });
    const W = await hook(w, ["email_sent"]);
    const d = await pending(w, W.id, {
      status: "SENDING",
      attempts: 1,
      leaseUntil: new Date(T.getTime() - S),
    });
    expect(await deliver(fixedClock(T))).toEqual({ delivered: 1, failed: 0 });
    expect(await P().webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({
      status: "DELIVERED",
      attempts: 2,
    });
    expect(hits.map((h) => h.eventId)).toEqual([d.eventId]);
    // a live lease is left alone
    const live = await pending(w, W.id, {
      status: "SENDING",
      attempts: 1,
      leaseUntil: new Date(T.getTime() + S),
    });
    await deliver(fixedClock(T));
    expect((await P().webhookDelivery.findUniqueOrThrow({ where: { id: live.id } })).status).toBe(
      "SENDING",
    );
  });

  test("a late result write from the old attempt (attempts mismatch) changes nothing", async () => {
    const w = await world({ leads: 0 });
    const W = await hook(w, ["email_sent"]);
    const d = await pending(w, W.id);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    answer = (_h, i) => (i === 0 ? { status: 500, hold } : { status: 200 });
    const first = deliver(fixedClock(T));
    await vi.waitFor(() => expect(hits).toHaveLength(1));
    // the first worker "died": its lease expired, and another run reclaims and delivers
    await P().webhookDelivery.update({
      where: { id: d.id },
      data: { leaseUntil: new Date(T.getTime() - S) },
    });
    expect(await deliver(fixedClock(T), client())).toEqual({ delivered: 1, failed: 0 });
    release();
    expect(await first).toEqual({ delivered: 0, failed: 0 });
    expect(await P().webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({
      status: "DELIVERED",
      attempts: 2,
      lastStatus: 200,
    });
    expect((await P().webhook.findUniqueOrThrow({ where: { id: W.id } })).consecutiveFailures).toBe(
      0,
    );
  });
});

describe("shutdown", () => {
  test("a worker shutdown mid-POST is not a failed attempt: SENDING stays for the lease, counter unchanged", async () => {
    const w = await world({ leads: 0 });
    const W = await hook(w, ["email_sent"]);
    const d = await pending(w, W.id);
    answer = () => ({ status: 200, hold: new Promise((r) => setTimeout(r, 1_000)) });
    const ac = new AbortController();
    const run = deliverDue(P(), fixedClock(T), { ...OUT, maxMs: 0, signal: ac.signal });
    await vi.waitFor(() => expect(hits).toHaveLength(1));
    ac.abort();
    expect(await run).toEqual({ delivered: 0, failed: 0 });
    expect(await P().webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({
      status: "SENDING",
      attempts: 1,
    });
    expect((await P().webhook.findUniqueOrThrow({ where: { id: W.id } })).consecutiveFailures).toBe(
      0,
    );
  });
});

describe("auto-disable", () => {
  test("the 20th consecutive failure → ERROR, PENDING rows FAILED, one audit; resume and redeliver", async () => {
    const w = await world();
    const W = await hook(w, ["email_sent"]);
    await P().webhook.update({ where: { id: W.id }, data: { consecutiveFailures: 19 } });
    const due = await pending(w, W.id);
    const later = await pending(w, W.id, { nextAttemptAt: new Date(T.getTime() + 3600 * S) });
    answer = () => ({ status: 500 });
    await deliver(fixedClock(T));
    expect(await P().webhook.findUniqueOrThrow({ where: { id: W.id } })).toMatchObject({
      status: "ERROR",
      consecutiveFailures: 20,
      lastError: "http_500",
      disabledAt: T,
    });
    for (const id of [due.id, later.id])
      expect(await P().webhookDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: "FAILED",
        lastError: "webhook_disabled",
      });
    expect(
      await P().auditLog.findMany({
        where: { workspaceId: w.ws, action: "webhook.disabled" },
        select: { target: true, meta: true },
      }),
    ).toEqual([{ target: W.id, meta: { lastError: "http_500" } }]);
    await accepted(w);
    expect((await drain()).deliveries).toBe(0);
    const r = await resumeWebhook(P(), w.ws, "u1", W.id);
    expect(r).toMatchObject({ status: "ACTIVE", consecutiveFailures: 0, disabledAt: null });
    expect(
      await P().auditLog.count({ where: { workspaceId: w.ws, action: "webhook.resume" } }),
    ).toBe(1);
    await redeliver(P(), w.ws, "u1", due.id);
    expect(await P().webhookDelivery.findUniqueOrThrow({ where: { id: due.id } })).toMatchObject({
      status: "PENDING",
      attempts: 0,
    });
    expect(
      await P().auditLog.count({
        where: { workspaceId: w.ws, action: "webhook.redeliver", target: due.id },
      }),
    ).toBe(1);
    answer = () => ({ status: 200 });
    await deliver(fixedClock(T));
    expect(await P().webhookDelivery.findUniqueOrThrow({ where: { id: due.id } })).toMatchObject({
      status: "DELIVERED",
      attempts: 1,
    });
    const o = await world({ leads: 0 });
    expect(await err(redeliver(P(), o.ws, "u1", due.id))).toMatchObject({ status: 404 });
    expect(await err(resumeWebhook(P(), o.ws, "u1", W.id))).toMatchObject({ status: 404 });
  });

  test("concurrent failures flip the webhook once and audit once", async () => {
    const w = await world({ leads: 0 });
    const W = await hook(w, ["email_sent"]);
    await P().webhook.update({ where: { id: W.id }, data: { consecutiveFailures: 15 } });
    for (let i = 0; i < 12; i++) await pending(w, W.id);
    answer = () => ({ status: 500 });
    await Promise.all([deliver(fixedClock(T)), deliver(fixedClock(T), client())]);
    expect((await P().webhook.findUniqueOrThrow({ where: { id: W.id } })).status).toBe("ERROR");
    expect(
      await P().auditLog.count({ where: { workspaceId: w.ws, action: "webhook.disabled" } }),
    ).toBe(1);
    expect(
      await P().webhookDelivery.count({ where: { webhookId: W.id, status: { not: "FAILED" } } }),
    ).toBe(0);
  });

  test("an in-flight POST failing after the disable ends FAILED webhook_disabled", async () => {
    const w = await world({ leads: 0 });
    const W = await hook(w, ["email_sent"]);
    const d = await pending(w, W.id);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    answer = () => ({ status: 500, hold });
    const run = deliver(fixedClock(T));
    await vi.waitFor(() => expect(hits).toHaveLength(1));
    await P().webhook.update({ where: { id: W.id }, data: { status: "ERROR", disabledAt: T } });
    release();
    await run;
    expect(await P().webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({
      status: "FAILED",
      lastError: "webhook_disabled",
      lastStatus: 500,
    });
  });
});

describe("concurrency", () => {
  test("two deliverDue runs over 30 PENDING rows POST each row exactly once", async () => {
    const w = await world({ leads: 0 });
    const W = await hook(w, ["email_sent"]);
    const ds = [];
    for (let i = 0; i < 30; i++) ds.push(await pending(w, W.id));
    answer = () => ({ status: 200 });
    const [a, b] = await Promise.all([
      deliverDue(P(), fixedClock(T), { ...OUT, maxMs: 0, limit: 5 }),
      deliverDue(client(), fixedClock(T), { ...OUT, maxMs: 0, limit: 5 }),
    ]);
    // maxMs 0 = one claim each; run until drained
    let more = a.delivered + b.delivered;
    while (more < 30) more += (await deliver(fixedClock(T))).delivered;
    expect(hits.map((h) => h.eventId).sort()).toEqual(ds.map((d) => d.eventId).sort());
    expect(a.delivered).toBeGreaterThan(0);
    expect(b.delivered).toBeGreaterThan(0);
  });

  test("A2: a slow endpoint holding many due rows does not delay another webhook in the same batch", async () => {
    const w = await world({ leads: 0 });
    const slow = await hook(w, ["email_sent"], { url: `${URL_()}/slow` });
    const fast = await hook(w, ["email_sent"], { url: `${URL_()}/fast` });
    for (let i = 0; i < 10; i++)
      await pending(w, slow.id, { nextAttemptAt: new Date(T.getTime() - S) });
    await pending(w, fast.id); // sorts last: without a per-webhook cap it waits for the third wave
    answer = (h) =>
      h.path.endsWith("/slow")
        ? { status: 200, hold: new Promise((r) => setTimeout(r, 400)) }
        : { status: 200 };
    const start = Date.now();
    expect(await deliver(fixedClock(T))).toEqual({ delivered: 11, failed: 0 });
    expect(hits.find((h) => h.path.endsWith("/fast"))!.at - start).toBeLessThan(300);
  });

  test("no tx around network: the claimed row can be updated while its POST is held 2 s", async () => {
    const w = await world({ leads: 0 });
    const W = await hook(w, ["email_sent"]);
    const d = await pending(w, W.id);
    answer = () => ({ status: 200, hold: new Promise((r) => setTimeout(r, 2_000)) });
    const run = deliver(fixedClock(T));
    await vi.waitFor(() => expect(hits).toHaveLength(1));
    const t0 = Date.now();
    await client()
      .$executeRaw`UPDATE "WebhookDelivery" SET "lastError" = 'probe' WHERE id = ${d.id}`;
    expect(Date.now() - t0).toBeLessThan(500);
    await run;
  });
});

describe("gdpr purges deliveries", () => {
  test("erasure removes the lead's PENDING/FAILED deliveries and any payload holding the address", async () => {
    const w = await world();
    const W = await hook(w, ["all_events"]);
    await pending(w, W.id, { leadId: w.lead.id });
    await pending(w, W.id, { leadId: w.lead.id, status: "FAILED" });
    const leadless = await pending(w, W.id, {
      payload: { lead_email: w.lead.email.toUpperCase() },
    });
    const other = await pending(w, W.id, { payload: { lead_email: "someone@else.test" } });
    await gdprDeleteLead(P(), fixedClock(T), w.ws, w.lead.id, "u1");
    expect((await rows(W.id)).map((d) => d.id)).toEqual([other.id]);
    expect(leadless.id).not.toBe(other.id);
    await deliver(fixedClock(T));
    expect(hits.map((h) => h.eventId)).toEqual([other.eventId]);
  });

  test("R8: erasure concurrent with a dispatch batch that inserted the lead's delivery leaves nothing", async () => {
    const w = await world();
    const W = await hook(w, ["reply_received"]);
    await ev(w, "REPLY", { leadId: w.lead.id, campaignId: w.campaign.id });
    let inserted!: () => void;
    const didInsert = new Promise<void>((r) => (inserted = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(insertDeliveries).mockImplementation(async (...a) => {
      const k = await realHook(...a);
      inserted();
      await gate;
      return k;
    });
    const d = dispatchEvents(P(), fixedClock(T), { maxMs: 0 });
    await didInsert;
    const g = gdprDeleteLead(client(), fixedClock(T), w.ws, w.lead.id, "u1");
    await new Promise((r) => setTimeout(r, 300)); // gdpr now waits on the claimed Event
    release();
    expect((await d).deliveries).toBe(1);
    await g;
    const left = await P().$queryRaw<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM "WebhookDelivery" WHERE payload::text ILIKE ${`%${w.lead.email}%`}`;
    expect(left[0]!.n).toBe(0);
    expect(await rows(W.id)).toEqual([]);
    await deliver(fixedClock(T));
    expect(hits).toEqual([]);
  });
});

describe("overview, list, test, retention", () => {
  test("delivered and failed per local day of the last attempt", async () => {
    const w = await world({ leads: 0, workspace: { timezone: "America/New_York" } });
    const W = await hook(w, ["email_sent"]);
    const at = (iso: string) => new Date(iso);
    // 2026-10-20 03:00Z is still 10-19 in New York
    for (const [status, last] of [
      ["DELIVERED", "2026-10-20T03:00:00Z"],
      ["DELIVERED", "2026-10-20T15:00:00Z"],
      ["DELIVERED", "2026-10-21T15:00:00Z"],
      ["FAILED", "2026-10-20T15:00:00Z"],
      ["PENDING", "2026-10-21T16:00:00Z"],
    ] as const)
      await pending(w, W.id, {
        status,
        lastAttemptAt: at(last),
        lastError: status === "DELIVERED" ? null : "http_500",
      });
    await pending(w, W.id); // never attempted
    expect(await webhookOverview(P(), w.ws, { from: "2026-10-19", to: "2026-10-21" })).toEqual([
      { day: "2026-10-19", delivered: 1, failed: 0 },
      { day: "2026-10-20", delivered: 1, failed: 1 },
      { day: "2026-10-21", delivered: 1, failed: 1 },
    ]);
    expect(await webhookOverview(P(), w.ws, { from: "2026-10-21", to: "2026-10-21" })).toEqual([
      { day: "2026-10-21", delivered: 1, failed: 1 },
    ]);
  });

  test("listDeliveries pages newest first", async () => {
    const w = await world({ leads: 0 });
    const W = await hook(w, ["email_sent"]);
    const a = await pending(w, W.id, { createdAt: new Date(T.getTime() - 2 * S) });
    const b = await pending(w, W.id, { createdAt: new Date(T.getTime() - S) });
    const p1 = await listDeliveries(P(), w.ws, W.id, { take: 1 });
    expect(p1.deliveries.map((d) => d.id)).toEqual([b.id]);
    const p2 = await listDeliveries(P(), w.ws, W.id, { take: 1, cursor: p1.nextCursor });
    expect(p2).toMatchObject({ nextCursor: null });
    expect(p2.deliveries.map((d) => d.id)).toEqual([a.id]);
  });

  test("testWebhook sends a signed test payload, stores nothing and reports status or code", async () => {
    const w = await world({ leads: 0 });
    const W = await hook(w, ["email_sent"]);
    expect(await testWebhook(P(), fixedClock(T), w.ws, W.id, OUT)).toMatchObject({
      status: 200,
      error: null,
    });
    expect(JSON.parse(hits[0]!.body)).toMatchObject({ event_type: "test", workspace: w.ws });
    expect(hits[0]!.sig).toBe(
      sign(
        decrypt((await P().webhook.findUniqueOrThrow({ where: { id: W.id } })).secretEnc),
        T.getTime() / S,
        hits[0]!.body,
      ),
    );
    answer = () => ({ status: 500 });
    expect(await testWebhook(P(), fixedClock(T), w.ws, W.id, OUT)).toMatchObject({
      status: 500,
      error: "http_500",
    });
    expect(
      await testWebhook(P(), fixedClock(T), w.ws, W.id, {
        allowPrivate: false,
        resolve: OUT.resolve,
      }),
    ).toMatchObject({ status: null, error: "host_not_public" });
    expect(await P().webhookDelivery.count({ where: { webhookId: W.id } })).toBe(0);
    expect(
      await err(testWebhook(P(), fixedClock(T), (await world({ leads: 0 })).ws, W.id, OUT)),
    ).toMatchObject({ status: 404 });
  });

  test("retention deletes DELIVERED/FAILED deliveries older than 30 days only", async () => {
    const w = await world({ leads: 0 });
    const W = await hook(w, ["email_sent"]);
    const old = new Date(T.getTime() - 31 * 86_400 * S);
    await pending(w, W.id, { status: "DELIVERED", createdAt: old });
    await pending(w, W.id, { status: "FAILED", createdAt: old });
    const keepPending = await pending(w, W.id, {
      createdAt: old,
      nextAttemptAt: new Date(T.getTime() + 86_400 * S),
    });
    const recent = await pending(w, W.id, {
      status: "DELIVERED",
      createdAt: new Date(T.getTime() - 29 * 86_400 * S),
    });
    expect(await purgeRetention(P(), fixedClock(T))).toMatchObject({ webhookDeliveries: 2 });
    expect((await rows(W.id)).map((d) => d.id).sort()).toEqual([keepPending.id, recent.id].sort());
  });
});

describe("fix round 1", () => {
  test("I1: a send_webhook rule on reply_received needs inbox:read for an API key", async () => {
    const w = await world({ leads: 0 });
    const W = await hook(w, ["email_sent"]);
    const input = {
      name: "leak",
      trigger: "reply_received",
      actions: [{ type: "send_webhook", webhookId: W.id }],
    };
    const base = ["automations:write", "webhooks:write", "leads:read"];
    expect(await err(createRule(P(), w.ws, null, input, { scopes: base }))).toEqual({
      status: 403,
      message: "scope_required:inbox:read",
    });
    await createRule(P(), w.ws, null, input, { scopes: [...base, "inbox:read"] });
    // another trigger carries no reply body: no inbox:read needed
    await createRule(P(), w.ws, null, { ...input, trigger: "bounced" }, { scopes: base });
  });

  test("M4: a send_webhook rule needs leads:read for an API key unless the trigger carries no lead", async () => {
    const w = await world({ leads: 0 });
    const W = await hook(w, ["email_sent"]);
    const base = { scopes: ["automations:write", "webhooks:write", "inbox:read"] };
    const input = (trigger: string) => ({
      name: "m4",
      trigger,
      actions: [{ type: "send_webhook", webhookId: W.id }],
    });
    for (const t of ["bounced", "reply_received"])
      expect(await err(createRule(P(), w.ws, null, input(t), base))).toEqual({
        status: 403,
        message: "scope_required:leads:read",
      });
    for (const t of ["account_error", "campaign_completed", "quota_reached"])
      await createRule(P(), w.ws, null, input(t), base);
    const r = await createRule(P(), w.ws, null, input("quota_reached"), base);
    expect(await err(updateRule(P(), w.ws, null, r.id, { trigger: "bounced" }, base))).toEqual({
      status: 403,
      message: "scope_required:leads:read",
    });
    await updateRule(
      P(),
      w.ws,
      null,
      r.id,
      { trigger: "bounced" },
      {
        scopes: [...base.scopes, "leads:read"],
      },
    );
  });

  test("I2: custom fields never override the envelope; a non-string event_type cannot break dispatch", async () => {
    const w = await world();
    const W = await hook(w, ["email_sent"]);
    await P().lead.update({
      where: { id: w.lead.id },
      data: {
        customFields: { event_type: 5, event_id: "spoof", lead_email: "x@y.z", plan: "pro" },
      },
    });
    const e = await accepted(w);
    expect(await drain()).toEqual({ events: 1, deliveries: 1 });
    expect((await P().event.findUniqueOrThrow({ where: { id: e.id } })).dispatchError).toBeNull();
    const [d] = await rows(W.id);
    expect(d!.eventType).toBe("email_sent");
    expect(d!.payload).toMatchObject({
      event_type: "email_sent",
      event_id: e.id,
      lead_email: w.lead.email,
      plan: "pro",
    });
  });

  test("a custom field named like a conditional standard field never reaches the receiver as one", async () => {
    const w = await world();
    const spoof = {
      step: 99,
      variant: 9,
      is_first: true,
      email_id: "x",
      email_subject: "x",
      email_text: "x",
      email_html: "x",
      unibox_url: "http://evil.test",
      email_account: "evil@x.test",
      reply_text: "x",
      reply_subject: "x",
      reply_html: "x",
      reply_text_snippet: "x",
      plan: "pro",
    };
    await P().lead.update({ where: { id: w.lead.id }, data: { customFields: spoof } });
    const e = await ev(w, "OPEN", { leadId: w.lead.id, campaignId: w.campaign.id });
    const p = await P().$transaction((tx) => buildPayload(tx, e, "https://a.test"));
    expect(p).toMatchObject({ plan: "pro" });
    for (const k of Object.keys(spoof).filter((k) => k !== "plan")) expect(p).not.toHaveProperty(k);
  });

  test("I3: listDeliveries strips reply and body fields for an API key without inbox:read", async () => {
    const w = await world({ leads: 0 });
    const W = await hook(w, ["all_events"]);
    await pending(w, W.id, {
      payload: {
        event_type: "reply_received",
        lead_email: "a@b.test",
        first_name: "Ann",
        company_name: "Acme",
        plan: "pro",
        step: 1,
        reply_text: "secret",
        reply_html: "<p>secret</p>",
        reply_subject: "Re",
        reply_text_snippet: "secret",
        email_text: "body",
        email_html: "<p>body</p>",
      },
    });
    const shown = async (c?: { scopes?: string[] }) =>
      (await listDeliveries(P(), w.ws, W.id, {}, c)).deliveries[0]!.payload;
    expect(await shown({ scopes: ["webhooks:read", "leads:read"] })).toEqual({
      event_type: "reply_received",
      lead_email: "a@b.test",
      first_name: "Ann",
      company_name: "Acme",
      plan: "pro",
      step: 1,
    });
    // round C: without leads:read the lead's address, standard fields and custom fields go too
    expect(await shown({ scopes: ["webhooks:read"] })).toEqual({
      event_type: "reply_received",
      step: 1,
    });
    expect(await shown({ scopes: ["webhooks:read", "inbox:read"] })).toEqual({
      event_type: "reply_received",
      step: 1,
      reply_text: "secret",
      reply_html: "<p>secret</p>",
      reply_subject: "Re",
      reply_text_snippet: "secret",
      email_text: "body",
      email_html: "<p>body</p>",
    });
    expect(await shown()).toMatchObject({ reply_text: "secret" }); // a session user
  });

  test("M4: a payload still over 256 KB after the drops is refused, not stored", async () => {
    const w = await world();
    const W = await hook(w, ["email_sent"]);
    await P().lead.update({
      where: { id: w.lead.id },
      data: { customFields: { notes: "n".repeat(300 * 1024) } },
    });
    const err_ = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = await accepted(w);
    expect(await P().$transaction((tx) => buildPayload(tx, e, "https://a.test"))).toBeNull();
    await drain();
    expect(await rows(W.id)).toEqual([]);
    expect(err_).toHaveBeenCalledWith("webhook_payload_too_large", { eventId: e.id });
    err_.mockRestore();
  });
});
