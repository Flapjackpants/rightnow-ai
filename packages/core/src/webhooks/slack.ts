export const SLACK_URL_MASK = "https://hooks.slack.com/services/***";
export function isSlackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      u.hostname === "hooks.slack.com" &&
      u.pathname.startsWith("/services/") &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function slackText(p: Record<string, unknown>): string {
  const val = (k: string) => (typeof p[k] === "string" ? esc(p[k] as string) : "");
  const who = val("lead_email") + (val("company_name") ? ` (${val("company_name")})` : "");
  const account = val("email_account");
  let line: string;
  switch (p.event_type) {
    case "lead_interested":
      line = `:fire: Interested reply from ${who}`;
      break;
    case "lead_meeting_booked":
      line = `:calendar: Meeting requested by ${who}`;
      break;
    case "reply_received":
      line = `:speech_balloon: Reply from ${who}`;
      break;
    case "account_error":
      line = `:warning: Mailbox problem: ${account}${val("reason") ? ` (${val("reason")})` : ""}`;
      break;
    case "quota_reached":
      line = `:hourglass_flowing_sand: Daily quota reached: ${account}${val("campaign_name") ? ` on ${val("campaign_name")}` : ""}`;
      break;
    default:
      line = `${val("event_type")}: ${who || account || "workspace"}`;
  }
  if (typeof p.unibox_url === "string" && p.unibox_url.startsWith("http"))
    line += ` <${p.unibox_url}|Open in inbox>`;
  if (typeof p.reply_text_snippet === "string")
    line += `\n> ${esc(p.reply_text_snippet.slice(0, 200))}`;
  return line;
}
