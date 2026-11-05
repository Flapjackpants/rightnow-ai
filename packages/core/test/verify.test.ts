import { randomBytes } from "node:crypto";
import { createTestDb } from "@rightnow/db/test-db";
import { HttpOutError, safeRequest, type SafeResponse } from "@rightnow/providers";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { fixedClock } from "../src/clock";
import { decrypt } from "../src/crypto";
import { claimDue } from "../src/dispatch";
import { createImport, runImport } from "../src/leads/import";
import {
  getVerifierSettings,
  httpVerifier,
  MILLIONVERIFIER_URL,
  millionVerifier,
  mxVerifier,
  queueVerify,
  runVerify,
  setVerifierSettings,
  workspaceVerifier,
  type EmailVerifier,
} from "../src/leads/verify";
import { planDue } from "../src/planner";
import { unsubscribeKeys } from "../src/unsubscribe";
import { testEnv } from "./accounts-fixture";
import { seedCampaign } from "./campaign-fixture";

let db: Awaited<ReturnType<typeof createTestDb>>;
const T = new Date("2026-10-20T10:00:00Z");
const clock = fixedClock(T);
const sig = () => new AbortController().signal;
const err = (code: string) => Object.assign(new Error(code), { code });
const mx = (m: Record<string, string>) => async (d: string) => {
  if (m[d] === "mx") return [{ exchange: "mx.x.test", priority: 1 }];
  throw err(m[d] ?? "ENOTFOUND");
};
const ENV = {
  appUrl: "https://app.example.com",
  unsubscribeKeys: unsubscribeKeys({ ENCRYPTION_KEY: randomBytes(32).toString("base64") }),
};
let n = 0;
const mkWs = async () =>
  (await db.prisma.workspace.create({ data: { name: "W", slug: `w-ver-${++n}` } })).id;
const mkLead = (ws: string, email: string, extra = {}) =>
  db.prisma.lead.create({ data: { workspaceId: ws, email, ...extra } });
const status = (id: string) =>
  db.prisma.lead.findUniqueOrThrow({
    where: { id },
    select: { verificationStatus: true, verifyPrevStatus: true },
  });
/** Verifier answering from a map by address; "throw" throws, "null" leaves unchanged. */
const stub = (m: Record<string, string>): EmailVerifier => ({
  kind: "mx",
  verify: async (e) => {
    const v = m[e];
    if (v === "throw") throw new Error("boom");
    return v && v !== "null" ? (v as never) : null;
  },
});
const res = (body: string, status = 200): SafeResponse => ({
  status,
  headers: {},
  body: Buffer.from(body),
  latencyMs: 1,
});
const claimOpts = {
  limit: 5,
  bootId: "b",
  stalenessSec: 300,
  sendableProviders: ["SMTP" as const],
};

beforeAll(async () => {
  testEnv();
  db = await createTestDb();
});
afterAll(() => db.drop());
// runVerify scans every workspace: leftovers of an earlier test must not count
beforeEach(() =>
  db.prisma.lead.updateMany({
    where: { verificationStatus: "PENDING_JOB" },
    data: { verificationStatus: "NOT_VERIFIED", verifyPrevStatus: null },
  }),
);

describe("mxVerifier", () => {
  const v = mxVerifier(mx({ "ok.test": "mx", "slow.test": "ETIMEOUT", "nodata.test": "ENODATA" }));
  test.each([
    ["a@nomx.test", "INVALID"],
    ["a@nodata.test", "INVALID"],
    ["not-an-email", "INVALID"],
    ["a@mailinator.com", "RISKY"],
    ["a@ok.test", null],
    ["a@slow.test", null],
  ])("%s -> %s", async (email, want) => {
    expect(await v.verify(email, sig())).toBe(want);
  });
});

describe("httpVerifier", () => {
  const cfg = { url: "https://v.example.com/check", apiKey: "k", statusPath: "result.status" };
  type Req = typeof safeRequest;
  const reply = (body: unknown, status = 200) =>
    vi.fn<Req>(async () => res(JSON.stringify(body), status));
  const pub = async () => ["93.184.216.34"];
  test("maps the status at statusPath and sends a bearer POST through safeRequest", async () => {
    const f = reply({ result: { status: "catch_all" } });
    expect(await httpVerifier(cfg, f, pub).verify("a@b.test", sig())).toBe("CATCH_ALL");
    const [url, o] = f.mock.calls[0]!;
    expect(url).toBe(cfg.url);
    expect(o).toMatchObject({
      method: "POST",
      allowPrivate: false,
      resolve: pub,
      timeoutMs: 10_000,
      maxResponseBytes: 64 * 1024,
    });
    expect(o.headers!.authorization).toBe("Bearer k");
    expect(JSON.parse(o.body as string)).toEqual({ email: "a@b.test" });
  });
  test("valid/invalid/risky/unknown map to statuses", async () => {
    for (const [s, want] of [
      ["valid", "VERIFIED"],
      ["invalid", "INVALID"],
      ["risky", "RISKY"],
      ["unknown", "NOT_VERIFIED"],
    ] as const)
      expect(
        await httpVerifier(cfg, reply({ result: { status: s } }), pub).verify("a@b.test", sig()),
      ).toBe(want);
  });
  test("every HTTP error status and every malformed 200 is a coded failure, never a silent null", async () => {
    const code = (f: Req) =>
      httpVerifier(cfg, f, pub)
        .verify("a@b.test", sig())
        .then(
          () => "no error",
          (e: { code?: string }) => e.code,
        );
    for (const st of [301, 302, 400, 401, 429, 500, 503])
      expect(await code(reply({}, st))).toBe(`http_${st}`);
    expect(await code(reply({ result: { status: "weird" } }))).toBe("bad_status_path");
    expect(await code(reply({ other: 1 }))).toBe("bad_status_path");
    expect(await code(vi.fn(async () => res("not json")))).toBe("bad_response");
    const big = vi.fn<Req>(async () => {
      throw new HttpOutError("response_too_large", 200);
    });
    expect(await code(big)).toBe("bad_response");
    const slow = vi.fn<Req>(async () => {
      throw new HttpOutError("timeout");
    });
    expect(await code(slow)).toBe("timeout");
  });
  test("http:// is refused before any request; private hosts by safeRequest, before any socket", async () => {
    const f = reply({ result: { status: "valid" } });
    await expect(
      httpVerifier({ ...cfg, url: "http://v.example.com/x" }, f, pub).verify("a@b.test", sig()),
    ).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
    for (const [url, resolve] of [
      ["https://10.0.0.1/x", undefined],
      [cfg.url, async () => ["127.0.0.1"]],
    ] as const)
      await expect(
        httpVerifier({ ...cfg, url }, safeRequest, resolve).verify("a@b.test", sig()),
      ).rejects.toMatchObject({ code: "host_not_public" });
  });

  test("verifier pinned: a name that resolves public, then private, is refused on the second call", async () => {
    let n = 0;
    const resolve = vi.fn(async () => (n++ === 0 ? ["93.184.216.34"] : ["10.0.0.1"]));
    // call 1 answers without the network, after resolving through the verifier's own resolver, as safeRequest does
    const first = vi.fn<Req>(async (_u, o) => {
      await o.resolve!("v.example.com");
      return res(JSON.stringify({ result: { status: "valid" } }));
    });
    expect(await httpVerifier(cfg, first, resolve).verify("a@b.test", sig())).toBe("VERIFIED");
    await expect(
      httpVerifier(cfg, safeRequest, resolve).verify("a@b.test", sig()),
    ).rejects.toMatchObject({ code: "host_not_public" });
    expect(resolve).toHaveBeenCalledTimes(2); // one lookup per call: no separate check before the request
  });

  test("ALLOW_PRIVATE_HTTP_HOSTS lets a LAN verifier through, but never cloud metadata", async () => {
    const f = reply({ result: { status: "valid" } });
    expect(
      await httpVerifier(cfg, f, async () => ["10.0.0.1"], true).verify("a@b.test", sig()),
    ).toBe("VERIFIED");
    expect(f.mock.calls[0]![1]).toMatchObject({ allowPrivate: true });
    await expect(
      httpVerifier(cfg, safeRequest, async () => ["169.254.169.254"], true).verify(
        "a@b.test",
        sig(),
      ),
    ).rejects.toMatchObject({ code: "host_not_public" });
  });
});

describe("millionVerifier", () => {
  type Req = typeof safeRequest;
  const reply = (body: unknown, status = 200) =>
    vi.fn<Req>(async () => res(JSON.stringify(body), status));
  const pub = async () => ["93.184.216.34"];
  const verifier = (f: Req) => millionVerifier({ apiKey: "mv-secret" }, f, pub);
  const code = (f: Req) =>
    verifier(f)
      .verify("a@b.test", sig())
      .then(
        () => "no error",
        (e: { code?: string }) => e.code,
      );

  test.each([
    ["ok", "VERIFIED"],
    ["catch_all", "CATCH_ALL"],
    ["invalid", "INVALID"],
    ["disposable", "RISKY"],
    ["unknown", null],
  ])("result %s -> %s", async (result, want) => {
    expect(await verifier(reply({ result })).verify("a@b.test", sig())).toBe(want);
  });

  test("sends a GET to the fixed host with the key, the encoded email and an 8 s timeout", async () => {
    const f = reply({ result: "ok" });
    expect(await verifier(f).verify("a+b@x.test", sig())).toBe("VERIFIED");
    const [url, o] = f.mock.calls[0]!;
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(MILLIONVERIFIER_URL);
    expect(u.searchParams.get("api")).toBe("mv-secret");
    expect(u.searchParams.get("email")).toBe("a+b@x.test");
    expect(u.searchParams.get("timeout")).toBe("8");
    expect(o).toMatchObject({
      method: "GET",
      allowPrivate: false,
      resolve: pub,
      timeoutMs: 10_000,
      maxResponseBytes: 64 * 1024,
    });
  });

  test("every failure is a coded reason, never the URL, key or body", async () => {
    for (const st of [301, 400, 500, 503]) expect(await code(reply({}, st))).toBe(`http_${st}`);
    expect(await code(reply({ result: "error", error: "Apikey not found" }))).toBe(
      "bad_status_path",
    );
    expect(await code(reply({}))).toBe("bad_status_path");
    expect(await code(vi.fn(async () => res("not json")))).toBe("bad_response");
    expect(
      await code(
        vi.fn<Req>(async () => {
          throw new HttpOutError("response_too_large", 200);
        }),
      ),
    ).toBe("bad_response");
    expect(
      await code(
        vi.fn<Req>(async () => {
          throw new HttpOutError("timeout");
        }),
      ),
    ).toBe("timeout");
  });

  test("through runVerify the workspace records the code, never the key or body", async () => {
    const ws = await mkWs();
    const l = await mkLead(ws, "mv@r.test");
    await queueVerify(db.prisma, clock, ws, "u", [l.id]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runVerify(db.prisma, clock, {
      verifierFor: async () =>
        millionVerifier(
          { apiKey: "mv-secret" },
          vi.fn<Req>(async () =>
            res(JSON.stringify({ result: "error", error: "body-with-mv-secret" })),
          ),
          pub,
        ),
    });
    const s = await getVerifierSettings(db.prisma, ws);
    expect(s.lastError).toMatchObject({ reason: "bad_status_path" });
    const all = JSON.stringify(s) + err.mock.calls.flat().join(" ");
    expect(all).not.toContain("mv-secret");
    expect(all).not.toContain("body-with");
    err.mockRestore();
  });
});

describe("queueVerify / runVerify", () => {
  test("queueVerify sets PENDING_JOB, remembers the status, skips pending and foreign leads", async () => {
    const ws = await mkWs();
    const other = await mkWs();
    const a = await mkLead(ws, "a@q.test", { verificationStatus: "RISKY" });
    const b = await mkLead(ws, "b@q.test");
    const c = await mkLead(other, "c@q.test");
    expect(await queueVerify(db.prisma, clock, ws, "u", [a.id, c.id])).toEqual({ queued: 1 });
    expect(await status(a.id)).toEqual({
      verificationStatus: "PENDING_JOB",
      verifyPrevStatus: "RISKY",
    });
    expect(await queueVerify(db.prisma, clock, ws, "u", [a.id, b.id])).toEqual({ queued: 1 });
    expect((await status(a.id)).verifyPrevStatus).toBe("RISKY");
    expect((await status(c.id)).verificationStatus).toBe("NOT_VERIFIED");
    expect(
      await db.prisma.auditLog.count({ where: { workspaceId: ws, action: "lead.verify" } }),
    ).toBe(2);
  });

  test("runVerify writes results; null restores the previous status; a throw keeps the lead queued", async () => {
    const ws = await mkWs();
    const L = {
      risky: await mkLead(ws, "risky@r.test", { verificationStatus: "RISKY" }),
      invalid: await mkLead(ws, "invalid@r.test", { verificationStatus: "INVALID" }),
      bad: await mkLead(ws, "bad@r.test"),
      good: await mkLead(ws, "good@r.test"),
    };
    await queueVerify(
      db.prisma,
      clock,
      ws,
      "u",
      Object.values(L).map((l) => l.id),
    );
    const res = await runVerify(db.prisma, clock, {
      verifierFor: async () =>
        stub({
          "risky@r.test": "null",
          "invalid@r.test": "throw",
          "bad@r.test": "INVALID",
          "good@r.test": "VERIFIED",
        }),
    });
    expect(res).toEqual({ done: 4, changed: 2, restored: 1 });
    expect((await status(L.risky.id)).verificationStatus).toBe("RISKY");
    expect((await status(L.invalid.id)).verificationStatus).toBe("PENDING_JOB"); // retried later, never mailed meanwhile
    expect(await status(L.bad.id)).toEqual({
      verificationStatus: "INVALID",
      verifyPrevStatus: null,
    });
    expect((await status(L.good.id)).verificationStatus).toBe("VERIFIED");
  });

  test("a lead edited meanwhile keeps its edit; at most 50 per workspace per run", async () => {
    const ws = await mkWs();
    const ids: string[] = [];
    for (let i = 0; i < 52; i++) ids.push((await mkLead(ws, `m${i}@m.test`)).id);
    await queueVerify(db.prisma, clock, ws, "u", ids);
    let edited = "";
    const edit: EmailVerifier = {
      kind: "mx",
      verify: async (email) => {
        // the user marks the first lead they get VERIFIED while the job is verifying it
        if (!edited) {
          edited = email;
          await db.prisma.lead.updateMany({
            where: { email },
            data: { verificationStatus: "VERIFIED" },
          });
        }
        return "INVALID";
      },
    };
    const res = await runVerify(db.prisma, clock, { verifierFor: async () => edit });
    expect(res.done).toBe(50);
    const kept = await db.prisma.lead.findFirstOrThrow({ where: { email: edited } });
    expect(kept.verificationStatus).toBe("VERIFIED");
    expect(
      await db.prisma.lead.count({ where: { workspaceId: ws, verificationStatus: "PENDING_JOB" } }),
    ).toBe(2);
  });

  test("a row claimed by a run and stalled for 31 minutes is restored without verifying", async () => {
    const ws = await mkWs();
    const l = await mkLead(ws, "stuck@s.test", { verificationStatus: "RISKY" });
    await queueVerify(db.prisma, clock, ws, "u", [l.id]);
    await db.prisma.lead.update({
      where: { id: l.id },
      data: { verifyClaimedAt: new Date(T.getTime() - 5 * 60_000) },
    });
    const later = fixedClock(new Date(T.getTime() + 26 * 60_000 + 1000));
    const verify = vi.fn(async () => "INVALID" as const);
    const res = await runVerify(db.prisma, later, {
      verifierFor: async () => ({ kind: "mx", verify }),
    });
    expect(await status(l.id)).toEqual({ verificationStatus: "RISKY", verifyPrevStatus: null });
    expect(verify).not.toHaveBeenCalled();
    expect(res.restored).toBe(1);
  });

  test("a backlog bigger than one batch stays PENDING_JOB past 30 minutes; none reverts unverified", async () => {
    const ws = await mkWs();
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) ids.push((await mkLead(ws, `b${i}@b.test`)).id);
    await queueVerify(db.prisma, clock, ws, "u", ids);
    const ok: EmailVerifier = { kind: "mx", verify: async () => "VERIFIED" };
    const verifierFor = async () => ok;
    await runVerify(db.prisma, clock, { verifierFor });
    const later = fixedClock(new Date(T.getTime() + 31 * 60_000));
    const res = await runVerify(db.prisma, later, { verifierFor });
    expect(res).toMatchObject({ done: 50, restored: 0 });
    const by = await db.prisma.lead.groupBy({
      by: ["verificationStatus"],
      where: { workspaceId: ws },
      _count: true,
    });
    expect(Object.fromEntries(by.map((r) => [r.verificationStatus, r._count]))).toEqual({
      VERIFIED: 100,
      PENDING_JOB: 20,
    });
  });

  test("a failing verifier keeps leads PENDING_JOB with backoff, records a safe reason, and reverts after 3 attempts", async () => {
    const ws = await mkWs();
    await setVerifierSettings(db.prisma, clock, ws, "u", {
      kind: "http",
      url: "https://v.example.com/x",
      apiKey: "k",
      statusPath: "a",
    });
    const l = await mkLead(ws, "fail@f.test", { verificationStatus: "RISKY" });
    await queueVerify(db.prisma, clock, ws, "u", [l.id]);
    const boom: EmailVerifier = {
      kind: "http",
      verify: async () => {
        throw Object.assign(new Error("body-with-secret-key"), { code: "ECONNRESET" });
      },
    };
    const run = (c: ReturnType<typeof fixedClock>) =>
      runVerify(db.prisma, c, { verifierFor: async () => boom });
    const at = (min: number) => fixedClock(new Date(T.getTime() + min * 60_000));
    const attempts = async () =>
      (await db.prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).verifyAttempts;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await run(at(0));
    expect(await status(l.id)).toMatchObject({ verificationStatus: "PENDING_JOB" });
    expect(await attempts()).toBe(1);
    await run(at(1)); // backoff: not picked yet
    expect(await attempts()).toBe(1);
    await run(at(2));
    expect(await attempts()).toBe(2);
    expect(await status(l.id)).toMatchObject({ verificationStatus: "PENDING_JOB" });
    await run(at(6));
    expect(await status(l.id)).toEqual({ verificationStatus: "RISKY", verifyPrevStatus: null });
    const s = await getVerifierSettings(db.prisma, ws);
    expect(s.lastError).toMatchObject({ reason: "ECONNRESET" });
    expect(JSON.stringify(s)).not.toContain("secret");
    expect(err.mock.calls.flat().join(" ")).not.toContain("secret");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    // a later success clears the recorded failure
    const l2 = await mkLead(ws, "fine@f.test");
    await queueVerify(db.prisma, at(7), ws, "u", [l2.id]);
    await runVerify(db.prisma, at(7), {
      verifierFor: async () => stub({ "fine@f.test": "VERIFIED" }),
    });
    expect((await getVerifierSettings(db.prisma, ws)).lastError).toBeUndefined();
  });

  test("a 500 and a bad statusPath record a lastError and keep the lead queued", async () => {
    const ws = await mkWs();
    const cfg = { url: "https://v.example.com/x", apiKey: "k", statusPath: "a" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [r, want] of [
      [res("{}", 500), "http_500"],
      [res(JSON.stringify({ z: 1 })), "bad_status_path"],
    ] as const) {
      const l = await mkLead(ws, `${want}@h.test`);
      await queueVerify(db.prisma, clock, ws, "u", [l.id]);
      await runVerify(db.prisma, clock, {
        verifierFor: async () =>
          httpVerifier(
            cfg,
            async () => r,
            async () => ["93.184.216.34"],
          ),
      });
      expect((await status(l.id)).verificationStatus).toBe("PENDING_JOB");
      expect((await getVerifierSettings(db.prisma, ws)).lastError).toMatchObject({ reason: want });
    }
    err.mockRestore();
  });

  test("a worker shutdown abort is not a verifier failure: attempts unchanged, claim released", async () => {
    const ws = await mkWs();
    const l = await mkLead(ws, "abort@a.test", { verificationStatus: "RISKY" });
    await queueVerify(db.prisma, clock, ws, "u", [l.id]);
    const ac = new AbortController();
    const v: EmailVerifier = {
      kind: "http",
      verify: async () => {
        ac.abort();
        throw new Error("aborted");
      },
    };
    await runVerify(db.prisma, clock, { verifierFor: async () => v, signal: ac.signal });
    const row = await db.prisma.lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(row).toMatchObject({
      verificationStatus: "PENDING_JOB",
      verifyAttempts: 0,
      verifyClaimedAt: null,
    });
    expect((await getVerifierSettings(db.prisma, ws)).lastError).toBeUndefined();
  });

  test("a verifierFor failure keeps the batch queued for a retry", async () => {
    const ws = await mkWs();
    const l = await mkLead(ws, "cfg@s.test", { verificationStatus: "VERIFIED" });
    await queueVerify(db.prisma, clock, ws, "u", [l.id]);
    await runVerify(db.prisma, clock, {
      verifierFor: async () => {
        throw new Error("bad config");
      },
    });
    expect((await status(l.id)).verificationStatus).toBe("PENDING_JOB");
    expect((await getVerifierSettings(db.prisma, l.workspaceId)).lastError).toMatchObject({
      reason: "Error",
    });
  });
});

describe("settings", () => {
  test("setVerifierSettings encrypts the config; workspaceVerifier builds from it", async () => {
    const ws = await mkWs();
    expect((await workspaceVerifier(db.prisma, ws, mx({}))).kind).toBe("mx");
    await setVerifierSettings(db.prisma, clock, ws, "u", {
      kind: "http",
      url: "https://v.example.com/x",
      apiKey: "secret-key",
      statusPath: "a.b",
    });
    const w = await db.prisma.workspace.findUniqueOrThrow({ where: { id: ws } });
    expect(w.verifierKind).toBe("http");
    expect(w.verifierConfigEnc).not.toContain("secret-key");
    expect(JSON.parse(decrypt(w.verifierConfigEnc!))).toEqual({
      url: "https://v.example.com/x",
      apiKey: "secret-key",
      statusPath: "a.b",
    });
    expect((await workspaceVerifier(db.prisma, ws, mx({}))).kind).toBe("http");
    // apiKey omitted on a later save keeps the stored key
    await setVerifierSettings(db.prisma, clock, ws, "u", {
      kind: "http",
      url: "https://v.example.com/y",
      statusPath: "a.b",
    });
    const w2 = await db.prisma.workspace.findUniqueOrThrow({ where: { id: ws } });
    expect(JSON.parse(decrypt(w2.verifierConfigEnc!)).apiKey).toBe("secret-key");
    // a new host needs a new key: the stored one is never reused against it
    await expect(
      setVerifierSettings(db.prisma, clock, ws, "u", {
        kind: "http",
        url: "https://other.example.com/y",
        statusPath: "a.b",
      }),
    ).rejects.toThrow("api_key_required");
    for (const bad of [
      { kind: "http", url: "http://v.example.com", apiKey: "k", statusPath: "a" },
      { kind: "http", url: "https://v.example.com", apiKey: "k", statusPath: "a b" },
      { kind: "http", url: "https://v.example.com", statusPath: "a", extra: 1 },
    ])
      await expect(setVerifierSettings(db.prisma, clock, ws, "u", bad)).rejects.toThrow();
  });

  test("millionverifier stores the fixed URL, keeps its key and is built by workspaceVerifier", async () => {
    const ws = await mkWs();
    await setVerifierSettings(db.prisma, clock, ws, "u", {
      kind: "millionverifier",
      apiKey: "mv-key",
    });
    const w = await db.prisma.workspace.findUniqueOrThrow({ where: { id: ws } });
    expect(w.verifierKind).toBe("millionverifier");
    expect(JSON.parse(decrypt(w.verifierConfigEnc!))).toEqual({
      url: MILLIONVERIFIER_URL,
      apiKey: "mv-key",
      statusPath: "result",
    });
    const s = await getVerifierSettings(db.prisma, ws);
    expect(s).toEqual({
      kind: "millionverifier",
      url: MILLIONVERIFIER_URL,
      statusPath: "result",
      hasApiKey: true,
    });
    expect(JSON.stringify(s)).not.toContain("mv-key");
    // the stored key is kept while the host stays the same
    await setVerifierSettings(db.prisma, clock, ws, "u", { kind: "millionverifier" });
    expect((await workspaceVerifier(db.prisma, ws, mx({}))).kind).toBe("millionverifier");
    // an http config's key is never reused for MillionVerifier
    const ws2 = await mkWs();
    await setVerifierSettings(db.prisma, clock, ws2, "u", {
      kind: "http",
      url: "https://v.example.com/x",
      apiKey: "k",
      statusPath: "a",
    });
    await expect(
      setVerifierSettings(db.prisma, clock, ws2, "u", { kind: "millionverifier" }),
    ).rejects.toThrow("api_key_required");
  });
});

describe("pipeline: import, planner and claim", () => {
  const FILE = Buffer.from("email\r\nv1@v.test\r\nv2@v.test\r\nv3@v.test\r\n");
  const base = {
    fileName: "l.csv",
    data: FILE,
    mapping: ["email"],
    confirmedAuthorized: true,
    lawfulBasis: "legitimate_interest" as const,
  };

  test("verifyOnImport queues exactly the imported leads; an ACTIVE campaign plans nothing until verification ends", async () => {
    const s = await seedCampaign(db.prisma, { at: T, leads: 0, accounts: [{ dailyLimit: 100 }] });
    const { importJobId } = await createImport(db.prisma, s.ws, null, {
      ...base,
      options: { campaignId: s.campaign.id, verifyOnImport: true },
    });
    await runImport(db.prisma, clock, { resolveMx: mx({ "v.test": "mx" }) }, importJobId);
    const leads = await db.prisma.lead.findMany({ where: { workspaceId: s.ws } });
    expect(leads.map((l) => l.verificationStatus)).toEqual([
      "PENDING_JOB",
      "PENDING_JOB",
      "PENDING_JOB",
    ]);
    const plan = () =>
      planDue(db.prisma, clock, { stalenessSec: 300, sendableProviders: ["SMTP"], env: ENV });
    await plan();
    expect(await db.prisma.scheduledMessage.count({ where: { campaignId: s.campaign.id } })).toBe(
      0,
    );
    expect(
      await db.prisma.campaignLead.count({
        where: { campaignId: s.campaign.id, state: "STOPPED" },
      }),
    ).toBe(0);

    await runVerify(db.prisma, clock, {
      verifierFor: async () =>
        stub({ "v1@v.test": "INVALID", "v2@v.test": "VERIFIED", "v3@v.test": "null" }),
    });
    await plan();
    expect(await db.prisma.scheduledMessage.count({ where: { campaignId: s.campaign.id } })).toBe(
      2,
    );
    const inv = await db.prisma.campaignLead.findFirstOrThrow({
      where: { campaignId: s.campaign.id, lead: { email: "v1@v.test" } },
    });
    expect(inv).toMatchObject({ state: "STOPPED", stopReason: "SKIPPED" });
  });

  test("without the flag nothing is queued", async () => {
    const ws = await mkWs();
    const { importJobId } = await createImport(db.prisma, ws, null, { ...base, options: {} });
    await runImport(db.prisma, clock, { resolveMx: mx({ "v.test": "mx" }) }, importJobId);
    expect(
      await db.prisma.lead.count({ where: { workspaceId: ws, verificationStatus: "PENDING_JOB" } }),
    ).toBe(0);
  });

  test("the claim skips a PENDING_JOB lead without cancelling or stopping it", async () => {
    const s = await seedCampaign(db.prisma, { at: T, rows: 1 });
    await queueVerify(db.prisma, clock, s.ws, "u", [s.leads[0]!.lead.id]);
    const mine = async (c: typeof clock) =>
      (await claimDue(db.prisma, c, claimOpts)).filter((x) => x.workspaceId === s.ws);
    expect(await mine(clock)).toEqual([]);
    const r = await db.prisma.scheduledMessage.findUniqueOrThrow({ where: { id: s.rows[0]!.id } });
    expect(r.status).toBe("SCHEDULED");
    expect(r.dueAt.getTime()).toBeGreaterThan(T.getTime());
    expect(
      (await db.prisma.campaignLead.findUniqueOrThrow({ where: { id: s.leads[0]!.cl.id } })).state,
    ).toBe("ACTIVE");
    // verification ends: the row is claimable again
    await db.prisma.lead.update({
      where: { id: s.leads[0]!.lead.id },
      data: { verificationStatus: "VERIFIED" },
    });
    const later = fixedClock(new Date(T.getTime() + 10 * 60_000));
    await db.prisma.emailAccount.updateMany({
      where: { workspaceId: s.ws },
      data: { lastSyncCompletedAt: later.now() },
    });
    expect(await mine(later)).toHaveLength(1);
  });
});

describe("schema (audit A-3)", () => {
  test("the verify job's scans use a partial index on queued leads", async () => {
    const rows = await db.prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'Lead_verify_pending_idx'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(
      /\("workspaceId", "updatedAt"\) WHERE \("verificationStatus" = 'PENDING_JOB'::"VerificationStatus"\)/,
    );
  });
});
