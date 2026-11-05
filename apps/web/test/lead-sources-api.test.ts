import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@rightnow/db/test-db";
import { createFirstOwner } from "../lib/setup";

const ORIGIN = "http://localhost:3100";
let db: Awaited<ReturnType<typeof createTestDb>>;
let ws: string, cookie: string, key: string;
let settings: typeof import("../app/api/v1/settings/apollo/route");
let sources: typeof import("../app/api/v1/lead-sources/route");
let source: typeof import("../app/api/v1/lead-sources/[id]/route");
const req = (method: string, body?: unknown, headers: Record<string, string> = { cookie }) =>
  new Request(`${ORIGIN}/x`, {
    method,
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
beforeAll(async () => {
  db = await createTestDb();
  Object.assign(process.env, {
    MODE: "local",
    DATABASE_URL: db.url,
    APP_URL: ORIGIN,
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    BETTER_AUTH_SECRET: "x".repeat(40),
    SETUP_TOKEN: "t".repeat(20),
  });
  const { auth } = await import("../lib/auth");
  const { createApiKey } = await import("@rightnow/core");
  settings = await import("../app/api/v1/settings/apollo/route");
  sources = await import("../app/api/v1/lead-sources/route");
  source = await import("../app/api/v1/lead-sources/[id]/route");
  ({ workspaceId: ws } = await createFirstOwner(
    db.prisma,
    {
      name: "O",
      email: "apollo@x.io",
      password: "correct horse battery",
      workspaceName: "Acme",
      token: "t".repeat(20),
    },
    "t".repeat(20),
  ));
  const { headers } = await auth.api.signInEmail({
    body: { email: "apollo@x.io", password: "correct horse battery" },
    returnHeaders: true,
  });
  cookie = headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  key = (
    await createApiKey(db.prisma, ws, "k", [
      "leads:create",
      "leads:read",
      "leads:update",
      "leads:delete",
    ])
  ).token;
});
afterAll(() => db.drop());
const id = { params: Promise.resolve({ id: "missing" }) };
describe("lead sources API", () => {
  it("requires an admin session on every route", async () => {
    await db.prisma.member.updateMany({ where: { workspaceId: ws }, data: { role: "MEMBER" } });
    for (const run of [
      () => settings.GET(req("GET")),
      () => settings.PUT(req("PUT", { apiKey: null })),
      () => sources.GET(req("GET")),
      () => sources.POST(req("POST", {})),
      () => source.PATCH(req("PATCH", {}, { cookie }), id),
      () => source.DELETE(req("DELETE"), id),
    ])
      expect((await run()).status).toBe(403);
    await db.prisma.member.updateMany({ where: { workspaceId: ws }, data: { role: "OWNER" } });
    const bearer = { authorization: `Bearer ${key}` };
    for (const run of [
      () => settings.GET(req("GET", undefined, bearer)),
      () => settings.PUT(req("PUT", { apiKey: null }, bearer)),
      () => sources.GET(req("GET", undefined, bearer)),
      () => sources.POST(req("POST", {}, bearer)),
      () => source.PATCH(req("PATCH", {}, bearer), id),
      () => source.DELETE(req("DELETE", undefined, bearer), id),
    ])
      expect((await run()).status).toBe(401);
  });
  it("saves a write-only key and manages a search", async () => {
    expect((await settings.PUT(req("PUT", { apiKey: "private-apollo-key" }))).status).toBe(200);
    const settingText = await (await settings.GET(req("GET"))).text();
    expect(settingText).toContain('"hasApiKey":true');
    expect(settingText).not.toContain("private-apollo-key");
    const list = await db.prisma.leadList.create({ data: { workspaceId: ws, name: "API list" } });
    const created = await sources.POST(
      req("POST", {
        name: "Executives",
        filters: { personTitles: ["CTO"] },
        listId: list.id,
        lawfulBasis: "consent",
        confirmedAuthorized: true,
      }),
    );
    expect(created.status).toBe(201);
    const body = await created.json();
    expect((await sources.GET(req("GET"))).status).toBe(200);
    expect(
      (
        await source.PATCH(req("PATCH", { enabled: false }), {
          params: Promise.resolve({ id: body.id }),
        })
      ).status,
    ).toBe(200);
    expect(
      (await source.DELETE(req("DELETE"), { params: Promise.resolve({ id: body.id }) })).status,
    ).toBe(200);
  });
  it("cannot read or change another workspace's search", async () => {
    const other = await db.prisma.workspace.create({
      data: { name: "Other", slug: `other-${Date.now()}` },
    });
    const list = await db.prisma.leadList.create({
      data: { workspaceId: other.id, name: "Other list" },
    });
    const foreign = await db.prisma.leadSource.create({
      data: {
        workspaceId: other.id,
        name: "Foreign",
        filters: { personTitles: ["CEO"] },
        listId: list.id,
        lawfulBasis: "consent",
      },
    });
    expect(JSON.stringify(await (await sources.GET(req("GET"))).json())).not.toContain(foreign.id);
    expect(
      (
        await source.PATCH(req("PATCH", { enabled: false }), {
          params: Promise.resolve({ id: foreign.id }),
        })
      ).status,
    ).toBe(404);
    expect(
      (await source.DELETE(req("DELETE"), { params: Promise.resolve({ id: foreign.id }) })).status,
    ).toBe(404);
    expect(
      (await db.prisma.leadSource.findUniqueOrThrow({ where: { id: foreign.id } })).enabled,
    ).toBe(true);
  });
});
