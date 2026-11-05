export const INTEREST: Record<string, string> = {
  "1": "Interested",
  "2": "Meeting booked",
  "3": "Meeting completed",
  "4": "Won",
  "0": "Out of office",
  "-1": "Not interested",
  "-2": "Wrong person",
  "-3": "Lost",
  "-4": "No show",
};
export const VERIFICATION: Record<string, string> = {
  NOT_VERIFIED: "Not verified",
  VERIFIED: "Verified",
  PENDING: "Pending",
  PENDING_JOB: "Pending",
  INVALID: "Invalid",
  RISKY: "Risky",
  CATCH_ALL: "Catch-all",
  JOB_CHANGE: "Job change",
};
export const ESP: Record<string, string> = {
  GOOGLE: "Google",
  MICROSOFT: "Microsoft",
  ZOHO: "Zoho",
  YAHOO: "Yahoo",
  YANDEX: "Yandex",
  OTHER: "Other",
  NOT_FOUND: "Not found",
  IN_QUEUE: "Detecting",
};
export const REASON: Record<string, string> = {
  UNSUBSCRIBE: "Unsubscribed",
  HARD_BOUNCE: "Hard bounce",
  COMPLAINT: "Complaint",
  MANUAL: "Manual",
  NOT_INTERESTED: "Not interested",
  GDPR_ERASURE: "Erased (GDPR)",
  CUSTOMER: "Customer",
};
/** B3.3 section tabs shared by the Leads, Lead lists and Blocklist pages. */
export const LEAD_TABS = [
  { href: "/leads", label: "Leads" },
  { href: "/leads/lists", label: "Lead lists" },
  { href: "/blocklist", label: "Blocklist" },
];
