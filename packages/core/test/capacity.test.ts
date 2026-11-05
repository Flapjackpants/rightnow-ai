import { createTestDb } from "@rightnow/db/test-db";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { leadCapacity } from "../src/leads/capacity";
import { seedCampaign } from "./campaign-fixture";

const T = new Date("2026-11-05T12:00:00Z");
let db: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => {
  db = await createTestDb();
});
afterEach(() => db.drop());
const capacity = (ws: string, sendable: ("SMTP" | "GMAIL" | "MICROSOFT")[] = ["SMTP"]) =>
  leadCapacity(db.prisma, ws, T, sendable);

describe("lead capacity", () => {
  test("sums allowances, applies the workspace cap, and reserves two days", async () => {
    const s = await seedCampaign(db.prisma, {
      at: T,
      accounts: [{ dailyLimit: 30 }, { dailyLimit: 20 }],
    });
    expect(await capacity(s.ws)).toEqual({
      dailySends: 50,
      followUpsDue: 0,
      newPerDay: 50,
      queued: 0,
      headroom: 100,
    });
    await db.prisma.workspace.update({ where: { id: s.ws }, data: { dailyCap: 40 } });
    expect(await capacity(s.ws)).toMatchObject({ dailySends: 40, headroom: 80 });
  });

  test("uses ramp and re-warm allowances, excluding unavailable accounts", async () => {
    const s = await seedCampaign(db.prisma, {
      at: T,
      accounts: [
        {
          dailyLimit: 30,
          slowRamp: true,
          rampStartVolume: 3,
          rampIncrementPerDay: 2,
          rampStartedAt: T,
        },
        { dailyLimit: 30, lifecycle: "REWARMING", rewarmStartedAt: T, rewarmStartVolume: 5 },
        { dailyLimit: 30, lifecycle: "PAUSED" },
        { dailyLimit: 30, lifecycle: "NEEDS_ATTENTION" },
        { dailyLimit: 30, status: "DISCONNECTED" },
        { dailyLimit: 30, deletedAt: T },
        { dailyLimit: 30, provider: "GMAIL" },
      ],
    });
    expect(await capacity(s.ws)).toMatchObject({ dailySends: 8, headroom: 16 });
    expect(await capacity(s.ws, ["SMTP", "GMAIL"])).toMatchObject({ dailySends: 38 });
  });

  test("counts due follow-ups and queued leads only in live campaigns", async () => {
    const s = await seedCampaign(db.prisma, { at: T, accounts: [{ dailyLimit: 30 }], leads: 42 });
    const ids = s.leads.map((l) => l.cl.id);
    await db.prisma.campaignLead.updateMany({
      where: { id: { in: ids.slice(0, 10) } },
      data: { nextDueAt: new Date(T.getTime() + 24 * 60 * 60 * 1000) },
    });
    await db.prisma.campaignLead.update({
      where: { id: ids[10] },
      data: { nextDueAt: new Date(T.getTime() + 3 * 24 * 60 * 60 * 1000) },
    });
    await db.prisma.campaignLead.updateMany({
      where: { id: { in: ids.slice(11, 41) } },
      data: { state: "QUEUED", nextDueAt: T },
    });
    expect(await capacity(s.ws)).toMatchObject({
      followUpsDue: 10,
      newPerDay: 20,
      queued: 30,
      headroom: 10,
    });
    await db.prisma.campaignLead.update({ where: { id: ids[41] }, data: { state: "QUEUED" } });
    await db.prisma.campaignLead.updateMany({
      where: { id: { in: ids.slice(0, 10) } },
      data: { state: "QUEUED" },
    });
    expect(await capacity(s.ws)).toMatchObject({ followUpsDue: 0, queued: 41, headroom: 19 });
    await db.prisma.workspace.update({ where: { id: s.ws }, data: { dailyCap: 10 } });
    await db.prisma.campaignLead.updateMany({
      where: { id: { in: ids.slice(0, 11) } },
      data: { state: "ACTIVE", nextDueAt: T },
    });
    expect(await capacity(s.ws)).toMatchObject({ followUpsDue: 11, newPerDay: 0, headroom: 0 });
  });

  test("ignores draft, completed, deleted, and foreign campaigns and accounts", async () => {
    const s = await seedCampaign(db.prisma, { at: T, accounts: [{ dailyLimit: 30 }], leads: 1 });
    const due = new Date(T.getTime() + 1000);
    const add = async (campaign: { status?: "DRAFT" | "COMPLETED"; deletedAt?: Date }) => {
      const x = await seedCampaign(db.prisma, {
        at: T,
        workspaceId: s.ws,
        useAccounts: s.accounts,
        campaign,
        leads: 2,
      });
      await db.prisma.campaignLead.update({
        where: { id: x.leads[0]!.cl.id },
        data: { nextDueAt: due },
      });
      await db.prisma.campaignLead.update({
        where: { id: x.leads[1]!.cl.id },
        data: { state: "QUEUED" },
      });
    };
    await add({ status: "DRAFT" });
    await add({ status: "COMPLETED" });
    await add({ deletedAt: T });
    const other = await seedCampaign(db.prisma, {
      at: T,
      accounts: [{ dailyLimit: 20 }],
      leads: 2,
    });
    await db.prisma.campaignLead.update({
      where: { id: other.leads[0]!.cl.id },
      data: { nextDueAt: due },
    });
    await db.prisma.campaignLead.update({
      where: { id: other.leads[1]!.cl.id },
      data: { state: "QUEUED" },
    });
    expect(await capacity(s.ws)).toEqual({
      dailySends: 30,
      followUpsDue: 0,
      newPerDay: 30,
      queued: 0,
      headroom: 60,
    });
  });
});
