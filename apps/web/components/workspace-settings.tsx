"use client";

import { useRouter } from "next/navigation";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { Callout } from "./callout";
import { SettingRow, SettingsCard } from "./settings-row";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";

const cap = (v: FormDataEntryValue | null) => (String(v).trim() === "" ? null : Number(v));

export function WorkspaceSettings({
  timezone,
  physicalAddress,
  dailyCap,
  perCompanyDailyLimit,
  disableOpenTracking,
  firstEmailTextOnly,
  storeNonLeadMail,
}: {
  timezone: string;
  physicalAddress: string;
  dailyCap: number | null;
  perCompanyDailyLimit: number | null;
  disableOpenTracking: boolean;
  firstEmailTextOnly: boolean;
  storeNonLeadMail: boolean;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState("");

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const res = await fetch("/api/v1/settings/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        timezone: f.get("timezone"),
        physicalAddress: f.get("physicalAddress"),
        dailyCap: cap(f.get("dailyCap")),
        perCompanyDailyLimit: cap(f.get("perCompanyDailyLimit")),
        disableOpenTracking: f.has("disableOpenTracking"),
        firstEmailTextOnly: f.has("firstEmailTextOnly"),
        storeNonLeadMail: f.has("storeNonLeadMail"),
      }),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    setMsg(res.ok ? "Saved." : (j.error ?? "Request failed"));
    if (res.ok) router.refresh();
  }

  const [flags, setFlags] = useState({ disableOpenTracking, firstEmailTextOnly, storeNonLeadMail });
  const flag = (k: keyof typeof flags) => ({
    name: k,
    checked: flags[k],
    onChange: (e: ChangeEvent<HTMLInputElement>) =>
      setFlags((f) => ({ ...f, [k]: e.target.checked })),
  });

  return (
    <SettingsCard id="workspace" title="Workspace">
      <form onSubmit={save} className="flex flex-col">
        <SettingRow htmlFor="timezone" label="Timezone (IANA name, e.g. Europe/Berlin)">
          <Input id="timezone" name="timezone" defaultValue={timezone} required />
        </SettingRow>
        <SettingRow
          htmlFor="physicalAddress"
          label="Physical postal address"
          helper="Printed in every campaign email footer (CAN-SPAM). Required to launch: campaigns cannot launch or send while it is empty."
        >
          <Input
            id="physicalAddress"
            name="physicalAddress"
            aria-describedby="physicalAddress-help"
            defaultValue={physicalAddress}
            maxLength={500}
          />
        </SettingRow>
        <SettingRow
          htmlFor="dailyCap"
          label="Daily send cap for all campaigns (empty = no cap)"
          helper="Recommended: about 30 per connected account per day."
        >
          <Input
            id="dailyCap"
            name="dailyCap"
            type="number"
            min={1}
            aria-describedby="dailyCap-help"
            defaultValue={dailyCap ?? ""}
          />
        </SettingRow>
        <SettingRow
          htmlFor="perCompanyDailyLimit"
          label="Daily emails per company (empty = no limit)"
        >
          <Input
            id="perCompanyDailyLimit"
            name="perCompanyDailyLimit"
            type="number"
            min={1}
            defaultValue={perCompanyDailyLimit ?? ""}
          />
        </SettingRow>
        <SettingRow
          label="Sending options"
          helper="When saving emails from non-leads is off, replies from people who are not leads and not in a known thread are not saved. Bounces and unsubscribes are always processed."
        >
          <Switch label="Never track opens" {...flag("disableOpenTracking")} />
          <Switch
            label="Send the first email of every sequence as plain text"
            {...flag("firstEmailTextOnly")}
          />
          <Switch label="Save emails from non-leads" {...flag("storeNonLeadMail")} />
          {!flags.storeNonLeadMail && (
            <Callout tone="warning">
              Replies from unknown addresses are discarded and cannot be recovered, including
              referrals.
            </Callout>
          )}
        </SettingRow>
        <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
          <p role="status" className="mr-auto text-[13px]/[18px]">
            {msg}
          </p>
          <Button type="submit">Save</Button>
        </div>
      </form>
    </SettingsCard>
  );
}
