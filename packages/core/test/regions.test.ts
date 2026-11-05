import { randomBytes } from "node:crypto";
import { createTestDb } from "@rightnow/db/test-db";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { enrollLeads } from "../src/campaigns/enroll";
import { fixedClock } from "../src/clock";
import { createImport, previewImport, runImport } from "../src/leads/import";
import {
  countrySpellings,
  normalizeCountry,
  normalizeRegion,
  regionExcluded,
} from "../src/leads/regions";
import { createLead } from "../src/leads/service";
import { planDue } from "../src/planner";
import { getWorkspaceSettings, updateWorkspaceSettings } from "../src/settings";
import { unsubscribeKeys } from "../src/unsubscribe";
import { testEnv } from "./accounts-fixture";
import { seedCampaign } from "./campaign-fixture";

let db: Awaited<ReturnType<typeof createTestDb>>;
const P = () => db.prisma;
beforeAll(async () => {
  testEnv();
  db = await createTestDb();
});
afterAll(() => db.drop());

const T = new Date("2026-10-20T10:00:00Z");
const clock = fixedClock(T);
const ENV = {
  appUrl: "https://app.example.com",
  unsubscribeKeys: unsubscribeKeys({ ENCRYPTION_KEY: randomBytes(32).toString("base64") }),
};
const plan = () =>
  planDue(P(), clock, {
    stalenessSec: 300,
    sendableProviders: ["GMAIL", "MICROSOFT", "SMTP"],
    env: ENV,
  });
const clOf = (id: string) => P().campaignLead.findUniqueOrThrow({ where: { id } });
const save = (ws: string, input: unknown) => updateWorkspaceSettings(P(), clock, ws, null, input);
const err = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { status?: number; message?: string }) => ({ status: e.status, message: e.message }),
  );
let n = 0;

describe("normalizeCountry", () => {
  test("codes, English names and aliases in any case; unknown or empty is null", () => {
    expect(normalizeCountry("us")).toBe("US");
    expect(normalizeCountry("USA")).toBe("US");
    expect(normalizeCountry("United States")).toBe("US");
    expect(normalizeCountry(" germany ")).toBe("DE");
    expect(normalizeCountry("DE")).toBe("DE");
    expect(normalizeCountry("uk")).toBe("GB");
    expect(normalizeCountry("Great Britain")).toBe("GB");
    expect(normalizeCountry("United Kingdom")).toBe("GB");
    expect(normalizeCountry("Deutschland")).toBeNull();
    expect(normalizeCountry("qq")).toBeNull(); // not an assigned code
    expect(normalizeCountry("")).toBeNull();
    expect(normalizeCountry("   ")).toBeNull();
    expect(normalizeCountry(null)).toBeNull();
  });
});

describe("normalizeRegion", () => {
  test("trimmed and lower-cased; empty is null", () => {
    expect(normalizeRegion(" Bavaria ")).toBe("bavaria");
    expect(normalizeRegion("")).toBeNull();
    expect(normalizeRegion(null)).toBeNull();
  });
});

describe("countrySpellings", () => {
  test("every spelling maps back to the code", () => {
    const spellings = countrySpellings("US");
    expect(spellings).toEqual(expect.arrayContaining(["us", "usa", "united states"]));
    for (const s of spellings) expect(normalizeCountry(s)).toBe("US");
  });
});

describe("regionExcluded", () => {
  test("normalizes the lead's location; nulls and empties never match", () => {
    const r = { excludedCountries: ["DE"], excludedRegions: ["bavaria"] };
    expect(regionExcluded({ country: "germany", region: null }, r)).toBe(true);
    expect(regionExcluded({ country: null, region: " Bavaria " }, r)).toBe(true);
    expect(regionExcluded({ country: "France", region: "Bavaria" }, r)).toBe(true);
    expect(regionExcluded({ country: "France", region: "Paris" }, r)).toBe(false);
    expect(regionExcluded({ country: null, region: null }, r)).toBe(false);
    expect(regionExcluded({ country: "", region: "" }, r)).toBe(false);
    expect(
      regionExcluded(
        { country: "germany", region: "bavaria" },
        { excludedCountries: [], excludedRegions: [] },
      ),
    ).toBe(false);
  });
});

describe("settings: country and region exclusions", () => {
  test("saving a country stores the code and stops matching open leads in this workspace only", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 3, rows: 3 });
    const other = await seedCampaign(P(), { at: T, leads: 1, rows: 1 });
    await P().lead.update({ where: { id: s.leads[0]!.lead.id }, data: { country: "germany" } });
    await P().lead.update({ where: { id: s.leads[1]!.lead.id }, data: { country: "France" } });
    await P().lead.update({
      where: { id: other.leads[0]!.lead.id },
      data: { country: "germany" },
    });

    const w = await save(s.ws, { excludedCountries: ["Germany"] });
    expect(w.excludedCountries).toEqual(["DE"]);

    expect(await clOf(s.leads[0]!.cl.id)).toMatchObject({
      state: "STOPPED",
      stopReason: "SKIPPED",
    });
    expect(
      await P().scheduledMessage.findFirstOrThrow({
        where: { campaignLeadId: s.leads[0]!.cl.id },
      }),
    ).toMatchObject({ status: "CANCELLED" });
    expect(await clOf(s.leads[1]!.cl.id)).toMatchObject({ state: "ACTIVE" });
    expect(await clOf(s.leads[2]!.cl.id)).toMatchObject({ state: "ACTIVE" });
    expect(await P().scheduledMessage.count({ where: { campaignLeadId: s.leads[1]!.cl.id } })).toBe(
      1,
    );
    expect(await P().scheduledMessage.count({ where: { campaignLeadId: s.leads[2]!.cl.id } })).toBe(
      1,
    );
    expect(await clOf(other.leads[0]!.cl.id)).toMatchObject({ state: "ACTIVE" });

    const log = await P().auditLog.findFirstOrThrow({
      where: { workspaceId: s.ws, action: "settings.update" },
      orderBy: { id: "desc" },
    });
    expect(log.meta).toMatchObject({ excludedCountries: ["DE"], stopped: 1 });
  });

  test("a region matches trimmed, lower-cased lead regions", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 1 });
    await P().lead.update({
      where: { id: s.leads[0]!.lead.id },
      data: { region: " bavaria " },
    });
    const w = await save(s.ws, { excludedRegions: ["Bavaria"] });
    expect(w.excludedRegions).toEqual(["bavaria"]);
    expect(await clOf(s.leads[0]!.cl.id)).toMatchObject({
      state: "STOPPED",
      stopReason: "SKIPPED",
    });
  });

  test("every alias of an excluded country matches the saved rule", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 2 });
    await P().lead.update({ where: { id: s.leads[0]!.lead.id }, data: { country: "USA" } });
    await P().lead.update({
      where: { id: s.leads[1]!.lead.id },
      data: { country: "u.s.a." },
    });
    const w = await save(s.ws, { excludedCountries: ["America", "US"] });
    expect(w.excludedCountries).toEqual(["US"]);
    for (const entry of s.leads)
      expect(await clOf(entry.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "SKIPPED" });
  });

  test("an unknown country is a 400 and stores nothing", async () => {
    const s = await seedCampaign(P(), { at: T });
    expect(await err(save(s.ws, { excludedCountries: ["Nowhereland"] }))).toEqual({
      status: 400,
      message: "invalid_country",
    });
    const ws = await P().workspace.findUniqueOrThrow({ where: { id: s.ws } });
    expect(ws.excludedCountries).toEqual([]);
  });

  test("enrollment skips an excluded lead and enrolls one with no location", async () => {
    const s = await seedCampaign(P(), { at: T });
    await save(s.ws, { excludedCountries: ["DE"] });
    const excluded = await createLead(P(), s.ws, null, { email: "de@x.test", country: "Germany" });
    const unknown = await createLead(P(), s.ws, null, { email: "unknown@x.test" });
    const r = await enrollLeads(P(), clock, s.ws, s.campaign.id, {
      leadIds: [excluded.id, unknown.id],
    });
    expect(r).toEqual({
      enrolled: 1,
      skipped: {
        in_other_active_campaign: 0,
        already_in_campaign: 0,
        suppressed: 0,
        deleted: 0,
        excluded_region: 1,
      },
    });
  });

  test("the planner stops a lead whose country was edited after enrollment", async () => {
    const s = await seedCampaign(P(), { at: T, leads: 1 });
    await P().lead.update({
      where: { id: s.leads[0]!.lead.id },
      data: { country: "germany" },
    });
    await P().workspace.update({
      where: { id: s.ws },
      data: { excludedCountries: ["DE"] },
    });
    await plan();
    expect(await clOf(s.leads[0]!.cl.id)).toMatchObject({
      state: "STOPPED",
      stopReason: "SKIPPED",
    });
    expect(
      await P().scheduledMessage.count({
        where: { campaignLeadId: s.leads[0]!.cl.id, status: "SCHEDULED" },
      }),
    ).toBe(0);
  });

  test("noLocationLeads counts live leads with no country and no region", async () => {
    const s = await seedCampaign(P(), { at: T });
    await createLead(P(), s.ws, null, { email: "none1@x.test" });
    await createLead(P(), s.ws, null, { email: "none2@x.test" });
    await P().lead.create({ data: { workspaceId: s.ws, email: "none3@x.test" } });
    await P().lead.create({
      data: { workspaceId: s.ws, email: "empty@x.test", country: "", region: "" },
    });
    await createLead(P(), s.ws, null, { email: "located@x.test", country: "DE" });
    await P().lead.create({
      data: { workspaceId: s.ws, email: "gone@x.test", deletedAt: T },
    });
    const w = await getWorkspaceSettings(P(), s.ws);
    expect(w.noLocationLeads).toBe(4);
    expect(w.excludedCountries).toEqual([]);
    expect(w.excludedRegions).toEqual([]);
  });
});

describe("import: location columns", () => {
  test("a CSV with Country and State headers imports both fields", async () => {
    const ws = (await P().workspace.create({ data: { name: "W", slug: `w-reg-${++n}` } })).id;
    const data = Buffer.from("Email,Country,State\r\nloc@x.test,Germany,Bavaria\r\n");
    expect((await previewImport(P(), ws, data)).mapping).toEqual(["email", "country", "region"]);
    const { importJobId } = await createImport(P(), ws, null, {
      fileName: "leads.csv",
      data,
      mapping: ["email", "country", "region"],
      options: {},
      confirmedAuthorized: true,
      lawfulBasis: "legitimate_interest",
    });
    await runImport(
      P(),
      clock,
      {
        resolveMx: async () => {
          throw Object.assign(new Error("x"), { code: "ESERVFAIL" });
        },
      },
      importJobId,
    );
    const lead = await P().lead.findFirstOrThrow({ where: { workspaceId: ws } });
    expect(lead).toMatchObject({ country: "Germany", region: "Bavaria" });
  });
});
