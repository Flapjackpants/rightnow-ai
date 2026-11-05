import {
  Prisma,
  type AccountProvider,
  type LeadSource,
  type PrismaClient,
} from "@rightnow/db/client";
import { z } from "zod";
import { audit } from "../audit";
import type { Clock } from "../clock";
import { decrypt, encrypt } from "../crypto";
import { withTxRetry } from "../dispatch";
import { dayKey, localMidnightUtc } from "../schedule";
import { enrollBatch, noSkips } from "../campaigns/enroll";
import {
  apolloEnrich,
  apolloSearch,
  ApolloError,
  leadSourceFilters,
  type ApolloOpts,
  type ApolloPerson,
} from "./apollo";
import { leadCapacity } from "./capacity";
import { DISPOSABLE_DOMAINS } from "./disposable";
import { companyDomainOf, domainOf } from "./domain";
import { regionExcluded } from "./regions";
import { suppressedEmails } from "./suppression";
import { parseEmail } from "./validate";
import { LAWFUL_BASES } from "./import";
import { LeadError } from "./service";
import { isPrismaCode } from "../accounts/service";

type Actor = string | null | undefined;
export const apolloSettingsInput = z.strictObject({
  apiKey: z.string().min(1).max(500).nullable(),
});
const settings = apolloSettingsInput;
const MAX_SOURCES = 20;
const name = z.string().trim().min(1).max(100);
export const leadSourceInput = z.strictObject({
  name,
  filters: leadSourceFilters,
  listId: z.string().min(1),
  campaignId: z.string().min(1).nullable().optional(),
  dailyCreditCap: z.number().int().min(1).max(10_000).optional(),
  lawfulBasis: z.enum(LAWFUL_BASES),
  confirmedAuthorized: z.literal(true, { error: "authorization_required" }),
});
export const leadSourcePatch = z.strictObject({
  name: name.optional(),
  filters: leadSourceFilters.optional(),
  listId: z.string().min(1).optional(),
  campaignId: z.string().min(1).nullable().optional(),
  dailyCreditCap: z.number().int().min(1).max(10_000).optional(),
  enabled: z.boolean().optional(),
});
export type ApiLeadSource = Pick<
  LeadSource,
  | "id"
  | "name"
  | "enabled"
  | "listId"
  | "campaignId"
  | "lawfulBasis"
  | "dailyCreditCap"
  | "nextPage"
  | "lastRunAt"
  | "lastError"
  | "lastErrorAt"
  | "createdAt"
> & { filters: z.infer<typeof leadSourceFilters>; creditsUsedToday: number };
const notFound = () => new LeadError(404, "not_found");
async function validateRefs(
  tx: Prisma.TransactionClient,
  ws: string,
  v: { listId?: string; campaignId?: string | null },
) {
  if (
    v.listId &&
    !(await tx.leadList.findFirst({
      where: { id: v.listId, workspaceId: ws },
      select: { id: true },
    }))
  )
    throw new LeadError(400, "unknown_list");
  if (
    v.campaignId &&
    !(await tx.campaign.findFirst({
      where: { id: v.campaignId, workspaceId: ws, status: { not: "ARCHIVED" }, deletedAt: null },
      select: { id: true },
    }))
  )
    throw new LeadError(400, "unknown_campaign");
}
function output(row: LeadSource, day: string): ApiLeadSource {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    filters: row.filters as z.infer<typeof leadSourceFilters>,
    listId: row.listId,
    campaignId: row.campaignId,
    lawfulBasis: row.lawfulBasis,
    dailyCreditCap: row.dailyCreditCap,
    creditsUsedToday: row.creditDay?.toISOString().slice(0, 10) === day ? row.creditsUsed : 0,
    nextPage: row.nextPage,
    lastRunAt: row.lastRunAt,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
    createdAt: row.createdAt,
  };
}
export async function listLeadSources(
  prisma: PrismaClient,
  clock: Clock,
  ws: string,
): Promise<ApiLeadSource[]> {
  const [workspace, rows] = await Promise.all([
    prisma.workspace.findUniqueOrThrow({ where: { id: ws }, select: { timezone: true } }),
    prisma.leadSource.findMany({ where: { workspaceId: ws }, orderBy: { name: "asc" } }),
  ]);
  return rows.map((row) => output(row, dayKey(workspace.timezone, clock.now())));
}
export async function createLeadSource(
  prisma: PrismaClient,
  clock: Clock,
  ws: string,
  actorId: Actor,
  input: unknown,
): Promise<ApiLeadSource> {
  const v = leadSourceInput.parse(input);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${ws} FOR NO KEY UPDATE`;
      await validateRefs(tx, ws, v);
      if ((await tx.leadSource.count({ where: { workspaceId: ws } })) >= MAX_SOURCES)
        throw new LeadError(409, "source_limit");
      const row = await tx.leadSource.create({
        data: {
          workspaceId: ws,
          name: v.name,
          filters: v.filters,
          listId: v.listId,
          campaignId: v.campaignId,
          dailyCreditCap: v.dailyCreditCap,
          lawfulBasis: v.lawfulBasis,
        },
      });
      await audit(tx, { workspaceId: ws, actorId, at: clock.now() }, "lead_source.create", row.id);
      const workspace = await tx.workspace.findUniqueOrThrow({
        where: { id: ws },
        select: { timezone: true },
      });
      return output(row, dayKey(workspace.timezone, clock.now()));
    });
  } catch (e) {
    throw isPrismaCode(e, "P2002") ? new LeadError(409, "name_taken") : e;
  }
}
export async function updateLeadSource(
  prisma: PrismaClient,
  clock: Clock,
  ws: string,
  actorId: Actor,
  id: string,
  input: unknown,
): Promise<ApiLeadSource> {
  const v = leadSourcePatch.parse(input);
  try {
    return await prisma.$transaction(async (tx) => {
      if (
        !(await tx.leadSource.findFirst({ where: { id, workspaceId: ws }, select: { id: true } }))
      )
        throw notFound();
      await validateRefs(tx, ws, v);
      const row = await tx.leadSource.update({
        where: { id },
        data: {
          ...v,
          ...(v.filters && { filters: v.filters, nextPage: 1 }),
          ...(v.enabled === true && { lastError: null, lastErrorAt: null }),
        },
      });
      await audit(tx, { workspaceId: ws, actorId, at: clock.now() }, "lead_source.update", id, {
        fields: Object.keys(v),
      });
      const workspace = await tx.workspace.findUniqueOrThrow({
        where: { id: ws },
        select: { timezone: true },
      });
      return output(row, dayKey(workspace.timezone, clock.now()));
    });
  } catch (e) {
    throw isPrismaCode(e, "P2002") ? new LeadError(409, "name_taken") : e;
  }
}
export async function deleteLeadSource(
  prisma: PrismaClient,
  clock: Clock,
  ws: string,
  actorId: Actor,
  id: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (!(await tx.leadSource.findFirst({ where: { id, workspaceId: ws }, select: { id: true } })))
      throw notFound();
    await tx.leadSource.delete({ where: { id } });
    await audit(tx, { workspaceId: ws, actorId, at: clock.now() }, "lead_source.delete", id);
  });
}
const MAX_PER_RUN = 100;
const MAX_PAGES_PER_RUN = 3;

export async function setApolloSettings(
  prisma: PrismaClient,
  clock: Clock,
  ws: string,
  actorId: Actor,
  input: unknown,
): Promise<void> {
  const v = settings.parse(input);
  await prisma.$transaction(async (tx) => {
    await tx.workspace.update({
      where: { id: ws },
      data: { apolloConfigEnc: v.apiKey ? encrypt(JSON.stringify({ apiKey: v.apiKey })) : null },
    });
    await audit(tx, { workspaceId: ws, actorId, at: clock.now() }, "settings.apollo", ws, {
      set: !!v.apiKey,
    });
  });
}

export async function getApolloSettings(
  prisma: PrismaClient,
  ws: string,
): Promise<{ hasApiKey: boolean }> {
  const w = await prisma.workspace.findUniqueOrThrow({
    where: { id: ws },
    select: { apolloConfigEnc: true },
  });
  return { hasApiKey: !!w.apolloConfigEnc };
}

const clip = (v: string | null, n: number) => v?.slice(0, n) ?? null;
function usable(p: ApolloPerson): string | null {
  if (
    !p.email ||
    p.email.toLowerCase().startsWith("email_not_unlocked") ||
    p.emailStatus === "unavailable"
  )
    return null;
  const email = parseEmail(p.email);
  return email && !DISPOSABLE_DOMAINS.has(domainOf(email)) ? email : null;
}

export async function runLeadSources(
  prisma: PrismaClient,
  clock: Clock,
  deps: { sendable: AccountProvider[] } & ApolloOpts,
): Promise<{ searched: number; enriched: number; created: number }> {
  const totals = { searched: 0, enriched: 0, created: 0 };
  const sources = await prisma.leadSource.findMany({
    where: { enabled: true },
    orderBy: [{ lastRunAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
  });
  for (const source of sources) {
    if (deps.signal?.aborted) break;
    const now = clock.now();
    let error: string | null = null;
    let disable = false;
    let campaignUnavailable = false;
    let enriched = 0;
    let created = 0;
    let usableEmails = 0;
    try {
      const workspace = await prisma.workspace.findUniqueOrThrow({
        where: { id: source.workspaceId },
        select: {
          apolloConfigEnc: true,
          timezone: true,
          excludedCountries: true,
          excludedRegions: true,
        },
      });
      if (!workspace.apolloConfigEnc) {
        error = "no_api_key";
        continue;
      }
      const apiKey = (JSON.parse(decrypt(workspace.apolloConfigEnc)) as { apiKey: string }).apiKey;
      const day = dayKey(workspace.timezone, now);
      const loaded = await prisma.lead.count({
        where: {
          workspaceId: source.workspaceId,
          source: "apollo",
          createdAt: { gte: localMidnightUtc(day, workspace.timezone) },
          deletedAt: null,
        },
      });
      const cap = await leadCapacity(prisma, source.workspaceId, now, deps.sendable);
      const want = Math.min(MAX_PER_RUN, cap.headroom, cap.newPerDay - loaded);
      if (want <= 0) continue;
      const filters = leadSourceFilters.parse(source.filters);
      let page = source.nextPage;
      // the page each candidate came from: people the cap leaves over are read again from there next run
      const pageOf = new Map<string, number>();
      const used = source.creditDay?.toISOString().slice(0, 10) === day ? source.creditsUsed : 0;
      const limit = Math.min(want, source.dailyCreditCap - used);
      if (limit <= 0) continue;
      for (let i = 0; i < MAX_PAGES_PER_RUN && pageOf.size < limit && !deps.signal?.aborted; i++) {
        const result = await apolloSearch(apiKey, filters, page, deps);
        totals.searched += result.people.length;
        const ids = result.people.filter((p) => p.hasEmail).map((p) => p.id);
        const seen = await prisma.leadSourceSeen.findMany({
          where: { workspaceId: source.workspaceId, externalId: { in: ids } },
          select: { externalId: true },
        });
        const known = new Set(seen.map((s) => s.externalId));
        for (const id of ids) if (!known.has(id) && !pageOf.has(id)) pageOf.set(id, page);
        const last = page * 100 >= result.total || page >= 500 || result.people.length === 0;
        page = last ? 1 : page + 1;
        if (last) break;
      }
      const reserved = await withTxRetry(() =>
        prisma.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<
            {
              id: string;
              enabled: boolean;
              creditDay: Date | null;
              creditsUsed: number;
              dailyCreditCap: number;
            }[]
          >`
          SELECT "id", "enabled", "creditDay", "creditsUsed", "dailyCreditCap" FROM "LeadSource" WHERE "id" = ${source.id} AND "workspaceId" = ${source.workspaceId} FOR UPDATE`;
          const row = rows[0];
          if (!row?.enabled) return [] as string[];
          const spent = row.creditDay?.toISOString().slice(0, 10) === day ? row.creditsUsed : 0;
          const all = [...pageOf.keys()];
          const take = all.slice(0, Math.max(0, Math.min(want, row.dailyCreditCap - spent)));
          const inserted = take.length
            ? await tx.$queryRaw<{ externalId: string }[]>`
          INSERT INTO "LeadSourceSeen" ("workspaceId", "externalId")
          SELECT ${source.workspaceId}, unnest(${take}::text[])
          ON CONFLICT DO NOTHING RETURNING "externalId"`
            : [];
          await tx.leadSource.update({
            where: { id: source.id },
            data: {
              creditDay: new Date(`${day}T00:00:00Z`),
              creditsUsed: spent + inserted.length,
              nextPage: pageOf.get(all[take.length]!) ?? page,
            },
          });
          return inserted.map((r) => r.externalId);
        }),
      );
      for (let i = 0; i < reserved.length; i += 10) {
        if (deps.signal?.aborted) break;
        const matches = await apolloEnrich(apiKey, reserved.slice(i, i + 10), deps);
        enriched += reserved.slice(i, i + 10).length;
        usableEmails += matches.filter(usable).length;
        const result = await withTxRetry(() =>
          prisma.$transaction(
            async (tx) => {
              const candidates = matches
                .map((p) => ({ p, email: usable(p) }))
                .filter((x): x is { p: ApolloPerson; email: string } => !!x.email);
              const blocked = await suppressedEmails(
                tx,
                source.workspaceId,
                candidates.map((x) => x.email),
              );
              const valid = candidates.filter(
                ({ p, email }) =>
                  !blocked.has(email) &&
                  !regionExcluded({ country: p.country, region: p.state }, workspace),
              );
              const existing = await tx.lead.findMany({
                where: {
                  workspaceId: source.workspaceId,
                  email: { in: valid.map((x) => x.email) },
                  deletedAt: null,
                },
                select: { email: true },
              });
              const old = new Set(existing.map((x) => x.email));
              const fresh = valid.filter((x) => !old.has(x.email));
              await tx.lead.createMany({
                data: fresh.map(({ p, email }) => ({
                  workspaceId: source.workspaceId,
                  email,
                  firstName: clip(p.firstName, 100),
                  lastName: clip(p.lastName, 100),
                  jobTitle: clip(p.title, 200),
                  companyName: clip(p.companyName, 200),
                  companyDomain: companyDomainOf(email),
                  website: clip(p.website, 500),
                  industry: clip(p.industry, 200),
                  country: clip(p.country, 100),
                  region: clip(p.state, 100),
                  source: "apollo",
                  uploadMethod: "api",
                  lawfulBasis: source.lawfulBasis,
                  enrichmentStatus: "ENRICHED",
                  verificationStatus: "PENDING_JOB",
                  verifyPrevStatus: "NOT_VERIFIED",
                  tags: [],
                  labels: [],
                })),
                skipDuplicates: true,
              });
              const leads = await tx.lead.findMany({
                where: {
                  workspaceId: source.workspaceId,
                  source: "apollo",
                  email: { in: fresh.map((x) => x.email) },
                  deletedAt: null,
                },
                select: { id: true },
              });
              await tx.leadListMember.createMany({
                data: leads.map((l) => ({ listId: source.listId, leadId: l.id })),
                skipDuplicates: true,
              });
              if (source.campaignId) {
                const campaign = await tx.campaign.findFirst({
                  where: {
                    id: source.campaignId,
                    workspaceId: source.workspaceId,
                    deletedAt: null,
                    status: { not: "ARCHIVED" },
                  },
                  select: { id: true },
                });
                if (campaign)
                  await enrollBatch(
                    tx,
                    source.workspaceId,
                    campaign.id,
                    leads.map((l) => l.id),
                    false,
                    noSkips(),
                  );
                else campaignUnavailable = true;
              }
              await audit(
                tx,
                { workspaceId: source.workspaceId, at: now },
                "lead_source.run",
                source.id,
                { enriched: matches.length, created: leads.length },
              );
              return leads.length;
            },
            { timeout: 30_000 },
          ),
        );
        created += result;
      }
      if (reserved.length && usableEmails === 0) error = "apollo_no_emails";
      if (campaignUnavailable) error = "campaign_unavailable";
    } catch (e) {
      error = e instanceof ApolloError ? e.code : "internal_error";
      disable =
        error === "apollo_auth" || error === "apollo_plan" || /^apollo_http_4\d\d$/.test(error);
      console.error("lead source", error);
    } finally {
      totals.enriched += enriched;
      totals.created += created;
      await prisma.leadSource.updateMany({
        where: { id: source.id, workspaceId: source.workspaceId },
        data: {
          lastRunAt: now,
          lastError: error,
          lastErrorAt: error ? now : null,
          ...(disable && { enabled: false }),
        },
      });
    }
  }
  return totals;
}
