import type { Member, Named } from "../leads/bulk-bar";

export const TRIGGERS: Record<string, string> = {
  reply_received: "Reply received",
  positive_reply: "Positive reply",
  negative_reply: "Negative reply",
  status_changed: "Lead status changed",
  label_added: "Label added",
  unsubscribed: "Unsubscribed",
  bounced: "Bounced",
  campaign_completed: "Campaign completed",
  escalation_overdue: "Escalation unanswered",
  account_error: "Mailbox error",
  send_failure_threshold: "Send failure threshold",
  quota_reached: "Daily limit reached",
  deal_won: "Deal won",
  deal_lost: "Deal lost",
};

export type Source = "campaigns" | "lists" | "subsequences" | "members" | "webhooks";
export type Field = {
  key: string;
  label: string;
  kind: "text" | "number" | "select" | "check" | "members" | "territories";
  source?: Source;
  required?: boolean;
};
export const ACTION_TYPES: Record<string, { label: string; fields: Field[] }> = {
  forward_to_owner: { label: "Forward the thread to the owner", fields: [] },
  create_task: {
    label: "Create task",
    fields: [
      { key: "title", label: "Title", kind: "text", required: true },
      { key: "dueInDays", label: "Due in days", kind: "number" },
      { key: "escalateAfterHours", label: "Alert again after hours", kind: "number" },
      { key: "assigneeId", label: "Assignee", kind: "select", source: "members" },
    ],
  },
  create_opportunity: { label: "Create opportunity", fields: [] },
  stop_sequence: {
    label: "Stop sequence",
    fields: [
      { key: "campaignId", label: "Only this campaign", kind: "select", source: "campaigns" },
    ],
  },
  suppress_contact: { label: "Suppress contact", fields: [] },
  suppress_company_domain: { label: "Block the company's domain", fields: [] },
  pause_account: {
    label: "Pause mailbox",
    fields: [{ key: "until", label: "Until next day", kind: "check" }],
  },
  add_to_list: {
    label: "Add to list",
    fields: [{ key: "listId", label: "List", kind: "select", source: "lists", required: true }],
  },
  enroll_campaign: {
    label: "Enroll in campaign",
    fields: [
      { key: "campaignId", label: "Campaign", kind: "select", source: "campaigns", required: true },
    ],
  },
  move_to_subsequence: {
    label: "Move to subsequence",
    fields: [
      {
        key: "subsequenceId",
        label: "Subsequence",
        kind: "select",
        source: "subsequences",
        required: true,
      },
    ],
  },
  assign_owner: {
    label: "Assign owner",
    fields: [{ key: "userId", label: "Owner", kind: "select", source: "members", required: true }],
  },
  assign_round_robin: {
    label: "Assign owner by rotation",
    fields: [{ key: "userIds", label: "Reps", kind: "members", required: true }],
  },
  assign_territory: {
    label: "Assign owner by territory",
    fields: [
      { key: "territories", label: "Territories", kind: "territories", required: true },
      { key: "fallbackUserId", label: "Everyone else", kind: "select", source: "members" },
    ],
  },
  add_tag: {
    label: "Add tag",
    fields: [{ key: "tag", label: "Tag", kind: "text", required: true }],
  },
  send_webhook: {
    label: "Send webhook",
    fields: [
      { key: "webhookId", label: "Webhook", kind: "select", source: "webhooks", required: true },
    ],
  },
};

export type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  trigger: string;
  conditions: {
    campaignIds?: string[];
    accountIds?: string[];
    leadTags?: string[];
    interestCodes?: number[];
    labels?: string[];
  };
  actions: ({ type: string } & Record<string, unknown>)[];
};
export type Refs = {
  campaigns: Named[];
  lists: Named[];
  subsequences: Named[];
  members: Member[];
  accounts: Named[];
  webhooks: Named[];
};

/** Per-action field values are edited as strings and converted on save; an action type this table lacks (raw) passes through unchanged. */
export type Draft = { type: string; v: Record<string, string>; raw?: Rule["actions"][number] };
export const toDraft = (a: Rule["actions"][number]): Draft =>
  a.type in ACTION_TYPES ||
  (a.type === "assign_owner" && (a.strategy === "round_robin" || a.strategy === "territory"))
    ? {
        type:
          a.type === "assign_owner" && a.strategy === "round_robin"
            ? "assign_round_robin"
            : a.type === "assign_owner" && a.strategy === "territory"
              ? "assign_territory"
              : a.type,
        v: Object.fromEntries(
          Object.entries(a)
            .filter(([k]) => k !== "type" && k !== "strategy")
            .map(([k, x]) => [
              k,
              x === "next_day" ? "1" : Array.isArray(x) ? JSON.stringify(x) : String(x),
            ]),
        ),
      }
    : { type: a.type, v: {}, raw: a };
export function toAction({ type, v, raw }: Draft) {
  if (raw) return raw;
  if (type === "assign_round_robin")
    return {
      type: "assign_owner",
      strategy: "round_robin",
      userIds: JSON.parse(v.userIds || "[]") as string[],
    };
  if (type === "assign_territory") {
    const territories = (
      JSON.parse(v.territories || "[]") as {
        countries?: string[];
        regions?: string[];
        userId: string;
      }[]
    ).filter((t) => t.userId || t.countries?.length || t.regions?.length);
    return {
      type: "assign_owner",
      strategy: "territory",
      territories,
      ...(v.fallbackUserId && { fallbackUserId: v.fallbackUserId }),
    };
  }
  const out: Record<string, unknown> = { type };
  for (const f of ACTION_TYPES[type]!.fields) {
    const x = v[f.key];
    if (!x) continue;
    out[f.key] = f.kind === "number" ? Number(x) : f.kind === "check" ? "next_day" : x;
  }
  return out;
}
