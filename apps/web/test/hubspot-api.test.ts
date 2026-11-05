import { createTestDb } from "@rightnow/db/test-db";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createFirstOwner } from "../lib/setup";

vi.mock("@rightnow/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rightnow/providers")>();
  return {
    ...actual,
    safeRequest: vi.fn(async (url: string) => ({
      status: 200,
      body: Buffer.from(
        JSON.stringify(
          url.endsWith("/pipelines/deals")
            ? { results: [{ id: "p", label: "Sales", stages: [{ id: "s", label: "Won" }] }] }
            : {},
        ),
      ),
      headers: {},
      latencyMs: 1,
    })),
  };
});
const TOKEN = "t".repeat(20);
const PASSWORD = "correct horse battery";
const ORIGIN = "http://localhost:3100";
let db: Awaited<ReturnType<typeof createTestDb>>;
let workspaceId: string;
let cookie: string;
let key: string;
let settings: typeof import("../app/api/v1/settings/hubspot/route");
let pipelines: typeof import("../app/api/v1/settings/hubspot/pipelines/route");
const req = (method: string, body?: unknown, headers: Record<string, string> = { cookie }) =>
  new Request(`${ORIGIN}/x`, {
    method,
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const setRole = (role: string) =>
  db.prisma.member.updateMany({ where: { workspaceId }, data: { role } });

beforeAll(async () => {
  db = await createTestDb();
  Object.assign(process.env, {
    MODE: "local",
    DATABASE_URL: db.url,
    APP_URL: ORIGIN,
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    BETTER_AUTH_SECRET: "x".repeat(40),
    SETUP_TOKEN: TOKEN,
  });
  const { auth } = await import("../lib/auth");
  const { createApiKey } = await import("@rightnow/core");
  settings = await import("../app/api/v1/settings/hubspot/route");
  pipelines = await import("../app/api/v1/settings/hubspot/pipelines/route");
  ({ workspaceId } = await createFirstOwner(
    db.prisma,
    { name: "O", email: "owner@x.io", password: PASSWORD, workspaceName: "Acme", token: TOKEN },
    TOKEN,
  ));
  const { headers } = await auth.api.signInEmail({
    body: { email: "owner@x.io", password: PASSWORD },
    returnHeaders: true,
  });
  cookie = headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  key = (await createApiKey(db.prisma, workspaceId, "k", ["crm:read"])).token;
});
afterAll(async () => {
  await db.drop();
});

test("all HubSpot routes require admin session", async () => {
  const calls = [
    () => settings.GET(req("GET")),
    () => settings.PUT(req("PUT", { token: "secret", pipelineId: "p", stageMap: {} })),
    () => settings.DELETE(req("DELETE")),
    () => pipelines.POST(req("POST", { token: "secret" })),
  ];
  await setRole("member");
  for (const call of calls) expect((await call()).status).toBe(403);
  await setRole("owner");
  const keyed = [
    () => settings.GET(req("GET", undefined, { authorization: `Bearer ${key}` })),
    () =>
      settings.PUT(
        req(
          "PUT",
          { token: "secret", pipelineId: "p", stageMap: {} },
          { authorization: `Bearer ${key}` },
        ),
      ),
    () => settings.DELETE(req("DELETE", undefined, { authorization: `Bearer ${key}` })),
    () => pipelines.POST(req("POST", { token: "secret" }, { authorization: `Bearer ${key}` })),
  ];
  for (const call of keyed) expect((await call()).status).toBe(401);
});

test("owner connects, reads without token, lists pipelines, rejects unknown stages and disconnects", async () => {
  expect(
    (await settings.PUT(req("PUT", { token: "secret", pipelineId: "p", stageMap: {} }))).status,
  ).toBe(200);
  const got = await settings.GET(req("GET"));
  const text = await got.text();
  expect(JSON.parse(text).connected).toBe(true);
  expect(text).not.toContain("secret");
  const bad = await settings.PUT(req("PUT", { pipelineId: "p", stageMap: { unknown: "s" } }));
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ error: "unknown_stage" });
  const list = await pipelines.POST(req("POST", {}));
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual({
    pipelines: [{ id: "p", label: "Sales", stages: [{ id: "s", label: "Won" }] }],
  });
  expect((await settings.DELETE(req("DELETE"))).status).toBe(200);
  expect(await (await settings.GET(req("GET"))).json()).toMatchObject({ connected: false });
});

test("another workspace sees disconnected", async () => {
  const other = await db.prisma.workspace.create({
    data: { name: "Other", slug: "hubspot-other" },
  });
  expect(
    (await settings.PUT(req("PUT", { token: "secret", pipelineId: "p", stageMap: {} }))).status,
  ).toBe(200);
  await db.prisma.member.updateMany({ where: { workspaceId }, data: { workspaceId: other.id } });
  try {
    expect(await (await settings.GET(req("GET"))).json()).toMatchObject({ connected: false });
  } finally {
    await db.prisma.member.updateMany({ where: { workspaceId: other.id }, data: { workspaceId } });
  }
});
