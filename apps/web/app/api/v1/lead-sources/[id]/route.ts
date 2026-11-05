import { deleteLeadSource, leadSourcePatch, systemClock, updateLeadSource } from "@rightnow/core";
import { prisma } from "@rightnow/db";
import { run } from "../../../../../lib/accounts-http";
import { route } from "../../../../../lib/api";

export const dynamic = "force-dynamic";
export const PATCH = route({ auth: "session", role: "ADMIN", body: leadSourcePatch }, (c) =>
  run(() => updateLeadSource(prisma, systemClock, c.workspaceId, c.userId, c.params.id!, c.body)),
);
export const DELETE = route({ auth: "session", role: "ADMIN" }, (c) =>
  run(() => deleteLeadSource(prisma, systemClock, c.workspaceId, c.userId, c.params.id!)),
);
