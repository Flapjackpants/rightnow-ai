"use client";

import { useCallback, useEffect, useState } from "react";
import { Users } from "lucide-react";
import { LEAD_STATE, pillFor, StatusPill } from "../../../../components/status-pill";
import { TableEmpty, TableFrame } from "../../../../components/table-kit";
import { Button } from "../../../../components/ui/button";
import { Card } from "../../../../components/ui/card";
import { Label } from "../../../../components/ui/label";
import { Select } from "../../../../components/ui/select";
import { call, errorText } from "../../accounts/api-client";
import type { Named } from "./campaign-builder";

type Row = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  campaignStatus?: string;
};
/** B4.4 lead-state tones; this tab prints "Active" for leads in sequence. */
const STATE = { ...LEAD_STATE, Active: LEAD_STATE["In sequence"]! };
const SKIP: Record<string, string> = {
  in_other_active_campaign: "in another live campaign",
  already_in_campaign: "already in this campaign",
  suppressed: "suppressed",
  deleted: "deleted",
  excluded_region: "in an excluded region",
};

export function LeadsTab({
  campaignId,
  lists,
  statuses,
  canEdit,
  version,
  onChange,
}: {
  campaignId: string;
  lists: Named[];
  statuses: string[];
  canEdit: boolean;
  version: number;
  onChange: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState("");
  const [source, setSource] = useState("");
  const [dupes, setDupes] = useState(false);
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  const base = `/api/v1/campaigns/${campaignId}/leads`;

  const load = useCallback(
    async (cursor?: string) => {
      const q = new URLSearchParams({ take: "50" });
      if (filter) q.set("status", filter);
      if (cursor) q.set("cursor", cursor);
      const r = await call(`${base}?${q}`, "GET");
      if (!r.ok) return setMsg(errorText(r));
      const got = (r.json.leads ?? []) as Row[];
      setRows((o) => (cursor ? [...o, ...got] : got));
      setNext((r.json.nextCursor as string | null) ?? null);
    },
    [base, filter],
  );
  useEffect(() => {
    void load();
  }, [load, tick, version]);
  useEffect(() => {
    // exact per-status totals: one count query each (take=1 keeps it light)
    void Promise.all(
      statuses.map((s) =>
        call(`${base}?status=${s}&take=1`, "GET").then(
          (r) => [s, Number(r.json.total ?? 0)] as const,
        ),
      ),
    ).then((e) => setCounts(Object.fromEntries(e)));
  }, [base, statuses, tick, version]);

  async function enroll() {
    const r = await call(base, "POST", {
      ...(source ? { listId: source } : { filter: {} }),
      allowDuplicates: dupes,
    });
    if (!r.ok) return setMsg(errorText(r));
    const j = r.json as { enrolled: number; skipped: Record<string, number> };
    const skipped = Object.entries(j.skipped)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${SKIP[k] ?? k}`);
    setMsg(
      `Enrolled ${j.enrolled} lead(s)${skipped.length ? `; skipped ${skipped.join(", ")}` : ""}.`,
    );
    setTick((n) => n + 1);
    onChange();
  }

  return (
    <div className="flex flex-col gap-4">
      {canEdit && (
        <Card>
          <form
            className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              void enroll();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="lead-source">Lead source</Label>
              <Select
                id="lead-source"
                className="md:w-64"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="">All leads</option>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    List: {l.name}
                  </option>
                ))}
              </Select>
            </div>
            <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
              <input type="checkbox" checked={dupes} onChange={(e) => setDupes(e.target.checked)} />
              Allow leads that are in another live campaign
            </label>
            <Button type="submit" className="md:ml-auto">
              Enroll leads
            </Button>
          </form>
        </Card>
      )}
      {msg && (
        <p role="status" className="text-sm">
          {msg}
        </p>
      )}
      <ul
        aria-label="Lead status totals"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
      >
        {statuses.map((s) => (
          <li
            key={s}
            className="flex flex-col items-start gap-1.5 rounded-lg border border-border bg-surface px-3 py-2.5"
          >
            <StatusPill {...pillFor(STATE, s)}>{s}</StatusPill>{" "}
            <span className="text-xl/7 font-semibold tabular-nums">{counts[s] ?? 0}</span>
          </li>
        ))}
      </ul>
      <div className="flex min-h-12 flex-wrap items-center gap-2">
        <Select
          size="sm"
          aria-label="Filter by status"
          className="w-auto"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              Status: {s}
            </option>
          ))}
        </Select>
      </div>
      <TableFrame>
        <table aria-label="Campaign leads">
          <thead>
            <tr>
              <th scope="col" data-pin="id" className="max-md:left-0">
                Email
              </th>
              <th scope="col" className="hidden md:table-cell">
                Name
              </th>
              <th scope="col" className="hidden md:table-cell">
                Company
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id}>
                <td
                  data-pin="id"
                  className="max-w-56 truncate font-medium max-md:left-0"
                  title={l.email}
                >
                  {l.email}
                </td>
                <td className="hidden md:table-cell">
                  {[l.firstName, l.lastName].filter(Boolean).join(" ") || (
                    <span className="text-fg-subtle">-</span>
                  )}
                </td>
                <td className="hidden md:table-cell">
                  {l.companyName || <span className="text-fg-subtle">-</span>}
                </td>
                <td>
                  {l.campaignStatus && (
                    <StatusPill {...pillFor(STATE, l.campaignStatus)}>
                      {l.campaignStatus}
                    </StatusPill>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <TableEmpty
                colSpan={4}
                icon={Users}
                title="No leads in this campaign yet."
                body="Choose a lead list or filter above and enroll them."
              />
            )}
          </tbody>
        </table>
      </TableFrame>
      {next && (
        <Button variant="outline" size="sm" className="self-start" onClick={() => void load(next)}>
          Load more
        </Button>
      )}
    </div>
  );
}
