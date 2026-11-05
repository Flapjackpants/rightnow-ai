import type { Event, EventType } from "@rightnow/db/client";

const BY_TYPE: Partial<Record<EventType, string>> = {
  ACCEPTED: "email_sent",
  OPEN: "email_opened",
  CLICK: "email_link_clicked",
  REPLY: "reply_received",
  AUTO_REPLY: "auto_reply_received",
  BOUNCE_HARD: "email_bounced",
  BOUNCE_SOFT: "email_bounced",
  UNSUBSCRIBE: "lead_unsubscribed",
  ACCOUNT_ERROR: "account_error",
  CAMPAIGN_COMPLETED: "campaign_completed",
  ESCALATION_OVERDUE: "escalation_overdue",
  DEAL_WON: "deal_won",
  DEAL_LOST: "deal_lost",
  QUOTA_REACHED: "quota_reached",
};
const BY_INTEREST: Record<string, string> = {
  null: "lead_neutral",
  0: "lead_out_of_office",
  1: "lead_interested",
  2: "lead_meeting_booked",
  3: "lead_meeting_completed",
  4: "lead_closed",
  "-1": "lead_not_interested",
  "-2": "lead_wrong_person",
  "-3": "lead_lost",
  "-4": "lead_no_show",
};

/** The standard event names a webhook subscribes to (Fixed names `WEBHOOK_EVENTS`); label names come on top. */
export const WEBHOOK_EVENTS = [
  ...new Set([...Object.values(BY_TYPE), ...Object.values(BY_INTEREST)]),
] as string[];
/** Reply events expose message bodies: an API key also needs `inbox:read` for them (I3). */
export const REPLY_EVENTS = ["reply_received", "auto_reply_received", "all_events"];

/** The only events whose payload names no lead; any other (labels and `all_events` included) needs `leads:read` (M4). */
export const LEADLESS_EVENTS = ["account_error", "campaign_completed", "quota_reached"];

/** D44 name of an Event; null = not deliverable (machine open, scanner click, unmapped type). */
export function webhookEventName(
  e: Pick<Event, "type" | "meta">,
  labelName?: string,
): string | null {
  const m = (e.meta ?? {}) as Record<string, unknown>;
  if (m.machine || m.scanner) return null;
  if (e.type === "LABEL_ADDED") return labelName ?? (typeof m.label === "string" ? m.label : null);
  if (e.type === "INTEREST_CHANGED") return BY_INTEREST[String(m.to ?? null)] ?? null;
  return BY_TYPE[e.type] ?? null;
}
