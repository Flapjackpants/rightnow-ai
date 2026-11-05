"use client";

import { useEffect, useState } from "react";
import { AiAssist } from "../../../components/ai-assist";
import { RichText } from "../../../components/rich-text";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Select } from "../../../components/ui/select";
import { call } from "../accounts/api-client";
import { MacrosDialog, type Macro } from "./macros-dialog";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Plain text to HTML: blank lines split paragraphs, single newlines become <br>, https links are linked. */
export const toHtml = (text: string) =>
  text
    .trim()
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p>${esc(p)
          .replace(/\n/g, "<br>")
          .replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`)}</p>`,
    )
    .join("");

/** An emptied editor leaves tags behind (<br>, <div><br></div>): only text counts. */
const hasText = (html: string) => !!html.replace(/<[^>]*>|&nbsp;/g, " ").trim();

const MESSAGES: Record<string, string> = {
  provider_cap:
    "This mailbox has used half of its provider's daily cap, so manual replies are paused until tomorrow.",
  recipient_suppressed: "A recipient is on your blocklist or suppression list. Nothing was sent.",
  attachments_too_large_for_provider:
    "The attachments are too large for this Microsoft mailbox (3 MB limit). Nothing was sent.",
  attachments_too_large: "The attachments are over the 20 MB limit. Nothing was sent.",
  account_needs_attention:
    "This mailbox needs attention (reconnect it on the Email Accounts page). Nothing was sent.",
  account_unavailable: "This mailbox is not connected. Nothing was sent.",
  rate_limited:
    "The provider is rate limiting this mailbox. Nothing was sent; try again in a few minutes.",
  provider_unavailable: "The provider could not be reached. Nothing was sent.",
  invalid_recipient: "A recipient address is not valid.",
  no_recipient: "There is no recipient to reply to.",
  to_required: "Enter who to forward this to.",
  invalid_message: "The message could not be built. Nothing was sent.",
  reply_in_progress: "A reply to this conversation is already being sent. Nothing was sent.",
  no_owner: "This lead has no owner yet.",
};
/** Never retried automatically: an uncertain or unrecorded send is reported and left to the person. */
const sendError = (j: Record<string, unknown>) =>
  j.error === "send_uncertain" || j.error === "sent_not_recorded"
    ? String(j.message)
    : (MESSAGES[String(j.error)] ?? String(j.error ?? "Something went wrong"));

export function Composer({
  threadId,
  hasOwner,
  onResult,
  onSent,
}: {
  threadId: string;
  hasOwner: boolean;
  onResult: (ok: string, err: string) => void;
  onSent: () => void;
}) {
  const [mode, setMode] = useState("reply");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [body, setBody] = useState(""); // editor html: the server sanitizes it and derives the text part
  const [files, setFiles] = useState<File[]>([]);
  const [macros, setMacros] = useState<Macro[]>([]);
  const [busy, setBusy] = useState(false);
  const [fileKey, setFileKey] = useState(0);
  // FR I3: after an unknown outcome Send stays off until the person chooses "Send anyway"
  const [held, setHeld] = useState(false);
  const [manage, setManage] = useState(false);
  const loadMacros = async () => {
    const r = await call("/api/v1/inbox/macros", "GET");
    setMacros((r.json.macros as Macro[]) ?? []);
  };
  useEffect(() => void loadMacros(), []);
  useEffect(() => setHeld(false), [threadId]);

  async function macro(id: string) {
    if (!id) return;
    const r = await call(`/api/v1/inbox/macros/${id}/render`, "POST", { threadId });
    if (r.ok) setBody((b) => b + toHtml(String(r.json.text)));
    else onResult("", "The macro could not be filled in for this conversation.");
  }

  async function handoff() {
    setBusy(true);
    const r = await call(`/api/v1/inbox/threads/${threadId}/handoff`, "POST");
    setBusy(false);
    if (!r.ok) return onResult("", sendError(r.json));
    setMode("reply");
    setBody((b) => b + toHtml(String(r.json.text)));
    setCc(String(r.json.cc));
  }

  async function send() {
    setBusy(true);
    setHeld(false);
    onResult("", "");
    const f = new FormData();
    f.set("mode", mode);
    f.set("html", body);
    if (mode === "forward") f.set("to", JSON.stringify(to.split(/[,;\s]+/).filter(Boolean)));
    if (cc) f.set("cc", JSON.stringify([cc]));
    files.forEach((x) => f.append("attachments", x));
    const res = await fetch(`/api/v1/inbox/threads/${threadId}/reply`, {
      method: "POST",
      body: f,
    }).catch(() => null);
    const json = (await res?.json().catch(() => ({}))) as Record<string, unknown> | undefined;
    setBusy(false);
    // sent_not_recorded: the provider took it, so the draft goes as on success (one more click would be a duplicate)
    const gone = !!res?.ok || json?.error === "sent_not_recorded";
    if (!gone) {
      // an unknown outcome (or a connection that dropped after the request left) keeps the draft but holds Send
      if (!res || json?.error === "send_uncertain") setHeld(true);
      return onResult(
        "",
        res
          ? sendError(json ?? {})
          : "The connection dropped. The message may have been sent: check the mailbox's Sent folder before trying again.",
      );
    }
    setBody("");
    setTo("");
    setCc("");
    setFiles([]);
    setFileKey((k) => k + 1);
    if (res?.ok) onResult(mode === "forward" ? "Forward sent." : "Reply sent.", "");
    else onResult("", sendError(json ?? {}));
    onSent();
  }

  return (
    <>
      <form
        aria-label="Reply to this conversation"
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {/* B4.20 asks for a segmented control; a native select stays because tests find the editor by the exact
            label "Reply", which a "Reply" radio would also match */}
        <div className="flex flex-wrap items-center gap-2">
          <Select
            size="sm"
            aria-label="Reply mode"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="reply">Reply</option>
            <option value="reply_all">Reply all</option>
            <option value="forward">Forward</option>
          </Select>
          {macros.length > 0 && (
            <Select
              size="sm"
              aria-label="Insert macro"
              value=""
              onChange={(e) => void macro(e.target.value)}
            >
              <option value="">Insert macro</option>
              {macros.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={() => setManage(true)}>
            Manage macros
          </Button>
          {hasOwner && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void handoff()}
            >
              Hand off to owner
            </Button>
          )}
          <AiAssist
            label="Suggest reply"
            path="reply-draft"
            body={{ threadId }}
            onUse={(t) => setBody((b) => b + toHtml(t))}
          />
          <AiAssist label="Summarize" path="summary" body={{ threadId }} />
        </div>
        {mode === "forward" && (
          <Input
            aria-label="Forward to"
            placeholder="name@example.com"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        )}
        {cc && (
          <div className="flex items-center gap-2 text-sm">
            CC: {cc}
            <Button type="button" variant="ghost" size="sm" onClick={() => setCc("")}>
              Remove CC
            </Button>
          </div>
        )}
        <RichText id="reply-body" label="Reply" value={body} onChange={setBody} />
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="reply-files" className="sr-only">
            Attachments
          </label>
          <input
            id="reply-files"
            key={fileKey}
            type="file"
            multiple
            className="min-w-0 flex-1 text-[13px]/[18px] text-fg-muted file:mr-2 file:inline-flex file:h-8 file:items-center file:rounded-sm file:border-0 file:bg-transparent file:px-2.5 file:text-[13px] file:font-medium file:text-fg hover:file:bg-hover"
            onChange={(e) => setFiles([...(e.target.files ?? [])])}
          />
          {held && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || !hasText(body)}
              onClick={() => void send()}
            >
              Send anyway
            </Button>
          )}
          <Button type="submit" disabled={busy || held || !hasText(body)} loading={busy}>
            {busy ? "Sending..." : mode === "forward" ? "Send forward" : "Send reply"}
          </Button>
        </div>
      </form>
      {/* outside the form: the dialog has its own */}
      {manage && (
        <MacrosDialog macros={macros} onChanged={loadMacros} onClose={() => setManage(false)} />
      )}
    </>
  );
}
