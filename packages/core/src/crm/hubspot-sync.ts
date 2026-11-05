import type { PrismaClient } from "@rightnow/db/client";
import { z } from "zod";
import { AccountError } from "../accounts/service";
import { audit } from "../audit";
import type { Clock } from "../clock";
import { decrypt, encrypt } from "../crypto";
import { withTxRetry } from "../dispatch";
import { companyDomainOf } from "../leads/domain";
import { suppress, suppressedEmails } from "../leads/suppression";
import {
  associateDeals,
  customerDomains,
  ensureDealProperty,
  HubspotError,
  type HubspotOpts,
  upsertContacts,
  upsertDeals,
} from "./hubspot";

export const crmSyncInput = z.strictObject({
  token: z.string().min(1).max(500).optional(),
  pipelineId: z.string().min(1).max(100),
  stageMap: z.record(z.string(), z.string()),
});
type Config = { token: string; pipelineId: string; stageMap: Record<string, string> };
type Actor = string | null | undefined;
const config = (enc: string): Config => JSON.parse(decrypt(enc)) as Config;

export async function setCrmSyncSettings(
  prisma: PrismaClient,
  clock: Clock,
  ws: string,
  actorId: Actor,
  input: unknown,
  o: HubspotOpts = {},
): Promise<void> {
  const v = crmSyncInput.parse(input);
  const old = await prisma.workspace.findUniqueOrThrow({
    where: { id: ws },
    select: { crmSyncConfigEnc: true },
  });
  const token = v.token ?? (old.crmSyncConfigEnc ? config(old.crmSyncConfigEnc).token : null);
  if (!token) throw new AccountError(400, "token_required");
  const stages = await prisma.pipelineStage.findMany({
    where: { workspaceId: ws, id: { in: Object.keys(v.stageMap) } },
    select: { id: true },
  });
  if (stages.length !== Object.keys(v.stageMap).length)
    throw new AccountError(400, "unknown_stage");
  try {
    await ensureDealProperty(token, o);
  } catch (e) {
    if (e instanceof HubspotError && (e.code === "hubspot_auth" || e.code === "hubspot_scope"))
      throw new AccountError(400, e.code);
    throw e;
  }
  await prisma.$transaction(async (tx) => {
    await tx.workspace.update({
      where: { id: ws },
      data: {
        crmSyncConfigEnc: encrypt(
          JSON.stringify({ token, pipelineId: v.pipelineId, stageMap: v.stageMap }),
        ),
        crmSyncLastError: null,
        crmSyncLastErrorAt: null,
        crmCustomersPulledAt: null,
      },
    });
    await audit(tx, { workspaceId: ws, actorId, at: clock.now() }, "settings.hubspot", ws, {
      set: true,
    });
  });
}
export async function clearCrmSyncSettings(
  prisma: PrismaClient,
  clock: Clock,
  ws: string,
  actorId: Actor,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.workspace.update({ where: { id: ws }, data: { crmSyncConfigEnc: null } });
    await audit(tx, { workspaceId: ws, actorId, at: clock.now() }, "settings.hubspot", ws, {
      set: false,
    });
  });
}
export async function getCrmSyncSettings(
  prisma: PrismaClient,
  ws: string,
): Promise<{
  connected: boolean;
  pipelineId?: string;
  stageMap?: Record<string, string>;
  lastRunAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  customersPulledAt: Date | null;
}> {
  const w = await prisma.workspace.findUniqueOrThrow({
    where: { id: ws },
    select: {
      crmSyncConfigEnc: true,
      crmSyncLastRunAt: true,
      crmSyncLastError: true,
      crmSyncLastErrorAt: true,
      crmCustomersPulledAt: true,
    },
  });
  const c = w.crmSyncConfigEnc ? config(w.crmSyncConfigEnc) : null;
  return {
    connected: !!c,
    ...(c && { pipelineId: c.pipelineId, stageMap: c.stageMap }),
    lastRunAt: w.crmSyncLastRunAt,
    lastError: w.crmSyncLastError,
    lastErrorAt: w.crmSyncLastErrorAt,
    customersPulledAt: w.crmCustomersPulledAt,
  };
}

type Deal = {
  id: string;
  leadId: string;
  stageId: string;
  title: string;
  value: { toString(): string };
  closedAt: Date | null;
  expectedCloseAt: Date | null;
  updatedAt: Date;
};
type LeadRow = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  jobTitle: string | null;
  website: string | null;
  phone: string | null;
  country: string | null;
  region: string | null;
  updatedAt: Date;
};
const domainValid = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const value = (v: string | null) => v?.trim() || undefined;

/** Push only engaged, live people and mapped deals. Every network request happens outside a transaction. */
export async function runCrmSync(
  prisma: PrismaClient,
  clock: Clock,
  o: HubspotOpts = {},
): Promise<{ contacts: number; deals: number; domains: number }> {
  const total = { contacts: 0, deals: 0, domains: 0 };
  const workspaces = await prisma.workspace.findMany({
    where: {
      crmSyncConfigEnc: { not: null },
      OR: [{ crmSyncLastError: null }, { crmSyncLastError: { not: "hubspot_auth" } }],
    },
    select: { id: true, crmSyncConfigEnc: true, crmCustomersPulledAt: true },
  });
  for (const w of workspaces) {
    if (o.signal?.aborted) break;
    const ws = w.id;
    let firstError: string | null = null;
    try {
      const cfg = config(w.crmSyncConfigEnc!); // a bad value fails this workspace only
      const deals = await prisma.$queryRaw<Deal[]>`
        SELECT d."id", d."leadId", d."stageId", d."title", d."value", d."closedAt", d."expectedCloseAt", d."updatedAt"
        FROM "Opportunity" d JOIN "Lead" l ON l."id" = d."leadId" AND l."workspaceId" = ${ws} AND l."deletedAt" IS NULL
        WHERE d."workspaceId" = ${ws} AND (d."crmSyncedAt" IS NULL OR d."updatedAt" > d."crmSyncedAt")
        ORDER BY d."updatedAt", d."id" LIMIT 100`;
      const mapped = deals.filter((d) => {
        if (cfg.stageMap[d.stageId]) return true;
        firstError ??= "hubspot_unmapped_stage";
        return false;
      });
      // shortcut: scans the workspace's leads each run, add an index if a workspace outgrows it.
      const leads = await prisma.$queryRaw<LeadRow[]>`
        WITH pending AS (
          SELECT l."id" FROM "Lead" l WHERE l."workspaceId" = ${ws} AND l."deletedAt" IS NULL
            AND (l."crmSyncedAt" IS NULL OR l."updatedAt" > l."crmSyncedAt")
            AND (l."replies" > 0 OR coalesce(l."interestStatus", 0) > 0
              OR EXISTS (SELECT 1 FROM "Opportunity" d WHERE d."leadId" = l."id" AND d."workspaceId" = ${ws}))
          ORDER BY l."updatedAt", l."id" LIMIT 100
        )
        SELECT l."id", l."email", l."firstName", l."lastName", l."companyName", l."jobTitle", l."website", l."phone", l."country", l."region", l."updatedAt"
        FROM "Lead" l WHERE l."workspaceId" = ${ws} AND l."deletedAt" IS NULL
          AND (l."id" IN (SELECT "id" FROM pending) OR l."id" = ANY(${mapped.map((d) => d.leadId)}::text[]))
        ORDER BY l."updatedAt", l."id"`;
      const blocked = await suppressedEmails(
        prisma,
        ws,
        leads.map((l) => l.email),
      );
      const dropped = leads.filter((l) => blocked.has(l.email.toLowerCase()));
      for (const l of dropped)
        await prisma.$executeRaw`UPDATE "Lead" SET "crmSyncedAt" = "updatedAt" WHERE "id" = ${l.id} AND "workspaceId" = ${ws} AND "updatedAt" = ${l.updatedAt}`;
      const send = leads.filter((l) => !blocked.has(l.email.toLowerCase()));
      const eligibleDeals = mapped.filter((d) => send.some((l) => l.id === d.leadId));
      const contacts = send.length
        ? await upsertContacts(
            cfg.token,
            send.map((l) => ({
              email: l.email,
              properties: Object.fromEntries(
                Object.entries({
                  email: l.email,
                  firstname: value(l.firstName),
                  lastname: value(l.lastName),
                  company: value(l.companyName),
                  jobtitle: value(l.jobTitle),
                  website: value(l.website),
                  phone: value(l.phone),
                  country: value(l.country),
                  state: value(l.region),
                }).filter(([, v]) => v),
              ) as Record<string, string>,
            })),
            o,
          )
        : new Map<string, string>();
      total.contacts += contacts.size;
      const dealIds = eligibleDeals.length
        ? await upsertDeals(
            cfg.token,
            eligibleDeals.map((d) => ({
              rightnowId: d.id,
              properties: {
                rightnow_id: d.id,
                dealname: d.title,
                amount: d.value.toString(),
                pipeline: cfg.pipelineId,
                dealstage: cfg.stageMap[d.stageId]!,
                ...((d.closedAt ?? d.expectedCloseAt) && {
                  closedate: (d.closedAt ?? d.expectedCloseAt)!.toISOString(),
                }),
              },
            })),
            o,
          )
        : new Map<string, string>();
      if (eligibleDeals.length)
        await associateDeals(
          cfg.token,
          eligibleDeals.map((d) => ({
            dealId: dealIds.get(d.id)!,
            contactId: contacts.get(send.find((l) => l.id === d.leadId)!.email.toLowerCase())!,
          })),
          o,
        );
      total.deals += eligibleDeals.length;
      for (const d of eligibleDeals)
        await prisma.$executeRaw`UPDATE "Opportunity" SET "crmSyncedAt" = "updatedAt" WHERE "id" = ${d.id} AND "workspaceId" = ${ws} AND "updatedAt" = ${d.updatedAt}`;
      for (const l of send)
        await prisma.$executeRaw`UPDATE "Lead" SET "crmSyncedAt" = "updatedAt" WHERE "id" = ${l.id} AND "workspaceId" = ${ws} AND "updatedAt" = ${l.updatedAt}`;
      if (
        !w.crmCustomersPulledAt ||
        clock.now().getTime() - w.crmCustomersPulledAt.getTime() >= 86_400_000
      ) {
        try {
          const domains = [
            ...new Set(
              (await customerDomains(cfg.token, o))
                .map((d) =>
                  d
                    .trim()
                    .toLowerCase()
                    .replace(/^www\./, ""),
                )
                .filter((d) => domainValid.test(d) && companyDomainOf(`x@${d}`) !== null),
            ),
          ];
          for (let i = 0; i < domains.length; i += 500)
            total.domains += await withTxRetry(() =>
              prisma.$transaction((tx) =>
                suppress(
                  tx,
                  ws,
                  domains.slice(i, i + 500).map((value) => ({ kind: "DOMAIN", value })),
                  "CUSTOMER",
                  "hubspot",
                ),
              ),
            );
          await prisma.workspace.update({
            where: { id: ws },
            data: { crmCustomersPulledAt: clock.now() },
          });
        } catch (e) {
          firstError ??= e instanceof HubspotError ? e.code : "hubspot_failed";
        }
      }
    } catch (e) {
      firstError ??= e instanceof HubspotError ? e.code : "hubspot_failed";
    }
    await prisma.workspace.update({
      where: { id: ws },
      data: {
        crmSyncLastRunAt: clock.now(),
        crmSyncLastError: firstError,
        crmSyncLastErrorAt: firstError ? clock.now() : null,
      },
    });
    if (firstError) console.warn("crm-sync", firstError);
  }
  return total;
}
