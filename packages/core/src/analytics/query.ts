import { Prisma } from "@rightnow/db/client";
import { z } from "zod";
import { AccountError } from "../accounts/service";
import { TARGETED_SQL } from "../deliverability/health";

const DAY = 86_400_000;
const sql = Prisma.sql;

const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const t = Date.parse(`${s}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().startsWith(s); // 2026-02-30 rolls over: refused
  }, "Invalid date");
const ids = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().max(64)).min(1).max(100));
const text = z.string().min(1).max(200);

/** D42 query (PS-ANALYTICS-01). The range, at most 400 local days, and the zone are checked by the statements. */
export const analyticsQuery = z.strictObject({
  from: ymd,
  to: ymd,
  // IANA-shaped; Postgres decides whether the zone exists (22023 → 400)
  tz: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/)
    .default("UTC"),
  campaignIds: ids.optional(),
  accountIds: ids.optional(),
  campaignTag: text.optional(),
  ownerId: text.optional(),
  status: z.enum(["active", "completed"]).optional(),
  esp: z
    .enum(["GOOGLE", "MICROSOFT", "ZOHO", "YAHOO", "YANDEX", "OTHER", "NOT_FOUND", "IN_QUEUE"])
    .optional(),
  listId: text.optional(),
  tag: text.optional(),
  customKey: text.optional(),
  customValue: text.optional(),
  includeAutoReplies: z.stringbool().default(false),
  replyBase: z.enum(["contacted", "sent"]).default("contacted"),
  groupBy: z.enum(["none", "campaign", "account", "step", "variant", "day", "esp"]).default("none"),
});
export type AnalyticsQuery = z.infer<typeof analyticsQuery>;

/** Inclusive local days of the range (D42: 1..400, else 400). */
export function rangeDays(q: Pick<AnalyticsQuery, "from" | "to">): number {
  const n = (Date.parse(q.to) - Date.parse(q.from)) / DAY + 1;
  if (!(n >= 1 && n <= 400)) throw new AccountError(400, "invalid_range");
  return n;
}

/** The range's local days, `YYYY-MM-DD`, for zero-filled day rows. */
export const rangeKeys = (q: Pick<AnalyticsQuery, "from" | "to">) =>
  Array.from({ length: rangeDays(q) }, (_, i) =>
    new Date(Date.parse(q.from) + i * DAY).toISOString().slice(0, 10),
  );

/** Runs the statements; Postgres 22023 (an unknown time zone) is a bad request, not a 500 (Rev 2 M6). */
export async function checked<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    const x = e as { code?: string; meta?: { code?: string }; message?: string } | null;
    if (/22023/.test(`${x?.code} ${x?.meta?.code} ${x?.message}`))
      throw new AccountError(400, "invalid_tz");
    throw e;
  }
}

/** `col` (UTC `timestamp`) within the local days from..to of `tz`, bounds computed in SQL (Rev 2 M6). */
export const inRange = (col: Prisma.Sql, q: AnalyticsQuery) =>
  sql`${col} >= ((${q.from}::date::timestamp AT TIME ZONE ${q.tz}) AT TIME ZONE 'UTC')
    AND ${col} < (((${q.to}::date + 1)::timestamp AT TIME ZONE ${q.tz}) AT TIME ZONE 'UTC')`;

/** The local day of `col` in `tz`, as `YYYY-MM-DD`. */
export const localDay = (col: Prisma.Sql, q: AnalyticsQuery) =>
  sql`to_char((${col} AT TIME ZONE 'UTC') AT TIME ZONE ${q.tz}, 'YYYY-MM-DD')`;

/**
 * The campaign, account and segment filters over the aliases `c` (Campaign) and `l` (Lead). List, tag and custom
 * values filter and never group: a lead can be in many lists. Campaign filters drop rows without a campaign.
 */
export function filters(
  q: AnalyticsQuery,
  f: { campaign: Prisma.Sql; account: Prisma.Sql; lead: Prisma.Sql },
): Prisma.Sql {
  const w: Prisma.Sql[] = [];
  if (q.campaignIds) w.push(sql`${f.campaign} = ANY(${q.campaignIds}::text[])`);
  if (q.accountIds) w.push(sql`${f.account} = ANY(${q.accountIds}::text[])`);
  if (q.status === "active") w.push(sql`c.status NOT IN ('DRAFT', 'COMPLETED', 'ARCHIVED')`);
  if (q.status === "completed") w.push(sql`c.status IN ('COMPLETED', 'ARCHIVED')`);
  if (q.campaignTag) w.push(sql`${q.campaignTag} = ANY(c.tags)`);
  if (q.ownerId) w.push(sql`c."ownerId" = ${q.ownerId}`);
  if (q.esp) w.push(sql`l."espType" = ${q.esp}::"EspType"`);
  if (q.listId)
    w.push(
      sql`EXISTS (SELECT 1 FROM "LeadListMember" m WHERE m."listId" = ${q.listId} AND m."leadId" = ${f.lead})`,
    );
  if (q.tag) w.push(sql`${q.tag} = ANY(l.tags)`);
  if (q.customKey)
    w.push(
      q.customValue === undefined
        ? sql`l."customFields" ->> ${q.customKey} IS NOT NULL`
        : sql`l."customFields" ->> ${q.customKey} = ${q.customValue}`,
    );
  return w.length ? Prisma.join(w, " AND ") : sql`TRUE`;
}

/** Event e with its send (sm), lead (l) and campaign (c), each joined within the workspace. */
export const EVENT_FROM = sql`"Event" e
  LEFT JOIN "ScheduledMessage" sm ON sm.id = e."scheduledMessageId" AND sm."workspaceId" = e."workspaceId"
  LEFT JOIN "Lead" l ON l.id = e."leadId" AND l."workspaceId" = e."workspaceId"
  LEFT JOIN "Campaign" c ON c.id = e."campaignId" AND c."workspaceId" = e."workspaceId"`;

/** D42 / M5: an event belongs to the mailbox that sent the message it is about. */
export const SENDER = sql`COALESCE(sm."accountId", e."accountId")`;

/**
 * WHERE over EVENT_FROM: the workspace, campaign events only (Rev 2 M8), D34's TARGETED_SQL (a DSN or ARF that
 * matched no send never counts) and the range. The D43 automation Events never count. Warm-up and placement mail never become Events (D36, D37).
 */
export function eventScope(ws: string, q: AnalyticsQuery): Prisma.Sql {
  return sql`e."workspaceId" = ${ws} AND e."campaignId" IS NOT NULL AND ${TARGETED_SQL}
    AND e.type NOT IN ('ACCOUNT_ERROR', 'QUOTA_REACHED', 'CAMPAIGN_COMPLETED', 'ESCALATION_OVERDUE', 'LABEL_ADDED')
    AND ${inRange(sql`e."occurredAt"`, q)}
    AND ${filters(q, { campaign: sql`e."campaignId"`, account: SENDER, lead: sql`e."leadId"` })}`;
}
