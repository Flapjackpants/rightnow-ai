import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, Webhook, WebhookDelivery } from "@rightnow/db/client";
import { assertPublicHost, type OutEnv } from "@rightnow/providers";
import { z } from "zod";
import { AccountError, notFound } from "../accounts/service";
import { scopeAllows } from "../apikeys";
import { audit } from "../audit";
import type { Clock } from "../clock";
import { decrypt, encrypt } from "../crypto";
import { isLeadKey } from "./payload";
import { postWebhook } from "./deliver";
import { LEADLESS_EVENTS, REPLY_EVENTS, WEBHOOK_EVENTS } from "./events";
import { isSlackUrl, SLACK_URL_MASK } from "./slack";

type Db = PrismaClient | Prisma.TransactionClient;
type Actor = string | null | undefined;
/** `scopes` is set when an API key calls (I3). */
type Caller = { scopes?: string[] };
export type ApiWebhook = Omit<Webhook, "secretEnc" | "headersEnc" | "urlEnc"> & {
  hasSecret: true;
  headerNames: string[];
};
type ApiDelivery = WebhookDelivery;

const bad = (m: string) => new AccountError(400, m);
const RESERVED = /^(host|content-length|content-type|transfer-encoding|connection|x-rightnow-.*)$/i;
const headers = z
  .record(z.string(), z.string())
  .refine((h) => Object.keys(h).length <= 10, "invalid_header")
  .refine(
    (h) =>
      Object.entries(h).every(
        ([k, v]) =>
          /^[A-Za-z0-9-]{1,64}$/.test(k) &&
          !RESERVED.test(k) &&
          v.length <= 1024 &&
          !/[\r\n]/.test(v),
      ),
    "invalid_header",
  );
export const webhookInput = z.strictObject({
  name: z.string().trim().max(100).nullish(),
  url: z.string().max(2048),
  events: z.array(z.string().min(1).max(100)).min(1).max(50),
  campaignId: z.string().min(1).max(100).nullish(),
  headers: headers.nullish(),
  format: z.enum(["json", "slack"]).optional(),
});
type Input = z.output<typeof webhookInput>;

function parse<S extends z.ZodType>(s: S, input: unknown): z.output<S> {
  const r = s.safeParse(input);
  if (!r.success) throw bad(r.error.issues[0]!.message);
  return r.data;
}

const BODY = /^(reply_.*|email_text|email_html)$/;
const newSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;
const toApi = (w: Webhook, headerNames: string[]): ApiWebhook => {
  const out: Partial<Webhook> = { ...w };
  delete out.secretEnc;
  delete out.headersEnc;
  delete out.urlEnc;
  return {
    ...(out as Omit<Webhook, "secretEnc" | "headersEnc" | "urlEnc">),
    hasSecret: true,
    headerNames,
  };
};
/** Header names only: the values may carry credentials and are never returned. */
const names = (h: Webhook) =>
  h.headersEnc ? Object.keys(JSON.parse(decrypt(h.headersEnc)) as object) : [];

/** http(s), no userinfo, and a host that is public now (checked again on every delivery: DNS rebinding). */
async function checkUrl(url: string, env: OutEnv) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw bad("invalid_url");
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password)
    throw bad("invalid_url");
  try {
    await assertPublicHost(u.hostname, {
      mode: "vps",
      allowPrivate: env.allowPrivate,
      resolve: env.resolve,
    });
  } catch {
    throw bad("webhook_host_not_public");
  }
}

/** Event names, the campaign and (for an API key) `inbox:read` for reply bodies (I3), `leads:read` for lead events (M4). */
async function checkRefs(db: Db, ws: string, d: Pick<Input, "events" | "campaignId">, c: Caller) {
  if (
    c.scopes &&
    d.events.some((e) => REPLY_EVENTS.includes(e)) &&
    !scopeAllows(c.scopes, "inbox:read")
  )
    throw new AccountError(403, "scope_required:inbox:read");
  // M4: every other event names a lead (lead_email and its fields in the payload)
  if (
    c.scopes &&
    d.events.some((e) => !LEADLESS_EVENTS.includes(e)) &&
    !scopeAllows(c.scopes, "leads:read")
  )
    throw new AccountError(403, "scope_required:leads:read");
  const custom = d.events.filter((e) => e !== "all_events" && !WEBHOOK_EVENTS.includes(e));
  if (
    custom.length &&
    (await db.leadLabel.count({ where: { workspaceId: ws, name: { in: custom } } })) !==
      new Set(custom).size
  )
    throw bad("unknown_event");
  if (
    d.campaignId &&
    !(await db.campaign.count({ where: { id: d.campaignId, workspaceId: ws, deletedAt: null } }))
  )
    throw bad("invalid_reference");
}

export async function listWebhooks(db: Db, ws: string): Promise<ApiWebhook[]> {
  const rows = await db.webhook.findMany({
    where: { workspaceId: ws },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((w) => toApi(w, names(w)));
}

export async function getWebhook(db: Db, ws: string, id: string): Promise<ApiWebhook> {
  const w = await db.webhook.findFirst({ where: { id, workspaceId: ws } });
  if (!w) throw notFound();
  return toApi(w, names(w));
}

/** D44: the secret is returned only here and by rotateSecret. The host check (DNS) runs before the transaction. */
export async function createWebhook(
  prisma: PrismaClient,
  ws: string,
  actor: Actor,
  input: unknown,
  env: OutEnv,
  c: Caller = {},
): Promise<ApiWebhook & { secret: string }> {
  const d = parse(webhookInput, input);
  if (d.format === "slack") {
    if (!isSlackUrl(d.url)) throw bad("invalid_slack_url");
    if (d.headers && Object.keys(d.headers).length) throw bad("headers_not_allowed");
  }
  await checkRefs(prisma, ws, d, c);
  await checkUrl(d.url, env);
  const secret = newSecret();
  const w = await prisma.$transaction(async (tx) => {
    const w = await tx.webhook.create({
      data: {
        workspaceId: ws,
        name: d.name ?? null,
        url: d.format === "slack" ? SLACK_URL_MASK : d.url,
        urlEnc: d.format === "slack" ? encrypt(d.url) : null,
        format: d.format ?? "json",
        events: d.events,
        campaignId: d.campaignId ?? null,
        secretEnc: encrypt(secret),
        headersEnc:
          d.headers && Object.keys(d.headers).length ? encrypt(JSON.stringify(d.headers)) : null,
      },
    });
    await audit(tx, { workspaceId: ws, actorId: actor }, "webhook.create", w.id, {
      events: d.events,
    });
    return w;
  });
  return { ...toApi(w, Object.keys(d.headers ?? {})), secret };
}

/** A partial patch; `headers` replaces the set (null clears it). Status is changed only by resume and auto-disable. */
export async function updateWebhook(
  prisma: PrismaClient,
  ws: string,
  actor: Actor,
  id: string,
  input: unknown,
  env: OutEnv,
  c: Caller = {},
): Promise<ApiWebhook> {
  const p = parse(webhookInput.partial(), input);
  const cur = await prisma.webhook.findFirst({ where: { id, workspaceId: ws } });
  if (!cur) throw notFound();
  if (p.format !== undefined && p.format !== cur.format) throw bad("format_fixed");
  if (cur.format === "slack") {
    if (p.headers && Object.keys(p.headers).length) throw bad("headers_not_allowed");
    if (p.url !== undefined && p.url !== SLACK_URL_MASK && !isSlackUrl(p.url))
      throw bad("invalid_slack_url");
  }
  await checkRefs(
    prisma,
    ws,
    {
      events: p.events ?? cur.events,
      campaignId: p.campaignId === undefined ? cur.campaignId : p.campaignId,
    },
    c,
  );
  // I3: stored headers may carry the old receiver's credentials; a new origin gets new ones (or `headers: null`)
  if (
    cur.format !== "slack" &&
    p.url !== undefined &&
    p.headers === undefined &&
    cur.headersEnc &&
    new URL(p.url).origin !== new URL(cur.url).origin
  )
    throw bad("headers_required");
  if (p.url !== undefined && !(cur.format === "slack" && p.url === SLACK_URL_MASK))
    await checkUrl(p.url, env);
  return prisma.$transaction(async (tx) => {
    const r = await tx.webhook.updateMany({
      where: { id, workspaceId: ws },
      data: {
        ...(p.name !== undefined && { name: p.name }),
        ...(p.url !== undefined && cur.format !== "slack" && { url: p.url }),
        ...(p.url !== undefined &&
          cur.format === "slack" &&
          p.url !== SLACK_URL_MASK && { urlEnc: encrypt(p.url) }),
        ...(p.events !== undefined && { events: p.events }),
        ...(p.campaignId !== undefined && { campaignId: p.campaignId }),
        ...(p.headers !== undefined && {
          headersEnc:
            p.headers && Object.keys(p.headers).length ? encrypt(JSON.stringify(p.headers)) : null,
        }),
      },
    });
    if (!r.count) throw notFound();
    await audit(tx, { workspaceId: ws, actorId: actor }, "webhook.update", id, {
      fields: Object.keys(p),
    });
    return getWebhook(tx, ws, id);
  });
}

export async function deleteWebhook(prisma: PrismaClient, ws: string, actor: Actor, id: string) {
  await prisma.$transaction(async (tx) => {
    if (!(await tx.webhook.deleteMany({ where: { id, workspaceId: ws } })).count) throw notFound();
    await audit(tx, { workspaceId: ws, actorId: actor }, "webhook.delete", id);
  });
}

/** ERROR → ACTIVE with the counter at 0; the deliveries failed at the disable stay FAILED (redeliver them). */
export async function resumeWebhook(
  prisma: PrismaClient,
  ws: string,
  actor: Actor,
  id: string,
): Promise<ApiWebhook> {
  return prisma.$transaction(async (tx) => {
    const r = await tx.webhook.updateMany({
      where: { id, workspaceId: ws },
      data: { status: "ACTIVE", consecutiveFailures: 0, disabledAt: null, lastError: null },
    });
    if (!r.count) throw notFound();
    await audit(tx, { workspaceId: ws, actorId: actor }, "webhook.resume", id);
    return getWebhook(tx, ws, id);
  });
}

/** Immediate switch, no overlap: the next attempt is signed with the new secret (M5). */
export async function rotateSecret(
  prisma: PrismaClient,
  ws: string,
  actor: Actor,
  id: string,
): Promise<{ secret: string }> {
  const secret = newSecret();
  await prisma.$transaction(async (tx) => {
    const r = await tx.webhook.updateMany({
      where: { id, workspaceId: ws },
      data: { secretEnc: encrypt(secret) },
    });
    if (!r.count) throw notFound();
    await audit(tx, { workspaceId: ws, actorId: actor }, "webhook.rotate_secret", id);
  });
  return { secret };
}

/** A synchronous signed `{event_type: "test"}` POST, outside any transaction; nothing is stored. */
export async function testWebhook(
  prisma: PrismaClient,
  clock: Clock,
  ws: string,
  id: string,
  env: OutEnv,
): Promise<{ status: number | null; latencyMs: number; error: string | null }> {
  const w = await prisma.webhook.findFirst({ where: { id, workspaceId: ws } });
  if (!w) throw notFound();
  const now = clock.now();
  const eventId = `test_${randomUUID()}`;
  const body = JSON.stringify({
    event_id: eventId,
    timestamp: now.toISOString(),
    event_type: "test",
    workspace: ws,
  });
  const { status, latencyMs, error } = await postWebhook(w, eventId, body, now, env);
  return { status, latencyMs, error };
}

const listQuery = z.object({
  cursor: z.string().min(1).nullish(),
  take: z.coerce.number().int().min(1).max(200).optional(),
  status: z.enum(["PENDING", "SENDING", "DELIVERED", "FAILED"]).optional(),
});

/** Newest first, paged by cursor. */
export async function listDeliveries(
  db: Db,
  ws: string,
  webhookId: string,
  q: unknown,
  c: Caller = {},
): Promise<{ deliveries: ApiDelivery[]; nextCursor: string | null }> {
  const p = parse(listQuery, q);
  if (!(await db.webhook.count({ where: { id: webhookId, workspaceId: ws } }))) throw notFound();
  const take = p.take ?? 50;
  const deliveries = await db.webhookDelivery.findMany({
    where: { workspaceId: ws, webhookId, ...(p.status && { status: p.status }) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(p.cursor && { cursor: { id: p.cursor } }),
  });
  const next = deliveries.length > take ? deliveries.pop()! : null;
  // fix I3: message bodies are inbox data; round C: the lead's fields are lead data
  const noBody = c.scopes && !scopeAllows(c.scopes, "inbox:read");
  const noLead = c.scopes && !scopeAllows(c.scopes, "leads:read");
  if (noBody || noLead)
    for (const d of deliveries)
      d.payload = Object.fromEntries(
        Object.entries(d.payload as Prisma.JsonObject).filter(
          ([k]) => !(noBody && BODY.test(k)) && !(noLead && isLeadKey(k)),
        ),
      );
  return { deliveries, nextCursor: next?.id ?? null };
}

/** A finished (DELIVERED / FAILED) delivery goes back to PENDING with attempts 0, due at once. */
export async function redeliver(
  prisma: PrismaClient,
  ws: string,
  actor: Actor,
  deliveryId: string,
) {
  await prisma.$transaction(async (tx) => {
    const n = await tx.$executeRaw`
      UPDATE "WebhookDelivery" SET status = 'PENDING', attempts = 0, "nextAttemptAt" = "createdAt", "leaseUntil" = NULL
      WHERE id = ${deliveryId} AND "workspaceId" = ${ws} AND status IN ('DELIVERED', 'FAILED')`;
    if (!n) throw notFound();
    await audit(tx, { workspaceId: ws, actorId: actor }, "webhook.redeliver", deliveryId);
  });
}

/** PS-ANALYTICS-19: per local day (workspace timezone) of the last attempt, delivered vs failed. */
export async function webhookOverview(
  db: Db,
  ws: string,
  q: { from: string; to: string },
): Promise<{ day: string; delivered: number; failed: number }[]> {
  const day = z.iso.date();
  const from = parse(day, q.from);
  const to = parse(day, q.to);
  return db.$queryRaw`
    SELECT to_char(d."lastAttemptAt" AT TIME ZONE 'UTC' AT TIME ZONE w.timezone, 'YYYY-MM-DD') AS day,
      count(*) FILTER (WHERE d.status = 'DELIVERED')::int AS delivered,
      count(*) FILTER (WHERE d.status <> 'DELIVERED')::int AS failed
    FROM "WebhookDelivery" d JOIN "Workspace" w ON w.id = d."workspaceId"
    WHERE d."workspaceId" = ${ws} AND d."lastAttemptAt" IS NOT NULL AND d.status <> 'SENDING'
      AND (d."lastAttemptAt" AT TIME ZONE 'UTC' AT TIME ZONE w.timezone)::date BETWEEN ${from}::date AND ${to}::date
    GROUP BY 1 ORDER BY 1`;
}
