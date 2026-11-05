import type { Event, Prisma } from "@rightnow/db/client";
import { webhookEventName } from "./events";

type Tx = Prisma.TransactionClient;
const MAX_BYTES = 256 * 1024;
const LEAD_FIELDS = [
  ["firstName", "first_name"],
  ["lastName", "last_name"],
  ["companyName", "company_name"],
  ["companyDomain", "company_domain"],
  ["jobTitle", "job_title"],
  ["website", "website"],
  ["industry", "industry"],
  ["phone", "phone"],
  ["personalization", "personalization"],
  ["country", "country"],
  ["region", "region"],
] as const;
/** Every key the payload sets itself, present or not: a lead custom field with one of these names is dropped, never passed off as standard. */
const STANDARD_FIELDS: ReadonlySet<string> = new Set([
  "event_id",
  "timestamp",
  "event_type",
  "workspace",
  "campaign_id",
  "campaign_name",
  "lead_email",
  ...LEAD_FIELDS.map(([, out]) => out),
  "email_account",
  "unibox_url",
  "step",
  "variant",
  "is_first",
  "email_id",
  "email_subject",
  "email_text",
  "email_html",
  "reply_subject",
  "reply_text",
  "reply_html",
  "reply_text_snippet",
]);
/** Round C: the lead's part of a payload (its address, standard fields and custom fields, i.e. any non-standard key). */
export const isLeadKey = (k: string) =>
  k === "lead_email" || LEAD_FIELDS.some(([, out]) => out === k) || !STANDARD_FIELDS.has(k);
// M6: a rendered unsubscribe link is a working token; a third party never gets it
const unsub = (s: string) => s.replace(/[^\s"'<>()]*\/u\/[A-Za-z0-9._~%-]+/g, "[unsubscribe link]");

/**
 * D44 payload (PS-AUTO-07), built at enqueue time so the log and a redelivery are identical. Null = not deliverable.
 * Over 256 KB the html fields are dropped first, then the text fields.
 */
export async function buildPayload(
  tx: Tx,
  e: Event,
  appUrl: string,
): Promise<Record<string, unknown> | null> {
  const event_type = webhookEventName(e);
  if (!event_type) return null;
  const ws = e.workspaceId;
  const [campaign, lead, account, sm, msg, step] = await Promise.all([
    e.campaignId
      ? tx.campaign.findFirst({
          where: { id: e.campaignId, workspaceId: ws },
          select: { name: true },
        })
      : null,
    e.leadId ? tx.lead.findFirst({ where: { id: e.leadId, workspaceId: ws } }) : null,
    e.accountId
      ? tx.emailAccount.findFirst({
          where: { id: e.accountId, workspaceId: ws },
          select: { email: true },
        })
      : null,
    e.scheduledMessageId
      ? tx.scheduledMessage.findFirst({ where: { id: e.scheduledMessageId, workspaceId: ws } })
      : null,
    e.messageId ? tx.message.findFirst({ where: { id: e.messageId, workspaceId: ws } }) : null,
    e.stepId
      ? tx.sequenceStep.findFirst({
          where: { id: e.stepId, campaign: { workspaceId: ws } },
          select: {
            order: true,
            subsequenceId: true,
            variants: { select: { id: true, label: true } },
          },
        })
      : null,
  ]);
  const custom = lead?.customFields;
  // custom fields never use a standard field's name (fix I2); first, so key order stays stable
  const p: Record<string, unknown> = {
    ...(custom && typeof custom === "object" && !Array.isArray(custom)
      ? Object.fromEntries(Object.entries(custom).filter(([k]) => !STANDARD_FIELDS.has(k)))
      : {}),
    event_id: e.id,
    timestamp: e.occurredAt.toISOString(),
    event_type,
    workspace: ws,
    campaign_id: e.campaignId,
    campaign_name: campaign?.name ?? null,
  };
  if (lead) {
    p.lead_email = lead.email;
    for (const [k, out] of LEAD_FIELDS) p[out] = lead[k];
  }
  if (account) p.email_account = account.email;
  if (msg) p.unibox_url = `${appUrl.replace(/\/+$/, "")}/inbox?thread=${msg.threadId}`;
  if (step) {
    const labels = step.variants.map((v) => v.label).sort();
    const v = step.variants.find((x) => x.id === e.variantId);
    Object.assign(p, {
      step: step.order,
      variant: v ? labels.indexOf(v.label) + 1 : null,
      is_first: step.order === 1 && !step.subsequenceId,
    });
  }
  if (sm)
    Object.assign(p, {
      email_id: sm.id,
      email_subject: sm.renderedSubject,
      email_text: unsub(sm.renderedText),
      email_html: unsub(sm.renderedBody),
    });
  if (msg && msg.direction === "IN" && (e.type === "REPLY" || e.type === "AUTO_REPLY"))
    Object.assign(p, {
      reply_subject: msg.subject,
      reply_text: msg.text,
      reply_html: msg.html,
      reply_text_snippet: (msg.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    });
  for (const drop of [
    ["email_html", "reply_html"],
    ["email_text", "reply_text"],
  ])
    if (Buffer.byteLength(JSON.stringify(p)) > MAX_BYTES) for (const k of drop) delete p[k];
  // fix M4: still too large (huge custom fields): refused, so no delivery row is written
  if (Buffer.byteLength(JSON.stringify(p)) > MAX_BYTES) {
    console.error("webhook_payload_too_large", { eventId: e.id });
    return null;
  }
  return p;
}
