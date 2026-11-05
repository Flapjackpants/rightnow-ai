"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Callout } from "./callout";
import { SettingRow, SettingsCard } from "./settings-row";
import { StatusPill } from "./status-pill";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

type Source = {
  id: string;
  name: string;
  enabled: boolean;
  creditsUsedToday: number;
  dailyCreditCap: number;
  lastRunAt: string | null;
  lastError: string | null;
};
type Option = { id: string; name: string };
const ERRORS: Record<string, string> = {
  apollo_auth: "Apollo refused the key. Check it, then resume this search.",
  apollo_plan:
    "Your Apollo plan or key does not allow this endpoint. A master API key may be needed.",
  rate_limited: "Apollo rate limit reached. It will try again next hour.",
  apollo_no_emails: "Apollo returned no usable emails. You may be out of credits.",
  campaign_unavailable: "The campaign is gone or archived, so leads went to the list only.",
  no_api_key: "Add an API key.",
};
const split = (value: FormDataEntryValue | null, separator = ",") =>
  String(value ?? "")
    .split(separator)
    .map((x) => x.trim())
    .filter(Boolean);
async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? "Request failed");
  return json;
}

export function LeadSources({
  hasApiKey,
  sources,
  lists,
  campaigns,
}: {
  hasApiKey: boolean;
  sources: Source[];
  lists: Option[];
  campaigns: Option[];
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(hasApiKey);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  async function act(fn: () => Promise<unknown>) {
    setError("");
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    }
  }
  async function saveKey(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await act(async () => {
      await call("/api/v1/settings/apollo", "PUT", { apiKey: key });
      setSaved(true);
      setKey("");
    });
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const filters = Object.fromEntries(
      [
        ["personTitles", split(f.get("personTitles"))],
        ["personLocations", split(f.get("personLocations"))],
        ["personSeniorities", split(f.get("personSeniorities"))],
        ["organizationLocations", split(f.get("organizationLocations"))],
        ["employeeRanges", split(f.get("employeeRanges"), ";")],
      ].filter(([, v]) => (v as string[]).length),
    );
    const keywords = String(f.get("keywords") ?? "").trim();
    if (keywords) filters.keywords = keywords;
    await act(async () => {
      await call("/api/v1/lead-sources", "POST", {
        name: f.get("name"),
        filters,
        listId: f.get("listId"),
        campaignId: f.get("campaignId") || null,
        dailyCreditCap: Number(f.get("dailyCreditCap")),
        lawfulBasis: f.get("lawfulBasis"),
        confirmedAuthorized: f.get("confirmedAuthorized") === "on",
      });
      form.reset();
    });
  }
  return (
    <div className="flex flex-col gap-6 lg:max-w-240">
      {error && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      )}
      <SettingsCard
        id="apollo"
        title="Apollo API key"
        status={
          <StatusPill tone={saved ? "success" : "neutral"}>
            {saved ? "Key saved" : "No key"}
          </StatusPill>
        }
        description="The key is write-only and is never shown again."
      >
        <form onSubmit={saveKey} className="flex flex-col gap-3">
          <SettingRow htmlFor="apollo-key" label="API key">
            <Input
              id="apollo-key"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              required
            />
          </SettingRow>
          <Button className="self-start" type="submit">
            Save key
          </Button>
        </form>
        {saved && (
          <Button
            variant="outline"
            className="self-start"
            onClick={() =>
              void act(async () => {
                await call("/api/v1/settings/apollo", "PUT", { apiKey: null });
                setSaved(false);
              })
            }
          >
            Remove key
          </Button>
        )}
      </SettingsCard>
      {!saved && <Callout tone="neutral">Add an Apollo API key before running searches.</Callout>}
      <SettingsCard
        id="new-search"
        title="New search"
        description="Search uses no credits. Each email found costs 1 Apollo credit. Leads load only as fast as your mailboxes can take them."
      >
        <form onSubmit={create} className="flex flex-col gap-2">
          <SettingRow htmlFor="source-name" label="Name">
            <Input id="source-name" name="name" required maxLength={100} />
          </SettingRow>
          {(
            [
              ["personTitles", "Job titles", "CTO, VP"],
              ["personLocations", "Locations", "New York, Boston"],
              ["personSeniorities", "Seniorities", "director, vp"],
              ["organizationLocations", "Company locations", "United States, Canada"],
              ["employeeRanges", "Employee ranges", "1,10; 11,50"],
              ["keywords", "Keywords", "software"],
            ] as const
          ).map(([name, label, placeholder]) => (
            <SettingRow key={name} htmlFor={name} label={label}>
              <Input id={name} name={name} placeholder={placeholder} />
            </SettingRow>
          ))}
          <SettingRow htmlFor="source-list" label="List">
            <Select id="source-list" name="listId" required defaultValue="">
              <option value="" disabled>
                Choose a list
              </option>
              {lists.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </SettingRow>
          <SettingRow htmlFor="source-campaign" label="Campaign">
            <Select id="source-campaign" name="campaignId">
              <option value="">List only</option>
              {campaigns.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </SettingRow>
          <SettingRow htmlFor="source-cap" label="Daily credit cap">
            <Input
              id="source-cap"
              name="dailyCreditCap"
              type="number"
              min={1}
              max={10000}
              defaultValue={25}
              required
            />
          </SettingRow>
          <SettingRow htmlFor="source-basis" label="Lawful basis">
            <Select id="source-basis" name="lawfulBasis">
              <option value="legitimate_interest">Legitimate interest</option>
              <option value="consent">Consent</option>
              <option value="contract">Contract</option>
              <option value="other">Other</option>
            </Select>
          </SettingRow>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="confirmedAuthorized" required />I have the right to contact
            these people and have checked Apollo&apos;s terms
          </label>
          <Button type="submit" className="self-start" disabled={!lists.length}>
            Create search
          </Button>
        </form>
      </SettingsCard>
      <SettingsCard id="searches" title="Searches">
        {sources.length === 0 ? (
          <p>No searches yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {sources.map((s) => (
              <li key={s.id} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{s.name}</strong>
                  <StatusPill tone={s.enabled ? "success" : "neutral"}>
                    {s.enabled ? "Active" : "Paused"}
                  </StatusPill>
                </div>
                <p className="text-sm">
                  {s.creditsUsedToday} / {s.dailyCreditCap} credits today · Last run:{" "}
                  {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : "Never"}
                </p>
                {s.lastError && (
                  <p className="text-sm text-danger">{ERRORS[s.lastError] ?? s.lastError}</p>
                )}
                <div className="mt-2 flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() =>
                      void act(() =>
                        call(`/api/v1/lead-sources/${s.id}`, "PATCH", { enabled: !s.enabled }),
                      )
                    }
                  >
                    {s.enabled ? "Pause" : "Resume"}
                  </Button>
                  {pendingDelete === s.id ? (
                    <>
                      <Button
                        variant="destructive"
                        onClick={() =>
                          void act(async () => {
                            await call(`/api/v1/lead-sources/${s.id}`, "DELETE");
                            setPendingDelete(null);
                          })
                        }
                      >
                        Confirm delete
                      </Button>
                      <Button variant="outline" onClick={() => setPendingDelete(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button variant="danger-ghost" onClick={() => setPendingDelete(s.id)}>
                      Delete
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
    </div>
  );
}
