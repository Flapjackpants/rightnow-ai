import { getEnv, outEnv, runCrmSync } from "@rightnow/core";
import type { JobDef } from "../boss";

export const crmSyncJob: JobDef = {
  name: "crm-sync",
  cron: "*/5 * * * *",
  options: { policy: "stately", retryLimit: 0, heartbeatSeconds: 10 },
  handler: async (_jobs, { prisma, clock, signal }) => {
    await runCrmSync(prisma, clock, { allowPrivate: outEnv(getEnv()).allowPrivate, signal });
  },
};
