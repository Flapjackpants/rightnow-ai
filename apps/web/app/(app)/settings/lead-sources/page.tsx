import { getApolloSettings, listLeadSources, systemClock } from "@rightnow/core";
import { prisma } from "@rightnow/db";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Callout } from "../../../../components/callout";
import { LeadSources } from "../../../../components/lead-sources";
import { PageHeader } from "../../../../components/page-header";
import { SectionTabs } from "../../../../components/section-tabs";
import { getSessionInfo } from "../../../../lib/workspace";
import { SETTINGS_TABS } from "../tabs";

export const metadata: Metadata = { title: "Lead sources" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const info = await getSessionInfo(await headers());
  if (!info) redirect("/sign-in");
  const header = (
    <PageHeader
      title="Lead sources"
      description="Manage Apollo searches and credits used."
      tabs={<SectionTabs tabs={SETTINGS_TABS} />}
    />
  );
  if (info.role !== "OWNER" && info.role !== "ADMIN")
    return (
      <div className="flex flex-col gap-6">
        {header}
        <Callout tone="neutral">Only workspace owners and admins can manage lead sources.</Callout>
      </div>
    );
  const ws = info.workspaceId;
  const [settings, sources, lists, campaigns] = await Promise.all([
    getApolloSettings(prisma, ws),
    listLeadSources(prisma, systemClock, ws),
    prisma.leadList.findMany({
      where: { workspaceId: ws },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.campaign.findMany({
      where: { workspaceId: ws, deletedAt: null, status: { not: "ARCHIVED" } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);
  return (
    <div className="flex flex-col gap-6">
      {header}
      <LeadSources
        hasApiKey={settings.hasApiKey}
        sources={sources.map((s) => ({
          ...s,
          createdAt: s.createdAt.toISOString(),
          lastRunAt: s.lastRunAt?.toISOString() ?? null,
          lastErrorAt: s.lastErrorAt?.toISOString() ?? null,
        }))}
        lists={lists}
        campaigns={campaigns}
      />
    </div>
  );
}
