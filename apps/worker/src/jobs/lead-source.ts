import { getEnv, outEnv, runLeadSources, sendableProviders } from "@rightnow/core";
import type { JobDef } from "../boss";

export const leadSourceJob: JobDef = {
  name: "lead-source",
  cron: "7 * * * *",
  options: { policy: "stately", retryLimit: 0, heartbeatSeconds: 10 },
  handler: async (_jobs, { prisma, clock, signal }) => {
    const env = getEnv();
    await runLeadSources(prisma, clock, {
      sendable: await sendableProviders(prisma, env),
      allowPrivate: outEnv(env).allowPrivate,
      signal,
    });
  },
};
