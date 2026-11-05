"use client";

import {
  Copy,
  FileJson,
  KeyRound,
  List,
  Pencil,
  Play,
  RotateCcw,
  Send,
  Trash2,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
} from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Callout } from "../../../components/callout";
import { EmptyState } from "../../../components/empty-state";
import { focusOnMount, type useInlineEditor } from "../../../components/inline-editor";
import { chipClass } from "../../../components/overlay";
import {
  DELIVERY_STATUS,
  pillFor,
  StatusPill,
  WEBHOOK_STATUS,
} from "../../../components/status-pill";
import { TableEmpty, TableFrame } from "../../../components/table-kit";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Select } from "../../../components/ui/select";
import { call, errorText } from "../accounts/api-client";
import type { Named } from "../leads/bulk-bar";
import { Err, Head } from "./ui";

export type Hook = {
  id: string;
  name: string | null;
  url: string;
  format: "json" | "slack";
  events: string[];
  campaignId: string | null;
  status: "ACTIVE" | "ERROR";
  lastError: string | null;
  disabledAt: string | null;
  headerNames: string[];
};
type Delivery = {
  id: string;
  eventId: string;
  eventType: string;
  status: "PENDING" | "SENDING" | "DELIVERED" | "FAILED";
  attempts: number;
  nextAttemptAt: string;
  lastStatus: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  payload: unknown;
};
type Res = Awaited<ReturnType<typeof call>>;

// a body the route's schema refused carries the reason in issues[0].message (e.g. invalid_header)
const why = (r: Res) =>
  (r.json.issues as { message?: string }[] | undefined)?.[0]?.message ?? errorText(r);
const label = (h: Hook) => h.name || h.url;
const when = (s: string) => new Date(s).toLocaleString();

export function WebhooksTab({
  hooks,
  reload,
  canEdit,
  campaigns,
  events,
  labels,
  editor,
}: {
  hooks: Hook[] | null;
  reload: () => void;
  canEdit: boolean;
  campaigns: Named[];
  events: string[];
  labels: string[];
  /** the "New webhook" button lives in the page header */
  editor: ReturnType<typeof useInlineEditor<Hook>>;
}) {
  const { editing, open: openEditor, close: closeEditor } = editor;
  const [viewing, setViewing] = useState<Hook | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // bumps the overview after anything that can change its counts

  // one request per webhook at a time, so a double click cannot race
  async function act(h: Hook, what: "test" | "resume" | "rotate-secret" | "delete") {
    if (
      what === "delete" &&
      !confirm(`Delete webhook ${label(h)}? Its delivery log is deleted too.`)
    )
      return;
    if (
      what === "rotate-secret" &&
      !confirm(`Rotate the secret of ${label(h)}? The old one stops working at once.`)
    )
      return;
    setBusy(h.id);
    setNotice("");
    const r =
      what === "delete"
        ? await call(`/api/v1/webhooks/${h.id}`, "DELETE")
        : await call(`/api/v1/webhooks/${h.id}/${what}`, "POST");
    setBusy(null);
    setError(r.ok ? "" : why(r));
    if (r.ok && what === "test")
      setNotice(
        r.json.error
          ? `Test of ${label(h)} failed: ${String(r.json.error)}`
          : `Test of ${label(h)}: HTTP ${String(r.json.status)} in ${String(r.json.latencyMs)} ms`,
      );
    if (r.ok && what === "rotate-secret") {
      setCopied(false);
      setSecret({ name: label(h), value: String(r.json.secret) });
    }
    if (r.ok && what === "delete" && viewing?.id === h.id) setViewing(null);
    setTick((t) => t + 1);
    reload();
  }

  if (editing)
    return (
      <HookForm
        hook={editing === "new" ? null : editing}
        campaigns={campaigns}
        events={events}
        labels={labels}
        onCancel={closeEditor}
        onSaved={(created) => {
          closeEditor();
          if (created) {
            setCopied(false);
            setSecret(created);
          }
          reload();
        }}
      />
    );
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px]/[18px] text-fg-muted">
        Each event is sent as a signed JSON POST (header X-RightNow-Signature) to your URL.
      </p>
      {secret && (
        <Card role="region" aria-label="Signing secret" className="flex flex-col gap-3">
          <p className="text-sm font-medium">
            Signing secret for {secret.name}. It is shown only once; copy it now.
          </p>
          <div className="flex gap-2">
            <Input
              readOnly
              aria-label="Signing secret value"
              className="font-mono md:text-[13px]"
              value={secret.value}
              onFocus={(e) => e.target.select()}
            />
            <Button
              variant="outline"
              onClick={() =>
                void navigator.clipboard?.writeText(secret.value).then(() => setCopied(true))
              }
            >
              <Copy aria-hidden />
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <Callout tone="warning">Copy it now. It will not be shown again.</Callout>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setSecret(null)}
          >
            I have saved it
          </Button>
        </Card>
      )}
      <Err text={error} />
      <p role="status" className="text-[13px]/[18px] empty:hidden">
        {notice}
      </p>
      {hooks && !hooks.length && (
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState
            icon={Webhook}
            title="No webhooks."
            body="Send events such as reply received or lead unsubscribed to your own endpoint."
          />
        </div>
      )}
      {!!hooks?.length && (
        <TableFrame>
          <table aria-label="Webhooks">
            <Head cols={["Webhook", "Events", "Status", "Actions"]} right={["Actions"]} />
            <tbody>
              {hooks.map((h) => (
                <tr key={h.id} data-stripe={h.status === "ERROR" ? "danger" : undefined}>
                  <td className="max-w-72 py-2.5">
                    <div className="truncate font-medium">{label(h)}</div>
                    {h.format === "slack" && <span className={chipClass}>Slack</span>}
                    {h.name && (
                      <div className="truncate font-mono text-xs text-fg-subtle" title={h.url}>
                        {h.url}
                      </div>
                    )}
                  </td>
                  <td className="max-w-72">
                    <span className="flex flex-wrap gap-1">
                      {h.events.slice(0, 3).map((e) => (
                        <span key={e} className={chipClass}>
                          {e}
                        </span>
                      ))}
                      {h.events.length > 3 && (
                        <span className={chipClass} title={h.events.slice(3).join(", ")}>
                          +{h.events.length - 3}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="text-[13px]/[18px]">
                    {h.status === "ACTIVE" ? (
                      <StatusPill {...pillFor(WEBHOOK_STATUS, "Active")}>Active</StatusPill>
                    ) : (
                      <span className="flex flex-col items-start gap-1">
                        <span>
                          <StatusPill {...pillFor(WEBHOOK_STATUS, "Error")}>Error</StatusPill> since{" "}
                          {h.disabledAt ? when(h.disabledAt) : "unknown"}
                        </span>
                        {h.lastError && <span className="text-fg-muted">{h.lastError}</span>}
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="flex flex-wrap justify-end gap-1">
                      <RowAction
                        icon={List}
                        text="Deliveries"
                        aria-label={`Deliveries of ${label(h)}`}
                        onClick={() => setViewing(h)}
                      />
                      {canEdit && (
                        <>
                          <RowAction
                            icon={Send}
                            text="Test"
                            aria-label={`Test ${label(h)}`}
                            disabled={busy === h.id}
                            onClick={() => void act(h, "test")}
                          />
                          {h.status === "ERROR" && (
                            <RowAction
                              icon={Play}
                              text="Resume"
                              aria-label={`Resume ${label(h)}`}
                              disabled={busy === h.id}
                              onClick={() => void act(h, "resume")}
                            />
                          )}
                          <RowAction
                            icon={Pencil}
                            text="Edit"
                            aria-label={`Edit ${label(h)}`}
                            data-opener={h.id}
                            onClick={() => openEditor(h, h.id)}
                          />
                          <RowAction
                            icon={KeyRound}
                            text="Rotate secret"
                            aria-label={`Rotate secret of ${label(h)}`}
                            disabled={busy === h.id}
                            onClick={() => void act(h, "rotate-secret")}
                          />
                          <RowAction
                            icon={Trash2}
                            text="Delete"
                            danger
                            aria-label={`Delete ${label(h)}`}
                            disabled={busy === h.id}
                            onClick={() => void act(h, "delete")}
                          />
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableFrame>
      )}
      <Overview tick={tick} />
      {viewing && (
        <Deliveries
          key={viewing.id}
          hook={viewing}
          canEdit={canEdit}
          onClose={() => setViewing(null)}
          onRedelivered={(m) => {
            setNotice(m);
            setTick((t) => t + 1);
          }}
        />
      )}
    </div>
  );
}

/** B4.6 row action: icon + short label; the label collapses to the icon below 1536 (the aria-label names it). */
function RowAction({
  icon: Icon,
  text,
  danger,
  ...props
}: ComponentProps<typeof Button> & { icon: LucideIcon; text: string; danger?: boolean }) {
  return (
    <Button
      variant={danger ? "danger-ghost" : "ghost"}
      size="sm"
      className="max-2xl:w-8 max-2xl:px-0 max-md:w-11"
      title={text}
      {...props}
    >
      <Icon aria-hidden />
      <span className="max-2xl:sr-only">{text}</span>
    </Button>
  );
}

function HookForm({
  hook,
  campaigns,
  events,
  labels,
  onSaved,
  onCancel,
}: {
  hook: Hook | null;
  campaigns: Named[];
  events: string[];
  labels: string[];
  onSaved: (created?: { name: string; value: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(hook?.name ?? "");
  const [url, setUrl] = useState(hook?.url ?? "");
  const [format, setFormat] = useState<"json" | "slack">(hook?.format ?? "json");
  const [chosen, setChosen] = useState(hook?.events ?? []);
  const [campaignId, setCampaignId] = useState(hook?.campaignId ?? "");
  // header values are never returned, so on edit they are replaced only when asked
  const [replace, setReplace] = useState(!hook);
  const [rows, setRows] = useState<{ k: string; v: string }[]>([]);
  const [error, setError] = useState("");
  const toggle = (e: string) =>
    setChosen((s) => (s.includes(e) ? s.filter((x) => x !== e) : [...s, e]));
  const setRow = (i: number, d: Partial<{ k: string; v: string }>) =>
    setRows((r) => r.map((x, j) => (j === i ? { ...x, ...d } : x)));

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!chosen.length) return setError("Choose at least one event");
    const headers = Object.fromEntries(
      rows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]),
    );
    const body = {
      name: name.trim() || null,
      url: url.trim(),
      events: chosen,
      campaignId: campaignId || null,
      ...(!hook && { format }),
      ...(format === "json" &&
        replace && { headers: Object.keys(headers).length ? headers : null }),
    };
    const r = await call(
      hook ? `/api/v1/webhooks/${hook.id}` : "/api/v1/webhooks",
      hook ? "PATCH" : "POST",
      body,
    );
    if (!r.ok)
      return setError(
        why(r) === "invalid_slack_url" ? "Enter a hooks.slack.com/services URL." : why(r),
      );
    onSaved(
      hook || format === "slack"
        ? undefined
        : { name: name.trim() || url.trim(), value: String(r.json.secret) },
    );
  }

  return (
    <Card>
      <form
        onSubmit={save}
        className="flex flex-col gap-4"
        aria-label={hook ? "Edit webhook" : "New webhook"}
      >
        <h2 ref={focusOnMount} tabIndex={-1} className="text-base font-semibold outline-none">
          {hook ? "Edit webhook" : "New webhook"}
        </h2>
        <Err text={error} />
        <div className="flex flex-col gap-1.5 self-start">
          <Label htmlFor="hook-format">Format</Label>
          <Select
            id="hook-format"
            value={format}
            disabled={!!hook}
            onChange={(e) => setFormat(e.target.value as "json" | "slack")}
          >
            <option value="json">Standard signed JSON</option>
            <option value="slack">Slack</option>
          </Select>
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="hook-name">Name</Label>
            <Input
              id="hook-name"
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex min-w-60 flex-1 flex-col gap-1.5">
            <Label htmlFor="hook-url">URL</Label>
            <Input
              className="font-mono md:text-[13px]"
              id="hook-url"
              type="url"
              required
              maxLength={2048}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            {format === "slack" && (
              <p className="text-xs text-fg-muted">
                Paste the Incoming Webhook URL from Slack. It is stored encrypted.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="hook-campaign">Campaign</Label>
            <Select
              id="hook-campaign"
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
            >
              <option value="">Any campaign</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
          <legend className="micro px-1 text-fg-muted">Events</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[13px]">
            {["all_events", ...events, ...labels].map((e) => (
              <label key={e} className="flex min-h-11 items-center gap-1.5 md:min-h-7">
                <input type="checkbox" checked={chosen.includes(e)} onChange={() => toggle(e)} />
                {e}
              </label>
            ))}
          </div>
        </fieldset>
        {format === "json" && (
          <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
            <legend className="micro px-1 text-fg-muted">Custom headers</legend>
            {hook && (
              <label className="flex items-center gap-2 text-[13px]/[18px]">
                <input
                  type="checkbox"
                  checked={replace}
                  onChange={(e) => setReplace(e.target.checked)}
                />
                Replace the stored headers
                {hook.headerNames.length
                  ? ` (${hook.headerNames.join(", ")}; values are not shown)`
                  : ""}
              </label>
            )}
            {replace && (
              <>
                {rows.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`hdr-k-${i}`}>Header name {i + 1}</Label>
                      <Input
                        id={`hdr-k-${i}`}
                        maxLength={64}
                        value={r.k}
                        onChange={(e) => setRow(i, { k: e.target.value })}
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`hdr-v-${i}`}>Header value {i + 1}</Label>
                      <Input
                        id={`hdr-v-${i}`}
                        maxLength={1024}
                        value={r.v}
                        onChange={(e) => setRow(i, { v: e.target.value })}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="danger-ghost"
                      aria-label={`Remove header ${i + 1}`}
                      onClick={() => setRows((x) => x.filter((_, j) => j !== i))}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={rows.length >= 10}
                    onClick={() => setRows((x) => [...x, { k: "", v: "" }])}
                  >
                    Add header
                  </Button>
                </div>
              </>
            )}
          </fieldset>
        )}
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit">Save webhook</Button>
        </div>
      </form>
    </Card>
  );
}

function Deliveries({
  hook,
  canEdit,
  onClose,
  onRedelivered,
}: {
  hook: Hook;
  canEdit: boolean;
  onClose: () => void;
  onRedelivered: (message: string) => void;
}) {
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<Delivery[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Delivery | null>(null);
  const current = useRef(status);

  const load = useCallback(
    async (cursor?: string) => {
      const q = new URLSearchParams({
        ...(status && { status }),
        ...(cursor && { cursor }),
      }).toString();
      const r = await call(`/api/v1/webhooks/${hook.id}/deliveries${q && `?${q}`}`, "GET");
      if (status !== current.current) return; // the filter moved on
      if (!r.ok) return setError(errorText(r));
      setError("");
      setRows((old) => [...(cursor ? (old ?? []) : []), ...(r.json.deliveries as Delivery[])]);
      setNext(r.json.nextCursor as string | null);
    },
    [hook.id, status],
  );
  useEffect(() => {
    current.current = status;
    setRows(null);
    setNext(null);
    void load();
  }, [status, load]);

  async function redeliver(d: Delivery) {
    const r = await call(`/api/v1/webhooks/deliveries/${d.id}/redeliver`, "POST");
    setError(r.ok ? "" : why(r));
    if (!r.ok) return;
    // keep the loaded pages: only this row changes
    setRows((old) =>
      (old ?? []).map((x) =>
        x.id === d.id
          ? { ...x, status: "PENDING", attempts: 0, nextAttemptAt: new Date().toISOString() }
          : x,
      ),
    );
    onRedelivered(`Queued ${d.eventType} for redelivery`);
  }

  return (
    <Card role="region" aria-label={`Deliveries of ${label(hook)}`} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <h2 className="min-w-0 truncate text-base font-semibold">Deliveries: {label(hook)}</h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="deliv-status">Status</Label>
          <Select
            id="deliv-status"
            size="sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All</option>
            {["PENDING", "DELIVERED", "FAILED"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </div>
        <Button className="ml-auto" variant="ghost" onClick={onClose}>
          Close deliveries
        </Button>
      </div>
      <Err text={error} />
      {rows && (
        <TableFrame>
          <table aria-label="Deliveries">
            <Head
              cols={["Event", "Status", "Code", "Latency", "Attempts", "Next attempt", "Actions"]}
              right={["Code", "Latency", "Attempts", "Actions"]}
            />
            <tbody>
              {rows.map((d) => {
                const word = d.status.charAt(0) + d.status.slice(1).toLowerCase();
                return (
                  <tr key={d.id} data-stripe={d.status === "FAILED" ? "danger" : undefined}>
                    <td className="font-mono text-[13px]">{d.eventType}</td>
                    <td>
                      {/* the raw status stays the text (tests read it); CSS shows it as a word */}
                      <StatusPill {...pillFor(DELIVERY_STATUS, word)}>
                        <span className="inline-block lowercase first-letter:uppercase">
                          {d.status}
                        </span>
                      </StatusPill>
                      {d.lastError && (
                        <span className="mt-1 block text-[13px]/[18px] text-fg-muted">
                          {d.lastError}
                        </span>
                      )}
                    </td>
                    <td className="text-right tabular-nums">{d.lastStatus ?? "-"}</td>
                    <td className="text-right whitespace-nowrap tabular-nums">
                      {d.lastLatencyMs === null ? "-" : `${d.lastLatencyMs} ms`}
                    </td>
                    <td className="text-right tabular-nums">{d.attempts}</td>
                    <td className="whitespace-nowrap text-fg-muted">
                      {d.status === "PENDING" ? when(d.nextAttemptAt) : "-"}
                    </td>
                    <td>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`View payload of ${d.eventType} ${d.eventId}`}
                          onClick={() => setOpen(d)}
                        >
                          <FileJson aria-hidden />
                          Payload
                        </Button>
                        {canEdit && (d.status === "DELIVERED" || d.status === "FAILED") && (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Redeliver ${d.eventType} ${d.eventId}`}
                            onClick={() => void redeliver(d)}
                          >
                            <RotateCcw aria-hidden />
                            Redeliver
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!rows.length && <TableEmpty colSpan={7} icon={Webhook} title="No deliveries." />}
            </tbody>
          </table>
        </TableFrame>
      )}
      {next && (
        <Button variant="outline" size="sm" className="self-start" onClick={() => void load(next)}>
          Load more
        </Button>
      )}
      {open && (
        <div role="region" aria-label="Payload" className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold">Payload of {open.eventType}</h3>
            <Button variant="ghost" size="sm" onClick={() => setOpen(null)}>
              Close payload
            </Button>
          </div>
          <pre
            tabIndex={0}
            aria-label="Payload JSON"
            className="max-h-80 overflow-auto rounded-md border border-border bg-sunken p-3 font-mono text-[13px]/5"
          >
            {JSON.stringify(open.payload, null, 2)}
          </pre>
        </div>
      )}
    </Card>
  );
}

type Day = { day: string; delivered: number; failed: number };
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** PS-ANALYTICS-19: delivered vs failed attempts per day, last 14 days; the table is the text alternative. */
function Overview({ tick }: { tick: number }) {
  const [days, setDays] = useState<Day[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    // the server buckets by workspace timezone: ending tomorrow (UTC) keeps the local today in range
    const to = new Date(Date.now() + 86_400_000);
    const from = new Date(to.getTime() - 14 * 86_400_000);
    void call(`/api/v1/webhooks/overview?from=${iso(from)}&to=${iso(to)}`, "GET").then((r) => {
      if (!r.ok) return setError(errorText(r));
      setDays(r.json.days as Day[]);
    });
  }, [tick]);
  // B4.16: axis and grid from tokens, bars 3px top radius, delivered success / failed danger
  const axis = {
    tick: { fontSize: 12, fill: "var(--chart-axis)" },
    axisLine: false,
    tickLine: false,
  };
  return (
    <figure
      aria-label="Deliveries per day"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 md:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <figcaption className="text-base font-semibold">
          Deliveries per day, last 14 days{" "}
          <span className="text-[13px]/[18px] font-normal text-fg-muted">
            (figures in the table below)
          </span>
        </figcaption>
        <span aria-hidden className="flex gap-3 text-[13px]/[18px] text-fg-muted">
          <span className="flex items-center gap-1.5">
            <span className="size-2 bg-success-solid" /> Delivered
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 bg-danger-solid" /> Failed
          </span>
        </span>
      </div>
      <Err text={error} />
      {days && !days.length && (
        <p className="text-[13px]/[18px] text-fg-muted">No delivery attempts yet.</p>
      )}
      {!!days?.length && (
        <>
          <div className="h-60">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={days}>
                <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="3 3" />
                <XAxis dataKey="day" {...axis} />
                <YAxis allowDecimals={false} width={40} {...axis} />
                <Tooltip
                  cursor={{ fill: "var(--hover)" }}
                  contentStyle={{
                    background: "var(--surface-elevated)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 13,
                  }}
                />
                <Bar
                  dataKey="delivered"
                  name="Delivered"
                  fill="var(--success-solid)"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={24}
                  isAnimationActive={false}
                />
                <Bar
                  dataKey="failed"
                  name="Failed"
                  fill="var(--danger-solid)"
                  radius={[3, 3, 0, 0]}
                  maxBarSize={24}
                  isAnimationActive={false}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          {/* the table stays open: it is the chart's text alternative and tests read it */}
          <TableFrame>
            <table aria-label="Deliveries by day">
              <Head cols={["Day", "Delivered", "Failed"]} right={["Delivered", "Failed"]} />
              <tbody>
                {days.map((d) => (
                  <tr key={d.day}>
                    <td className="tabular-nums">{d.day}</td>
                    <td className="text-right tabular-nums">{d.delivered}</td>
                    <td className="text-right tabular-nums">{d.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        </>
      )}
    </figure>
  );
}
