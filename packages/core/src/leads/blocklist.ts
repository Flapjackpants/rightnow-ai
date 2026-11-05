import type { Prisma, PrismaClient, SuppressionReason } from "@rightnow/db/client";
import { z } from "zod";
import { audit } from "../audit";
import { withTxRetry } from "../dispatch";
import { parseCsv } from "./csv";
import { csvCell } from "./export";
import { MAX_IMPORT_ROWS } from "./import";
import { LeadError } from "./service";
import { suppress } from "./suppression";
import { parseEmail } from "./validate";

type Db = PrismaClient;
type Actor = string | null | undefined;

const MAX_BLOCKLIST_VALUES = 1000;
export const MAX_BLOCKLIST_CSV_BYTES = 5 * 1024 * 1024;
/** D20: erasure records and complaints can never be removed; the other system reasons only one at a time. Bulk paths touch MANUAL entries only. */
const NEVER: SuppressionReason[] = ["GDPR_ERASURE", "COMPLAINT"];
export type Attestation = { reason: string; recipientConsent: true };
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A value containing `@` is an EMAIL, anything else a DOMAIN; null when it is neither. */
function classify(raw: string) {
  const v = raw.trim().toLowerCase();
  if (v.includes("@")) {
    const e = parseEmail(v);
    return e ? { kind: "EMAIL" as const, value: e } : null;
  }
  return DOMAIN.test(v) ? { kind: "DOMAIN" as const, value: v } : null;
}

async function addValues(prisma: Db, ws: string, values: string[]) {
  const valid = values.map(classify).filter((x) => x !== null);
  const unique = [...new Map(valid.map((e) => [`${e.kind}:${e.value}`, e])).values()];
  const added = unique.length
    ? // gate M-1: Suppression before CampaignLead (a hard-bounce settle locks the reverse): retried
      await withTxRetry(() =>
        prisma.$transaction((tx) => suppress(tx, ws, unique, "MANUAL", "blocklist")),
      )
    : 0;
  return { added, duplicates: valid.length - added, invalid: values.length - valid.length };
}

export async function addBlocklist(prisma: Db, ws: string, actorId: Actor, values: string[]) {
  if (values.length > MAX_BLOCKLIST_VALUES) throw new LeadError(400, "too_many_values");
  const r = await addValues(prisma, ws, values);
  await audit(prisma, { workspaceId: ws, actorId }, "blocklist.add", undefined, r);
  return r;
}

export const blocklistQuery = z.strictObject({
  q: z.string().trim().min(1).optional(),
  reason: z
    .enum([
      "UNSUBSCRIBE",
      "HARD_BOUNCE",
      "COMPLAINT",
      "MANUAL",
      "NOT_INTERESTED",
      "GDPR_ERASURE",
      "CUSTOMER",
    ])
    .optional(),
  kind: z.enum(["EMAIL", "DOMAIN"]).optional(),
  cursor: z.string().min(1).optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
});

/** Paged blocklist (newest first) with the live lead behind each address; `total` (first page only) is a database count. */
export async function listBlocklist(prisma: Db, ws: string, input: z.input<typeof blocklistQuery>) {
  const q = blocklistQuery.parse(input);
  const take = q.take ?? 50;
  const where: Prisma.SuppressionWhereInput = {
    workspaceId: ws,
    ...(q.reason && { reason: q.reason }),
    ...(q.kind && { kind: q.kind }),
    ...(q.q && { value: { contains: q.q, mode: "insensitive" } }),
  };
  const found = await prisma.suppression.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(q.cursor && { cursor: { id: q.cursor } }),
    select: { id: true, kind: true, value: true, reason: true, source: true, createdAt: true },
  });
  const next = found.length > take ? found.pop()! : null;
  const leads = await prisma.lead.findMany({
    where: {
      workspaceId: ws,
      deletedAt: null,
      email: { in: found.flatMap((r) => (r.kind === "EMAIL" && r.value ? [r.value] : [])) },
    },
    select: { id: true, email: true, firstName: true, lastName: true, companyName: true },
  });
  const by = new Map(leads.map(({ email, ...l }) => [email, l]));
  return {
    rows: found.map((r) => ({ ...r, lead: (r.value && by.get(r.value)) || null })),
    nextCursor: next?.id ?? null,
    ...(!q.cursor && { total: await prisma.suppression.count({ where }) }),
  };
}

/**
 * ADMIN only (the route enforces it), D20. GDPR_ERASURE and COMPLAINT: 409 `suppression_protected`.
 * UNSUBSCRIBE needs `resubscribeAttestation` (reason + the recipient's consent), recorded in the audit.
 * HARD_BOUNCE needs `confirm`. Audited with the hash, never the address.
 */
export async function removeBlocklist(
  prisma: Db,
  ws: string,
  actorId: Actor,
  id: string,
  opts: { confirm?: boolean; resubscribeAttestation?: Attestation } = {},
) {
  await prisma.$transaction(async (tx) => {
    const s = await tx.suppression.findFirst({ where: { id, workspaceId: ws } });
    if (!s) throw new LeadError(404, "Not found");
    if (NEVER.includes(s.reason)) throw new LeadError(409, "suppression_protected");
    const att = opts.resubscribeAttestation;
    if (s.reason === "UNSUBSCRIBE" && (!att?.reason.trim() || att.recipientConsent !== true))
      throw new LeadError(400, "attestation_required");
    if (s.reason === "HARD_BOUNCE" && !opts.confirm) throw new LeadError(400, "confirm_required");
    await tx.suppression.delete({ where: { id } });
    await audit(tx, { workspaceId: ws, actorId }, "blocklist.remove", id, {
      kind: s.kind,
      reason: s.reason,
      hash: s.valueHash,
      ...(att && { attestation: att.reason.trim().slice(0, 500), recipientConsent: true }),
    });
  });
}

async function removeMany(
  prisma: Db,
  ws: string,
  actorId: Actor,
  where: Prisma.SuppressionWhereInput,
) {
  return prisma.$transaction(async (tx) => {
    const base = { workspaceId: ws, ...where };
    const gone = await tx.suppression.findMany({
      where: { ...base, reason: "MANUAL" },
      select: { id: true, valueHash: true },
    });
    const kept = await tx.suppression.count({ where: { ...base, reason: { not: "MANUAL" } } });
    await tx.suppression.deleteMany({
      where: { id: { in: gone.map((g) => g.id) }, workspaceId: ws },
    });
    await audit(tx, { workspaceId: ws, actorId }, "blocklist.remove", undefined, {
      deleted: gone.length,
      kept,
      hashes: gone.slice(0, 1000).map((g) => g.valueHash), // capped; `deleted` is the true count
    });
    return { deleted: gone.length, kept };
  });
}

export const bulkDeleteBlocklist = (prisma: Db, ws: string, actorId: Actor, ids: string[]) =>
  removeMany(prisma, ws, actorId, {
    id: { in: z.array(z.string().min(1)).min(1).max(MAX_BLOCKLIST_VALUES).parse(ids) },
  });

export async function clearBlocklist(prisma: Db, ws: string, actorId: Actor, confirm: string) {
  if (confirm !== "DELETE ALL") throw new LeadError(400, "confirm_required");
  return removeMany(prisma, ws, actorId, {});
}

/** `value,kind,reason,createdAt`, paged. An erased address exports with an empty value. */
export async function* exportBlocklistCsv(prisma: Db, ws: string): AsyncIterable<string> {
  yield "value,kind,reason,createdAt\r\n";
  let cursor: string | undefined;
  do {
    const r = await listBlocklist(prisma, ws, { take: 200, cursor });
    yield r.rows
      .map((x) => [x.value, x.kind, x.reason, x.createdAt].map(csvCell).join(",") + "\r\n")
      .join("");
    cursor = r.nextCursor ?? undefined;
  } while (cursor);
}

const HEADERS = ["value", "email", "domain", "address"];
const UNGUARD = new RegExp("^'(?=[=+\\-@])");

/** One value per row; a `value`, `email` or `domain` header picks the column, otherwise column 0 and no header. */
export async function importBlocklistCsv(prisma: Db, ws: string, actorId: Actor, buf: Buffer) {
  if (buf.length > MAX_BLOCKLIST_CSV_BYTES) throw new LeadError(413, "file_too_large");
  const { headers, rows } = parseCsv(buf);
  const col = headers.findIndex((h) => HEADERS.includes(h.toLowerCase()));
  const data = col >= 0 ? rows : [headers, ...rows];
  if (data.length > MAX_IMPORT_ROWS) throw new LeadError(413, "too_many_rows");
  // undo the export's formula guard so an exported file imports back
  const values = data.map((r) => (r[Math.max(col, 0)] ?? "").replace(UNGUARD, ""));
  const total = { added: 0, duplicates: 0, invalid: 0 };
  for (let i = 0; i < values.length; i += MAX_BLOCKLIST_VALUES) {
    const r = await addValues(prisma, ws, values.slice(i, i + MAX_BLOCKLIST_VALUES));
    total.added += r.added;
    total.duplicates += r.duplicates;
    total.invalid += r.invalid;
  }
  await audit(prisma, { workspaceId: ws, actorId }, "blocklist.add", undefined, {
    ...total,
    csv: true,
  });
  return total;
}
