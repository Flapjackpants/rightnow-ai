import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@rightnow/db/test-db";
import { createFirstOwner } from "../lib/setup";

const TOKEN = "t".repeat(20);
const PASSWORD = "correct horse battery";
const ORIGIN = "http://localhost:3100";
let db: Awaited<ReturnType<typeof createTestDb>>;
let workspaceId: string;
let cookie: string;
let key: string;
let verify: typeof import("../app/api/v1/leads/verify/route");
let settings: typeof import("../app/api/v1/settings/verifier/route");

const setRole = (role: string) =>
  db.prisma.member.updateMany({ where: { workspaceId }, data: { role } });
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
    SETUP_TOKEN: TOKEN,
  });
  const { auth } = await import("../lib/auth");
  const { createApiKey } = await import("@rightnow/core");
  verify = await import("../app/api/v1/leads/verify/route");
  settings = await import("../app/api/v1/settings/verifier/route");
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
  key = (await createApiKey(db.prisma, workspaceId, "k", ["leads:update"])).token;
});
afterAll(async () => {
  await db.drop();
});

const HTTP = { kind: "http", url: "https://v.example.com/x", apiKey: "sekrit", statusPath: "a.b" };

describe("verifier settings", () => {
  it("GET never returns the apiKey; PUT is ADMIN and session only", async () => {
    await setRole("member");
    expect((await settings.PUT(req("PUT", HTTP))).status).toBe(403);
    await setRole("owner");
    expect((await settings.PUT(req("PUT", HTTP, { authorization: `Bearer ${key}` }))).status).toBe(
      401,
    );
    expect((await settings.PUT(req("PUT", HTTP))).status).toBe(200);
    const res = await settings.GET(req("GET"));
    const text = await res.text();
    expect(text).not.toContain("sekrit");
    expect(JSON.parse(text)).toEqual({
      kind: "http",
      url: "https://v.example.com/x",
      statusPath: "a.b",
      hasApiKey: true,
    });
    expect(
      await db.prisma.auditLog.count({ where: { workspaceId, action: "settings.verifier" } }),
    ).toBe(1);
  });

  it("validates url, statusPath and unknown fields", async () => {
    for (const b of [
      { ...HTTP, url: "http://v.example.com" },
      { ...HTTP, statusPath: "a b" },
      { ...HTTP, extra: 1 },
      { kind: "other" },
    ])
      expect((await settings.PUT(req("PUT", b))).status, JSON.stringify(b)).toBe(400);
  });

  it("MillionVerifier: fixed host, key write-only, no url field", async () => {
    const MV = { kind: "millionverifier", apiKey: "mv-sekrit" };
    expect((await settings.PUT(req("PUT", MV))).status).toBe(200);
    const res = await settings.GET(req("GET"));
    const text = await res.text();
    expect(text).not.toContain("mv-sekrit");
    expect(JSON.parse(text)).toEqual({
      kind: "millionverifier",
      url: "https://api.millionverifier.com/api/v3/",
      statusPath: "result",
      hasApiKey: true,
    });
    expect((await settings.PUT(req("PUT", { ...MV, url: "https://evil.test" }))).status).toBe(400);
  });
});

describe("POST /leads/verify", () => {
  it("queues the leads and answers 202; a MEMBER API key may call it", async () => {
    const lead = await db.prisma.lead.create({ data: { workspaceId, email: "a@lead.test" } });
    const res = await verify.POST(
      req("POST", { ids: [lead.id] }, { authorization: `Bearer ${key}` }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: 1 });
    expect(
      (await db.prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).verificationStatus,
    ).toBe("PENDING_JOB");
    expect((await verify.POST(req("POST", { ids: [] }))).status).toBe(400);
    expect((await verify.POST(req("POST", { ids: [lead.id] }, {}))).status).toBe(401);
  });
});
