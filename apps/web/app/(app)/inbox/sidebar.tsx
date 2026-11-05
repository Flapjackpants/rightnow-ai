"use client";

import { SlidersHorizontal, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Select } from "../../../components/ui/select";
import { cn } from "../../../lib/utils";
import { call, errorText } from "../accounts/api-client";
import { INTEREST } from "../leads/labels";
import type { Filter } from "./types";

const VIEWS = [
  ["primary", "Primary"],
  ["others", "Others"],
  ["triage", "Triage"],
  ["unread", "Unread"],
  ["reminders", "Reminders"],
  ["sent", "Sent"],
  ["scheduled", "Scheduled"],
  ["all", "All"],
] as const;
type Opt = { id: string; name?: string; email?: string };
type Saved = { id: string; name: string; filters: Record<string, unknown> };

export function Sidebar({
  filter,
  counts,
  canEdit,
  onFilter,
}: {
  filter: Filter;
  counts: { primary: number; others: number; triage: number; total: number; remindersDue: number };
  canEdit: boolean;
  onFilter: (f: Filter) => void;
}) {
  const [accounts, setAccounts] = useState<Opt[]>([]);
  const [campaigns, setCampaigns] = useState<Opt[]>([]);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  // the filters are folded behind "Filters" below 1024 and always shown beside the inbox from 1024
  const [open, setOpen] = useState(true);
  useEffect(() => setOpen(window.matchMedia("(min-width: 64rem)").matches), []);
  const active = [filter.accountId, filter.campaignId, filter.interestStatus].filter(
    (v) => v !== undefined,
  ).length;

  const loadSaved = () =>
    call("/api/v1/inbox/views", "GET").then((r) => setSaved((r.json.views as Saved[]) ?? []));
  useEffect(() => {
    void call("/api/v1/accounts", "GET").then((r) => setAccounts((r.json.accounts as Opt[]) ?? []));
    void call("/api/v1/campaigns", "GET").then((r) =>
      setCampaigns((r.json.campaigns as Opt[]) ?? []),
    );
    void loadSaved();
  }, []);

  const badge: Record<string, number> = {
    primary: counts.primary,
    others: counts.others,
    triage: counts.triage,
    unread: counts.total,
    reminders: counts.remindersDue,
  };
  const set = (patch: Partial<Filter>) => onFilter({ ...filter, ...patch });

  async function save() {
    const { view, accountId, campaignId, interestStatus, q, hasAttachment } = filter;
    const r = await call("/api/v1/inbox/views", "POST", {
      name,
      filters: { view, accountId, campaignId, interestStatus, q, hasAttachment },
    });
    setErr(r.ok ? "" : errorText(r));
    if (r.ok) {
      setName("");
      void loadSaved();
    }
  }

  return (
    <div className="flex flex-col gap-3 lg:h-full lg:overflow-y-auto lg:rounded-lg lg:bg-sunken lg:p-2">
      <nav aria-label="Inbox views">
        {/* a row of chips that scrolls sideways below 1024, a list of 36px rows beside the inbox from 1024 */}
        <ul className="flex gap-1 max-lg:-mx-4 max-lg:overflow-x-auto max-lg:px-4 max-lg:[scrollbar-width:none] md:max-lg:mx-0 md:max-lg:px-0 lg:flex-col">
          {VIEWS.map(([id, label]) => {
            const on = filter.view === id;
            return (
              <li key={id} className="shrink-0">
                <button
                  type="button"
                  aria-current={on ? "true" : undefined}
                  onClick={() => set({ view: id })}
                  className={cn(
                    "relative flex h-9 w-full items-center justify-between gap-2 rounded-sm px-2.5 text-sm font-medium transition-colors duration-(--dur-1) hover:bg-hover focus-visible:-outline-offset-2 max-lg:h-11 max-lg:border max-lg:border-border max-lg:bg-surface lg:h-9",
                    on &&
                      "bg-active-nav max-lg:border-signal max-lg:bg-signal-tint max-lg:text-signal lg:before:absolute lg:before:top-2.5 lg:before:left-0 lg:before:h-4 lg:before:w-[3px] lg:before:rounded-r-xs lg:before:bg-signal",
                  )}
                >
                  {label}
                  {(badge[id] ?? 0) > 0 && (
                    <span className="min-w-4.5 rounded-full bg-surface px-1.25 text-center font-mono text-[11px]/[18px] font-medium text-fg-muted tabular-nums lg:bg-hover">
                      {badge[id]}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <details
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
        className="group flex flex-col gap-3"
      >
        <summary className="inline-flex h-11 cursor-pointer list-none items-center gap-1.5 rounded-sm border border-border-strong bg-surface px-3 text-sm font-medium lg:hidden [&::-webkit-details-marker]:hidden">
          <SlidersHorizontal className="size-4" aria-hidden />
          Filters
          {active > 0 && <span className="text-fg-muted tabular-nums">({active})</span>}
        </summary>
        <div className="mt-3 flex flex-col gap-3 max-lg:rounded-lg max-lg:border max-lg:border-border max-lg:bg-surface max-lg:p-3 lg:mt-1 lg:px-1">
          <div className="flex flex-col gap-2.5">
            <h2 className="micro px-1.5 text-fg-subtle max-lg:hidden">Filters</h2>
            <label className="flex flex-col gap-1.5 text-[13px]/[18px] font-medium">
              Mailbox
              <Select
                size="sm"
                value={filter.accountId ?? ""}
                onChange={(e) => set({ accountId: e.target.value || undefined })}
              >
                <option value="">All mailboxes</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.email}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px]/[18px] font-medium">
              Campaign
              <Select
                size="sm"
                value={filter.campaignId ?? ""}
                onChange={(e) => set({ campaignId: e.target.value || undefined })}
              >
                <option value="">All campaigns</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px]/[18px] font-medium">
              Lead status
              <Select
                size="sm"
                value={filter.interestStatus ?? ""}
                onChange={(e) =>
                  set({
                    interestStatus: e.target.value === "" ? undefined : Number(e.target.value),
                  })
                }
              >
                <option value="">Any status</option>
                {Object.entries(INTEREST).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="micro px-1.5 text-fg-subtle">Saved views</h2>
            {saved.length > 0 && (
              <ul className="flex flex-col">
                {saved.map((v) => (
                  <li key={v.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      className="h-8 flex-1 truncate rounded-sm px-2 text-left text-sm hover:bg-hover focus-visible:-outline-offset-2 max-md:h-11"
                      onClick={() =>
                        onFilter({ view: "primary", ...(v.filters as Partial<Filter>) })
                      }
                    >
                      {v.name}
                    </button>
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete saved view ${v.name}`}
                        onClick={() =>
                          void call(`/api/v1/inbox/views/${v.id}`, "DELETE").then(loadSaved)
                        }
                      >
                        <X aria-hidden />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <>
                <Input
                  aria-label="Saved view name"
                  placeholder="Name this view"
                  className="md:h-8 md:text-[13px]/[18px]"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!name.trim()}
                  onClick={() => void save()}
                >
                  Save current view
                </Button>
                {err && (
                  <p role="alert" className="text-[13px]/[18px] text-danger">
                    {err}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}
