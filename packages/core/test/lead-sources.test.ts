import { createTestDb } from "@rightnow/db/test-db";
import type { SafeResponse, safeRequest } from "@rightnow/providers";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fixedClock } from "../src/clock";
import { decrypt, ENCRYPTED_COLUMNS } from "../src/crypto";
import { apolloEnrich, apolloSearch, leadSourceFilters } from "../src/leads/apollo";
import { hashValue } from "../src/leads/suppression";
import {
  createLeadSource,
  deleteLeadSource,
  getApolloSettings,
  listLeadSources,
  runLeadSources,
  setApolloSettings,
  updateLeadSource,
} from "../src/leads/sources";
import { testEnv } from "./accounts-fixture";
import { seedCampaign } from "./campaign-fixture";

let db: Awaited<ReturnType<typeof createTestDb>>;
const P = () => db.prisma;
const clock = fixedClock(new Date("2026-10-20T10:00:00Z"));
const response = (body: unknown, status = 200): SafeResponse => ({
  status,
  body: Buffer.from(JSON.stringify(body)),
  headers: {},
  latencyMs: 1,
});
const people = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, has_email: true }));
const api = (found = people(2)) => {
  const calls: { url: string; options: Parameters<typeof safeRequest>[1] }[] = [];
  const request: typeof safeRequest = async (url, options) => {
    calls.push({ url, options });
    if (url.includes("api_search")) return response({ total_entries: found.length, people: found });
    const ids = JSON.parse(String(options.body)).details.map((d: { id: string }) => d.id);
    return response({
      matches: ids.map((id: string) => ({
        id,
        email: `${id}@company.test`,
        email_status: "verified",
        first_name: "Ada",
        last_name: "Lovelace",
        title: "CTO",
        country: "US",
        state: "NY",
        organization: { name: "Company", website_url: "https://company.test", industry: "Tech" },
      })),
    });
  };
  return { request, calls };
};
beforeAll(async () => {
  testEnv();
  db = await createTestDb();
});
afterAll(() => db.drop());

async function fixture(cap = 25) {
  await P().leadSource.updateMany({ data: { enabled: false } });
  const s = await seedCampaign(P(), { at: clock.now(), accounts: [{ dailyLimit: 100 }] });
  const list = await P().leadList.create({ data: { workspaceId: s.ws, name: "Apollo" } });
  await setApolloSettings(P(), clock, s.ws, null, { apiKey: "private-key" });
  const source = await P().leadSource.create({
    data: {
      workspaceId: s.ws,
      name: "People",
      filters: { personTitles: ["CTO"] },
      listId: list.id,
      campaignId: s.campaign.id,
      lawfulBasis: "legitimate_interest",
      dailyCreditCap: cap,
    },
  });
  return { ...s, list, source };
}

describe("Apollo client", () => {
  test("validates filters and sends repeated query params and safe bulk body", async () => {
    expect(leadSourceFilters.safeParse({}).success).toBe(false);
    expect(leadSourceFilters.safeParse({ employeeRanges: ["bad"] }).success).toBe(false);
    const a = api();
    await apolloSearch(
      "private-key",
      { personTitles: ["CTO", "VP"], employeeRanges: ["1,10"] },
      2,
      { request: a.request },
    );
    await apolloEnrich("private-key", ["p0", "p1"], { request: a.request });
    const u = new URL(a.calls[0]!.url);
    expect(u.searchParams.getAll("person_titles[]")).toEqual(["CTO", "VP"]);
    expect(u.searchParams.getAll("organization_num_employees_ranges[]")).toEqual(["1,10"]);
    expect(u.searchParams.getAll("contact_email_status[]")).toEqual(["verified"]);
    expect(a.calls[0]!.options.headers?.["x-api-key"]).toBe("private-key");
    expect(a.calls[1]!.options.body).toBe(
      JSON.stringify({ details: [{ id: "p0" }, { id: "p1" }] }),
    );
    expect(JSON.stringify(a.calls)).not.toMatch(/reveal_personal_emails|reveal_phone_number/);
  });
});

describe("lead sources", () => {
  test("management validates references, authorization, names, limit, and scopes ids", async () => {
    const s = await fixture();
    const other = await fixture();
    const input = {
      name: "Managed",
      filters: { personTitles: ["CTO"] },
      listId: s.list.id,
      campaignId: s.campaign.id,
      lawfulBasis: "consent",
      confirmedAuthorized: true,
    };
    await expect(
      createLeadSource(P(), clock, s.ws, null, { ...input, confirmedAuthorized: false }),
    ).rejects.toThrow("authorization_required");
    await expect(
      createLeadSource(P(), clock, s.ws, null, { ...input, listId: other.list.id }),
    ).rejects.toThrow("unknown_list");
    await expect(
      createLeadSource(P(), clock, s.ws, null, { ...input, campaignId: other.campaign.id }),
    ).rejects.toThrow("unknown_campaign");
    await P().campaign.update({
      where: { id: other.campaign.id },
      data: { deletedAt: clock.now() },
    });
    await expect(
      createLeadSource(P(), clock, other.ws, null, {
        ...input,
        listId: other.list.id,
        campaignId: other.campaign.id,
      }),
    ).rejects.toThrow("unknown_campaign");
    await P().campaign.update({ where: { id: s.campaign.id }, data: { status: "ARCHIVED" } });
    await expect(createLeadSource(P(), clock, s.ws, null, input)).rejects.toThrow(
      "unknown_campaign",
    );
    const created = await createLeadSource(P(), clock, s.ws, null, { ...input, campaignId: null });
    await expect(
      updateLeadSource(P(), clock, s.ws, null, created.id, { listId: other.list.id }),
    ).rejects.toThrow("unknown_list");
    await expect(
      updateLeadSource(P(), clock, s.ws, null, created.id, { campaignId: other.campaign.id }),
    ).rejects.toThrow("unknown_campaign");
    await expect(
      createLeadSource(P(), clock, s.ws, null, { ...input, campaignId: null }),
    ).rejects.toThrow("name_taken");
    await expect(
      updateLeadSource(P(), clock, other.ws, null, created.id, { enabled: false }),
    ).rejects.toThrow("not_found");
    await expect(deleteLeadSource(P(), clock, other.ws, null, created.id)).rejects.toThrow(
      "not_found",
    );
    await P().leadSource.createMany({
      data: Array.from({ length: 18 }, (_, i) => ({
        workspaceId: s.ws,
        name: `Extra ${i}`,
        filters: { personTitles: ["CTO"] },
        listId: s.list.id,
        lawfulBasis: "consent",
      })),
    });
    await expect(
      createLeadSource(P(), clock, s.ws, null, { ...input, name: "Overflow", campaignId: null }),
    ).rejects.toThrow("source_limit");
    expect(
      await P().auditLog.count({
        where: { workspaceId: s.ws, action: "lead_source.create", target: created.id },
      }),
    ).toBe(1);
  });

  test("patch resets cursor, clears errors on resume, computes today's credits, and audits", async () => {
    const s = await fixture();
    await P().leadSource.update({
      where: { id: s.source.id },
      data: {
        nextPage: 4,
        lastError: "apollo_auth",
        lastErrorAt: clock.now(),
        creditDay: new Date("2026-10-19T00:00:00Z"),
        creditsUsed: 7,
        enabled: false,
      },
    });
    expect(
      (await listLeadSources(P(), clock, s.ws)).find((x) => x.id === s.source.id)?.creditsUsedToday,
    ).toBe(0);
    const changed = await updateLeadSource(P(), clock, s.ws, null, s.source.id, {
      filters: { personTitles: ["VP"] },
      enabled: true,
    });
    expect(changed).toMatchObject({
      nextPage: 1,
      lastError: null,
      lastErrorAt: null,
      enabled: true,
    });
    await deleteLeadSource(P(), clock, s.ws, null, s.source.id);
    const logs = await P().auditLog.findMany({
      where: { workspaceId: s.ws, action: { startsWith: "lead_source." } },
    });
    expect(logs.map((x) => x.action)).toEqual(
      expect.arrayContaining(["lead_source.update", "lead_source.delete"]),
    );
    expect(JSON.stringify(logs)).not.toContain("VP");
  });
  test("encrypts settings and clears them with an audit", async () => {
    const s = await fixture();
    const w = await P().workspace.findUniqueOrThrow({ where: { id: s.ws } });
    expect(w.apolloConfigEnc).not.toContain("private-key");
    expect(decrypt(w.apolloConfigEnc!)).toContain("private-key");
    expect(ENCRYPTED_COLUMNS).toContainEqual({ model: "Workspace", field: "apolloConfigEnc" });
    expect(await getApolloSettings(P(), s.ws)).toEqual({ hasApiKey: true });
    await setApolloSettings(P(), clock, s.ws, null, { apiKey: null });
    expect(await getApolloSettings(P(), s.ws)).toEqual({ hasApiKey: false });
    expect(
      await P().auditLog.count({ where: { workspaceId: s.ws, action: "settings.apollo" } }),
    ).toBe(2);
  });

  test("reserves credits, creates verified-gated leads in list and campaign, and avoids repeat payment", async () => {
    const s = await fixture(2);
    const a = api(people(20));
    const first = await runLeadSources(P(), clock, { sendable: ["SMTP"], request: a.request });
    expect(first).toMatchObject({ enriched: 2, created: 2 });
    const rows = await P().lead.findMany({ where: { workspaceId: s.ws, source: "apollo" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      verificationStatus: "PENDING_JOB",
      enrichmentStatus: "ENRICHED",
      region: "NY",
      jobTitle: "CTO",
      uploadMethod: "api",
    });
    expect(await P().leadListMember.count({ where: { listId: s.list.id } })).toBe(2);
    expect(
      await P().campaignLead.count({ where: { campaignId: s.campaign.id, state: "QUEUED" } }),
    ).toBe(2);
    expect(
      (await P().leadSource.findUniqueOrThrow({ where: { id: s.source.id } })).creditsUsed,
    ).toBe(2);
    const n = a.calls.filter((c) => c.url.includes("bulk_match")).length;
    await runLeadSources(P(), clock, { sendable: ["SMTP"], request: a.request });
    expect(a.calls.filter((c) => c.url.includes("bulk_match"))).toHaveLength(n);
  });

  test("no mailbox capacity prevents both requests; missing key records a safe code", async () => {
    const s = await fixture();
    const a = api();
    await runLeadSources(P(), clock, { sendable: [], request: a.request });
    expect(a.calls).toHaveLength(0);
    await setApolloSettings(P(), clock, s.ws, null, { apiKey: null });
    await runLeadSources(P(), clock, { sendable: ["SMTP"], request: a.request });
    expect(a.calls).toHaveLength(0);
    expect((await P().leadSource.findUniqueOrThrow({ where: { id: s.source.id } })).lastError).toBe(
      "no_api_key",
    );
  });

  test("credit day resets, while seen ids are never enriched again", async () => {
    const s = await fixture(1);
    let found = people(2);
    const a = api(found);
    const request: typeof a.request = async (url, options) =>
      url.includes("api_search")
        ? response({ total_entries: found.length, people: found })
        : a.request(url, options);
    await runLeadSources(P(), clock, { sendable: ["SMTP"], request });
    expect(a.calls.filter((c) => c.url.includes("bulk_match"))).toHaveLength(1);
    await runLeadSources(P(), clock, { sendable: ["SMTP"], request });
    expect(a.calls.filter((c) => c.url.includes("bulk_match"))).toHaveLength(1);
    clock.advance(864e5);
    found = [{ id: "p2", has_email: true }];
    await runLeadSources(P(), clock, { sendable: ["SMTP"], request });
    expect(a.calls.filter((c) => c.url.includes("bulk_match"))).toHaveLength(2);
    expect(
      (await P().leadSource.findUniqueOrThrow({ where: { id: s.source.id } })).creditsUsed,
    ).toBe(1);
    clock.advance(-864e5);
  });

  test("concurrent runs reserve each id once", async () => {
    const s = await fixture(5);
    const a = api(people(3));
    await Promise.all([
      runLeadSources(P(), clock, { sendable: ["SMTP"], request: a.request }),
      runLeadSources(P(), clock, { sendable: ["SMTP"], request: a.request }),
    ]);
    const paid = a.calls
      .filter((c) => c.url.includes("bulk_match"))
      .flatMap((c) => JSON.parse(String(c.options.body)).details.map((d: { id: string }) => d.id));
    expect(new Set(paid).size).toBe(paid.length);
    expect(
      (await P().leadSource.findUniqueOrThrow({ where: { id: s.source.id } })).creditsUsed,
    ).toBe(paid.length);
  });

  test("a crash after reservation keeps credits and seen ids", async () => {
    const s = await fixture(5);
    let bulk = 0;
    const request = async (url: string) => {
      if (url.includes("api_search")) return response({ total_entries: 1, people: people(1) });
      bulk++;
      throw new Error("secret body private-key");
    };
    await runLeadSources(P(), clock, {
      sendable: ["SMTP"],
      request: request as typeof safeRequest,
    });
    expect((await P().leadSource.findUniqueOrThrow({ where: { id: s.source.id } })).lastError).toBe(
      "network",
    );
    await runLeadSources(P(), clock, {
      sendable: ["SMTP"],
      request: request as typeof safeRequest,
    });
    expect(bulk).toBe(1);
    const source = await P().leadSource.findUniqueOrThrow({ where: { id: s.source.id } });
    expect(source).toMatchObject({ creditsUsed: 1, enabled: true });
    expect(await P().leadSourceSeen.count({ where: { workspaceId: s.ws } })).toBe(1);
  });

  test.each([
    [401, "apollo_auth", false],
    [403, "apollo_plan", false],
    [429, "rate_limited", true],
  ])("HTTP %i records %s and enabled=%s", async (status, code, enabled) => {
    const s = await fixture();
    await runLeadSources(P(), clock, {
      sendable: ["SMTP"],
      request: async () => response({ secret: "private-key" }, status),
    });
    const source = await P().leadSource.findUniqueOrThrow({ where: { id: s.source.id } });
    expect(source).toMatchObject({ lastError: code, enabled });
    expect(source.lastError).not.toContain("private-key");
  });

  test("filters unusable and suppressed matches", async () => {
    const s = await fixture(10);
    await P().workspace.update({ where: { id: s.ws }, data: { excludedCountries: ["DE"] } });
    const ids = ["empty", "locked", "unavailable", "excluded", "good"];
    const request = async (url: string) =>
      url.includes("api_search")
        ? response({
            total_entries: ids.length,
            people: ids.map((id) => ({ id, has_email: true })),
          })
        : response({
            matches: ids.map((id) => ({
              id,
              email:
                id === "empty"
                  ? null
                  : id === "locked"
                    ? "email_not_unlocked@x.test"
                    : `${id}@company.test`,
              email_status: id === "unavailable" ? "unavailable" : "verified",
              country: id === "excluded" ? "DE" : "US",
            })),
          });
    await runLeadSources(P(), clock, {
      sendable: ["SMTP"],
      request: request as typeof safeRequest,
    });
    expect(
      (await P().lead.findMany({ where: { workspaceId: s.ws, source: "apollo" } })).map(
        (l) => l.email,
      ),
    ).toEqual(["good@company.test"]);
  });

  test("five-credit cap limits a twenty-person bulk request", async () => {
    const s = await fixture(5);
    const a = api(people(20));
    await runLeadSources(P(), clock, { sendable: ["SMTP"], request: a.request });
    const ids = a.calls
      .filter((c) => c.url.includes("bulk_match"))
      .flatMap((c) => JSON.parse(String(c.options.body)).details);
    expect(ids).toHaveLength(5);
    expect(
      (await P().leadSource.findUniqueOrThrow({ where: { id: s.source.id } })).creditsUsed,
    ).toBe(5);
  });

  test("has_email false is skipped and deleted campaign leaves leads in list", async () => {
    const s = await fixture();
    await P().campaign.update({ where: { id: s.campaign.id }, data: { deletedAt: clock.now() } });
    const a = api([
      { id: "skip", has_email: false },
      { id: "take", has_email: true },
    ]);
    await runLeadSources(P(), clock, { sendable: ["SMTP"], request: a.request });
    const bulk = a.calls.find((c) => c.url.includes("bulk_match"));
    expect(JSON.parse(String(bulk?.options.body)).details).toEqual([{ id: "take" }]);
    expect(await P().leadListMember.count({ where: { listId: s.list.id } })).toBe(1);
    expect(await P().campaignLead.count({ where: { campaignId: s.campaign.id } })).toBe(0);
    expect((await P().leadSource.findUniqueOrThrow({ where: { id: s.source.id } })).lastError).toBe(
      "campaign_unavailable",
    );
  });

  test("the page advances only once its people are used, and wraps after the last", async () => {
    const s = await fixture(2);
    const nextPage = async () =>
      (await P().leadSource.findUniqueOrThrow({ where: { id: s.source.id } })).nextPage;
    const pages = (total: number) =>
      (async (url: string, options: { body?: unknown }) =>
        url.includes("api_search")
          ? response({ total_entries: total, people: people(3) })
          : response({
              matches: JSON.parse(String(options.body)).details.map((d: { id: string }) => ({
                id: d.id,
                email: `${d.id}@company.test`,
              })),
            })) as typeof safeRequest;
    await runLeadSources(P(), clock, { sendable: ["SMTP"], request: pages(500) });
    expect(await nextPage()).toBe(1); // 2 of 3 used: one person is still on page 1
    await P().leadSource.update({
      where: { id: s.source.id },
      data: { dailyCreditCap: 10 },
    });
    await runLeadSources(P(), clock, { sendable: ["SMTP"], request: pages(500) });
    expect(await nextPage()).toBe(4); // the leftover, then pages 2 and 3 hold only seen people
    await P().leadSource.update({ where: { id: s.source.id }, data: { nextPage: 5 } });
    await runLeadSources(P(), clock, { sendable: ["SMTP"], request: pages(500) });
    expect(await nextPage()).toBe(1); // page 5 of 100 per page reaches 500 entries
  });

  test("existing, suppressed and disposable addresses create nothing and are not 'no emails'", async () => {
    const s = await fixture(10);
    await P().lead.create({ data: { workspaceId: s.ws, email: "old@company.test" } });
    await P().suppression.create({
      data: {
        workspaceId: s.ws,
        kind: "DOMAIN",
        value: "blocked.test",
        valueHash: hashValue("blocked.test"),
        reason: "MANUAL",
      },
    });
    const emails = ["old@company.test", "a@blocked.test", "a@mailinator.com"];
    const request = (async (url: string) =>
      url.includes("api_search")
        ? response({ total_entries: 3, people: people(3) })
        : response({
            matches: emails.map((email, i) => ({ id: `p${i}`, email })),
          })) as typeof safeRequest;
    await runLeadSources(P(), clock, { sendable: ["SMTP"], request });
    expect(await P().lead.count({ where: { workspaceId: s.ws, source: "apollo" } })).toBe(0);
    const source = await P().leadSource.findUniqueOrThrow({ where: { id: s.source.id } });
    expect(source.lastError).toBeNull();
  });

  test("no usable email at all is reported without pausing the source", async () => {
    const s = await fixture(10);
    const request = (async (url: string) =>
      url.includes("api_search")
        ? response({ total_entries: 1, people: people(1) })
        : response({ matches: [null] })) as typeof safeRequest;
    await runLeadSources(P(), clock, { sendable: ["SMTP"], request });
    expect(await P().leadSource.findUniqueOrThrow({ where: { id: s.source.id } })).toMatchObject({
      lastError: "apollo_no_emails",
      enabled: true,
    });
  });

  test("seen ids and credits belong to one workspace", async () => {
    const a = await fixture(5);
    const enabled = await P().leadSource.findUniqueOrThrow({ where: { id: a.source.id } });
    const b = await fixture(5);
    await P().leadSource.update({ where: { id: enabled.id }, data: { enabled: true } });
    const stub = api(people(1));
    await runLeadSources(P(), clock, { sendable: ["SMTP"], request: stub.request });
    const bulk = stub.calls.filter((c) => c.url.includes("bulk_match"));
    expect(bulk).toHaveLength(2); // the same Apollo person is paid for once per workspace
    expect(await P().lead.count({ where: { workspaceId: a.ws, source: "apollo" } })).toBe(1);
    expect(await P().lead.count({ where: { workspaceId: b.ws, source: "apollo" } })).toBe(1);
  });

  test("bad JSON produces a safe error code", async () => {
    const s = await fixture();
    await runLeadSources(P(), clock, {
      sendable: ["SMTP"],
      request: async () => ({ ...response(null), body: Buffer.from("private-key invalid") }),
    });
    const source = await P().leadSource.findUniqueOrThrow({ where: { id: s.source.id } });
    expect(source).toMatchObject({ lastError: "bad_response", enabled: true });
  });
});
