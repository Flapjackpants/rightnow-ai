"use client";

import { ChevronLeft, Inbox } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import { call, errorText } from "../accounts/api-client";
import { BulkBar } from "./bulk-bar";
import { Sidebar } from "./sidebar";
import { ThreadList } from "./thread-list";
import { ThreadView } from "./thread-view";
import type { Filter, ThreadRow } from "./types";

const NO_COUNTS = { primary: 0, others: 0, triage: 0, total: 0, remindersDue: 0 };

/**
 * B5.11 three panes: views (224px) | list (360px) | thread. From 1024 they fill the viewport height and scroll on
 * their own; below 768 one pane shows at a time (a selected thread replaces the list, with a back button).
 */
export function InboxApp({ canEdit, isAdmin }: { canEdit: boolean; isAdmin: boolean }) {
  const [filter, setFilter] = useState<Filter>({ view: "primary" });
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [counts, setCounts] = useState(NO_COUNTS);
  const [msg, setMsg] = useState("");

  const current = useRef(filter); // a slower response for an earlier filter is dropped
  current.current = filter;
  const load = useCallback(
    async (cursor?: string) => {
      const f = filter;
      const q = new URLSearchParams({ view: f.view, limit: "50" });
      for (const [k, v] of Object.entries(f))
        if (k !== "view" && v !== undefined) q.set(k, String(v));
      if (cursor) q.set("cursor", cursor);
      const r = await call(`/api/v1/inbox/threads?${q}`, "GET");
      if (current.current !== f) return;
      if (!r.ok) return setMsg(errorText(r));
      const got = (r.json.threads ?? []) as ThreadRow[];
      setThreads((o) => (cursor ? [...o, ...got] : got));
      setNext((r.json.nextCursor as string | null) ?? null);
      setLoaded(true);
    },
    [filter],
  );
  const refreshCounts = useCallback(async () => {
    const r = await call("/api/v1/inbox/unread-count", "GET");
    if (r.ok) setCounts(r.json as unknown as typeof NO_COUNTS);
    window.dispatchEvent(new Event("inbox:unread-changed"));
  }, []);

  useEffect(() => {
    setLoaded(false);
    setChecked(new Set());
    void load();
  }, [load]);
  useEffect(() => {
    void refreshCounts();
  }, [refreshCounts]);

  const changed = () => {
    void load();
    void refreshCounts();
  };

  async function bulk(action: string, interestStatus?: number | null) {
    const r = await call("/api/v1/inbox/threads/bulk", "POST", {
      ids: [...checked],
      action,
      ...(interestStatus !== undefined && { interestStatus }),
    });
    setMsg(r.ok ? `Updated ${(r.json.affected as number) ?? 0} conversation(s).` : errorText(r));
    if (r.ok && action === "delete" && selected && checked.has(selected)) setSelected(null);
    setChecked(new Set());
    changed();
  }

  return (
    <div className="flex flex-col gap-3 lg:h-[calc(100dvh-96px)]">
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl/7 font-semibold tracking-[-0.01em]">Unified inbox</h1>
        {filter.view === "scheduled" && (
          <Button asChild variant="link">
            <Link href="/scheduled">Open Scheduled emails</Link>
          </Button>
        )}
      </div>
      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[320px_minmax(0,1fr)] lg:grid-cols-[224px_360px_minmax(0,1fr)]">
        <div className={cn("min-w-0 md:col-span-2 lg:col-span-1", selected && "max-md:hidden")}>
          <Sidebar
            filter={filter}
            counts={counts}
            canEdit={canEdit}
            onFilter={(f) => {
              setFilter(f);
              setSelected(null);
            }}
          />
        </div>
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-surface",
            selected && "max-md:hidden",
          )}
        >
          {checked.size > 0 && canEdit && (
            <BulkBar
              count={checked.size}
              onClear={() => setChecked(new Set())}
              onAction={(a, i) => void bulk(a, i)}
            />
          )}
          <p
            role="status"
            className="px-4 text-[13px]/[18px] text-fg-muted empty:hidden [&:not(:empty)]:pt-2"
          >
            {msg}
          </p>
          <ThreadList
            threads={threads}
            selected={selected}
            checked={checked}
            hasMore={!!next}
            loaded={loaded}
            bulk={checked.size > 0 && canEdit}
            q={filter.q ?? ""}
            attachmentsOnly={!!filter.hasAttachment}
            onSelect={setSelected}
            onCheck={(id, on) =>
              setChecked((s) => {
                const n = new Set(s);
                if (on) n.add(id);
                else n.delete(id);
                return n;
              })
            }
            onCheckAll={(on) => setChecked(on ? new Set(threads.map((t) => t.id)) : new Set())}
            onMore={() => next && void load(next)}
            onSearch={(q) => setFilter({ ...filter, q: q || undefined })}
            onAttachments={(on) => setFilter({ ...filter, hasAttachment: on || undefined })}
          />
        </div>
        <div
          className={cn(
            "min-h-0 min-w-0 overflow-hidden rounded-lg border border-border bg-sunken",
            !selected && "max-md:hidden",
          )}
        >
          {selected ? (
            <div className="flex h-full flex-col">
              <Button
                variant="ghost"
                size="sm"
                className="m-2 self-start md:hidden"
                onClick={() => setSelected(null)}
              >
                <ChevronLeft aria-hidden />
                Conversations
              </Button>
              <ThreadView
                id={selected}
                canEdit={canEdit}
                isAdmin={isAdmin}
                onRead={() => {
                  setThreads((ts) =>
                    ts.map((t) => (t.id === selected ? { ...t, isRead: true } : t)),
                  );
                  void refreshCounts();
                }}
                onChanged={changed}
                onDeleted={() => {
                  setSelected(null);
                  setMsg("Conversation deleted.");
                  changed();
                }}
              />
            </div>
          ) : (
            <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-8 text-center">
              <Inbox className="size-10 text-fg-subtle" aria-hidden />
              <p className="text-sm text-fg-muted">Select a conversation</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
