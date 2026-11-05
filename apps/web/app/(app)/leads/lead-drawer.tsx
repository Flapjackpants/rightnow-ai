"use client";

import type { ApiLead } from "@rightnow/core";
import {
  Ban,
  CheckCircle2,
  Eye,
  FileUp,
  GitMerge,
  Handshake,
  ListChecks,
  MailX,
  MousePointerClick,
  Plus,
  Reply,
  Send,
  ShieldOff,
  StickyNote,
  UserPlus,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AiAssist, useAiOn } from "../../../components/ai-assist";
import { sheetClass, sheetFooter, sheetHeader } from "../../../components/overlay";
import {
  INTEREST as INTEREST_PILL,
  pillFor,
  StatusPill,
  VERIFICATION as VERIFICATION_PILL,
} from "../../../components/status-pill";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Select } from "../../../components/ui/select";
import { DrawerSection } from "../accounts/account-drawer";
import { call, errorText } from "../accounts/api-client";
import { ESP, INTEREST, VERIFICATION } from "./labels";

const FIELDS = [
  ...[
    ["firstName", "First name"],
    ["lastName", "Last name"],
    ["companyName", "Company"],
  ],
  ...[
    ["jobTitle", "Job title"],
    ["website", "Website"],
    ["industry", "Industry"],
  ],
  ...[
    ["phone", "Phone"],
    ["country", "Country"],
    ["region", "Region"],
  ],
] as const;
type TimelineItem = { at: string; kind: string; detail: Record<string, unknown> };
// B5.8 timeline: one 24px icon disc per event kind (suppression is the fallback)
const ICON: Record<string, LucideIcon> = {
  imported: FileUp,
  enrolled: UserPlus,
  sent: Send,
  status_changed: CheckCircle2,
  merged: GitMerge,
  unsubscribed: MailX,
  opened: Eye,
  clicked: MousePointerClick,
  replied: Reply,
  bounced: Ban,
  note: StickyNote,
  task: ListChecks,
  opportunity: Handshake,
};
const describe = (t: TimelineItem) => {
  const d = t.detail;
  switch (t.kind) {
    case "imported":
      return `Imported from ${d.fileName}`;
    case "enrolled":
      return `Added to campaign ${d.campaign}`;
    case "sent":
      return `Step ${d.step}${d.variant ? ` (variant ${d.variant})` : ""} sent from ${d.account}`;
    case "status_changed":
      return `Interest status set to ${INTEREST[String(d.interestStatus)] ?? "Lead"}`;
    case "merged":
      return "Merged with a duplicate";
    case "unsubscribed":
      return "Unsubscribed";
    case "opened":
      return "Opened (estimated)";
    case "clicked":
      return `Clicked ${d.url ?? "a link"}`;
    case "replied":
      return d.auto ? "Auto-replied" : "Replied";
    case "bounced":
      return `Bounced (${String(d.type).toLowerCase()})`;
    case "note":
      return `Note (${d.noteKind}): ${d.body}`;
    case "task":
      if (d.action === "task.delete") return d.title ? `Task removed: ${d.title}` : "Task removed";
      return `Task ${d.action === "task.create" ? "added" : "updated"}: ${d.title ?? "(deleted)"}`;
    case "opportunity":
      return `Deal ${String(d.action).slice("opportunity.".length)}`;
    default:
      return `Suppressed (${String(d.reason).toLowerCase()})`;
  }
};
type Custom = { key: string; value: string }[];
const toCustom = (l: ApiLead): Custom =>
  Object.entries(l.customFields as Record<string, unknown>).map(([key, v]) => ({
    key,
    value: v === null ? "" : String(v),
  }));
const toForm = (l: ApiLead): Record<string, string> => ({
  ...Object.fromEntries(FIELDS.map(([k]) => [k, (l[k] as string | null) ?? ""])),
  tags: l.tags.join(", "),
  interest: l.interestStatus === null ? "" : String(l.interestStatus),
});

/** AI helpers (D47). A follow-up is copied to the clipboard once approved; sending stays a human step in the inbox. */
function LeadAi({ lead, onChanged }: { lead: ApiLead; onChanged: () => void }) {
  const [scored, setScored] = useState<{ aiScore: number; aiScoreReason: string } | null>(
    lead.aiScore === null
      ? null
      : { aiScore: lead.aiScore, aiScoreReason: lead.aiScoreReason ?? "" },
  );
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  async function rate() {
    setErr("");
    const r = await call("/api/v1/ai/score", "POST", { leadId: lead.id });
    if (!r.ok)
      return setErr(
        r.status === 412 ? "AI is not set up. An admin can add a model in Settings." : errorText(r),
      );
    setScored(r.json as { aiScore: number; aiScoreReason: string });
    onChanged();
  }
  const on = useAiOn();
  if (!on) return null;
  return (
    <DrawerSection label="AI" title="AI">
      <div className="flex flex-wrap items-start gap-2">
        <Button variant="outline" size="sm" onClick={() => void rate()}>
          Score lead
        </Button>
        <AiAssist
          label="Suggest follow-up"
          path="followup"
          body={{ leadId: lead.id }}
          onUse={(t) => void navigator.clipboard?.writeText(t).then(() => setCopied(true))}
        />
      </div>
      {scored && (
        <p role="status" className="text-[13px]/[18px]">
          <span className="font-medium text-ai">Score {scored.aiScore}/100.</span>{" "}
          {scored.aiScoreReason}
        </p>
      )}
      {copied && (
        <p role="status" className="text-[13px]/[18px]">
          Follow-up copied. Paste it into a reply.
        </p>
      )}
      {err && (
        <p role="alert" className="text-[13px]/[18px] text-danger">
          {err}
        </p>
      )}
    </DrawerSection>
  );
}

export function LeadDrawer({
  lead,
  canEdit,
  onClose,
  onChanged,
}: {
  lead: ApiLead;
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [init, setInit] = useState(() => toForm(lead));
  const [form, setForm] = useState(init);
  const [custom, setCustom] = useState<Custom>(() => toCustom(lead));
  const [initCustom, setInitCustom] = useState(custom);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);

  useEffect(() => {
    dialog.current?.showModal();
    void call(`/api/v1/leads/${lead.id}/timeline`, "GET").then((r) =>
      setTimeline((r.json.timeline as TimelineItem[] | undefined) ?? []),
    );
  }, [lead.id]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const patch: Record<string, unknown> = {};
    for (const [k] of FIELDS) if (form[k] !== init[k]) patch[k] = (form[k] ?? "").trim() || null;
    if (form.tags !== init.tags)
      patch.tags = (form.tags ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    if (form.interest !== init.interest)
      patch.interestStatus = form.interest === "" ? null : Number(form.interest);
    if (JSON.stringify(custom) !== JSON.stringify(initCustom))
      patch.customFields = Object.fromEntries(
        custom.filter((c) => c.key.trim()).map((c) => [c.key.trim(), c.value]),
      );
    if (!Object.keys(patch).length) return setMsg("Nothing changed.");
    const r = await call(`/api/v1/leads/${lead.id}`, "PATCH", patch);
    if (!r.ok) {
      setMsg("");
      return setError(errorText(r));
    }
    setError("");
    setMsg("Saved.");
    setInit(form);
    setInitCustom(custom);
    onChanged();
  }

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const stat = (label: string, v: string | number) => (
    <div key={label} className="flex flex-col gap-0.5">
      <dt className="micro text-fg-muted">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">{v}</dd>
    </div>
  );
  const interest = lead.interestStatus === null ? null : INTEREST[String(lead.interestStatus)];
  const verification = VERIFICATION[lead.verificationStatus] ?? "";

  return (
    <dialog ref={dialog} aria-labelledby="lead-title" onClose={onClose} className={sheetClass()}>
      <div className="flex h-full flex-col">
        <header className={sheetHeader}>
          <h2
            id="lead-title"
            className="min-w-0 truncate text-base font-semibold"
            title={lead.email}
          >
            {lead.email}
          </h2>
          {interest && (
            <StatusPill {...pillFor(INTEREST_PILL, interest)} className="max-sm:hidden">
              {interest}
            </StatusPill>
          )}
          <StatusPill {...pillFor(VERIFICATION_PILL, verification)} className="max-sm:hidden">
            {verification}
          </StatusPill>
          <Button variant="ghost" className="ml-auto" onClick={() => dialog.current?.close()}>
            <X aria-hidden />
            Close
          </Button>
        </header>
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-5">
          <DrawerSection label="Details" title="Details">
            <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-sunken px-4 py-3 sm:grid-cols-4">
              {stat("Verification", verification)}
              {stat("ESP", ESP[lead.espType] ?? "")}
              {stat("Emails sent", lead.emailsSent)}
              {stat("Replies", lead.replies)}
            </dl>
            <form id="lead-form" onSubmit={save} className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
              {FIELDS.map(([k, label]) => (
                <div key={k} className="flex flex-col gap-1.5">
                  <Label htmlFor={`lead-${k}`}>{label}</Label>
                  <Input
                    id={`lead-${k}`}
                    disabled={!canEdit}
                    value={form[k]}
                    onChange={(e) => set(k, e.target.value)}
                  />
                </div>
              ))}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lead-interest">Interest status</Label>
                <Select
                  id="lead-interest"
                  disabled={!canEdit}
                  value={form.interest}
                  onChange={(e) => set("interest", e.target.value)}
                >
                  <option value="">Lead (no status)</option>
                  {Object.entries(INTEREST).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="lead-tags">Tags (comma separated)</Label>
                <Input
                  id="lead-tags"
                  disabled={!canEdit}
                  value={form.tags}
                  onChange={(e) => set("tags", e.target.value)}
                />
              </div>
              <fieldset className="flex flex-col gap-2 sm:col-span-2">
                <legend className="mb-1.5 text-[13px]/[18px] font-medium">Custom fields</legend>
                {custom.map((c, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      aria-label={`Custom field ${i + 1} name`}
                      disabled={!canEdit}
                      value={c.key}
                      onChange={(e) =>
                        setCustom((o) =>
                          o.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)),
                        )
                      }
                    />
                    <Input
                      aria-label={`Custom field ${i + 1} value`}
                      disabled={!canEdit}
                      value={c.value}
                      onChange={(e) =>
                        setCustom((o) =>
                          o.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                        )
                      }
                    />
                    {canEdit && (
                      <Button
                        type="button"
                        variant="danger-ghost"
                        aria-label={`Remove custom field ${i + 1}`}
                        onClick={() => setCustom((o) => o.filter((_, j) => j !== i))}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                ))}
                {canEdit && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="self-start"
                    onClick={() => setCustom((o) => [...o, { key: "", value: "" }])}
                  >
                    <Plus aria-hidden />
                    Add custom field
                  </Button>
                )}
              </fieldset>
            </form>
            {canEdit && (
              <p className="text-[13px]/[18px]">
                <a
                  className="text-signal underline underline-offset-2"
                  href={`/api/v1/leads/${lead.id}/export`}
                >
                  Export data (JSON)
                </a>
              </p>
            )}
          </DrawerSection>
          {canEdit && <LeadAi lead={lead} onChanged={onChanged} />}
          <DrawerSection label="Timeline" title="Timeline">
            {timeline.length ? (
              <ol className="flex flex-col">
                {timeline.map((t, i) => {
                  const Icon = ICON[t.kind] ?? ShieldOff;
                  return (
                    <li
                      key={i}
                      className="relative flex gap-3 pb-3 text-[13px]/[18px] last:pb-0 [&:not(:last-child)]:before:absolute [&:not(:last-child)]:before:top-6 [&:not(:last-child)]:before:bottom-0 [&:not(:last-child)]:before:left-3 [&:not(:last-child)]:before:w-px [&:not(:last-child)]:before:bg-border"
                    >
                      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-sunken">
                        <Icon className="size-3 text-fg-muted" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1 pt-0.5 break-words">{describe(t)}</span>
                      <time dateTime={t.at} className="shrink-0 pt-0.5 text-fg-subtle tabular-nums">
                        {new Date(t.at).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="text-[13px]/[18px] text-fg-muted">No activity yet.</p>
            )}
          </DrawerSection>
        </div>
        {canEdit && (
          <footer className={sheetFooter}>
            <div className="mr-auto min-w-0 flex-1 text-[13px]/[18px]">
              {error && (
                <p role="alert" className="text-danger">
                  {error}
                </p>
              )}
              {msg && <p role="status">{msg}</p>}
            </div>
            <Button type="submit" form="lead-form">
              Save
            </Button>
          </footer>
        )}
      </div>
    </dialog>
  );
}
