import dns from "node:dns";
import type { Prisma, PrismaClient } from "@rightnow/db/client";
import { z } from "zod";
import { audit } from "../audit";
import { enrollBatch, noSkips } from "../campaigns/enroll";
import type { Clock } from "../clock";
import { withTxRetry } from "../dispatch";
import { LEAD_FIELDS, autoMap, parseCsv, type Mapping } from "./csv";
import { DISPOSABLE_DOMAINS } from "./disposable";
import { companyDomainOf, domainOf } from "./domain";
import { detectEsp, type ResolveMx } from "./esp";
import { LeadError } from "./service";
import { hashValue } from "./suppression";
import { parseEmail } from "./validate";

type Db = PrismaClient;
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 100_000;
const BATCH = 500;
const PREVIEW_ROWS = 1000;
const MX_CONCURRENCY = 8;
const MX_PHASE_START = 90; // progress: rows are 0-90, the MX lookups 90-100

export const importOptions = z.strictObject({
  listId: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional(),
  skipIfInWorkspace: z.boolean().default(true),
  skipIfInList: z.boolean().default(false),
  skipIfInCampaign: z.boolean().default(false),
  verifyOnImport: z.boolean().default(false),
});
export const LAWFUL_BASES = ["legitimate_interest", "consent", "contract", "other"] as const;
export const mappingSchema = z.array(
  z.union([
    z.literal(LEAD_FIELDS),
    z
      .string()
      .regex(/^custom:.+/)
      .transform((s) => s as `custom:${string}`),
    z.null(),
  ]),
);

const MAX_LEN = {
  firstName: 100,
  lastName: 100,
  companyName: 200,
  jobTitle: 200,
  website: 500,
  phone: 50,
  country: 100,
  region: 100,
};

export async function previewImport(prisma: Db, ws: string, buf: Buffer, mapping?: Mapping) {
  const { headers, rows, delimiter } = parseCsv(buf, PREVIEW_ROWS);
  const map = mapping ?? autoMap(headers);
  const col = map.indexOf("email");
  const counts = {
    rows: rows.length,
    missingEmail: 0,
    invalidEmail: 0,
    duplicateInFile: 0,
    existsInWorkspace: 0,
  };
  const seen = new Set<string>();
  for (const r of rows) {
    const raw = (r[col] ?? "").trim();
    if (!raw) counts.missingEmail++;
    else {
      const e = parseEmail(raw);
      if (!e) counts.invalidEmail++;
      else if (seen.has(e)) counts.duplicateInFile++;
      else seen.add(e);
    }
  }
  counts.existsInWorkspace = await prisma.lead.count({
    where: { workspaceId: ws, deletedAt: null, email: { in: [...seen] } },
  });
  // shortcut: counts newline-separated lines, so a quoted multi-line cell inflates it; fine for a preview
  const lines =
    buf
      .toString("utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim()).length - 1;
  return {
    headers,
    mapping: map,
    delimiter,
    sample: rows.slice(0, 5),
    totalRows: Math.max(lines, 0),
    counts,
    sampled: lines > PREVIEW_ROWS,
  };
}

export async function createImport(
  prisma: Db,
  ws: string,
  actorId: string | null | undefined,
  p: {
    fileName: string;
    data: Buffer;
    mapping: unknown;
    options: unknown;
    confirmedAuthorized: boolean;
    source?: string;
    lawfulBasis: (typeof LAWFUL_BASES)[number];
  },
) {
  if (!p.confirmedAuthorized) throw new LeadError(400, "authorization_required");
  if (!LAWFUL_BASES.includes(p.lawfulBasis)) throw new LeadError(400, "invalid_lawful_basis");
  if (p.data.length > MAX_IMPORT_BYTES) throw new LeadError(413, "file_too_large");
  const options = importOptions.parse(p.options);
  if (options.skipIfInCampaign && !options.campaignId)
    throw new LeadError(400, "campaign_required");
  if (options.campaignId) {
    const c = await prisma.campaign.findFirst({
      where: { id: options.campaignId, workspaceId: ws, deletedAt: null },
      select: { status: true },
    });
    if (!c) throw new LeadError(400, "unknown_campaign");
    if (c.status === "ARCHIVED") throw new LeadError(400, "campaign_archived");
  }
  const mapping = mappingSchema.parse(p.mapping);
  const { headers, rows } = parseCsv(p.data);
  if (rows.length > MAX_IMPORT_ROWS) throw new LeadError(413, "too_many_rows");
  if (mapping.length !== headers.length || !mapping.includes("email"))
    throw new LeadError(400, "email_column_required");
  if (
    options.listId &&
    !(await prisma.leadList.findFirst({
      where: { id: options.listId, workspaceId: ws },
      select: { id: true },
    }))
  )
    throw new LeadError(400, "unknown_list");
  const fileName = p.fileName.slice(0, 200);
  const job = await prisma.importJob.create({
    data: {
      workspaceId: ws,
      createdById: actorId ?? "api",
      fileName,
      data: new Uint8Array(p.data),
      mapping,
      options,
      confirmedAuthorized: true,
      source: p.source?.trim().slice(0, 200) || `csv:${fileName}`,
      lawfulBasis: p.lawfulBasis,
    },
  });
  return { importJobId: job.id };
}

type Cand = { email: string; data: Prisma.LeadCreateManyInput };

/** Turns one row into lead data, or a skip reason. `seen` is the file-wide dedupe set. */
function prepare(
  row: string[],
  map: Mapping,
  job: { id: string; workspaceId: string; source: string; lawfulBasis: string },
  seen: Set<string>,
  verify: boolean,
): Cand | string {
  const data: Record<string, string> = {};
  const custom: Record<string, string> = {};
  map.forEach((m, i) => {
    const v = (row[i] ?? "").trim();
    if (!m || !v) return;
    if (m.startsWith("custom:")) custom[m.slice(7, 107)] ??= v.slice(0, 2000);
    else data[m] ??= v;
  });
  if (!data.email) return "missing_email";
  const email = parseEmail(data.email);
  if (!email) return "invalid_email";
  if (DISPOSABLE_DOMAINS.has(domainOf(email))) return "disposable";
  if (seen.has(email)) return "duplicate_in_file";
  seen.add(email);
  const lead: Record<string, unknown> = {};
  for (const [k, max] of Object.entries(MAX_LEN)) if (data[k]) lead[k] = data[k].slice(0, max);
  return {
    email,
    data: {
      ...lead,
      email,
      workspaceId: job.workspaceId,
      companyDomain: companyDomainOf(email),
      customFields: custom,
      source: job.source,
      uploadMethod: "csv",
      lawfulBasis: job.lawfulBasis,
      importJobId: job.id,
      // D38: waits for the lead-verify job, so a running campaign cannot plan the lead first
      ...(verify && { verificationStatus: "PENDING_JOB", verifyPrevStatus: "NOT_VERIFIED" }),
    },
  };
}

type Opts = z.infer<typeof importOptions>;
type Job = { id: string; workspaceId: string; createdAt: Date };

/** One batch in one short transaction. No network here. Returns exact counts. */
async function insertBatch(prisma: Db, job: Job, opts: Opts, cands: Cand[]) {
  const ws = job.workspaceId;
  const emails = cands.map((c) => c.email);
  return prisma.$transaction(
    async (tx) => {
      // suppression is read before any lead write (lock order Suppression, then Lead)
      const sup = await tx.suppression.findMany({
        where: {
          workspaceId: ws,
          OR: [
            { kind: "EMAIL", valueHash: { in: emails.map(hashValue) } },
            {
              kind: "DOMAIN",
              valueHash: { in: [...new Set(emails.map((e) => hashValue(domainOf(e))))] },
            },
          ],
        },
        select: { kind: true, valueHash: true },
      });
      const blocked = new Set(sup.map((s) => `${s.kind}:${s.valueHash}`));
      const existing = new Map(
        (
          await tx.lead.findMany({
            where: { workspaceId: ws, deletedAt: null, email: { in: emails } },
            select: { id: true, email: true, importJobId: true },
          })
        ).map((l) => [l.email, l]),
      );
      const inList = opts.listId
        ? new Map(
            (
              await tx.leadListMember.findMany({
                where: {
                  listId: opts.listId,
                  leadId: { in: [...existing.values()].map((l) => l.id) },
                },
                select: { leadId: true, createdAt: true },
              })
            ).map((m) => [m.leadId, m.createdAt] as const),
          )
        : new Map<string, Date>();
      const inCampaign = new Set(
        opts.campaignId && opts.skipIfInCampaign && existing.size
          ? (
              await tx.campaignLead.findMany({
                where: {
                  campaignId: opts.campaignId,
                  leadId: { in: [...existing.values()].map((l) => l.id) },
                },
                select: { leadId: true },
              })
            ).map((m) => m.leadId)
          : [],
      );
      const skip: Record<string, number> = {};
      const bump = (k: string) => void (skip[k] = (skip[k] ?? 0) + 1);
      const ours: string[] = []; // already imported by an earlier, interrupted run of this job
      const attach: string[] = [];
      const fresh: Cand[] = [];
      for (const c of cands) {
        if (
          blocked.has(`EMAIL:${hashValue(c.email)}`) ||
          blocked.has(`DOMAIN:${hashValue(domainOf(c.email))}`)
        )
          bump("blocklisted");
        else {
          const ex = existing.get(c.email);
          if (!ex) fresh.push(c);
          else if (ex.importJobId === job.id) ours.push(ex.id);
          else if (inCampaign.has(ex.id)) bump("exists_in_campaign");
          else if (opts.skipIfInWorkspace || (!opts.listId && !opts.campaignId))
            bump("exists_in_workspace");
          else if (!inList.has(ex.id)) attach.push(ex.id);
          // added by an earlier, interrupted run of this job (or skipIfInList is off): count it as attached again
          else if (!opts.skipIfInList || inList.get(ex.id)! >= job.createdAt) attach.push(ex.id);
          else bump("exists_in_list");
        }
      }
      let newIds: string[] = [];
      if (fresh.length) {
        await tx.lead.createMany({ data: fresh.map((c) => c.data), skipDuplicates: true });
        newIds = (
          await tx.lead.findMany({
            where: {
              workspaceId: ws,
              deletedAt: null,
              importJobId: job.id,
              email: { in: fresh.map((c) => c.email) },
            },
            select: { id: true },
          })
        ).map((l) => l.id);
        // a concurrent create of the same address won the race
        for (let k = newIds.length; k < fresh.length; k++) bump("exists_in_workspace");
      }
      const members = [...newIds, ...ours, ...attach];
      if (opts.listId && members.length)
        await tx.leadListMember.createMany({
          data: members.map((leadId) => ({ listId: opts.listId!, leadId })),
          skipDuplicates: true,
        });
      // Imported leads join the campaign; enrollment applies the blocklist and the cross-campaign conflict check.
      if (opts.campaignId && members.length) {
        const sk = noSkips();
        await enrollBatch(tx, ws, opts.campaignId, members, false, sk);
        if (sk.in_other_active_campaign)
          skip.in_other_active_campaign = sk.in_other_active_campaign;
        if (sk.excluded_region) skip.excluded_region = sk.excluded_region;
      }
      return { skip, imported: ours.length + newIds.length, attached: attach.length };
    },
    { timeout: 30_000 },
  );
}

/** Claims a PENDING job and runs it: batches of 500, then MX lookups outside any transaction. */
export async function runImport(
  prisma: Db,
  clock: Clock,
  deps: { resolveMx?: ResolveMx; mxTimeoutMs?: number },
  importJobId: string,
) {
  const claimed = await prisma.importJob.updateMany({
    where: { id: importJobId, status: "PENDING" },
    data: { status: "RUNNING" },
  });
  if (!claimed.count) return;
  const job = await prisma.importJob.findUniqueOrThrow({ where: { id: importJobId } });
  const ws = job.workspaceId;
  const skipped: Record<string, number> = {};
  let total = 0;
  let imported = 0;
  let attached = 0;
  const domains = new Set<string>();
  const progress = (pct: number) =>
    prisma.importJob.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: { progress: pct, total, imported, attached, skipped },
    });
  try {
    if (!job.data) throw new Error("import data missing");
    const { rows } = parseCsv(Buffer.from(job.data));
    total = rows.length;
    const map = job.mapping as Mapping;
    const opts = importOptions.parse(job.options);
    const seen = new Set<string>();

    for (let i = 0; i < rows.length; i += BATCH) {
      const cands: Cand[] = [];
      for (const r of rows.slice(i, i + BATCH)) {
        const c = prepare(r, map, job, seen, opts.verifyOnImport);
        if (typeof c === "string") skipped[c] = (skipped[c] ?? 0) + 1;
        else cands.push(c);
      }
      // sorted so overlapping writers lock rows in one order; a deadlock/serialization failure retries the batch
      cands.sort((a, b) => (a.email < b.email ? -1 : 1));
      const res = await withTxRetry(() => insertBatch(prisma, job, opts, cands));
      for (const [k, n] of Object.entries(res.skip)) skipped[k] = (skipped[k] ?? 0) + n;
      imported += res.imported;
      attached += res.attached;
      for (const c of cands) domains.add(domainOf(c.email));
      await progress(Math.floor((Math.min(i + BATCH, total) / total) * MX_PHASE_START));
    }

    // MX lookups: never inside a transaction. Progress also touches updatedAt, so a long run is not reset as stale.
    const resolveMx: ResolveMx = deps.resolveMx ?? ((d) => dns.promises.resolveMx(d));
    const todo = [...domains];
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < todo.length) {
        const d = todo[next++]!;
        const r = await detectEsp(d, resolveMx, deps.mxTimeoutMs);
        await prisma.lead.updateMany({
          where: {
            workspaceId: ws,
            importJobId: job.id,
            espType: "IN_QUEUE",
            email: { endsWith: `@${d}` },
          },
          data: {
            espType: r.esp,
            esg: r.esg,
            ...(r.invalid && { verificationStatus: "INVALID", verifyPrevStatus: null }),
          },
        });
        if (++done % 4 === 0)
          await progress(
            MX_PHASE_START + Math.floor((done / todo.length) * (100 - MX_PHASE_START - 1)),
          );
      }
    };
    await Promise.all(Array.from({ length: Math.min(MX_CONCURRENCY, todo.length) }, worker));

    const fin = await prisma.importJob.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: {
        status: "DONE",
        progress: 100,
        total,
        imported,
        attached,
        skipped,
        data: null,
        finishedAt: clock.now(),
      },
    });
    if (fin.count)
      await audit(
        prisma,
        { workspaceId: ws, actorId: job.createdById, at: clock.now() },
        "lead.import",
        job.id,
        {
          imported,
          attached,
          total,
        },
      );
  } catch (e) {
    await prisma.importJob.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: {
        status: "FAILED",
        error: String((e as Error).message).slice(0, 500),
        data: null,
        finishedAt: clock.now(),
      },
    });
  }
}
