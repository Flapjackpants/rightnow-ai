import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmailAccount, Prisma, ReplyCategory } from "@rightnow/db/client";
import { createTestDb } from "@rightnow/db/test-db";
import { getFakeProvider, newMessageId, parseRaw, type RemoteMessage } from "@rightnow/providers";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fixedClock } from "../src/clock";
import { claimDue } from "../src/dispatch";
import { companyDomainOf } from "../src/leads/domain";
import { classify, type Classification } from "../src/mail/classify";
import { ingestMessage } from "../src/mail/ingest";
import { applyInbound } from "../src/mail/stoprules";
import { healthInputs } from "../src/deliverability/health";
import { releaseUsage } from "../src/quota";
import { refOf, sendClaimed } from "../src/sender";
import { unsubscribeKeys } from "../src/unsubscribe";
import { planRow, seedCampaign } from "./campaign-fixture";

process.env.FAKE_MAIL_DIR = mkdtempSync(join(tmpdir(), "stoprules-"));

let db: Awaited<ReturnType<typeof createTestDb>>;
const P = () => db.prisma;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.drop());

const T = new Date("2026-10-20T10:00:00Z");
const DAY = 86_400_000;
const at = (ms: number) => new Date(T.getTime() + ms);
const clock = fixedClock(T);
const env = {
  appUrl: "https://app.example.com",
  unsubscribeKeys: unsubscribeKeys({ ENCRYPTION_KEY: randomBytes(32).toString("base64") }),
};
const fake = (a: { email: string }) => getFakeProvider(a.email);
type Setup = Awaited<ReturnType<typeof seedCampaign>>;

const setup = (campaign: Partial<Prisma.CampaignUncheckedCreateInput> = {}, workspaceId?: string) =>
  seedCampaign(P(), { at: T, steps: 3, campaign, workspaceId });

/**
 * `email` (or an existing lead) enrolled 2 days ago: step 1 SENT from account 0 yesterday ("Quick question"), step 2
 * SCHEDULED for `due` (tomorrow).
 */
async function enrol(
  s: Setup,
  email: string,
  o: { due?: Date; leadId?: string; cc?: string[] } = {},
) {
  const A = s.accounts[0]!;
  const lead = o.leadId
    ? await P().lead.findUniqueOrThrow({ where: { id: o.leadId } })
    : await P().lead.create({
        data: { workspaceId: s.ws, email, companyDomain: companyDomainOf(email) },
      });
  const due = o.due ?? at(DAY);
  const cl = await P().campaignLead.create({
    data: {
      workspaceId: s.ws,
      campaignId: s.campaign.id,
      leadId: lead.id,
      state: "ACTIVE",
      currentStepId: s.steps[1]!.id,
      accountId: A.id,
      nextDueAt: due,
      enrolledAt: at(-2 * DAY),
    },
  });
  const rfc = newMessageId("send.test");
  const base = {
    workspaceId: s.ws,
    campaignId: s.campaign.id,
    campaignLeadId: cl.id,
    accountId: A.id,
  };
  const step1 = await planRow(P(), {
    ...base,
    stepId: s.steps[0]!.id,
    variantId: s.steps[0]!.variant.id,
    dueAt: at(-DAY),
    status: "SENT",
    sentAt: at(-DAY),
    rfcMessageId: rfc,
    renderedSubject: "Quick question",
    cc: o.cc ?? [],
  });
  const step2 = await planRow(P(), {
    ...base,
    stepId: s.steps[1]!.id,
    variantId: s.steps[1]!.variant.id,
    dueAt: due,
  });
  return { lead, cl, step1, step2, rfc };
}

let n = 0;
const msg = (o: Partial<RemoteMessage>): RemoteMessage => ({
  providerMessageId: `p${++n}`,
  rfcMessageId: `<r${n}-${randomBytes(3).toString("hex")}@x.test>`,
  folder: "INBOX",
  inReplyTo: null,
  references: [],
  from: { email: "nobody@x.test" },
  to: [],
  cc: [],
  subject: "Re: Quick question",
  date: T,
  text: "Thanks.",
  html: null,
  headers: {},
  attachments: [],
  ...o,
});
const REPLY = (category: ReplyCategory = "NEUTRAL"): Classification => ({
  kind: "REPLY",
  category,
  source: "RULE",
});

/** ingest + applyInbound in one transaction, as the sync does; classifies with the message's own date as `now`. */
async function receive(a: EmailAccount, m: RemoteMessage, c?: Classification) {
  const cls = c ?? classify(m, { now: m.date, direction: "IN" });
  return P().$transaction(async (tx) => {
    const r = await ingestMessage(tx, a, m, cls, { historical: false });
    if (r.created)
      await applyInbound(tx, clock, {
        workspaceId: a.workspaceId,
        message: await tx.message.findUniqueOrThrow({ where: { id: r.messageId } }),
        classification: cls,
        match: r.match,
      });
    return r;
  });
}
const cl = (id: string) => P().campaignLead.findUniqueOrThrow({ where: { id } });
const row = (id: string) => P().scheduledMessage.findUniqueOrThrow({ where: { id } });
const lead = (id: string) => P().lead.findUniqueOrThrow({ where: { id } });
const events = (ws: string) =>
  P().event.findMany({ where: { workspaceId: ws }, orderBy: { createdAt: "asc" } });
const suppressions = (ws: string) =>
  P().suppression.findMany({ where: { workspaceId: ws }, orderBy: { value: "asc" } });

async function subsequence(s: Setup, trigger: Prisma.InputJsonValue) {
  const x = await P().subsequence.create({
    data: { campaignId: s.campaign.id, name: "sub", trigger, activatedAt: at(-DAY) },
  });
  const st = await P().sequenceStep.create({
    data: { campaignId: s.campaign.id, subsequenceId: x.id, order: 1, delayValue: 0 },
  });
  await P().stepVariant.create({ data: { stepId: st.id, label: "A", subject: "Hi", body: "Hi" } });
  return { ...x, stepId: st.id };
}

const dsn = (o: { to: string; recipient: string; status: string; diag: string; orig?: string }) =>
  Buffer.from(
    [
      "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      `To: ${o.to}`,
      "Subject: Delivery Status Notification (Failure)",
      `Date: ${T.toUTCString()}`,
      `Message-ID: <dsn-${++n}-${randomBytes(3).toString("hex")}@mx.test>`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/report; report-type=delivery-status; boundary="B1"',
      "",
      "--B1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Your message could not be delivered.",
      "",
      "--B1",
      "Content-Type: message/delivery-status",
      "",
      "Reporting-MTA: dns; mx.test",
      "",
      `Final-Recipient: rfc822; ${o.recipient}`,
      "Action: failed",
      `Status: ${o.status}`,
      `Diagnostic-Code: smtp; ${o.diag}`,
      "",
      ...(o.orig
        ? [
            "--B1",
            "Content-Type: text/rfc822-headers",
            "",
            `From: ${o.to}`,
            `To: ${o.recipient}`,
            "Subject: Quick question",
            `Message-ID: ${o.orig}`,
            "",
          ]
        : []),
      "--B1--",
      "",
    ].join("\r\n"),
  );
const parse = async (raw: Buffer) => ({
  ...(await parseRaw(raw, { providerMessageId: "", folder: "INBOX" })),
  providerMessageId: `p${++n}`,
});

describe("replies", () => {
  test("fresh referral creates an unenrolled linked lead and repeated mail does not duplicate it", async () => {
    const s = await setup();
    const e = await enrol(s, "pat@acme.test");
    await P().lead.update({
      where: { id: e.lead.id },
      data: {
        companyName: "Acme",
        lawfulBasis: "legitimate interest",
        website: "https://acme.test",
      },
    });
    const m = msg({
      from: { email: e.lead.email },
      inReplyTo: e.rfc,
      text: "Please contact sam@acme.test",
    });
    await receive(s.accounts[0]!, m, REPLY("WRONG_PERSON"));
    const referred = await P().lead.findFirstOrThrow({
      where: { workspaceId: s.ws, email: "sam@acme.test" },
    });
    expect(referred).toMatchObject({
      referredById: e.lead.id,
      tags: ["referral"],
      labels: [],
      source: "referral",
      companyName: "Acme",
      lawfulBasis: "legitimate interest",
      website: "https://acme.test",
    });
    expect(await P().campaignLead.count({ where: { leadId: referred.id } })).toBe(0);
    expect(await cl(e.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "REPLIED" });
    expect((await row(e.step2.id)).status).toBe("CANCELLED");
    await receive(s.accounts[0]!, m, REPLY("WRONG_PERSON"));
    expect(await P().lead.count({ where: { workspaceId: s.ws, email: "sam@acme.test" } })).toBe(1);
  });

  test("existing referral is linked without changing its other fields", async () => {
    const s = await setup();
    const e = await enrol(s, "pat@acme.test");
    const existing = await P().lead.create({
      data: { workspaceId: s.ws, email: "sam@acme.test", firstName: "Samuel", tags: ["keep"] },
    });
    await receive(
      s.accounts[0]!,
      msg({
        from: { email: e.lead.email },
        inReplyTo: e.rfc,
        cc: [{ email: existing.email }],
        text: "cc'ing my colleague",
      }),
      REPLY(),
    );
    expect(await lead(existing.id)).toMatchObject({
      referredById: e.lead.id,
      firstName: "Samuel",
      tags: ["keep"],
    });
  });

  test.each(["EMAIL", "DOMAIN"] as const)(
    "%s suppression prevents referral creation",
    async (kind) => {
      const s = await setup();
      const e = await enrol(s, "pat@acme.test");
      const value = kind === "EMAIL" ? "sam@acme.test" : "acme.test";
      await P().suppression.create({
        data: {
          workspaceId: s.ws,
          kind,
          value,
          valueHash: createHash("sha256").update(value).digest("hex"),
          reason: "MANUAL",
        },
      });
      await receive(
        s.accounts[0]!,
        msg({
          from: { email: e.lead.email },
          inReplyTo: e.rfc,
          text: "Please contact sam@acme.test",
        }),
        REPLY(),
      );
      expect(await P().lead.count({ where: { workspaceId: s.ws, email: "sam@acme.test" } })).toBe(
        0,
      );
    },
  );

  test("wrong person without an address creates an assigned task", async () => {
    const s = await setup();
    const e = await enrol(s, "pat@acme.test");
    await P().lead.update({ where: { id: e.lead.id }, data: { ownerId: "owner-1" } });
    await receive(
      s.accounts[0]!,
      msg({ from: { email: e.lead.email }, inReplyTo: e.rfc, text: "Wrong person" }),
      REPLY("WRONG_PERSON"),
    );
    expect(await P().task.findMany({ where: { leadId: e.lead.id } })).toMatchObject([
      {
        title: "Find the right contact for this referral",
        assigneeId: "owner-1",
        dueAt: at(DAY),
        createdAt: T,
      },
    ]);
  });
  test("referral write failure leaves the reply, stops, and Events committed", async () => {
    const s = await setup();
    const e = await enrol(s, "pat@acme.test");
    await P().$executeRawUnsafe(
      `CREATE FUNCTION referral_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.email = 'fail@acme.test' THEN RAISE EXCEPTION 'referral test failure'; END IF; RETURN NEW; END $$`,
    );
    await P().$executeRawUnsafe(
      `CREATE TRIGGER referral_test_fail_before_insert BEFORE INSERT ON "Lead" FOR EACH ROW EXECUTE FUNCTION referral_test_fail()`,
    );
    try {
      await receive(
        s.accounts[0]!,
        msg({
          from: { email: e.lead.email },
          inReplyTo: e.rfc,
          text: "Please contact fail@acme.test",
        }),
        REPLY(),
      );
      expect(await cl(e.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "REPLIED" });
      expect((await row(e.step2.id)).status).toBe("CANCELLED");
      expect(
        (await events(s.ws)).some((event) => event.type === "REPLY" && event.leadId === e.lead.id),
      ).toBe(true);
      expect(
        await P().auditLog.findFirst({
          where: { workspaceId: s.ws, action: "referral.hook_failed", target: e.lead.id },
        }),
      ).toMatchObject({ meta: { code: expect.any(String) } });
    } finally {
      await P().$executeRawUnsafe(`DROP TRIGGER referral_test_fail_before_insert ON "Lead"`);
      await P().$executeRawUnsafe(`DROP FUNCTION referral_test_fail()`);
    }
  });
  test("reply cancels pending follow-ups", async () => {
    const s = await setup();
    const e = await enrol(s, "ann@acme.test");
    await receive(
      s.accounts[0]!,
      msg({ from: { email: e.lead.email }, inReplyTo: e.rfc, references: [e.rfc] }),
      REPLY(),
    );
    expect((await row(e.step2.id)).status).toBe("CANCELLED");
    expect(await cl(e.cl.id)).toMatchObject({
      state: "STOPPED",
      stopReason: "REPLIED",
      nextDueAt: null,
    });
    expect(await events(s.ws)).toMatchObject([
      { type: "REPLY", leadId: e.lead.id, scheduledMessageId: e.step1.id },
    ]);
    const l = await lead(e.lead.id);
    expect(l).toMatchObject({ replies: 1, lastReplyAt: T });
    expect(l.lastEngagement).toMatchObject({
      reply: { stepId: s.steps[0]!.id, variantId: s.steps[0]!.variant.id, at: T.toISOString() },
    });
  });

  test("cross-mailbox reply stops lead (new message, no In-Reply-To, other mailbox)", async () => {
    const s = await setup();
    const e = await enrol(s, "ann@acme.test");
    await receive(
      s.accounts[1]!,
      msg({ from: { email: e.lead.email }, subject: "Another topic" }),
      REPLY(),
    );
    expect(await cl(e.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "REPLIED" });
    expect((await row(e.step2.id)).status).toBe("CANCELLED");
    expect((await lead(e.lead.id)).replies).toBe(1);
  });

  test("a PAUSED enrolment stops on reply and is never re-activated by a keyword subsequence", async () => {
    const s = await setup();
    await subsequence(s, { kind: "REPLY_KEYWORD", phrases: ["pricing"] });
    const e = await enrol(s, "ann@acme.test");
    await P().campaignLead.update({ where: { id: e.cl.id }, data: { state: "PAUSED" } });
    await receive(
      s.accounts[0]!,
      msg({ from: { email: e.lead.email }, inReplyTo: e.rfc, text: "pricing?" }),
      REPLY(),
    );
    expect(await cl(e.cl.id)).toMatchObject({
      state: "STOPPED",
      stopReason: "REPLIED",
      subsequenceId: null,
    });
  });

  test("a blank keyword phrase matches nothing", async () => {
    const s = await setup({ stopOnReply: false });
    await subsequence(s, { kind: "REPLY_KEYWORD", phrases: ["  "] });
    const e = await enrol(s, "ann@acme.test");
    await receive(
      s.accounts[0]!,
      msg({ from: { email: e.lead.email }, inReplyTo: e.rfc, text: "Not now, thanks." }),
      REPLY(),
    );
    expect(await cl(e.cl.id)).toMatchObject({ state: "ACTIVE", subsequenceId: null });
  });

  test("a PAUSED enrolment stops on reply too", async () => {
    const s = await setup();
    const e = await enrol(s, "ann@acme.test");
    await P().campaignLead.update({ where: { id: e.cl.id }, data: { state: "PAUSED" } });
    await receive(
      s.accounts[0]!,
      msg({ from: { email: e.lead.email }, inReplyTo: e.rfc }),
      REPLY(),
    );
    expect(await cl(e.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "REPLIED" });
  });

  test("company stop: a colleague's lead, never free-mail, and a threaded non-lead sender", async () => {
    const s = await setup({ stopForCompanyOnReply: true });
    const ann = await enrol(s, "ann@acme.test");
    const bob = await enrol(s, "bob@acme.test");
    const carl = await enrol(s, "carl@gmail.com");
    const dina = await enrol(s, "dina@gmail.com");
    await receive(
      s.accounts[0]!,
      msg({ from: { email: "ann@acme.test" }, inReplyTo: ann.rfc }),
      REPLY(),
    );
    expect(await cl(ann.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "REPLIED" });
    expect(await cl(bob.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "COMPANY_REPLIED" });
    expect((await row(bob.step2.id)).status).toBe("CANCELLED");
    await receive(
      s.accounts[0]!,
      msg({ from: { email: "carl@gmail.com" }, inReplyTo: carl.rfc }),
      REPLY(),
    );
    expect(await cl(carl.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "REPLIED" });
    expect((await cl(dina.cl.id)).state).toBe("ACTIVE");

    const s2 = await setup({ stopForCompanyOnReply: true });
    const ann2 = await enrol(s2, "ann@acme.test");
    const bob2 = await enrol(s2, "bob@acme.test");
    // I8: an unthreaded mail from a non-lead of the domain stops nobody
    await receive(
      s2.accounts[0]!,
      msg({ from: { email: "billing@acme.test" }, subject: "Invoice" }),
      REPLY(),
    );
    expect((await cl(ann2.cl.id)).state).toBe("ACTIVE");
    expect((await cl(bob2.cl.id)).state).toBe("ACTIVE");
    await receive(
      s2.accounts[0]!,
      msg({ from: { email: "ceo@acme.test" }, inReplyTo: ann2.rfc }),
      REPLY(),
    );
    expect(await cl(ann2.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "REPLIED" });
    expect(await cl(bob2.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "COMPANY_REPLIED" });
  });

  test("stopOnReply off keeps sending; a REPLY_KEYWORD phrase outside the quote enters the subsequence", async () => {
    const s = await setup({ stopOnReply: false });
    const sub = await subsequence(s, { kind: "REPLY_KEYWORD", phrases: ["pricing"] });
    const a = await enrol(s, "ann@acme.test");
    const b = await enrol(s, "bob@beta.test");
    const quoted =
      "Not now.\n\nOn Mon, Oct 19, 2026 at 10:00 AM S <s@send.test> wrote:\n> our pricing";
    await receive(
      s.accounts[0]!,
      msg({ from: { email: "bob@beta.test" }, inReplyTo: b.rfc, text: quoted }),
      REPLY(),
    );
    expect(await cl(b.cl.id)).toMatchObject({ state: "ACTIVE", subsequenceId: null });
    expect((await row(b.step2.id)).status).toBe("SCHEDULED");
    await receive(
      s.accounts[0]!,
      msg({ from: { email: "ann@acme.test" }, inReplyTo: a.rfc, text: "What is your Pricing?" }),
      REPLY(),
    );
    expect(await cl(a.cl.id)).toMatchObject({
      state: "ACTIVE",
      subsequenceId: sub.id,
      currentStepId: sub.stepId,
    });
    expect((await row(a.step2.id)).status).toBe("CANCELLED");
  });

  test("I1: with stopOnReply on, the main flow stops and the keyword subsequence takes over", async () => {
    const s = await setup();
    const sub = await subsequence(s, { kind: "REPLY_KEYWORD", phrases: ["send pricing"] });
    const e = await enrol(s, "ann@acme.test");
    await receive(
      s.accounts[0]!,
      msg({ from: { email: e.lead.email }, inReplyTo: e.rfc, text: "Please SEND pricing." }),
      REPLY(),
    );
    expect((await row(e.step2.id)).status).toBe("CANCELLED");
    expect(await cl(e.cl.id)).toMatchObject({
      state: "ACTIVE",
      stopReason: null,
      subsequenceId: sub.id,
    });
  });

  test("interest set only when empty: LEAD_STATUS subsequence, other campaigns untouched", async () => {
    const s = await setup();
    const sub = await subsequence(s, { kind: "LEAD_STATUS", interest: [1] });
    const e = await enrol(s, "ann@acme.test");
    const s2 = await setup({ stopOnReply: false }, s.ws);
    const other = await enrol(s2, "", { leadId: e.lead.id });
    await receive(
      s.accounts[0]!,
      msg({ from: { email: e.lead.email }, inReplyTo: e.rfc }),
      REPLY("INTERESTED"),
    );
    expect(await lead(e.lead.id)).toMatchObject({ interestStatus: 1, lastInterestChangeAt: T });
    expect(await cl(e.cl.id)).toMatchObject({ state: "ACTIVE", subsequenceId: sub.id });
    expect(await cl(other.cl.id)).toMatchObject({ state: "ACTIVE", subsequenceId: null });
    expect((await events(s.ws)).map((x) => x.type)).toEqual([
      "REPLY",
      "INTEREST_CHANGED",
      "OPPORTUNITY", // D40: the interest opens a deal
    ]);

    const s3 = await setup();
    const w = await enrol(s3, "wrong@acme.test");
    await P().lead.update({ where: { id: w.lead.id }, data: { interestStatus: -2 } });
    await receive(
      s3.accounts[0]!,
      msg({ from: { email: w.lead.email }, inReplyTo: w.rfc }),
      REPLY("INTERESTED"),
    );
    expect((await lead(w.lead.id)).interestStatus).toBe(-2);
    expect((await events(s3.ws)).map((x) => x.type)).toEqual(["REPLY"]);
  });

  test("not interested sets -1 and suppresses the address", async () => {
    const s = await setup({ stopOnReply: false });
    const e = await enrol(s, "ann@acme.test");
    await receive(
      s.accounts[0]!,
      msg({ from: { email: e.lead.email }, inReplyTo: e.rfc }),
      REPLY("NOT_INTERESTED"),
    );
    expect((await lead(e.lead.id)).interestStatus).toBe(-1);
    expect(await suppressions(s.ws)).toMatchObject([
      { value: e.lead.email, reason: "NOT_INTERESTED" },
    ]);
    expect(await cl(e.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "SUPPRESSED" });
  });

  test("double ingest counts once (the same reply in two mailboxes)", async () => {
    const s = await setup();
    const e = await enrol(s, "ann@acme.test");
    const m = msg({
      from: { email: e.lead.email },
      inReplyTo: e.rfc,
      to: s.accounts.map((a) => ({ email: a.email })),
    });
    await receive(s.accounts[0]!, m, REPLY("INTERESTED"));
    await receive(s.accounts[1]!, { ...m, providerMessageId: "other" }, REPLY("INTERESTED"));
    expect(await P().message.count({ where: { workspaceId: s.ws } })).toBe(2);
    expect((await events(s.ws)).map((x) => x.type)).toEqual([
      "REPLY",
      "INTEREST_CHANGED",
      "OPPORTUNITY", // D40: the interest opens a deal
    ]);
    expect((await lead(e.lead.id)).replies).toBe(1);
  });

  test("historical reply before enrolment does not stop; a threaded one a year old does (I7)", async () => {
    const s = await setup();
    const e = await enrol(s, "ann@acme.test");
    await receive(
      s.accounts[1]!,
      msg({ from: { email: e.lead.email }, subject: "Old chat", date: at(-3 * DAY) }),
      REPLY(),
    );
    expect((await cl(e.cl.id)).state).toBe("ACTIVE");
    await receive(
      s.accounts[0]!,
      msg({ from: { email: e.lead.email }, inReplyTo: e.rfc, date: at(-365 * DAY) }),
      REPLY(),
    );
    expect(await cl(e.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "REPLIED" });
  });

  test("a deleted lead is neither revived nor counted", async () => {
    const s = await setup({ stopOnReply: false });
    await subsequence(s, { kind: "REPLY_KEYWORD", phrases: ["pricing"] });
    const e = await enrol(s, "ann@acme.test");
    await P().lead.update({ where: { id: e.lead.id }, data: { deletedAt: T } });
    await P().campaignLead.update({
      where: { id: e.cl.id },
      data: { state: "STOPPED", stopReason: "SKIPPED" },
    });
    await receive(
      s.accounts[0]!,
      msg({ from: { email: e.lead.email }, inReplyTo: e.rfc, text: "pricing?" }),
      REPLY("INTERESTED"),
    );
    expect(await cl(e.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "SKIPPED" });
    expect(await lead(e.lead.id)).toMatchObject({ replies: 0, interestStatus: null });
  });
});

describe("auto-replies", () => {
  const ooo = (oooUntil: Date | null): Classification => ({
    kind: "AUTO_REPLY",
    category: "OUT_OF_OFFICE",
    oooUntil,
  });

  test("ooo reschedules, ooo clamp, no date → 7 days, stopOnAutoReply stops", async () => {
    const s = await setup();
    const a = await enrol(s, "a@a.test");
    const b = await enrol(s, "b@b.test");
    const c = await enrol(s, "c@c.test");
    const send = (e: typeof a, cls: Classification) =>
      receive(s.accounts[0]!, msg({ from: { email: e.lead.email }, inReplyTo: e.rfc }), cls);
    await send(a, ooo(at(10 * DAY)));
    expect((await row(a.step2.id)).dueAt).toEqual(at(10 * DAY));
    expect(await cl(a.cl.id)).toMatchObject({ state: "ACTIVE", nextDueAt: at(10 * DAY) });
    await send(b, ooo(at(400 * DAY)));
    expect((await row(b.step2.id)).dueAt).toEqual(at(90 * DAY));
    await send(c, ooo(null));
    expect((await row(c.step2.id)).dueAt).toEqual(at(7 * DAY));
    expect(await events(s.ws)).toHaveLength(3);
    expect((await lead(a.lead.id)).replies).toBe(0);

    const s2 = await setup({ stopOnAutoReply: true });
    const d = await enrol(s2, "d@d.test");
    await receive(
      s2.accounts[0]!,
      msg({ from: { email: d.lead.email }, inReplyTo: d.rfc }),
      ooo(null),
    );
    expect(await cl(d.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "AUTO_REPLIED" });
  });

  test("an OOO return date already past changes nothing", async () => {
    const s = await setup();
    const a = await enrol(s, "a@a.test");
    await receive(
      s.accounts[0]!,
      msg({ from: { email: a.lead.email }, inReplyTo: a.rfc }),
      ooo(at(-DAY)),
    );
    expect((await row(a.step2.id)).dueAt).toEqual(at(DAY));
  });
});

describe("unsubscribe and bounces", () => {
  test("unsubscribe reply suppresses and stops every campaign", async () => {
    const s = await setup({ stopOnReply: false });
    const e = await enrol(s, "ann@acme.test");
    const s2 = await setup({ stopOnReply: false }, s.ws);
    const other = await enrol(s2, "", { leadId: e.lead.id });
    await receive(
      s.accounts[0]!,
      msg({ from: { email: e.lead.email }, inReplyTo: e.rfc, text: "Please unsubscribe me." }),
    );
    expect(await suppressions(s.ws)).toMatchObject([
      { kind: "EMAIL", value: e.lead.email, reason: "UNSUBSCRIBE", source: "mailto" },
    ]);
    for (const id of [e.cl.id, other.cl.id])
      expect(await cl(id)).toMatchObject({ state: "STOPPED", stopReason: "UNSUBSCRIBED" });
    expect(await events(s.ws)).toMatchObject([{ type: "UNSUBSCRIBE", leadId: e.lead.id }]);
  });

  test("hard bounce suppresses; soft does not", async () => {
    const s = await setup();
    const A = s.accounts[0]!;
    const h = await enrol(s, "gone@acme.test");
    const so = await enrol(s, "full@beta.test");
    const diag = "550 5.1.1 The email account that you tried to reach does not exist.";
    await receive(
      A,
      await parse(
        dsn({ to: A.email, recipient: h.lead.email, status: "5.1.1", diag, orig: h.rfc }),
      ),
    );
    expect(await cl(h.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "BOUNCED" });
    expect((await row(h.step2.id)).status).toBe("CANCELLED");
    await receive(
      A,
      await parse(
        dsn({
          to: A.email,
          recipient: so.lead.email,
          status: "4.2.2",
          diag: "452 4.2.2 Mailbox full",
          orig: so.rfc,
        }),
      ),
    );
    expect((await cl(so.cl.id)).state).toBe("ACTIVE");
    expect(await suppressions(s.ws)).toMatchObject([
      { value: h.lead.email, reason: "HARD_BOUNCE", source: "dsn" },
    ]);
    expect(await events(s.ws)).toMatchObject([
      { type: "BOUNCE_HARD", leadId: h.lead.id, scheduledMessageId: h.step1.id },
      { type: "BOUNCE_SOFT", leadId: so.lead.id },
    ]);
  });

  test("bounce via Final-Recipient only finds the lead", async () => {
    const s = await setup();
    const A = s.accounts[0]!;
    const h = await enrol(s, "gone@acme.test");
    await receive(
      A,
      await parse(
        dsn({
          to: A.email,
          recipient: h.lead.email,
          status: "5.1.1",
          diag: "550 5.1.1 user unknown",
        }),
      ),
    );
    expect(await cl(h.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "BOUNCED" });
  });

  test("5.7.1 policy is UNKNOWN: no suppression", async () => {
    const s = await setup();
    const A = s.accounts[0]!;
    const h = await enrol(s, "boss@acme.test");
    await receive(
      A,
      await parse(
        dsn({
          to: A.email,
          recipient: h.lead.email,
          status: "5.7.1",
          diag: "550 5.7.1 Message rejected due to local policy",
          orig: h.rfc,
        }),
      ),
    );
    expect((await cl(h.cl.id)).state).toBe("ACTIVE");
    expect(await suppressions(s.ws)).toEqual([]);
    expect(await events(s.ws)).toMatchObject([{ type: "BOUNCE_UNKNOWN", leadId: h.lead.id }]);
  });

  test("I2: a DSN for the cc suppresses the cc only; PA #4: a hard bounce without a send of ours suppresses nothing", async () => {
    const s = await setup();
    const A = s.accounts[0]!;
    const e = await enrol(s, "ann@acme.test", { cc: ["cc@other.test"] });
    await receive(
      A,
      await parse(
        dsn({
          to: A.email,
          recipient: "cc@other.test",
          status: "5.1.1",
          diag: "550 5.1.1 user unknown",
          orig: e.rfc,
        }),
      ),
    );
    expect((await cl(e.cl.id)).state).toBe("ACTIVE");
    await receive(
      A,
      await parse(
        dsn({
          to: A.email,
          recipient: "stranger@else.test",
          status: "5.1.1",
          diag: "550 5.1.1 user unknown",
        }),
      ),
    );
    // a recipient we never mailed, even on a DSN naming our own send, is not suppressed
    await receive(
      A,
      await parse(
        dsn({
          to: A.email,
          recipient: "victim@else.test",
          status: "5.1.1",
          diag: "550 5.1.1 user unknown",
          orig: e.rfc,
        }),
      ),
    );
    expect((await suppressions(s.ws)).map((x) => x.value)).toEqual(["cc@other.test"]);
    expect(await events(s.ws)).toMatchObject([
      { type: "BOUNCE_HARD", leadId: e.lead.id, meta: { recipient: "cc@other.test" } },
      { type: "BOUNCE_HARD", leadId: null, meta: { recipient: "stranger@else.test" } },
      { type: "BOUNCE_HARD", leadId: e.lead.id, meta: { recipient: "victim@else.test" } },
    ]);
  });

  const arf = (o: { to: string; recipient: string; orig: string }) =>
    Buffer.from(
      [
        "From: Yahoo! Mail AntiSpam Feedback <feedback@arf.mail.yahoo.com>",
        `To: ${o.to}`,
        "Subject: FW: Quick question",
        `Date: ${T.toUTCString()}`,
        `Message-ID: <arf-${++n}-${randomBytes(3).toString("hex")}@yahoo.test>`,
        "MIME-Version: 1.0",
        'Content-Type: multipart/report; report-type=feedback-report; boundary="B1"',
        "",
        "--B1",
        "Content-Type: text/plain",
        "",
        "This is an email abuse report.",
        "",
        "--B1",
        "Content-Type: message/feedback-report",
        "",
        "Feedback-Type: abuse",
        `Original-Rcpt-To: <${o.recipient}>`,
        "",
        "--B1",
        "Content-Type: text/rfc822-headers",
        "",
        `From: ${o.to}`,
        `To: ${o.recipient}`,
        "Subject: Quick question",
        `Message-ID: ${o.orig}`,
        "",
        "--B1--",
        "",
      ].join("\r\n"),
    );

  test("complaint suppresses and stops", async () => {
    const s = await setup();
    const s2 = await setup({}, s.ws);
    const A = s.accounts[0]!;
    const e = await enrol(s, "angry@acme.test");
    const other = await enrol(s2, "", { leadId: e.lead.id });
    await receive(A, await parse(arf({ to: A.email, recipient: e.lead.email, orig: e.rfc })));
    for (const id of [e.cl.id, other.cl.id])
      expect(await cl(id)).toMatchObject({ state: "STOPPED", stopReason: "COMPLAINED" });
    expect((await row(e.step2.id)).status).toBe("CANCELLED");
    expect(await suppressions(s.ws)).toMatchObject([
      { value: e.lead.email, reason: "COMPLAINT", source: "arf" },
    ]);
    expect(await events(s.ws)).toMatchObject([
      { type: "COMPLAINT", leadId: e.lead.id, scheduledMessageId: e.step1.id, accountId: A.id },
    ]);

    // an ARF for a Message-ID we never sent: the event only (the From of a report is not authenticated)
    const s3 = await setup();
    const B = s3.accounts[0]!;
    const x = await enrol(s3, "calm@beta.test");
    await receive(
      B,
      await parse(
        arf({ to: B.email, recipient: "stranger@else.test", orig: "<unknown-1@else.test>" }),
      ),
    );
    expect((await cl(x.cl.id)).state).toBe("ACTIVE");
    expect(await suppressions(s3.ws)).toEqual([]);
    expect(await events(s3.ws)).toMatchObject([{ type: "COMPLAINT", leadId: null }]);
  });

  test("a complaint (or bounce) received by another mailbox counts against the account that sent the mail", async () => {
    const s = await setup();
    const [A, B] = s.accounts as [EmailAccount, EmailAccount];
    const e = await enrol(s, "angry2@acme.test"); // sent from A
    await receive(B, await parse(arf({ to: B.email, recipient: e.lead.email, orig: e.rfc })));
    expect(await events(s.ws)).toMatchObject([{ type: "COMPLAINT", accountId: A.id }]);
    const h = await healthInputs(P(), [A.id, B.id], T);
    expect(h.get(A.id)).toMatchObject({ complaints30d: 1 });
    expect(h.get(B.id)).toMatchObject({ complaints30d: 0 });
  });
});

describe("against the send claim", () => {
  const claimOpts = {
    limit: 1,
    bootId: "b",
    stalenessSec: 300,
    sendableProviders: ["SMTP" as const],
    env,
  };
  const deps = { providerFor: fake, env, random: () => 0 };
  const reserved = async (accountId: string) =>
    (await P().accountDailyUsage.findMany({ where: { accountId } })).map((u) => [
      u.sent,
      u.reserved,
    ]);

  test("stop races the claim: the claimed row is skipped, the pre-send check cancels it", async () => {
    const s = await setup();
    const A = s.accounts[0]!;
    const e = await enrol(s, "racer@race.test", { due: at(-60_000) });
    const [c] = await claimDue(P(), clock, claimOpts);
    expect(c!.id).toBe(e.step2.id);
    await receive(A, msg({ from: { email: e.lead.email }, inReplyTo: e.rfc }), REPLY());
    expect((await row(e.step2.id)).status).toBe("SENDING");
    expect(await cl(e.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "REPLIED" });
    expect(await sendClaimed(P(), clock, deps, c!)).toBe("CANCELLED");
    expect(await reserved(A.id)).toEqual([[0, 0]]);
    expect(await fake(A).sentRaw()).toHaveLength(0);
  });

  test("M17: a reply to an UNCERTAIN send settles it SENT and stops every stopOnReply campaign", async () => {
    const s = await setup();
    const A = s.accounts[0]!;
    const e = await enrol(s, "maybe@race.test", { due: at(-60_000) });
    const s2 = await setup({}, s.ws);
    const other = await enrol(s2, "", { leadId: e.lead.id });
    const [c] = await claimDue(P(), clock, claimOpts);
    fake(A).failNext("api_5xx");
    expect(await sendClaimed(P(), clock, deps, c!)).toBe("UNCERTAIN");
    const rfc = (await row(e.step2.id)).rfcMessageId!;
    await receive(
      A,
      msg({ from: { email: e.lead.email }, inReplyTo: rfc, references: [e.rfc, rfc] }),
      REPLY(),
    );
    expect(await row(e.step2.id)).toMatchObject({ status: "SENT" });
    expect(await reserved(A.id)).toEqual([[1, 0]]);
    expect(await cl(e.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "REPLIED" });
    expect(await cl(other.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "REPLIED" });
    expect((await row(other.step2.id)).status).toBe("CANCELLED");
    expect((await lead(e.lead.id)).emailsSent).toBe(1);
  });

  test("FR M6: a bounce of an UNCERTAIN send settles it SENT, so Release cannot send it twice", async () => {
    const s = await setup();
    const A = s.accounts[0]!;
    const e = await enrol(s, "full@race.test", { due: at(-60_000) });
    const [c] = await claimDue(P(), clock, claimOpts);
    fake(A).failNext("api_5xx");
    expect(await sendClaimed(P(), clock, deps, c!)).toBe("UNCERTAIN");
    const rfc = (await row(e.step2.id)).rfcMessageId!;
    await receive(
      A,
      await parse(
        dsn({
          to: A.email,
          recipient: e.lead.email,
          status: "4.2.2",
          diag: "452 4.2.2 Mailbox full",
          orig: rfc,
        }),
      ),
    );
    expect(await row(e.step2.id)).toMatchObject({ status: "SENT" });
    expect(await reserved(A.id)).toEqual([[1, 0]]);
    expect((await lead(e.lead.id)).emailsSent).toBe(1);
  });

  test("M17: a reply to a HELD send (no claim token) settles it SENT", async () => {
    const s = await setup();
    const A = s.accounts[0]!;
    const e = await enrol(s, "held@race.test", { due: at(-60_000) });
    const [c] = await claimDue(P(), clock, claimOpts);
    fake(A).failNext("api_5xx");
    expect(await sendClaimed(P(), clock, deps, c!)).toBe("UNCERTAIN");
    const r = await row(e.step2.id);
    await P().$transaction(async (tx) => {
      await releaseUsage(tx, refOf(r));
      await tx.scheduledMessage.update({
        where: { id: r.id },
        data: { status: "HELD", claimToken: null },
      });
    });
    expect(await reserved(A.id)).toEqual([[0, 0]]);
    await receive(A, msg({ from: { email: e.lead.email }, inReplyTo: r.rfcMessageId }), REPLY());
    expect(await row(r.id)).toMatchObject({ status: "SENT", claimToken: null });
    expect(await reserved(A.id)).toEqual([[1, 0]]);
    expect(await cl(e.cl.id)).toMatchObject({ state: "STOPPED", stopReason: "REPLIED" });
  });
});
