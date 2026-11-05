"use client";

import { useEffect, useRef, useState } from "react";
import { dialogClass } from "../../../components/overlay";
import { Button } from "../../../components/ui/button";
import { Helper, Input, Textarea } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { call, errorText } from "../accounts/api-client";

export type Macro = { id: string; name: string; body: string };

/** PS-INBOX-09: create, edit and delete reply macros (the composer's "Insert macro" list). */
export function MacrosDialog({
  macros,
  onChanged,
  onClose,
}: {
  macros: Macro[];
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [err, setErr] = useState("");

  const reset = () => {
    setEditing(null);
    setName("");
    setBody("");
  };
  async function save() {
    setErr("");
    const r = editing
      ? await call(`/api/v1/inbox/macros/${editing}`, "PATCH", { name, body })
      : await call("/api/v1/inbox/macros", "POST", { name, body });
    if (!r.ok) return setErr(errorText(r));
    reset();
    await onChanged();
  }
  async function remove(id: string) {
    setErr("");
    const r = await call(`/api/v1/inbox/macros/${id}`, "DELETE");
    if (!r.ok) return setErr(errorText(r));
    if (editing === id) reset();
    await onChanged();
  }

  return (
    <dialog ref={ref} aria-labelledby="macros-title" onClose={onClose} className={dialogClass(640)}>
      <h2 id="macros-title" className="mb-1 text-lg/[26px] font-semibold">
        Macros
      </h2>
      <p className="mb-4 text-[13px]/[18px] text-fg-muted">
        Saved replies you can insert into the composer.
      </p>
      <ul className="mb-4 flex flex-col divide-y divide-border rounded-lg border border-border empty:hidden">
        {macros.map((m) => (
          <li
            key={m.id}
            className="flex items-center justify-between gap-2 py-1.5 pr-2 pl-4 text-sm"
          >
            <span className="truncate font-medium">{m.name}</span>
            <span className="flex shrink-0 gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Edit ${m.name}`}
                onClick={() => {
                  setEditing(m.id);
                  setName(m.name);
                  setBody(m.body);
                }}
              >
                Edit
              </Button>
              <Button
                type="button"
                variant="danger-ghost"
                size="sm"
                aria-label={`Delete ${m.name}`}
                onClick={() => void remove(m.id)}
              >
                Delete
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Label htmlFor="macro-name">Name</Label>
        <Input
          id="macro-name"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
        <Label htmlFor="macro-body" className="mt-2">
          Body
        </Label>
        <Textarea
          id="macro-body"
          value={body}
          rows={5}
          maxLength={10_000}
          aria-describedby="macro-hint"
          onChange={(e) => setBody(e.target.value)}
        />
        <Helper id="macro-hint">
          Variables such as {"{{firstName}}"}, {"{{ownerName}}"}, {"{{ownerEmail}}"} or{" "}
          {"{{sendingAccountFirstName}}"} are filled in from the conversation&apos;s lead and
          mailbox.
        </Helper>
        {err && (
          <p role="alert" className="text-[13px]/[18px] text-danger">
            {err}
          </p>
        )}
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {editing && (
            <Button type="button" variant="ghost" onClick={reset}>
              Cancel edit
            </Button>
          )}
          <Button type="button" variant="outline" onClick={() => ref.current?.close()}>
            Close
          </Button>
          <Button type="submit" disabled={!name.trim() || !body.trim()}>
            Save macro
          </Button>
        </div>
      </form>
    </dialog>
  );
}
