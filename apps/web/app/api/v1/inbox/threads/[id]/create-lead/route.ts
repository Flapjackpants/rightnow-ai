import { createLeadFromThread, requireScopes, systemClock } from "@rightnow/core";
import { prisma } from "@rightnow/db";
import { run } from "../../../../../../../lib/accounts-http";
import { route } from "../../../../../../../lib/api";

export const dynamic = "force-dynamic";

export const POST = route({ auth: "session-or-apikey", scope: "inbox:write" }, (c) =>
  run(() => {
    // m13: this creates a lead, not only a thread link
    requireScopes(c.scopes, "leads:create");
    return createLeadFromThread(prisma, systemClock, c.workspaceId, c.userId, c.params.id!);
  }),
);
