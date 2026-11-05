export type Att = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  truncated: boolean;
};
export type Msg = {
  id: string;
  direction: "IN" | "OUT";
  kind: string;
  fromEmail: string;
  fromName: string | null;
  to: string[];
  cc: string[];
  text: string | null;
  html: string | null;
  sentAt: string;
  oooUntil: string | null;
  category: string | null;
  aiFeedback: number | null;
  attachments: Att[];
};
export type ThreadRow = {
  id: string;
  subject: string;
  isRead: boolean;
  category: string | null;
  reminderAt: string | null;
  hasAttachment: boolean;
  lastMessageAt: string;
  messages: (Pick<Msg, "id" | "direction" | "kind" | "fromEmail" | "fromName" | "sentAt"> & {
    snippet: string | null;
  })[]; // the list returns the latest message only, without its body
};
export type Note = { id: string; body: string; createdAt: string };
export type Detail = Omit<ThreadRow, "messages"> & {
  messages: Msg[];
  categorySource: string | null;
  campaignLeadId: string | null;
  campaignId: string | null;
  leadId: string | null;
  notes: Note[];
  leadNotes: Note[];
  lead: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    jobTitle: string | null;
    interestStatus: number | null;
    labels: string[];
    deletedAt: string | null;
  } | null;
  scheduled: { id: string; dueAt: string; renderedSubject: string }[];
  domainLeads: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  }[];
  origin: {
    step: { order: number };
    variant: { label: string } | null;
    campaign: { id: string; name: string };
  } | null;
};
export type Filter = {
  view: string;
  accountId?: string;
  campaignId?: string;
  interestStatus?: number;
  q?: string;
  hasAttachment?: boolean;
};
export const CATEGORIES: Record<string, string> = {
  INTERESTED: "Interested",
  MEETING_REQUESTED: "Meeting requested",
  NOT_INTERESTED: "Not interested",
  WRONG_PERSON: "Wrong person",
  NEUTRAL: "Neutral",
  OUT_OF_OFFICE: "Out of office",
  UNSUBSCRIBE: "Unsubscribe",
  AUTOMATED: "Automated",
  UNCERTAIN: "Uncertain",
};
export const who = (m: Pick<Msg, "fromName" | "fromEmail">) => m.fromName || m.fromEmail;
