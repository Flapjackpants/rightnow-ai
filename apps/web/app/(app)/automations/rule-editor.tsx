"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { focusOnMount } from "../../../components/inline-editor";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Select } from "../../../components/ui/select";
import { call, errorText } from "../accounts/api-client";
import type { Named } from "../leads/bulk-bar";
import { INTEREST } from "../leads/labels";
import {
  ACTION_TYPES,
  toAction,
  toDraft,
  TRIGGERS,
  type Draft,
  type Refs,
  type Rule,
  type Source,
} from "./rule-meta";

export type { Refs, Rule };

// B4.22: the editor reads as WHEN / IF / THEN blocks
const block = "flex flex-col gap-3 rounded-md border border-border p-3";
const blockTitle = "micro text-fg-muted";
const csv = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

type Territory = { countries?: string[]; regions?: string[]; userId: string };
const jsonRows = <T,>(value: string | undefined): T[] => {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
};

function TerritoryRows({
  value,
  members,
  onChange,
}: {
  value: string | undefined;
  members: Refs["members"];
  onChange: (value: string) => void;
}) {
  const rows = jsonRows<Territory>(value);
  const put = (next: Territory[]) => onChange(JSON.stringify(next));
  const edit = (i: number, patch: Partial<Territory>) =>
    put(rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm">
            Countries
            <Input
              aria-label={`Territory ${i + 1} countries`}
              value={(row.countries ?? []).join(", ")}
              onChange={(e) => edit(i, { countries: csv(e.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Regions
            <Input
              aria-label={`Territory ${i + 1} regions`}
              value={(row.regions ?? []).join(", ")}
              onChange={(e) => edit(i, { regions: csv(e.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Rep
            <Select
              aria-label={`Territory ${i + 1} rep`}
              value={row.userId ?? ""}
              onChange={(e) => edit(i, { userId: e.target.value })}
            >
              <option value="">Choose</option>
              {members.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.name}
                </option>
              ))}
            </Select>
          </label>
          <Button
            type="button"
            variant="danger-ghost"
            size="sm"
            onClick={() => put(rows.filter((_, j) => j !== i))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => put([...rows, { userId: "" }])}
      >
        Add territory
      </Button>
    </div>
  );
}

export function RuleEditor({
  rule,
  refs,
  onSaved,
  onCancel,
}: {
  rule: Rule | null;
  refs: Refs;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const c = rule?.conditions ?? {};
  const [name, setName] = useState(rule?.name ?? "");
  const [trigger, setTrigger] = useState(rule?.trigger ?? "reply_received");
  const [campaignIds, setCampaignIds] = useState(c.campaignIds ?? []);
  const [accountIds, setAccountIds] = useState(c.accountIds ?? []);
  const [codes, setCodes] = useState(c.interestCodes ?? []);
  const [tags, setTags] = useState((c.leadTags ?? []).join(", "));
  const [labels, setLabels] = useState((c.labels ?? []).join(", "));
  const [actions, setActions] = useState<Draft[]>(
    rule ? rule.actions.map(toDraft) : [{ type: "create_task", v: {} }],
  );
  const [error, setError] = useState("");

  const patchAction = (i: number, d: Partial<Draft>) =>
    setActions((a) => a.map((x, j) => (j === i ? { ...x, ...d } : x)));
  const move = (i: number, by: number) =>
    setActions((a) => {
      const n = [...a];
      [n[i], n[i + by]] = [n[i + by]!, n[i]!];
      return n;
    });
  const toggle = <T,>(set: (f: (s: T[]) => T[]) => void, x: T) =>
    set((s) => (s.includes(x) ? s.filter((y) => y !== x) : [...s, x]));

  async function save(e: FormEvent) {
    e.preventDefault();
    const body = {
      name: name.trim(),
      trigger,
      conditions: {
        ...(campaignIds.length && { campaignIds }),
        ...(accountIds.length && { accountIds }),
        ...(csv(tags).length && { leadTags: csv(tags) }),
        ...(csv(labels).length && { labels: csv(labels) }),
        ...(codes.length && { interestCodes: codes }),
      },
      actions: actions.map(toAction),
    };
    const r = await call(
      rule ? `/api/v1/automations/rules/${rule.id}` : "/api/v1/automations/rules",
      rule ? "PATCH" : "POST",
      body,
    );
    if (!r.ok) return setError(errorText(r));
    onSaved();
  }

  const options = (s: Source) =>
    s === "members" ? refs.members.map((m) => ({ id: m.userId, name: m.name })) : refs[s];

  return (
    <Card>
      <form
        onSubmit={save}
        className="flex flex-col gap-4"
        aria-label={rule ? "Edit rule" : "New rule"}
      >
        <h2 ref={focusOnMount} tabIndex={-1} className="text-base font-semibold outline-none">
          {rule ? "Edit rule" : "New rule"}
        </h2>
        {error && (
          <p role="alert" className="text-[13px]/[18px] text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-col gap-1.5 sm:max-w-sm">
          <Label htmlFor="rule-name">Name</Label>
          <Input
            id="rule-name"
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <section className={block}>
          <div className="flex flex-col gap-1.5 sm:max-w-sm">
            <Label htmlFor="rule-trigger" className={blockTitle}>
              When
            </Label>
            <Select id="rule-trigger" value={trigger} onChange={(e) => setTrigger(e.target.value)}>
              {!(trigger in TRIGGERS) && (
                <option value={trigger}>Unsupported trigger ({trigger})</option>
              )}
              {Object.entries(TRIGGERS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
        </section>

        <fieldset className={block}>
          <legend className="micro px-1 text-fg-muted">If (leave empty for any)</legend>
          <Checks
            legend="Campaigns"
            items={refs.campaigns}
            on={campaignIds}
            toggle={(id) => toggle(setCampaignIds, id)}
          />
          <Checks
            legend="Mailboxes"
            items={refs.accounts}
            on={accountIds}
            toggle={(id) => toggle(setAccountIds, id)}
          />
          <div
            role="group"
            aria-label="Lead status"
            className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]/[18px]"
          >
            <span className="w-full font-medium">Lead status</span>
            {Object.entries(INTEREST).map(([code, label]) => (
              <label key={code} className="flex min-h-11 items-center gap-1.5 md:min-h-7">
                <input
                  type="checkbox"
                  checked={codes.includes(Number(code))}
                  onChange={() => toggle(setCodes, Number(code))}
                />
                {label}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-tags">Lead has tags (comma separated)</Label>
              <Input id="rule-tags" value={tags} onChange={(e) => setTags(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rule-labels">Label is (comma separated)</Label>
              <Input id="rule-labels" value={labels} onChange={(e) => setLabels(e.target.value)} />
            </div>
          </div>
        </fieldset>

        <section className={block}>
          <h3 className={blockTitle}>Then</h3>
          <ol aria-label="Actions" className="flex flex-col gap-3">
            {actions.map((a, i) => (
              <li key={i}>
                <fieldset
                  aria-label={`Action ${i + 1}`}
                  className="flex flex-wrap items-end gap-3 rounded-md bg-sunken p-3"
                >
                  {a.raw ? (
                    <p className="pb-2 text-[13px]/[18px]">
                      Then {i + 1}: Unsupported action ({a.type}), kept as it is
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`act-type-${i}`}>Then {i + 1}</Label>
                      <Select
                        id={`act-type-${i}`}
                        value={a.type}
                        onChange={(e) => patchAction(i, { type: e.target.value, v: {} })}
                      >
                        {Object.entries(ACTION_TYPES).map(([k, t]) => (
                          <option key={k} value={k}>
                            {t.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                  )}
                  {(a.raw ? [] : ACTION_TYPES[a.type]!.fields).map((f) => {
                    const id = `act-${i}-${f.key}`;
                    const set = (x: string) => patchAction(i, { v: { ...a.v, [f.key]: x } });
                    return f.kind === "check" ? (
                      <label
                        key={f.key}
                        className="flex min-h-11 items-center gap-1.5 text-sm md:min-h-9"
                      >
                        <input
                          type="checkbox"
                          checked={!!a.v[f.key]}
                          onChange={(e) => set(e.target.checked ? "1" : "")}
                        />
                        {f.label}
                      </label>
                    ) : f.kind === "members" ? (
                      <fieldset key={f.key} className="flex flex-col gap-1.5">
                        <legend className="text-sm">{f.label}</legend>
                        {refs.members.map((member) => {
                          const chosen = jsonRows<string>(a.v[f.key]);
                          return (
                            <label
                              key={member.userId}
                              className="flex items-center gap-1.5 text-sm"
                            >
                              <input
                                type="checkbox"
                                checked={chosen.includes(member.userId)}
                                onChange={() =>
                                  set(
                                    JSON.stringify(
                                      chosen.includes(member.userId)
                                        ? chosen.filter((id) => id !== member.userId)
                                        : [...chosen, member.userId],
                                    ),
                                  )
                                }
                              />
                              {member.name}
                            </label>
                          );
                        })}
                      </fieldset>
                    ) : f.kind === "territories" ? (
                      <div key={f.key} className="flex flex-col gap-1.5">
                        <span className="text-sm">{f.label}</span>
                        <TerritoryRows value={a.v[f.key]} members={refs.members} onChange={set} />
                      </div>
                    ) : (
                      <div key={f.key} className="flex flex-col gap-1.5">
                        <Label htmlFor={id}>{f.label}</Label>
                        {f.kind === "select" ? (
                          <Select
                            id={id}
                            required={f.required}
                            value={a.v[f.key] ?? ""}
                            onChange={(e) => set(e.target.value)}
                          >
                            <option value="">{f.required ? "Choose" : "Any"}</option>
                            {options(f.source!).map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.name}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <Input
                            id={id}
                            type={f.kind}
                            min={f.kind === "number" ? 0 : undefined}
                            required={f.required}
                            value={a.v[f.key] ?? ""}
                            onChange={(e) => set(e.target.value)}
                          />
                        )}
                      </div>
                    );
                  })}
                  <div className="ml-auto flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Move action ${i + 1} up`}
                      title="Up"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Move action ${i + 1} down`}
                      title="Down"
                      disabled={i === actions.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="danger-ghost"
                      size="icon-sm"
                      aria-label={`Remove action ${i + 1}`}
                      title="Remove"
                      disabled={actions.length === 1}
                      onClick={() => setActions((x) => x.filter((_, j) => j !== i))}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </fieldset>
              </li>
            ))}
          </ol>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start"
            disabled={actions.length >= 10}
            onClick={() => setActions((a) => [...a, { type: "create_task", v: {} }])}
          >
            <Plus aria-hidden />
            Add action
          </Button>
        </section>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit">Save rule</Button>
        </div>
      </form>
    </Card>
  );
}

function Checks({
  legend,
  items,
  on,
  toggle,
}: {
  legend: string;
  items: Named[];
  on: string[];
  toggle: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div
      role="group"
      aria-label={legend}
      className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]/[18px]"
    >
      <span className="w-full font-medium">{legend}</span>
      {items.map((i) => (
        <label key={i.id} className="flex min-h-11 items-center gap-1.5 md:min-h-7">
          <input type="checkbox" checked={on.includes(i.id)} onChange={() => toggle(i.id)} />
          {i.name}
        </label>
      ))}
    </div>
  );
}
