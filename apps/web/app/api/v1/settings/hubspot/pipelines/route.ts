import { hubspotPipelinesInput, listHubspotPipelines } from "@rightnow/core";
import { prisma } from "@rightnow/db";
import { run } from "../../../../../../lib/accounts-http";
import { route } from "../../../../../../lib/api";
import { outEnv } from "../../../../../../lib/webhook-env";

export const dynamic = "force-dynamic";
export const POST = route({ auth: "session", role: "ADMIN", body: hubspotPipelinesInput }, (c) =>
  run(async () => ({
    pipelines: await listHubspotPipelines(prisma, c.workspaceId, c.body, outEnv()),
  })),
);
