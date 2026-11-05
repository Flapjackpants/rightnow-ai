"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { SettingRow, SettingsCard } from "./settings-row";
import { StatusPill } from "./status-pill";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

type Pipeline = { id: string; label: string; stages: { id: string; label: string }[] };
type Props = {
  connected: boolean;
  pipelineId?: string;
  stageMap?: Record<string, string>;
  lastRunAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  customersPulledAt: string | null;
  stages: { id: string; name: string }[];
};
const ERRORS: Record<string, string> = {
  hubspot_auth: "HubSpot refused the key. Check it and connect again.",
  hubspot_scope: "The key is missing a scope. See docs/ops/HUBSPOT_SETUP.md.",
  hubspot_unmapped_stage: "Some deals are in a stage you chose not to sync.",
  hubspot_partial: "HubSpot did not accept every record. It will try again.",
  rate_limited: "HubSpot rate limit reached. It will try again.",
  token_required: "Enter a service key.",
};
const message = (code: string) => ERRORS[code] ?? code;
const fmt = (date: string) => new Date(date).toLocaleString();

export function HubspotSettings(s: Props) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [pipelineId, setPipelineId] = useState(s.pipelineId ?? "");
  const [stageMap, setStageMap] = useState(s.stageMap ?? {});
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = pipelines.find((p) => p.id === pipelineId);

  async function call(url: string, method: string, body?: unknown) {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        pipelines?: Pipeline[];
      };
      if (!res.ok) throw new Error(message(data.error ?? "Request failed"));
      return data;
    } finally {
      setBusy(false);
    }
  }

  async function load() {
    try {
      const data = await call(
        "/api/v1/settings/hubspot/pipelines",
        "POST",
        key ? { token: key } : {},
      );
      setPipelines(data.pipelines ?? []);
      setPipelineId((current) => current || data.pipelines?.[0]?.id || "");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Request failed");
    }
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      await call("/api/v1/settings/hubspot", "PUT", {
        ...(key && { token: key }),
        pipelineId,
        stageMap: Object.fromEntries(Object.entries(stageMap).filter(([, value]) => value)),
      });
      setKey("");
      setMsg("Saved.");
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Request failed");
    }
  }
  async function disconnect() {
    if (!confirm("Disconnect HubSpot? Syncing stops immediately.")) return;
    try {
      await call("/api/v1/settings/hubspot", "DELETE");
      setKey("");
      setPipelines([]);
      setPipelineId("");
      setStageMap({});
      setMsg("Disconnected.");
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Request failed");
    }
  }

  return (
    <SettingsCard
      id="hubspot"
      title="HubSpot"
      status={
        <StatusPill tone={s.connected ? "success" : "neutral"}>
          {s.connected ? "Connected" : "Not connected"}
        </StatusPill>
      }
    >
      {(s.lastRunAt || s.customersPulledAt) && (
        <p className="text-[13px]/[18px] text-fg-muted">
          {s.lastRunAt && `Last run: ${fmt(s.lastRunAt)}`}
          {s.lastRunAt && s.customersPulledAt && " · "}
          {s.customersPulledAt && `Customers pulled: ${fmt(s.customersPulledAt)}`}
        </p>
      )}
      {s.lastError && (
        <p role="alert" className="text-[13px]/[18px] text-danger">
          {message(s.lastError)}
          {s.lastErrorAt && ` (${fmt(s.lastErrorAt)})`}
        </p>
      )}
      <form onSubmit={save} className="flex flex-col">
        <SettingRow
          htmlFor="hubspotKey"
          label="Service key"
          helper="From HubSpot under Development, Keys, Service keys. Write-only: it is never shown again."
        >
          <Input
            id="hubspotKey"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            aria-describedby="hubspotKey-help"
            placeholder={s.connected ? "Stored: leave empty to keep it" : ""}
          />
        </SettingRow>
        <div className="flex justify-end py-3">
          <Button
            type="button"
            variant="outline"
            disabled={busy || (!key && !s.connected)}
            onClick={() => void load()}
          >
            Load pipelines
          </Button>
        </div>
        {pipelines.length > 0 && (
          <>
            <SettingRow htmlFor="hubspotPipeline" label="Pipeline">
              <Select
                id="hubspotPipeline"
                value={pipelineId}
                onChange={(e) => {
                  setPipelineId(e.target.value);
                  setStageMap(e.target.value === s.pipelineId ? (s.stageMap ?? {}) : {});
                }}
              >
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </SettingRow>
            {s.stages.map((stage) => (
              <SettingRow key={stage.id} htmlFor={`hubspotStage-${stage.id}`} label={stage.name}>
                <Select
                  id={`hubspotStage-${stage.id}`}
                  value={stageMap[stage.id] ?? ""}
                  onChange={(e) => setStageMap((m) => ({ ...m, [stage.id]: e.target.value }))}
                >
                  <option value="">Do not sync</option>
                  {selected?.stages.map((hs) => (
                    <option key={hs.id} value={hs.id}>
                      {hs.label}
                    </option>
                  ))}
                </Select>
              </SettingRow>
            ))}
          </>
        )}
        <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
          <p role="status" className="mr-auto text-[13px]/[18px]">
            {msg}
          </p>
          {s.connected && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              Disconnect
            </Button>
          )}
          <Button type="submit" disabled={busy || !pipelineId}>
            Save
          </Button>
        </div>
      </form>
    </SettingsCard>
  );
}
