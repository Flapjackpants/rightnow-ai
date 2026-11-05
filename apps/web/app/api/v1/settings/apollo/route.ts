import {
  apolloSettingsInput,
  getApolloSettings,
  setApolloSettings,
  systemClock,
} from "@rightnow/core";
import { prisma } from "@rightnow/db";
import { run } from "../../../../../lib/accounts-http";
import { route } from "../../../../../lib/api";

export const dynamic = "force-dynamic";
export const GET = route({ auth: "session", role: "ADMIN" }, (c) =>
  getApolloSettings(prisma, c.workspaceId),
);
export const PUT = route({ auth: "session", role: "ADMIN", body: apolloSettingsInput }, (c) =>
  run(async () => {
    await setApolloSettings(prisma, systemClock, c.workspaceId, c.userId, c.body);
    return getApolloSettings(prisma, c.workspaceId);
  }),
);
