import { handoffDraft } from "@rightnow/core";
import { prisma } from "@rightnow/db";
import { run } from "../../../../../../../lib/accounts-http";
import { route } from "../../../../../../../lib/api";

export const dynamic = "force-dynamic";

/** Read-only handoff draft for the conversation's owner. Sending remains a separate user action. */
export const POST = route({ auth: "session-or-apikey", scope: "inbox:read", role: "VIEWER" }, (c) =>
  run(() => handoffDraft(prisma, c.workspaceId, c.params.id!)),
);
