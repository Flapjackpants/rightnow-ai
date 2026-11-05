"use client";

import { Clock, Paperclip, Sparkles, ThumbsDown, ThumbsUp, Trash2, UserX } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { chipClass } from "../../../components/overlay";
import { pillFor, REPLY_CATEGORY, StatusPill } from "../../../components/status-pill";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Select } from "../../../components/ui/select";
import { call, errorText } from "../accounts/api-client";
import { INTEREST } from "../leads/labels";
import { Composer } from "./composer";
import { DeleteLeadDialog } from "./delete-lead-dialog";
import { LeadPanel } from "./lead-panel";
import { MessageFrame } from "./message-frame";
import { CATEGORIES, who, type Detail } from "./types";

const field = "flex flex-col gap-1 text-[13px]/[18px] font-medium";

type Opt = { id: string; name: string };
const KIND: Record<string, string> = {
  AUTO_REPLY: "Auto-reply",
  BOUNCE: "Bounce",
  UNSUBSCRIBE: "Unsubscribe request",
};
const size = (n: number) =>
  n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const localInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export function ThreadView({
  id,
  canEdit,
  isAdmin,
  onRead,
  onChanged,
  onDeleted,
}: {
  id: string;
  canEdit: boolean;
  isAdmin: boolean;
  onRead: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [ok, setOk] = useState("");
  const [err, setErr] = useState("");
  const [remind, setRemind] = useState("");
  const [subs, setSubs] = useState<Opt[]>([]);
  const [campaigns, setCampaigns] = useState<Opt[]>([]);
  const [dialog, setDialog] = useState(false);
  const result = (o: string, e: string) => {
    setOk(o);
    setErr(e);
  };

  const load = useCallback(async () => {
    const r = await call(`/api/v1/inbox/threads/${id}`, "GET");
    if (!r.ok) {
      setErr(errorText(r));
      return null;
    }
    const t = r.json as unknown as Detail;
    setD(t);
    setRemind(localInput(t.reminderAt));
    return t;
  }, [id]);

  useEffect(() => {
    setD(null);
    setOk("");
    setErr("");
    void load().then(async (t) => {
      // only unread threads: read-all answers 404 for one that is already read
      if (t && !t.isRead && (await call(`/api/v1/inbox/threads/${id}/read-all`, "POST")).ok)
        onRead();
    });
  }, [id, load]);

  useEffect(() => {
    if (!d?.campaignId) return setSubs([]);
    void call(`/api/v1/campaigns/${d.campaignId}/steps`, "GET").then((r) =>
      setSubs((r.json.subsequences as Opt[] | undefined) ?? []),
    );
  }, [d?.campaignId]);
  useEffect(() => {
    void call("/api/v1/campaigns", "GET").then((r) =>
      setCampaigns((r.json.campaigns as Opt[] | undefined) ?? []),
    );
  }, []);

  async function patch(body: unknown, done: string) {
    const r = await call(`/api/v1/inbox/threads/${id}`, "PATCH", body);
    result(r.ok ? done : "", r.ok ? "" : errorText(r));
    if (r.ok) {
      await load();
      onChanged();
    }
  }
  async function act(url: string, method: string, body: unknown, done: string) {
    const r = await call(url, method, body);
    result(r.ok ? done : "", r.ok ? "" : errorText(r));
    if (r.ok) await load();
  }
  async function removeConversation() {
    const r = await call(`/api/v1/inbox/threads/${id}`, "DELETE");
    if (r.ok) onDeleted();
    else result("", errorText(r));
  }

  if (!d)
    return (
      <p role="status" className="p-4 text-sm text-fg-muted">
        Loading conversation...
      </p>
    );
  const lead = d.lead;
  const category = d.category ? CATEGORIES[d.category] : undefined;
  return (
    <div
      role="region"
      aria-label="Conversation"
      className="@container flex min-h-0 min-w-0 flex-1 flex-col lg:overflow-hidden"
    >
      <div className="shrink-0 border-b border-border bg-surface">
        <header className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
          <h2 className="min-w-0 truncate text-lg/[26px] font-semibold" title={d.subject}>
            {d.subject}
          </h2>
          {category && (
            <StatusPill {...pillFor(REPLY_CATEGORY, category)}>
              {d.categorySource === "AI" && <Sparkles className="size-3 text-ai" aria-hidden />}
              {category}
            </StatusPill>
          )}
          {d.origin && (
            <span className={chipClass} title={d.origin.campaign.name}>
              {d.origin.campaign.name}
            </span>
          )}
          {canEdit && (
            <span className="ml-auto flex flex-wrap gap-1">
              <Button variant="danger-ghost" size="sm" onClick={() => void removeConversation()}>
                <Trash2 aria-hidden />
                Delete conversation
              </Button>
              {lead && !lead.deletedAt && (
                <Button variant="danger-ghost" size="sm" onClick={() => setDialog(true)}>
                  <UserX aria-hidden />
                  Delete or block lead
                </Button>
              )}
            </span>
          )}
        </header>
        {canEdit && (
          <div className="flex flex-wrap items-end gap-2 border-t border-border px-4 py-2.5">
            {lead && (
              <label className={field}>
                Interest status
                <Select
                  size="sm"
                  value={lead.interestStatus ?? ""}
                  onChange={(e) =>
                    void act(
                      `/api/v1/leads/${lead.id}`,
                      "PATCH",
                      { interestStatus: e.target.value === "" ? null : Number(e.target.value) },
                      "Status updated.",
                    )
                  }
                >
                  <option value="">None</option>
                  {Object.entries(INTEREST).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <label className={field}>
              <span className="flex items-center gap-1.5">
                Category
                {d.categorySource === "AI" && (
                  <StatusPill tone="ai" size="sm" icon={Sparkles}>
                    AI
                  </StatusPill>
                )}
              </span>
              <Select
                size="sm"
                value={d.category ?? ""}
                onChange={(e) =>
                  e.target.value && void patch({ category: e.target.value }, "Category updated.")
                }
              >
                <option value="" disabled>
                  Not set
                </option>
                {Object.entries(CATEGORIES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </label>
            <label className={field}>
              Reminder
              <Input
                type="datetime-local"
                className="w-auto md:h-8 md:text-[13px]/[18px]"
                value={remind}
                onChange={(e) => setRemind(e.target.value)}
              />
            </label>
            <Button
              variant="outline"
              size="sm"
              disabled={!remind}
              onClick={() =>
                void patch({ reminderAt: new Date(remind).toISOString() }, "Reminder set.")
              }
            >
              <Clock aria-hidden />
              Set reminder
            </Button>
            {d.reminderAt && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void patch({ reminderAt: null }, "Reminder cleared.")}
              >
                Clear reminder
              </Button>
            )}
            {d.campaignLeadId && subs.length > 0 && (
              <label className={field}>
                Move to subsequence
                <Select
                  size="sm"
                  value=""
                  onChange={(e) =>
                    e.target.value &&
                    void act(
                      `/api/v1/campaigns/${d.campaignId}/leads/${d.campaignLeadId}`,
                      "POST",
                      { action: "move_to_subsequence", subsequenceId: e.target.value },
                      "Moved to subsequence.",
                    )
                  }
                >
                  <option value="">Choose</option>
                  {subs.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            {lead && (
              <label className={field}>
                Add to another campaign
                <Select
                  size="sm"
                  value=""
                  onChange={(e) =>
                    e.target.value &&
                    void act(
                      `/api/v1/campaigns/${e.target.value}/leads`,
                      "POST",
                      { leadIds: [lead.id] },
                      "Added to campaign.",
                    )
                  }
                >
                  <option value="">Choose</option>
                  {campaigns
                    .filter((c) => c.id !== d.campaignId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </Select>
              </label>
            )}
          </div>
        )}
        <div className="px-4 text-[13px]/[18px] empty:hidden [&:has(p:not(:empty))]:pb-2">
          <p role="status" className="text-success empty:hidden">
            {ok}
          </p>
          <p role="alert" className="text-danger empty:hidden">
            {err}
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 lg:overflow-y-auto @4xl:grid @4xl:grid-cols-[minmax(0,1fr)_320px] @4xl:overflow-hidden">
        <div className="flex min-w-0 flex-col gap-3 p-4 @4xl:overflow-y-auto">
          {d.messages.map((m) => (
            <article
              key={m.id}
              aria-label={`Message from ${who(m)}`}
              className="flex flex-col gap-3 rounded-lg border border-border bg-surface px-4 py-4 md:px-5"
            >
              <header className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="grid size-7 shrink-0 place-items-center rounded-full bg-sunken font-mono text-[11px] font-medium text-fg-muted"
                >
                  {initials(who(m))}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  {m.direction === "OUT" && (
                    <span className="micro truncate text-fg-subtle">Sent from {m.fromEmail}</span>
                  )}
                  <span className="truncate text-sm font-medium">
                    {who(m)}{" "}
                    <span className="font-normal text-fg-subtle">&lt;{m.fromEmail}&gt;</span>
                  </span>
                  <span className="truncate text-[13px]/[18px] text-fg-subtle">
                    to {m.to.join(", ")}
                  </span>
                </span>
                <span className="shrink-0 text-right text-[13px]/[18px] text-fg-subtle tabular-nums">
                  {KIND[m.kind] && (
                    <StatusPill tone="neutral" size="sm" className="mb-1">
                      {KIND[m.kind]}
                    </StatusPill>
                  )}
                  <span className="block">
                    {new Date(m.sentAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </span>
              </header>
              <MessageFrame html={m.html} text={m.text} />
              {canEdit && d.categorySource === "AI" && m.direction === "IN" && m.category && (
                <div className="flex flex-wrap items-center gap-1 text-[13px]/[18px] text-fg-muted">
                  <Sparkles className="size-3 text-ai" aria-hidden />
                  AI tagged this {CATEGORIES[m.category]?.toLowerCase() ?? "reply"}. Right?
                  {([1, -1] as const).map((vote) => (
                    <Button
                      key={vote}
                      variant="ghost"
                      size="icon-sm"
                      aria-label={vote === 1 ? "Good AI tag" : "Wrong AI tag"}
                      aria-pressed={m.aiFeedback === vote}
                      className="aria-pressed:bg-active-nav"
                      onClick={() =>
                        void act(
                          `/api/v1/inbox/messages/${m.id}/ai-feedback`,
                          "POST",
                          { vote },
                          "Thanks for the feedback.",
                        )
                      }
                    >
                      {vote === 1 ? <ThumbsUp aria-hidden /> : <ThumbsDown aria-hidden />}
                    </Button>
                  ))}
                </div>
              )}
              {m.attachments.length > 0 && (
                <ul className="flex flex-wrap gap-2 text-[13px]/[18px]">
                  {m.attachments.map((a) => (
                    <li
                      key={a.id}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-sunken px-2 py-1"
                    >
                      <Paperclip className="size-3 text-fg-muted" aria-hidden />
                      {a.truncated ? (
                        `${a.filename} (too large to keep)`
                      ) : (
                        <a
                          className="text-signal underline-offset-2 hover:underline"
                          href={`/api/v1/inbox/attachments/${a.id}`}
                          download
                        >
                          {a.filename}
                        </a>
                      )}
                      <span className="text-fg-subtle">{size(a.size)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}

          {canEdit && (
            <Composer
              threadId={id}
              hasOwner={!!lead?.ownerId}
              onResult={result}
              onSent={() => {
                void load();
                onChanged();
              }}
            />
          )}
        </div>
        <LeadPanel d={d} canEdit={canEdit} onChanged={() => void load()} onResult={result} />
      </div>
      {dialog && lead && (
        <DeleteLeadDialog
          lead={lead}
          isAdmin={isAdmin}
          onClose={() => setDialog(false)}
          onDone={(m) => {
            setDialog(false);
            result(m, "");
            void load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
