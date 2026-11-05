"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "../../../../components/ui/button";
import { Card } from "../../../../components/ui/card";
import { Helper, Input } from "../../../../components/ui/input";
import { Label } from "../../../../components/ui/label";
import { Select } from "../../../../components/ui/select";
import { Switch } from "../../../../components/ui/switch";
import { call, errorText } from "../../accounts/api-client";
import type { CampaignView } from "./campaign-builder";

type Kind = "bool" | "int" | "list" | "text" | "metric";
const METRICS = [
  ["reply", "Reply rate"],
  ["click", "Click rate"],
  ["open", "Open rate (estimated)"],
];
const FIELDS: { k: string; label: string; kind: Kind; hint?: string }[] = [
  { k: "name", label: "Campaign name", kind: "text" },
  { k: "tags", label: "Tags (comma separated)", kind: "list" },
  { k: "evergreen", label: "Evergreen (keep adding new leads)", kind: "bool" },
  { k: "dailyLimit", label: "Daily limit", kind: "int", hint: "Empty means no campaign limit." },
  {
    k: "maxNewLeadsPerDay",
    label: "Max new leads per day",
    kind: "int",
    hint: "0 sends no first emails.",
  },
  { k: "perCompanyDailyLimit", label: "Per-company daily limit", kind: "int" },
  { k: "minGapSec", label: "Minimum gap between emails (seconds)", kind: "int" },
  { k: "randomGapSec", label: "Random extra gap (seconds)", kind: "int" },
  { k: "stopOnReply", label: "Stop on reply", kind: "bool" },
  { k: "stopOnAutoReply", label: "Stop on auto-reply", kind: "bool" },
  { k: "stopForCompanyOnReply", label: "Stop for the whole company on reply", kind: "bool" },
  { k: "trackOpens", label: "Track opens", kind: "bool" },
  { k: "trackClicks", label: "Track clicks", kind: "bool" },
  { k: "textOnly", label: "Text only", kind: "bool" },
  { k: "firstEmailTextOnly", label: "First email text only", kind: "bool" },
  { k: "prioritizeNewLeads", label: "Prioritize new leads", kind: "bool" },
  { k: "matchProvider", label: "Match lead's email provider", kind: "bool" },
  { k: "allowRisky", label: "Email risky addresses", kind: "bool" },
  { k: "allowCatchAll", label: "Email catch-all addresses", kind: "bool" },
  { k: "bounceProtect", label: "Bounce protection", kind: "bool" },
  { k: "unsubscribeLink", label: "Include unsubscribe link in the footer", kind: "bool" },
  { k: "optOutText", label: "Opt-out message", kind: "text" },
  { k: "cc", label: "CC (comma separated)", kind: "list" },
  { k: "bcc", label: "BCC (comma separated)", kind: "list" },
  { k: "plValue", label: "Pipeline value per lead", kind: "int" },
  { k: "abAutoOptimize", label: "Auto-optimize A/Z", kind: "bool" },
  {
    k: "abWinnerMetric",
    label: "Winner metric",
    kind: "metric",
    hint: "Needs at least 100 sends per variant.",
  },
  { k: "abResetDaily", label: "Reset variant balance daily", kind: "bool" },
];
// Same text as DEFAULT_OPT_OUT_TEXT in @rightnow/core (a client component cannot import it).
const DEFAULT_OPT_OUT = 'Not interested? Just reply "unsubscribe" and I won\'t email you again.';
type Rule = { action: string; recipientEsp: string; senderEsp: string };
const ESP = ["all", "google", "outlook", "other"];
/** B5.6 Options groups, in this order; field labels are unchanged. */
const GROUPS: [string, string[]][] = [
  [
    "Sending",
    [
      "dailyLimit",
      "maxNewLeadsPerDay",
      "minGapSec",
      "randomGapSec",
      "perCompanyDailyLimit",
      "prioritizeNewLeads",
      "matchProvider",
    ],
  ],
  ["Stopping", ["stopOnReply", "stopOnAutoReply", "stopForCompanyOnReply", "bounceProtect"]],
  ["Tracking", ["trackOpens", "trackClicks"]],
  ["Content", ["textOnly", "firstEmailTextOnly", "unsubscribeLink", "optOutText"]],
  ["A/B", ["abAutoOptimize", "abWinnerMetric", "abResetDaily"]],
  ["Other", ["name", "tags", "cc", "bcc", "evergreen", "allowRisky", "allowCatchAll", "plValue"]],
];
const HELP: Record<string, string> = {
  trackOpens: "Opens are estimated: image blocking and privacy proxies distort them.",
};

const show = (v: unknown, kind: Kind) =>
  kind === "list" ? ((v as string[]) ?? []).join(", ") : v == null ? "" : String(v);
const initial = (v: unknown, kind: Kind) =>
  kind === "metric" ? String(v ?? "reply") : show(v, kind);
const split = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export function OptionsTab({
  campaignId,
  campaign,
  members,
  canEdit,
  onChange,
}: {
  campaignId: string;
  campaign: CampaignView;
  members: { userId: string; name: string }[];
  canEdit: boolean;
  onChange: () => void;
}) {
  const [form, setForm] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      FIELDS.map((f) => [
        f.k,
        f.kind === "bool"
          ? Boolean(campaign[f.k])
          : f.k === "optOutText"
            ? String(campaign[f.k] ?? DEFAULT_OPT_OUT)
            : initial(campaign[f.k], f.kind),
      ]),
    ),
  );
  const [owner, setOwner] = useState((campaign.ownerId as string | null) ?? "");
  const [rules, setRules] = useState<Rule[]>((campaign.espRoutingRules as Rule[]) ?? []);
  const [msg, setMsg] = useState("");
  const set = (k: string, v: string | boolean) => setForm((o) => ({ ...o, [k]: v }));

  async function save() {
    const body: Record<string, unknown> = {
      espRoutingRules: rules,
      ownerId: owner || null,
      unsubscribeHeader: true,
    };
    for (const f of FIELDS) {
      const v = form[f.k];
      if (f.kind === "bool") body[f.k] = v;
      else if (f.kind === "list") body[f.k] = split(v as string);
      else if (f.kind === "int") {
        const t = (v as string).trim();
        body[f.k] = t === "" ? null : Number(t);
        // required numbers: an empty box keeps the stored value instead of sending null
        if (t === "" && (f.k === "minGapSec" || f.k === "randomGapSec")) delete body[f.k];
      } else body[f.k] = f.k === "name" ? v : (v as string).trim() || null;
    }
    const r = await call(`/api/v1/campaigns/${campaignId}`, "PATCH", body);
    setMsg(r.ok ? "Options saved." : errorText(r));
    if (r.ok) onChange();
  }

  const field = (f: (typeof FIELDS)[number]) => {
    if (f.k === "optOutText" && form.unsubscribeLink) return null;
    if (f.kind === "bool")
      return (
        <div key={f.k} className="flex flex-col">
          <Switch
            label={f.label}
            checked={form[f.k] as boolean}
            onChange={(e) => set(f.k, e.target.checked)}
            aria-describedby={HELP[f.k] ? `opt-${f.k}-hint` : undefined}
          />
          {HELP[f.k] && <Helper id={`opt-${f.k}-hint`}>{HELP[f.k]}</Helper>}
        </div>
      );
    return (
      <div key={f.k} className="flex flex-col gap-1.5">
        <Label htmlFor={`opt-${f.k}`}>{f.label}</Label>
        {f.kind === "metric" ? (
          <Select
            id={`opt-${f.k}`}
            value={form[f.k] as string}
            onChange={(e) => set(f.k, e.target.value)}
            aria-describedby={`opt-${f.k}-hint`}
          >
            {METRICS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            id={`opt-${f.k}`}
            type={f.kind === "int" ? "number" : "text"}
            min={f.kind === "int" ? 0 : undefined}
            step={f.k === "plValue" ? "any" : undefined}
            value={form[f.k] as string}
            onChange={(e) => set(f.k, e.target.value)}
            aria-describedby={f.hint || f.k === "optOutText" ? `opt-${f.k}-hint` : undefined}
          />
        )}
        {f.k === "optOutText" && (
          <Helper id="opt-optOutText-hint">
            Replaces the link. Replies asking to unsubscribe are detected automatically and the lead
            is suppressed.
          </Helper>
        )}
        {f.hint && <Helper id={`opt-${f.k}-hint`}>{f.hint}</Helper>}
      </div>
    );
  };
  const group = (title: string, extra?: ReactNode) => (
    <Card key={title} className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {GROUPS.find(([t]) => t === title)![1].map((k) => field(FIELDS.find((f) => f.k === k)!))}
      </div>
      {extra}
    </Card>
  );

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={!canEdit} className="flex flex-col gap-3">
        {group(
          "Sending",
          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <h4 className="text-[13px]/[18px] font-medium">Provider routing rules</h4>
            {rules.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
                {(
                  [
                    ["action", ["send", "do_not_send"], "Action"],
                    ["senderEsp", ESP, "Sender provider"],
                    ["recipientEsp", ESP, "Recipient provider"],
                  ] as const
                ).map(([k, opts, label]) => (
                  <Select
                    key={k}
                    size="sm"
                    aria-label={`${label} of rule ${i + 1}`}
                    className="w-auto"
                    value={r[k]}
                    onChange={(e) =>
                      setRules((o) =>
                        o.map((x, n) => (n === i ? { ...x, [k]: e.target.value } : x)),
                      )
                    }
                  >
                    {opts.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </Select>
                ))}
                <Button
                  type="button"
                  variant="danger-ghost"
                  size="sm"
                  onClick={() => setRules((o) => o.filter((_, n) => n !== i))}
                >
                  <Trash2 aria-hidden />
                  Remove rule {i + 1}
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() =>
                setRules((o) => [...o, { action: "send", recipientEsp: "all", senderEsp: "all" }])
              }
            >
              <Plus aria-hidden />
              Add rule
            </Button>
          </div>,
        )}
        {group("Stopping")}
        {group("Tracking")}
        {group(
          "Content",
          <div className="flex flex-col">
            <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
              <input type="checkbox" checked disabled aria-describedby="unsub-why" />
              Unsubscribe header
            </label>
            <Helper id="unsub-why">
              Always on: every campaign email carries a List-Unsubscribe header, and unsubscribes
              are always honored.
            </Helper>
          </div>,
        )}
        {group("A/B")}
        {group(
          "Other",
          <div className="flex flex-col gap-1.5 sm:w-1/2 sm:pr-3">
            <Label htmlFor="opt-owner">Owner</Label>
            <Select id="opt-owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">No owner</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>,
        )}
      </fieldset>
      {canEdit && (
        <div className="flex items-center gap-3 max-md:sticky max-md:bottom-0 max-md:z-(--z-sticky) max-md:-mx-4 max-md:border-t max-md:border-border max-md:bg-bg max-md:px-4 max-md:py-3">
          <Button type="submit" className="max-md:flex-1">
            Save options
          </Button>
          <p role="status" className="text-sm">
            {msg}
          </p>
        </div>
      )}
    </form>
  );
}
