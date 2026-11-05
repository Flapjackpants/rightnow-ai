"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { chipClass } from "../../../components/overlay";
import { INTEREST as INTEREST_PILL, pillFor, StatusPill } from "../../../components/status-pill";
import { Input, Textarea } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { call, errorText } from "../accounts/api-client";
import { INTEREST } from "../leads/labels";
import type { Detail } from "./types";

const day = (iso: string) => new Date(iso).toLocaleDateString();
const CREATE_LEAD_ERRORS: Record<string, string> = {
  not_a_person: "This conversation has no sender to add as a lead.",
  suppressed: "This address opted out or was erased.",
  lead_attached: "A lead is already linked to this conversation.",
};

export function LeadPanel({
  d,
  canEdit,
  onChanged,
  onResult,
}: {
  d: Detail;
  canEdit: boolean;
  onChanged: () => void;
  onResult: (ok: string, err: string) => void;
}) {
  const [note, setNote] = useState("");
  const [email, setEmail] = useState("");
  const lead = d.lead;
  const ooo = [...d.messages].reverse().find((m) => m.kind === "AUTO_REPLY" && m.oooUntil);
  const next = d.scheduled[0];

  async function addNote() {
    const r = await call("/api/v1/inbox/notes", "POST", { threadId: d.id, body: note });
    if (!r.ok) return onResult("", errorText(r));
    setNote("");
    onChanged();
  }

  // PS-INBOX-05: a reply from another address is linked to the lead it belongs to
  async function attachById(leadId: string, done: string) {
    const r = await call(`/api/v1/inbox/threads/${d.id}/attach-lead`, "POST", { leadId });
    if (!r.ok) return onResult("", errorText(r));
    onResult(done, "");
    onChanged();
  }

  async function attach() {
    const found = await call(`/api/v1/leads?q=${encodeURIComponent(email.trim())}&take=1`, "GET");
    const id = (found.json.leads as { id: string }[] | undefined)?.[0]?.id;
    if (!id) return onResult("", "No lead matches that address.");
    await attachById(id, "Lead attached.");
  }

  // one click turns the sender of a triage thread into a lead and attaches it
  async function createFromSender() {
    const r = await call(`/api/v1/inbox/threads/${d.id}/create-lead`, "POST");
    if (!r.ok) return onResult("", CREATE_LEAD_ERRORS[errorText(r)] ?? errorText(r));
    onResult("Lead created.", "");
    onChanged();
  }

  const nameOf = (l: { firstName: string | null; lastName: string | null; email: string }) =>
    [l.firstName, l.lastName].filter(Boolean).join(" ") || l.email;

  const interest = lead?.interestStatus == null ? null : INTEREST[String(lead.interestStatus)];
  return (
    <aside
      aria-label="Lead"
      className="flex flex-col gap-5 border-t border-border bg-surface p-4 text-sm @4xl:overflow-y-auto @4xl:border-t-0 @4xl:border-l"
    >
      {lead ? (
        <>
          <div className="flex flex-col gap-1">
            <h3 className="micro text-fg-subtle">Lead</h3>
            <p className="text-base font-semibold">
              {[lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email}
            </p>
            <p className="break-all text-[13px]/[18px] text-fg-muted">{lead.email}</p>
            {(lead.jobTitle || lead.companyName) && (
              <p className="text-[13px]/[18px]">
                {[lead.jobTitle, lead.companyName].filter(Boolean).join(" · ")}
              </p>
            )}
            {(interest || lead.labels.length > 0) && (
              <div className="mt-1 flex flex-wrap gap-1">
                {interest && (
                  <StatusPill {...pillFor(INTEREST_PILL, interest)}>Status: {interest}</StatusPill>
                )}
                {lead.labels.map((l) => (
                  <span key={l} className={chipClass}>
                    {l}
                  </span>
                ))}
              </div>
            )}
            {lead.deletedAt && <p className="text-fg-muted">This lead was deleted.</p>}
          </div>
          {(d.origin || ooo || next) && (
            <dl className="flex flex-col gap-3 border-t border-border pt-4 text-[13px]/[18px]">
              {d.origin && (
                <div>
                  <dt className="micro text-fg-subtle">Campaign</dt>
                  <dd>
                    {d.origin.campaign.name}
                    <br />
                    <span className="text-fg-muted">
                      Started by Step {d.origin.step.order}
                      {d.origin.variant ? `, Variant ${d.origin.variant.label}` : ""}
                    </span>
                  </dd>
                </div>
              )}
              {ooo && (
                <div>
                  <dt className="micro text-fg-subtle">Out of office</dt>
                  <dd>Out of office until {day(ooo.oooUntil!)}. Follow-ups resume then.</dd>
                </div>
              )}
              {next && (
                <div>
                  <dt className="micro text-fg-subtle">Next email</dt>
                  <dd>
                    Next email: {next.renderedSubject} on {new Date(next.dueAt).toLocaleString()}{" "}
                    <Link href="/scheduled" className="text-signal underline underline-offset-2">
                      Scheduled emails
                    </Link>
                  </dd>
                </div>
              )}
            </dl>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-fg-muted">No lead is linked to this conversation.</p>
          {canEdit && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => void createFromSender()}
              >
                Create lead from sender
              </Button>
              <Input
                aria-label="Lead email"
                placeholder="lead@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                disabled={!email.trim()}
                onClick={() => void attach()}
              >
                Attach lead
              </Button>
              {d.domainLeads.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <h3 className="micro text-fg-subtle">Same company</h3>
                  <ul className="flex flex-col">
                    {d.domainLeads.map((l) => (
                      <li key={l.id}>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-auto w-full justify-start px-2 py-1 text-left"
                          onClick={() => void attachById(l.id, "Lead attached.")}
                        >
                          {nameOf(l)}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <h3 className="micro text-fg-subtle">Notes</h3>
        <ul className="flex flex-col gap-1.5">
          {[...d.leadNotes, ...d.notes].map((n) => (
            <li
              key={n.id}
              className="rounded-md border border-border bg-sunken px-3 py-2 text-[13px]/[18px] whitespace-pre-wrap"
            >
              {n.body}
            </li>
          ))}
        </ul>
        {canEdit && (
          <>
            <Label htmlFor="new-note">New note</Label>
            <Textarea
              id="new-note"
              rows={3}
              className="min-h-20"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              disabled={!note.trim()}
              onClick={() => void addNote()}
            >
              Add note
            </Button>
          </>
        )}
      </div>
    </aside>
  );
}
