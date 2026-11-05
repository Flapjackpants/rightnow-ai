import { createTestDb } from "@rightnow/db/test-db";
import type { SafeResponse } from "@rightnow/providers";
import { afterAll, beforeAll, expect, test } from "vitest";
import { fixedClock } from "../src/clock";
import { decrypt } from "../src/crypto";
import { ensureStages } from "../src/crm/stages";
import {
  HubspotError,
  upsertContacts,
  upsertDeals,
  associateDeals,
  ensureDealProperty,
  customerDomains,
} from "../src/crm/hubspot";
import {
  clearCrmSyncSettings,
  getCrmSyncSettings,
  runCrmSync,
  setCrmSyncSettings,
} from "../src/crm/hubspot-sync";
import { suppress } from "../src/leads/suppression";
import { testEnv } from "./accounts-fixture";
import { seedCampaign } from "./campaign-fixture";

type Req = NonNullable<Parameters<typeof upsertContacts>[2]>["request"];
const response = (status: number, value: unknown): SafeResponse => ({
  status,
  body: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
  headers: {},
  latencyMs: 1,
});
type TestBody = {
  inputs: {
    id?: string;
    idProperty?: string;
    properties?: Record<string, string>;
    from?: { id: string };
    to?: { id: string };
  }[];
  after?: string;
};
const seen: { url: string; method: string; body?: TestBody; token: string }[] = [];
let hook: ((url: string, body?: TestBody) => Promise<void>) | undefined;
let failPath: string | undefined;
const request: Req = async (url, opts) => {
  const body = opts.body ? (JSON.parse(String(opts.body)) as TestBody) : undefined;
  seen.push({ url, method: opts.method, body, token: opts.headers?.authorization ?? "" });
  await hook?.(url, body);
  if (failPath && url.includes(failPath)) return response(401, { secret: "never expose" });
  if (url.endsWith("/properties/deals/rightnow_id")) return response(200, {});
  if (url.includes("/companies/search")) return response(200, { results: [] });
  if (url.includes("/associate/default")) return response(200, {});
  if (url.includes("/batch/upsert"))
    return response(200, {
      results: body!.inputs.map((i, n) => ({
        id: `${url.includes("deals") ? "d" : "c"}${n}`,
        properties: { ...i.properties, [i.idProperty!]: i.id },
      })),
    });
  return response(200, {});
};
let db: Awaited<ReturnType<typeof createTestDb>>;
const clock = fixedClock(new Date("2026-11-05T12:00:00Z"));
beforeAll(async () => {
  testEnv();
  db = await createTestDb();
});
afterAll(() => db.drop());
let seq = 0;
async function world(token = "secret") {
  const w = await db.prisma.workspace.create({ data: { name: "CRM", slug: `crm-${++seq}` } });
  const stages = await ensureStages(db.prisma, w.id);
  const stage = stages[0]!;
  await setCrmSyncSettings(
    db.prisma,
    clock,
    w.id,
    null,
    { token, pipelineId: "pipe", stageMap: { [stage.id]: "hs-stage" } },
    { request },
  );
  seen.length = 0;
  return { ws: w.id, stage };
}
const lead = (ws: string, extra: Record<string, unknown> = {}) =>
  db.prisma.lead.create({
    data: { workspaceId: ws, email: `person${++seq}@example.org`, replies: 1, ...extra },
  });
const deal = (ws: string, leadId: string, stageId: string) =>
  db.prisma.opportunity.create({
    data: { workspaceId: ws, leadId, stageId, title: "New sale", value: 42 },
  });

test("client uses exact batch URLs, bearer auth, bodies and 100 record split", async () => {
  seen.length = 0;
  const contacts = await upsertContacts(
    "secret",
    Array.from({ length: 101 }, (_, i) => ({
      email: `A${i}@EXAMPLE.ORG`,
      properties: { firstname: "A" },
    })),
    { request },
  );
  expect(contacts.size).toBe(101);
  expect(seen.map((x) => x.body!.inputs.length)).toEqual([100, 1]);
  expect(seen[0]).toMatchObject({
    url: "https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert",
    token: "Bearer secret",
    method: "POST",
  });
  expect(seen[0]!.body!.inputs[0]).toEqual({
    id: "a0@example.org",
    idProperty: "email",
    properties: { email: "a0@example.org", firstname: "A" },
  });
  seen.length = 0;
  await upsertDeals("secret", [{ rightnowId: "rn", properties: { dealname: "D" } }], { request });
  expect(seen[0]!.body!.inputs[0]).toEqual({
    id: "rn",
    idProperty: "rightnow_id",
    properties: { rightnow_id: "rn", dealname: "D" },
  });
  seen.length = 0;
  expect(
    (
      await upsertDeals(
        "secret",
        Array.from({ length: 101 }, (_, i) => ({
          rightnowId: `rn${i}`,
          properties: { dealname: "D" },
        })),
        { request },
      )
    ).size,
  ).toBe(101);
  expect(seen.map((x) => x.body!.inputs.length)).toEqual([100, 1]);
  seen.length = 0;
  await associateDeals("secret", [{ dealId: "d0", contactId: "c0" }], { request });
  expect(seen[0]!.url).toBe(
    "https://api.hubapi.com/crm/v4/associations/deals/contacts/batch/associate/default",
  );
  expect(seen[0]!.body).toEqual({ inputs: [{ from: { id: "d0" }, to: { id: "c0" } }] });
});

test("client error codes never reveal response, email or token", async () => {
  for (const [status, code] of [
    [401, "hubspot_auth"],
    [403, "hubspot_scope"],
    [429, "rate_limited"],
    [207, "hubspot_partial"],
  ] as const) {
    const bad: Req = async () => response(status, { secret: "sensitive" });
    const e = await upsertContacts(
      "token-secret",
      [{ email: "email-secret@example.org", properties: {} }],
      { request: bad },
    ).then(
      () => null,
      (x) => x as HubspotError,
    );
    expect(e?.code).toBe(code);
    expect(e?.message).not.toMatch(/token-secret|email-secret|sensitive/);
  }
  const bad: Req = async () => response(200, "{oops");
  await expect(
    upsertContacts("t", [{ email: "a@b.com", properties: {} }], { request: bad }),
  ).rejects.toMatchObject({ code: "bad_response" });
  const partial: Req = async () => response(200, { results: [] });
  await expect(
    upsertContacts("t", [{ email: "a@b.com", properties: {} }], { request: partial }),
  ).rejects.toMatchObject({ code: "hubspot_partial" });
});

test("property presence, creation and duplicate; company pages and 9800 cap", async () => {
  const calls: string[] = [];
  let exists = true;
  const r: Req = async (url, opts) => {
    calls.push(`${opts.method} ${url}`);
    if (url.endsWith("/rightnow_id")) return response(exists ? 200 : 404, {});
    return response(409, {});
  };
  await ensureDealProperty("t", { request: r });
  expect(calls).toHaveLength(1);
  exists = false;
  await ensureDealProperty("t", { request: r });
  expect(calls.slice(1).map((x) => x.split(" ")[0])).toEqual(["GET", "POST"]);
  const pages: Req = async (_url, opts) =>
    response(200, {
      results: [{ properties: { domain: "www.Example.COM" } }],
      paging: { next: { after: String(Number(JSON.parse(String(opts.body)).after ?? 0) + 200) } },
    });
  const domains = await customerDomains("t", { request: pages });
  expect(domains).toHaveLength(49);
});

test("settings encrypt, retain token, validate stage and clear", async () => {
  const { ws, stage } = await world();
  const raw = await db.prisma.workspace.findUniqueOrThrow({ where: { id: ws } });
  expect(raw.crmSyncConfigEnc).not.toContain("secret");
  expect(JSON.parse(decrypt(raw.crmSyncConfigEnc!)).token).toBe("secret");
  expect(JSON.stringify(await getCrmSyncSettings(db.prisma, ws))).not.toContain("secret");
  await expect(
    setCrmSyncSettings(
      db.prisma,
      clock,
      ws,
      null,
      { pipelineId: "p", stageMap: { bad: "x" } },
      { request },
    ),
  ).rejects.toMatchObject({ status: 400, message: "unknown_stage" });
  await setCrmSyncSettings(
    db.prisma,
    clock,
    ws,
    null,
    { pipelineId: "p2", stageMap: { [stage.id]: "s" } },
    { request },
  );
  expect(
    JSON.parse(
      decrypt(
        (await db.prisma.workspace.findUniqueOrThrow({ where: { id: ws } })).crmSyncConfigEnc!,
      ),
    ).token,
  ).toBe("secret");
  await clearCrmSyncSettings(db.prisma, clock, ws, null);
  expect((await getCrmSyncSettings(db.prisma, ws)).connected).toBe(false);
  await expect(
    setCrmSyncSettings(db.prisma, clock, ws, null, { pipelineId: "p", stageMap: {} }, { request }),
  ).rejects.toMatchObject({ status: 400, message: "token_required" });
  const auth: Req = async () => response(401, {});
  await expect(
    setCrmSyncSettings(
      db.prisma,
      clock,
      ws,
      null,
      { token: "bad", pipelineId: "p", stageMap: {} },
      { request: auth },
    ),
  ).rejects.toMatchObject({ status: 400, message: "hubspot_auth" });
  expect((await getCrmSyncSettings(db.prisma, ws)).connected).toBe(false);
});

test("engaged contact and mapped deal push, associate, repeat safely, then edit", async () => {
  const { ws, stage } = await world();
  const l = await lead(ws);
  const d = await deal(ws, l.id, stage.id);
  await lead(ws, { replies: 0, interestStatus: null });
  expect(await runCrmSync(db.prisma, clock, { request })).toMatchObject({ contacts: 1, deals: 1 });
  const reqs = seen.filter((x) => x.url.includes("/batch/") || x.url.includes("associate/default"));
  expect(reqs).toHaveLength(3);
  expect(reqs[1]!.body!.inputs[0]!.properties).toMatchObject({
    rightnow_id: d.id,
    pipeline: "pipe",
    dealstage: "hs-stage",
    amount: "42",
  });
  expect(reqs[2]!.body!.inputs[0]).toEqual({ from: { id: "d0" }, to: { id: "c0" } });
  seen.length = 0;
  expect(await runCrmSync(db.prisma, clock, { request })).toMatchObject({ contacts: 0, deals: 0 });
  expect(seen.filter((x) => x.url.includes("upsert"))).toHaveLength(0);
  await db.prisma.opportunity.update({ where: { id: d.id }, data: { title: "Edited" } });
  seen.length = 0;
  expect(await runCrmSync(db.prisma, clock, { request })).toMatchObject({ deals: 1 });
});

test("edit during request remains pending; failed association leaves contact and deal pending", async () => {
  const { ws, stage } = await world();
  const l = await lead(ws);
  const d = await deal(ws, l.id, stage.id);
  hook = async (url) => {
    if (url.includes("deals/batch/upsert")) {
      hook = undefined;
      await db.prisma.opportunity.update({ where: { id: d.id }, data: { title: "Concurrent" } });
    }
  };
  await runCrmSync(db.prisma, clock, { request });
  expect(
    (await db.prisma.opportunity.findUniqueOrThrow({ where: { id: d.id } })).crmSyncedAt,
  ).toBeNull();
  seen.length = 0;
  await runCrmSync(db.prisma, clock, { request });
  expect(seen.some((x) => x.url.includes("deals/batch/upsert"))).toBe(true);
  const l2 = await lead(ws);
  const d2 = await deal(ws, l2.id, stage.id);
  failPath = "associate/default";
  await runCrmSync(db.prisma, clock, { request });
  failPath = undefined;
  expect(
    (await db.prisma.opportunity.findUniqueOrThrow({ where: { id: d2.id } })).crmSyncedAt,
  ).toBeNull();
  expect((await db.prisma.lead.findUniqueOrThrow({ where: { id: l2.id } })).crmSyncedAt).toBeNull();
});

test("unmapped and suppressed deals stay pending while other deals proceed", async () => {
  const { ws, stage } = await world();
  const other = (await ensureStages(db.prisma, ws))[1]!;
  const a = await lead(ws),
    b = await lead(ws),
    c = await lead(ws);
  await deal(ws, a.id, other.id);
  await deal(ws, b.id, stage.id);
  await deal(ws, c.id, stage.id);
  await db.prisma.$transaction((tx) =>
    suppress(tx, ws, [{ kind: "EMAIL", value: c.email }], "MANUAL", "test"),
  );
  seen.length = 0;
  await runCrmSync(db.prisma, clock, { request });
  expect(
    (await db.prisma.workspace.findUniqueOrThrow({ where: { id: ws } })).crmSyncLastError,
  ).toBe("hubspot_unmapped_stage");
  expect(seen.find((x) => x.url.includes("deals/batch/upsert"))!.body!.inputs).toHaveLength(1);
  expect(
    (await db.prisma.lead.findUniqueOrThrow({ where: { id: c.id } })).crmSyncedAt,
  ).not.toBeNull();
  await setCrmSyncSettings(
    db.prisma,
    clock,
    ws,
    null,
    { pipelineId: "p", stageMap: { [stage.id]: "s", [other.id]: "s2" } },
    { request },
  );
  await runCrmSync(db.prisma, clock, { request });
  expect(
    (await db.prisma.workspace.findUniqueOrThrow({ where: { id: ws } })).crmSyncLastError,
  ).toBeNull();
});

test("401 pauses workspace until settings update; another workspace runs", async () => {
  const a = await world("one"),
    b = await world("two");
  await lead(a.ws);
  await lead(b.ws);
  const mixed: Req = async (url, opts) =>
    opts.headers?.authorization === "Bearer one" ? response(401, {}) : request(url, opts);
  await runCrmSync(db.prisma, clock, { request: mixed });
  expect(
    (await db.prisma.workspace.findUniqueOrThrow({ where: { id: a.ws } })).crmSyncLastError,
  ).toBe("hubspot_auth");
  expect(
    (await db.prisma.lead.findFirstOrThrow({ where: { workspaceId: b.ws } })).crmSyncedAt,
  ).not.toBeNull();
  seen.length = 0;
  await runCrmSync(db.prisma, clock, { request: mixed });
  expect(seen.every((x) => x.token !== "Bearer one")).toBe(true);
  await setCrmSyncSettings(
    db.prisma,
    clock,
    a.ws,
    null,
    { pipelineId: "p", stageMap: {} },
    { request },
  );
  await runCrmSync(db.prisma, clock, { request });
  expect(
    (await db.prisma.workspace.findUniqueOrThrow({ where: { id: a.ws } })).crmSyncLastError,
  ).toBeNull();
});

test("customer pull normalizes domains, skips free mail, stops campaign leads, waits 24 hours", async () => {
  const { ws } = await world();
  const campaign = await seedCampaign(db.prisma, {
    at: clock.now(),
    workspaceId: ws,
    leads: 1,
    rows: 1,
  });
  await db.prisma.lead.update({
    where: { id: campaign.leads[0]!.lead.id },
    data: { email: "buyer@customer.org" },
  });
  let searches = 0;
  const search: Req = async (url, opts) =>
    url.includes("/companies/search")
      ? (searches++,
        response(200, {
          results: ["www.Customer.org", "gmail.com"].map((domain) => ({ properties: { domain } })),
        }))
      : request(url, opts);
  expect((await runCrmSync(db.prisma, clock, { request: search })).domains).toBe(1);
  expect(
    await db.prisma.suppression.findMany({
      where: { workspaceId: ws, reason: "CUSTOMER" },
      select: { value: true },
    }),
  ).toEqual([{ value: "customer.org" }]);
  expect(
    (await db.prisma.campaignLead.findUniqueOrThrow({ where: { id: campaign.leads[0]!.cl.id } }))
      .state,
  ).toBe("STOPPED");
  expect(searches).toBe(1);
  await runCrmSync(db.prisma, clock, { request: search });
  expect(searches).toBe(1);
});

test("an unreadable stored config fails its own workspace only", async () => {
  const a = await world("three"),
    b = await world("four");
  await lead(b.ws);
  await db.prisma.workspace.update({
    where: { id: a.ws },
    data: { crmSyncConfigEnc: "not-encrypted" },
  });
  await runCrmSync(db.prisma, clock, { request });
  expect(
    (await db.prisma.workspace.findUniqueOrThrow({ where: { id: a.ws } })).crmSyncLastError,
  ).toBe("hubspot_failed");
  expect(
    (await db.prisma.lead.findFirstOrThrow({ where: { workspaceId: b.ws } })).crmSyncedAt,
  ).not.toBeNull();
});
