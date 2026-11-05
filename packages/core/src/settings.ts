import type { Prisma, PrismaClient } from "@rightnow/db/client";
import { z } from "zod";
import { AccountError } from "./accounts/service";
import { audit } from "./audit";
import { lockEnrollment, stopOpenCampaignLeads } from "./campaigns/hooks";
import { OPEN_STATES_SQL } from "./campaigns/lead-status";
import type { Clock } from "./clock";
import { countrySpellings, normalizeCountry, normalizeRegion } from "./leads/regions";
import { isValidTimeZone } from "./schedule";

const patch = z.strictObject({
  timezone: z.string().refine(isValidTimeZone, "invalid_timezone").optional(),
  // empty clears it; sending stays blocked while it is empty (launch checks)
  physicalAddress: z.string().trim().max(500).optional(),
  // null = no cap
  dailyCap: z.number().int().min(1).max(1_000_000).nullable().optional(),
  perCompanyDailyLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
  disableOpenTracking: z.boolean().optional(),
  firstEmailTextOnly: z.boolean().optional(),
  // D34: account pause / BounceProtect line (hard bounce %) and the health throttle (% of the allowance kept)
  bounceThresholdPct: z.number().min(0.5).max(20).optional(),
  healthSlowdownPct: z.number().int().min(10).max(90).optional(),
  // D33 / D32: idle threshold, what happens at it, and the clean days a re-warm needs to finish
  inactivityDays: z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(60)]).optional(),
  autoRewarm: z.enum(["OFF", "RECOMMEND", "AUTO"]).optional(),
  rewarmExitCleanDays: z.number().int().min(1).max(30).optional(),
  rewarmExitBouncePct: z.number().min(0.5).max(10).optional(),
  // D40: one currency per workspace (ISO 4217); fixed while a deal carries money (Rev 2 M12)
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "invalid_currency")
    .optional(),
  // PS-CRM-12 (D48): false drops inbound replies from non-leads outside known threads
  storeNonLeadMail: z.boolean().optional(),
  // P9-T03: countries (ISO alpha-2 or a name) and regions; open campaign leads there stop when saved
  excludedCountries: z.array(z.string().trim().min(1).max(100)).max(250).optional(),
  excludedRegions: z.array(z.string().trim().min(1).max(100)).max(200).optional(),
});
const SELECT = {
  timezone: true,
  physicalAddress: true,
  dailyCap: true,
  perCompanyDailyLimit: true,
  disableOpenTracking: true,
  firstEmailTextOnly: true,
  bounceThresholdPct: true,
  healthSlowdownPct: true,
  inactivityDays: true,
  autoRewarm: true,
  rewarmExitCleanDays: true,
  rewarmExitBouncePct: true,
  currency: true,
  storeNonLeadMail: true,
  excludedCountries: true,
  excludedRegions: true,
} as const;

export async function getWorkspaceSettings(prisma: PrismaClient, ws: string) {
  const [w, noLocationLeads] = await Promise.all([
    prisma.workspace.findUniqueOrThrow({ where: { id: ws }, select: SELECT }),
    prisma.lead.count({
      where: {
        workspaceId: ws,
        deletedAt: null,
        AND: [
          { OR: [{ country: null }, { country: "" }] },
          { OR: [{ region: null }, { region: "" }] },
        ],
      },
    }),
  ]);
  return { ...w, noLocationLeads };
}

/** ADMIN settings: timezone (IANA), the CAN-SPAM physical address, workspace caps and the send flags; the change is audited with the new values. */
export async function updateWorkspaceSettings(
  prisma: PrismaClient,
  clock: Clock,
  ws: string,
  actorId: string | null | undefined,
  input: unknown,
) {
  const r = patch.safeParse(input);
  if (!r.success) throw new AccountError(400, r.error.issues[0]!.message);
  const { physicalAddress, excludedCountries, excludedRegions, ...rest } = r.data;
  // normalize before the transaction: an unknown country stores nothing
  const mapped = excludedCountries?.map(normalizeCountry);
  if (mapped?.some((c) => c === null)) throw new AccountError(400, "invalid_country");
  const countries = mapped?.filter((c): c is string => c !== null);
  const regions = excludedRegions?.map(normalizeRegion).filter((x): x is string => x !== null);
  const locations = excludedCountries !== undefined || excludedRegions !== undefined;
  const update = async (tx: Prisma.TransactionClient) => {
    // the enrollment lock first, so an enrollment after this commit sees the new rules
    if (locations) await lockEnrollment(tx, ws);
    if (rest.currency) {
      // FOR UPDATE conflicts with the FK KEY SHARE of a deal insert, so the count sees in-flight deals
      await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${ws} FOR UPDATE`;
      const cur = await tx.workspace.findUniqueOrThrow({
        where: { id: ws },
        select: { currency: true },
      });
      const money = {
        workspaceId: ws,
        OR: [{ value: { not: 0 } }, { cashCollected: { not: 0 } }],
      };
      if (cur.currency !== rest.currency && (await tx.opportunity.count({ where: money })))
        throw new AccountError(409, "currency_in_use");
    }
    const w = await tx.workspace.update({
      where: { id: ws },
      data: {
        ...rest,
        ...(physicalAddress !== undefined && { physicalAddress: physicalAddress || null }),
        ...(countries !== undefined && { excludedCountries: [...new Set(countries)] }),
        ...(regions !== undefined && { excludedRegions: [...new Set(regions)] }),
      },
      select: SELECT,
    });
    let stopped: number | undefined;
    if (locations) {
      // after update: the stored rules are the effective ones. Any spelling of an excluded country matches.
      const spellings = [...new Set(w.excludedCountries.flatMap((code) => countrySpellings(code)))];
      const ids = (
        await tx.$queryRaw<{ id: string }[]>`
        SELECT l."id" FROM "Lead" l
        WHERE l."workspaceId" = ${ws} AND l."deletedAt" IS NULL
          AND (lower(trim(l."country")) = ANY(${spellings}::text[])
            OR lower(trim(l."region")) = ANY(${w.excludedRegions}::text[]))
          AND EXISTS (
            SELECT 1 FROM "CampaignLead" cl
            WHERE cl."leadId" = l."id" AND cl."workspaceId" = ${ws}
              AND cl."state" = ANY(${OPEN_STATES_SQL})
          )`
      ).map((row) => row.id);
      await stopOpenCampaignLeads(tx, ws, ids, "SKIPPED", clock.now());
      stopped = ids.length;
    }
    await audit(tx, { workspaceId: ws, actorId, at: clock.now() }, "settings.update", ws, {
      ...rest,
      ...(physicalAddress !== undefined && { physicalAddress: w.physicalAddress }),
      ...(countries !== undefined && { excludedCountries: w.excludedCountries }),
      ...(regions !== undefined && { excludedRegions: w.excludedRegions }),
      ...(stopped !== undefined && { stopped }),
    });
    return w;
  };
  return prisma.$transaction(update, { timeout: 30_000 });
}
