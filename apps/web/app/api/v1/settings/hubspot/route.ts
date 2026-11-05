import {
  clearCrmSyncSettings,
  crmSyncInput,
  getCrmSyncSettings,
  setCrmSyncSettings,
  systemClock,
} from "@rightnow/core";
import { prisma } from "@rightnow/db";
import { run } from "../../../../../lib/accounts-http";
import { route } from "../../../../../lib/api";
import { outEnv } from "../../../../../lib/webhook-env";

export const dynamic = "force-dynamic";
export const GET = route({ auth: "session", role: "ADMIN" }, (c) =>
  getCrmSyncSettings(prisma, c.workspaceId),
);
export const PUT = route({ auth: "session", role: "ADMIN", body: crmSyncInput }, (c) =>
  run(async () => {
    await setCrmSyncSettings(prisma, systemClock, c.workspaceId, c.userId, c.body, outEnv());
    return getCrmSyncSettings(prisma, c.workspaceId);
  }),
);
export const DELETE = route({ auth: "session", role: "ADMIN" }, (c) =>
  run(async () => {
    await clearCrmSyncSettings(prisma, systemClock, c.workspaceId, c.userId);
    return getCrmSyncSettings(prisma, c.workspaceId);
  }),
);
