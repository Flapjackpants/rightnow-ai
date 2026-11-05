import { createLeadSource, leadSourceInput, listLeadSources, systemClock } from "@rightnow/core";
import { prisma } from "@rightnow/db";
import { run } from "../../../../lib/accounts-http";
import { route } from "../../../../lib/api";

export const dynamic = "force-dynamic";
export const GET = route({ auth: "session", role: "ADMIN" }, async (c) => ({
  sources: await listLeadSources(prisma, systemClock, c.workspaceId),
}));
export const POST = route({ auth: "session", role: "ADMIN", body: leadSourceInput }, (c) =>
  run(async () =>
    Response.json(await createLeadSource(prisma, systemClock, c.workspaceId, c.userId, c.body), {
      status: 201,
    }),
  ),
);
