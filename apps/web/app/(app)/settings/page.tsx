import {
  ensureStages,
  getCrmSyncSettings,
  getAiSettings,
  getVerifierSettings,
  getWorkspaceSettings,
  listLabels,
} from "@rightnow/core";
import { prisma } from "@rightnow/db";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AiSettings } from "../../../components/ai-settings";
import { AuditLog } from "../../../components/audit-log";
import { Callout } from "../../../components/callout";
import { HubspotSettings } from "../../../components/hubspot-settings";
import { LabelsSettings } from "../../../components/labels-settings";
import { MembersSettings } from "../../../components/members-settings";
import { PageHeader } from "../../../components/page-header";
import { SectionTabs } from "../../../components/section-tabs";
import { SecuritySettings } from "../../../components/security-settings";
import { VerifierSettings } from "../../../components/verifier-settings";
import { WorkspaceSettings } from "../../../components/workspace-settings";
import { getSessionInfo } from "../../../lib/workspace";
import { SETTINGS_TABS } from "./tabs";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; cursor?: string }>;
}) {
  const info = await getSessionInfo(await headers());
  if (!info?.userId) redirect("/sign-in");
  const ws = info.workspaceId;
  const admin = info.role === "OWNER" || info.role === "ADMIN";
  const s = admin ? await getWorkspaceSettings(prisma, ws) : null;
  const verifier = admin ? await getVerifierSettings(prisma, ws) : null;
  const ai = admin ? await getAiSettings(prisma, ws) : null;
  const crm = admin ? await getCrmSyncSettings(prisma, ws) : null;
  const stages = admin ? await ensureStages(prisma, ws) : [];
  const me = await prisma.user.findUniqueOrThrow({
    where: { id: info.userId },
    select: { twoFactorEnabled: true },
  });
  const [members, invites] = admin
    ? await Promise.all([
        prisma.member.findMany({
          where: { workspaceId: ws },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            userId: true,
            role: true,
            user: { select: { name: true, email: true } },
          },
        }),
        prisma.invitation.findMany({
          where: { workspaceId: ws, status: "pending", expiresAt: { gt: new Date() } },
          orderBy: { createdAt: "desc" },
          select: { id: true, email: true, role: true, expiresAt: true },
        }),
      ])
    : [[], []];
  const q = await searchParams;
  const member = info.role !== "VIEWER";
  // the "On this page" nav lists only the sections this role can see
  const sections = [
    ["workspace", "Workspace", true],
    ["members", "Members", admin],
    ["labels", "Labels", member],
    ["security", "Security", true],
    ["ai", "AI", admin],
    ["verifier", "Email verification", !!verifier],
    ["hubspot", "HubSpot", !!crm],
    ["audit-log", "Audit log", member],
  ].filter(([, , on]) => on) as [string, string, boolean][];
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Settings" tabs={<SectionTabs tabs={SETTINGS_TABS} />} />
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <nav
          aria-label="Settings sections"
          className="-mx-4 flex gap-1 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:px-0 lg:sticky lg:top-16 lg:w-50 lg:shrink-0 lg:flex-col"
        >
          {sections.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className="inline-flex h-9 shrink-0 items-center rounded-sm px-2.5 text-sm font-medium text-fg-muted hover:bg-hover hover:text-fg max-lg:h-11 max-lg:border max-lg:border-border max-lg:bg-surface"
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-6 lg:max-w-180">
          {s ? (
            <WorkspaceSettings {...s} physicalAddress={s.physicalAddress ?? ""} />
          ) : (
            <section id="workspace" className="scroll-mt-16">
              <Callout tone="neutral">
                Only workspace owners and admins can change settings.
              </Callout>
            </section>
          )}
          {admin && (
            <MembersSettings
              members={members.map((m) => ({
                id: m.id,
                name: m.user.name,
                email: m.user.email,
                role: m.role,
                self: m.userId === info.userId,
              }))}
              invites={invites.map((i) => ({ ...i, expiresAt: i.expiresAt.toISOString() }))}
            />
          )}
          {member && <LabelsSettings labels={await listLabels(prisma, ws)} />}
          <SecuritySettings enabled={me.twoFactorEnabled} />
          {admin && <AiSettings {...(ai ?? {})} />}
          {verifier && <VerifierSettings {...verifier} />}
          {crm && (
            <HubspotSettings
              {...crm}
              lastRunAt={crm.lastRunAt?.toISOString() ?? null}
              lastErrorAt={crm.lastErrorAt?.toISOString() ?? null}
              customersPulledAt={crm.customersPulledAt?.toISOString() ?? null}
              stages={stages.map(({ id, name }) => ({ id, name }))}
            />
          )}
          {member && <AuditLog workspaceId={ws} action={q.action} cursor={q.cursor} />}
        </div>
      </div>
    </div>
  );
}
