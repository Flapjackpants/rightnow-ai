"use client";

import { Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ActionCard } from "../../../components/empty-state";
import { dialogClass } from "../../../components/overlay";
import { StatusPill } from "../../../components/status-pill";
import { Select } from "../../../components/ui/select";
import { Switch } from "../../../components/ui/switch";
import { cn } from "../../../lib/utils";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import type { Named } from "./bulk-bar";

const FIELDS: [string, string][] = [
  ["email", "Email"],
  ["firstName", "First name"],
  ["lastName", "Last name"],
  ["companyName", "Company"],
  ["jobTitle", "Job title"],
  ["website", "Website"],
  ["phone", "Phone"],
  ["country", "Country"],
  ["region", "Region"],
];
const BASES = [
  ["legitimate_interest", "Legitimate interest"],
  ["consent", "Consent"],
  ["contract", "Contract"],
  ["other", "Other"],
];
const SKIP: Record<string, string> = {
  missing_email: "Missing email",
  invalid_email: "Invalid email",
  disposable: "Disposable domain",
  duplicate_in_file: "Duplicate in file",
  blocklisted: "Blocklisted",
  exists_in_workspace: "Already in workspace",
  exists_in_list: "Already in list",
};
type Counts = {
  rows: number;
  missingEmail: number;
  invalidEmail: number;
  duplicateInFile: number;
  existsInWorkspace: number;
};
type Preview = { headers: string[]; mapping: (string | null)[]; counts: Counts; sampled: boolean };
type Job = {
  status: "PENDING" | "RUNNING" | "DONE" | "FAILED";
  progress: number;
  imported: number;
  attached: number;
  skipped: Record<string, number>;
  error: string | null;
};
const STEPS = 4;

async function send(url: string, file: File, fields: Record<string, unknown>) {
  const fd = new FormData();
  fd.set("file", file);
  for (const [k, v] of Object.entries(fields)) fd.set(k, JSON.stringify(v));
  const res = await fetch(url, { method: "POST", body: fd }).catch(() => null);
  const json = (await res?.json().catch(() => ({}))) as Record<string, unknown> | undefined;
  return { ok: !!res?.ok, json: json ?? {} };
}
const err = (j: Record<string, unknown>) =>
  typeof j.error === "string" ? j.error : "Something went wrong";

/** B4.9 / B5.8: an 800px dialog with a 4-segment progress bar; `card` shows the opener as an empty-state card. */
export function ImportWizard({
  lists,
  onDone,
  card,
}: {
  lists: Named[];
  onDone: () => void;
  card?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(1);
  const [file, setFile] = useState<File | null>(null);
  const [pre, setPre] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<(string | null)[]>([]);
  const [listId, setListId] = useState("");
  const [skipWs, setSkipWs] = useState(true);
  const [skipList, setSkipList] = useState(false);
  const [verify, setVerify] = useState(false);
  const [source, setSource] = useState("");
  const [basis, setBasis] = useState("legitimate_interest");
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  function reset() {
    setStep(1);
    setFile(null);
    setPre(null);
    setAuthorized(false);
    setError("");
    setJobId("");
    setJob(null);
  }

  async function pick(f: File | undefined) {
    if (!f) return;
    setFile(f);
    setError("");
    setBusy(true);
    const r = await send("/api/v1/imports/preview", f, {});
    setBusy(false);
    if (!r.ok) return setError(err(r.json));
    const p = r.json as unknown as Preview;
    setPre(p);
    setMapping(p.mapping);
  }

  async function toOptions() {
    setBusy(true);
    const r = await send("/api/v1/imports/preview", file!, { mapping });
    setBusy(false);
    if (!r.ok) return setError(err(r.json));
    setError("");
    setPre(r.json as unknown as Preview);
    setStep(3);
  }

  async function run() {
    setBusy(true);
    const r = await send("/api/v1/imports", file!, {
      options: {
        mapping,
        options: {
          ...(listId && { listId }),
          skipIfInWorkspace: skipWs,
          skipIfInList: skipList,
          verifyOnImport: verify,
        },
        confirmedAuthorized: authorized,
        lawfulBasis: basis,
        ...(source.trim() && { source: source.trim() }),
      },
    });
    setBusy(false);
    if (!r.ok) return setError(err(r.json));
    setError("");
    setJobId(r.json.importJobId as string);
    setStep(4);
  }

  useEffect(() => {
    if (!jobId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const res = await fetch(`/api/v1/imports/${jobId}`).catch(() => null);
      const j = (await res?.json().catch(() => null)) as Job | null;
      if (!live) return;
      if (j) setJob(j);
      if (j && (j.status === "DONE" || j.status === "FAILED")) return done.current();
      timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [jobId]);

  const c = pre?.counts;
  const count = (label: string, n: number | undefined) => (
    <li key={label} className="border-b border-border py-1.5 last:border-0">
      {label}: {n ?? 0}
    </li>
  );
  const finished = job?.status === "DONE" || job?.status === "FAILED";

  const openWizard = () => {
    reset();
    dialog.current?.showModal();
  };
  const tile =
    "flex flex-col rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium tabular-nums";
  return (
    <>
      {card ? (
        <ActionCard
          icon={Upload}
          title="Import a CSV file"
          description="Map columns, preview problems, then import."
          onClick={openWizard}
        />
      ) : (
        <Button onClick={openWizard}>
          <Upload aria-hidden />
          Import CSV
        </Button>
      )}
      <dialog ref={dialog} aria-labelledby="import-title" className={dialogClass(800)}>
        <div className="flex items-start justify-between gap-4">
          <h2 id="import-title" className="text-lg/[26px] font-semibold">
            Import leads
          </h2>
          <Button variant="ghost" onClick={() => dialog.current?.close()}>
            Close
          </Button>
        </div>
        <div aria-hidden className="mt-3 mb-5 grid grid-cols-4 gap-1">
          {Array.from({ length: STEPS }, (_, i) => (
            <span key={i} className={cn("h-1 rounded-xs", i < step ? "bg-signal" : "bg-sunken")} />
          ))}
        </div>

        {step === 1 && (
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">Step 1 of 4: Upload a CSV</h3>
            <Label htmlFor="import-file">CSV file (comma, semicolon, tab or pipe separated)</Label>
            <input
              id="import-file"
              type="file"
              accept=".csv,text/csv"
              className="rounded-md border border-dashed border-border-strong bg-sunken p-4 text-sm file:mr-3 file:h-8 file:rounded-sm file:border file:border-border-strong file:bg-surface file:px-2.5 file:text-[13px] file:font-medium file:text-fg"
              onChange={(e) => void pick(e.target.files?.[0])}
            />
            {pre && (
              <p role="status" className="text-sm">
                {c?.rows} rows found in {file?.name}.
              </p>
            )}
            <div className="flex justify-end">
              <Button disabled={!pre || busy} onClick={() => setStep(2)}>
                Next
              </Button>
            </div>
          </section>
        )}

        {step === 2 && pre && (
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">Step 2 of 4: Map columns</h3>
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="micro hidden grid-cols-[minmax(0,1fr)_16px_minmax(0,1fr)_88px] items-center gap-3 border-b border-border bg-sunken px-4 py-2.5 text-fg-muted sm:grid">
                <span>CSV column</span>
                <span />
                <span>Field</span>
                <span />
              </div>
              {pre.headers.map((h, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 last:border-0 sm:grid-cols-[minmax(0,1fr)_16px_minmax(0,1fr)_88px]"
                >
                  <Label htmlFor={`map-${i}`} className="truncate" title={h}>
                    {h}
                  </Label>
                  <span aria-hidden className="hidden text-fg-subtle sm:block">
                    →
                  </span>
                  <Select
                    id={`map-${i}`}
                    size="sm"
                    className="w-full"
                    value={mapping[i] ?? ""}
                    onChange={(e) =>
                      setMapping((m) => m.map((x, j) => (j === i ? e.target.value || null : x)))
                    }
                  >
                    <option value="">Ignore this column</option>
                    {FIELDS.map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                    <option value={`custom:${h}`}>Custom field “{h}”</option>
                  </Select>
                  <span className="max-sm:col-span-2">
                    {mapping[i] && mapping[i] === pre.mapping[i] && (
                      <StatusPill tone="success" size="sm">
                        Matched
                      </StatusPill>
                    )}
                  </span>
                </div>
              ))}
            </div>
            {!mapping.includes("email") && (
              <p role="alert" className="text-[13px]/[18px] text-danger">
                Map one column to Email.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button disabled={busy || !mapping.includes("email")} onClick={toOptions}>
                Next
              </Button>
            </div>
          </section>
        )}

        {step === 3 && pre && (
          <section className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold">Step 3 of 4: Options and preview</h3>
            <div className="rounded-lg border border-border px-4 py-2">
              <h4 className="micro py-1 text-fg-muted">
                Preview{pre.sampled ? " (first 1000 rows)" : ""}
              </h4>
              <ul className="text-sm tabular-nums">
                {count("Rows", c?.rows)}
                {count("Missing email", c?.missingEmail)}
                {count("Invalid email", c?.invalidEmail)}
                {count("Duplicate in file", c?.duplicateInFile)}
                {count("Already in workspace", c?.existsInWorkspace)}
              </ul>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="import-list">Add to list</Label>
                <Select id="import-list" value={listId} onChange={(e) => setListId(e.target.value)}>
                  <option value="">No list</option>
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="import-source">Source (optional)</Label>
                <Input
                  id="import-source"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-col divide-y divide-border rounded-lg border border-border px-4">
              <Switch
                className="py-2"
                label="Skip leads that already exist in the workspace"
                checked={skipWs}
                onChange={(e) => setSkipWs(e.target.checked)}
              />
              <Switch
                className="py-2"
                label="Skip leads already in the chosen list"
                checked={skipList}
                disabled={!listId}
                onChange={(e) => setSkipList(e.target.checked)}
              />
              <Switch
                className="py-2"
                label="Verify new addresses after the import (campaigns wait for the result)"
                checked={verify}
                onChange={(e) => setVerify(e.target.checked)}
              />
            </div>
            <div className="flex flex-col gap-1.5 sm:max-w-xs">
              <Label htmlFor="import-basis">Lawful basis</Label>
              <Select id="import-basis" value={basis} onChange={(e) => setBasis(e.target.value)}>
                {BASES.map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </div>
            <label className="flex min-h-11 items-center gap-2 text-sm font-medium md:min-h-0">
              <input
                type="checkbox"
                required
                checked={authorized}
                onChange={(e) => setAuthorized(e.target.checked)}
              />
              I am authorized to email these contacts
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setStep(2)}>
                Back
              </Button>
              <Button disabled={!authorized || busy} onClick={run}>
                Run import
              </Button>
            </div>
          </section>
        )}

        {step === 4 && (
          <section className="flex flex-col gap-3" aria-live="polite">
            <h3 className="text-sm font-semibold">Step 4 of 4: Import</h3>
            {!finished && (
              <>
                <progress
                  aria-label="Import progress"
                  max={100}
                  value={job?.progress ?? 0}
                  className="w-full"
                />
                <p role="status" className="text-sm text-fg-muted">
                  {job?.status === "RUNNING"
                    ? `Importing… ${job.progress}%`
                    : "Waiting for the worker to start the import…"}
                </p>
              </>
            )}
            {job?.status === "FAILED" && (
              <p role="alert" className="text-sm text-danger">
                Import failed: {job.error}
              </p>
            )}
            {job?.status === "DONE" && (
              <ul
                role="status"
                aria-label="Import result"
                className="grid grid-cols-2 gap-3 sm:grid-cols-4"
              >
                <li className={tile}>Imported {job.imported}</li>
                {job.attached > 0 && <li className={tile}>Added to list {job.attached}</li>}
                {Object.entries(job.skipped).map(([k, n]) => (
                  <li key={k} className={tile}>
                    {SKIP[k] ?? k} {n}
                  </li>
                ))}
              </ul>
            )}
            {finished && (
              <div className="flex justify-end">
                <Button onClick={() => dialog.current?.close()}>Done</Button>
              </div>
            )}
          </section>
        )}
        {error && (
          <p role="alert" className="mt-3 text-[13px]/[18px] text-danger">
            {error}
          </p>
        )}
      </dialog>
    </>
  );
}
