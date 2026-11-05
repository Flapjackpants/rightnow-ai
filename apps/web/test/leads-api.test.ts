import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@rightnow/db/test-db";
import { createFirstOwner } from "../lib/setup";

const TOKEN = "t".repeat(20);
const PASSWORD = "correct horse battery";
const ORIGIN = "http://localhost:3100";
let db: Awaited<ReturnType<typeof createTestDb>>;
let workspaceId: string;
let cookie: string;
let leadId: string;
let foreignId: string;
let readKey: string;
let list: typeof import("../app/api/v1/leads/route");
let one: typeof import("../app/api/v1/leads/[id]/route");
let gdpr: typeof import("../app/api/v1/leads/[id]/gdpr-delete/route");
let bulk: typeof import("../app/api/v1/leads/bulk/route");
let merge: typeof import("../app/api/v1/leads/merge/route");
let labels: typeof import("../app/api/v1/lead-labels/route");
let capacity: typeof import("../app/api/v1/leads/capacity/route");

const setRole = (role: string) =>
  db.prisma.member.updateMany({ where: { workspaceId }, data: { role } });
const req = (
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = { cookie },
) =>
  new Request(`${ORIGIN}${url}`, {
    method,
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const p = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown, headers?: Record<string, string>) =>
  one.PATCH(req("PATCH", `/api/v1/leads/${id}`, body, headers), p(id));
const post = (id: string) =>
  gdpr.POST(req("POST", `/api/v1/leads/${id}/gdpr-delete`, undefined), p(id));

beforeAll(async () => {
  db = await createTestDb();
  Object.assign(process.env, {
    MODE: "local",
    MAIL_PROVIDER_FAKE: "1",
    FAKE_MAIL_DIR: mkdtempSync(join(tmpdir(), "rn-web-")),
    DATABASE_URL: db.url,
    APP_URL: ORIGIN,
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    BETTER_AUTH_SECRET: "x".repeat(40),
    SETUP_TOKEN: TOKEN,
  });
  const { auth } = await import("../lib/auth");
  const { createApiKey } = await import("@rightnow/core");
  list = await import("../app/api/v1/leads/route");
  one = await import("../app/api/v1/leads/[id]/route");
  gdpr = await import("../app/api/v1/leads/[id]/gdpr-delete/route");
  bulk = await import("../app/api/v1/leads/bulk/route");
  merge = await import("../app/api/v1/leads/merge/route");
  labels = await import("../app/api/v1/lead-labels/route");
  capacity = await import("../app/api/v1/leads/capacity/route");
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
  leadId = (await db.prisma.lead.create({ data: { workspaceId, email: "mine@acme.io" } })).id;
  const other = await db.prisma.workspace.create({ data: { name: "Other", slug: "other" } });
  foreignId = (await db.prisma.lead.create({ data: { workspaceId: other.id, email: "t@acme.io" } }))
    .id;
  readKey = (await createApiKey(db.prisma, workspaceId, "k", ["leads:read"])).token;
});
afterAll(async () => {
  await db.drop();
});

describe("leads routes", () => {
  it("allows a viewer to read capacity and enforces the API key scope", async () => {
    await setRole("viewer");
    const response = await capacity.GET(req("GET", "/api/v1/leads/capacity"));
    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<string, unknown>;
    for (const field of ["dailySends", "followUpsDue", "newPerDay", "queued", "headroom"])
      expect(typeof data[field]).toBe("number");
    await setRole("owner");
    const { createApiKey } = await import("@rightnow/core");
    const key = (await createApiKey(db.prisma, workspaceId, "no leads", ["accounts:read"])).token;
    expect(
      (
        await capacity.GET(
          req("GET", "/api/v1/leads/capacity", undefined, { authorization: `Bearer ${key}` }),
        )
      ).status,
    ).toBe(403);
  });
  it("lists and reads only this workspace's leads", async () => {
    const j = (await (await list.GET(req("GET", "/api/v1/leads"))).json()) as {
      leads: { id: string }[];
    };
    expect(j.leads.map((l) => l.id)).toEqual([leadId]);
    expect((await one.GET(req("GET", `/api/v1/leads/${leadId}`), p(leadId))).status).toBe(200);
    expect((await one.GET(req("GET", `/api/v1/leads/${foreignId}`), p(foreignId))).status).toBe(
      404,
    );
    expect((await patch(foreignId, { firstName: "x" })).status).toBe(404);
    expect((await post(foreignId)).status).toBe(404);
  });

  it("a leads:read key can GET but not POST", async () => {
    const h = { authorization: `Bearer ${readKey}` };
    expect((await list.GET(req("GET", "/api/v1/leads", undefined, h))).status).toBe(200);
    const r = await list.POST(req("POST", "/api/v1/leads", { email: "n@acme.io" }, h));
    expect(r.status).toBe(403);
  });

  it("a VIEWER cannot PATCH or POST", async () => {
    await setRole("viewer");
    expect((await patch(leadId, { firstName: "x" })).status).toBe(403);
    expect((await list.POST(req("POST", "/api/v1/leads", { email: "v@acme.io" }))).status).toBe(
      403,
    );
    await setRole("owner");
  });

  it("creates, rejects duplicates and unknown keys", async () => {
    const ok = await list.POST(req("POST", "/api/v1/leads", { email: "New@Acme.io" }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { email: string }).email).toBe("new@acme.io");
    const dup = await list.POST(req("POST", "/api/v1/leads", { email: "new@acme.io" }));
    expect(dup.status).toBe(409);
    expect((await patch(leadId, { workspaceId: "x" })).status).toBe(400);
    expect((await patch(leadId, { interestStatus: 7 })).status).toBe(400);
    expect((await patch(leadId, { interestStatus: 2 })).status).toBe(200);
  });

  it("MEMBER cannot GDPR-delete or bulk-delete; ADMIN can", async () => {
    await setRole("member");
    expect((await post(leadId)).status).toBe(403);
    const del = await bulk.POST(
      req("POST", "/api/v1/leads/bulk", { ids: [leadId], action: "delete" }),
    );
    expect(del.status).toBe(403);
    await setRole("admin");
    expect((await post(leadId)).status).toBe(200);
    await setRole("owner");
  });

  it("merge and labels work and stay in the workspace", async () => {
    const a = await db.prisma.lead.create({ data: { workspaceId, email: "ma@acme.io" } });
    const b = await db.prisma.lead.create({ data: { workspaceId, email: "mb@acme.io" } });
    const bad = await merge.POST(
      req("POST", "/api/v1/leads/merge", { keepId: a.id, mergeId: foreignId }),
    );
    expect(bad.status).toBe(404);
    const ok = await merge.POST(
      req("POST", "/api/v1/leads/merge", { keepId: a.id, mergeId: b.id }),
    );
    expect(ok.status).toBe(200);
    const lab = await labels.POST(
      req("POST", "/api/v1/lead-labels", { name: "Hot", color: "#ff0000" }),
    );
    expect(lab.status).toBe(200);
    const j = (await (await labels.GET(req("GET", "/api/v1/lead-labels"))).json()) as {
      labels: { name: string }[];
    };
    expect(j.labels.map((l) => l.name)).toEqual(["Hot"]);
  });

  it("DELETE, bulk and gdpr-delete respect workspace and auth type", async () => {
    expect(
      (await one.DELETE(req("DELETE", `/api/v1/leads/${foreignId}`), p(foreignId))).status,
    ).toBe(404);
    const b = await bulk.POST(
      req("POST", "/api/v1/leads/bulk", { ids: [foreignId], action: "add_tags", value: ["x"] }),
    );
    expect(((await b.json()) as { affected: number }).affected).toBe(0);
    const { createApiKey } = await import("@rightnow/core");
    const all = (await createApiKey(db.prisma, workspaceId, "all", ["all:all"])).token;
    const h = { authorization: `Bearer ${all}` };
    const mine = await db.prisma.lead.create({ data: { workspaceId, email: "key@acme.io" } });
    const r = await gdpr.POST(
      req("POST", `/api/v1/leads/${mine.id}/gdpr-delete`, undefined, h),
      p(mine.id),
    );
    expect(r.status).toBe(401); // session-only: API keys are not accepted
    expect(await db.prisma.lead.count({ where: { id: mine.id } })).toBe(1);
    const del = await one.DELETE(req("DELETE", `/api/v1/leads/${mine.id}`), p(mine.id));
    expect(del.status).toBe(200);
  });
});
