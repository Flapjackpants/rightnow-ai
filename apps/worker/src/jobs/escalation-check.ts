import { runEscalationCheck } from "@rightnow/core";
import type { JobDef } from "../boss";

export const escalationCheckJob: JobDef = {
  name: "escalation-check",
  cron: "*/10 * * * *",
  options: { policy: "stately", retryLimit: 0, heartbeatSeconds: 10 },
  handler: async (_jobs, { prisma, clock, signal }) => {
    await runEscalationCheck(prisma, clock, signal);
  },
};
