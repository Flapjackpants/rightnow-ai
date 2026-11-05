import { getEnv, leadCapacity, sendableProviders, systemClock } from "@rightnow/core";
import { prisma } from "@rightnow/db";
import { route } from "../../../../../lib/api";

export const dynamic = "force-dynamic";

export const GET = route({ auth: "session-or-apikey", scope: "leads:read" }, async (c) =>
  Response.json(
    await leadCapacity(
      prisma,
      c.workspaceId,
      systemClock.now(),
      await sendableProviders(prisma, getEnv()),
    ),
  ),
);
