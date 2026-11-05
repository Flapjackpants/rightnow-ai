"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Callout } from "./callout";
import { SettingRow, SettingsCard } from "./settings-row";
import { StatusPill } from "./status-pill";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

type Props = {
  kind: string;
  url?: string;
  statusPath?: string;
  hasApiKey?: boolean;
  lastError?: { reason: string; at: string | Date | null };
};

/**
 * Email verifier (D38): GET/PUT /settings/verifier. The API key is write-only: the stored one is never shown. The form
 * remounts when the saved values change, so the inputs show what was saved and the key field is empty again.
 */
export function VerifierSettings(v: Props) {
  const [msg, setMsg] = useState("");
  return (
    <VerifierForm
      key={JSON.stringify([v.kind, v.url, v.statusPath, v.hasApiKey])}
      {...v}
      msg={msg}
      setMsg={setMsg}
    />
  );
}

function VerifierForm({ msg, setMsg, ...v }: Props & { msg: string; setMsg: (m: string) => void }) {
  const router = useRouter();
  const [kind, setKind] = useState(v.kind);
  const external = kind === "http" || kind === "millionverifier";

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const key = String(f.get("apiKey") ?? "");
    const res = await fetch("/api/v1/settings/verifier", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        kind === "http"
          ? {
              kind,
              url: f.get("url"),
              statusPath: f.get("statusPath"),
              ...(key && { apiKey: key }), // empty = keep the stored key
            }
          : { kind, ...(key && { apiKey: key }) },
      ),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    setMsg(
      res.ok
        ? "Saved."
        : j.error === "api_key_required"
          ? "Enter the API key: a new host needs its own key."
          : (j.error ?? "Request failed"),
    );
    if (res.ok) router.refresh();
  }

  return (
    <SettingsCard
      id="verifier"
      title="Email verification"
      status={
        v.kind !== "mx" ? (
          v.hasApiKey ? (
            <StatusPill tone="success">Key saved</StatusPill>
          ) : (
            <StatusPill tone="warning">No key</StatusPill>
          )
        ) : undefined
      }
    >
      <form onSubmit={save} className="flex flex-col">
        <SettingRow
          htmlFor="verifierKind"
          label="Verifier"
          helper="The built-in check never marks an address verified. An external service is paid for by you."
        >
          <Select
            id="verifierKind"
            value={kind}
            aria-describedby="verifierKind-help"
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="mx">Built in (syntax and MX records)</option>
            <option value="http">External service (HTTPS)</option>
            <option value="millionverifier">MillionVerifier</option>
          </Select>
        </SettingRow>
        {external && (
          <>
            {kind === "http" && (
              <SettingRow
                htmlFor="verifierUrl"
                label="Service URL (https)"
                helper={`Receives a POST with {"email": "..."} and an Authorization: Bearer header.`}
              >
                <Input
                  id="verifierUrl"
                  name="url"
                  type="url"
                  className="font-mono md:text-[13px]"
                  aria-describedby="verifierUrl-help"
                  defaultValue={v.url}
                  required
                />
              </SettingRow>
            )}
            <SettingRow
              htmlFor="verifierKey"
              label="API key"
              helper="Write-only: the stored key is never shown."
            >
              <Input
                id="verifierKey"
                name="apiKey"
                type="password"
                autoComplete="off"
                aria-describedby="verifierKey-help"
                placeholder={v.hasApiKey ? "Stored: leave empty to keep it" : ""}
              />
              {kind === "http" && (
                <Callout tone="warning">Changing the host requires a new key.</Callout>
              )}
            </SettingRow>
            {kind === "http" && (
              <SettingRow
                htmlFor="verifierPath"
                label="Response field with the result (e.g. result.status)"
              >
                <Input
                  id="verifierPath"
                  name="statusPath"
                  className="font-mono md:text-[13px]"
                  defaultValue={v.statusPath}
                  pattern="[A-Za-z0-9_.]{1,64}"
                  required
                />
              </SettingRow>
            )}
          </>
        )}
        {v.lastError && (
          <p
            role="alert"
            className="mb-3 rounded-md border border-danger-solid/30 bg-danger-tint px-3.5 py-3 text-[13px]/[18px]"
          >
            Last verifier error: {v.lastError.reason}
            {v.lastError.at && ` (${new Date(v.lastError.at).toLocaleString()})`}
          </p>
        )}
        <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
          <p role="status" className="mr-auto text-[13px]/[18px]">
            {msg}
          </p>
          <Button type="submit">Save verifier</Button>
        </div>
      </form>
    </SettingsCard>
  );
}
