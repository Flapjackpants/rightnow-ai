import dns from "node:dns";
import type { PrismaClient, VerificationStatus } from "@rightnow/db/client";
import { HttpOutError, mapLimit, safeRequest } from "@rightnow/providers";
import { z } from "zod";
import { AccountError } from "../accounts/service";
import { audit } from "../audit";
import type { Clock } from "../clock";
import { decrypt, encrypt } from "../crypto";
import { getEnv, outEnv } from "../env";
import { DISPOSABLE_DOMAINS } from "./disposable";
import type { ResolveMx } from "./esp";
import { parseEmail } from "./validate";
import { domainOf } from "./domain";

type Db = PrismaClient;
type Actor = string | null | undefined;

const BATCH = 50; // per workspace per run
const PARALLEL = 5;
const TIMEOUT_MS = 10_000;
const STUCK_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MIN = 2; // minutes per failed attempt
const MAX_BODY = 64 * 1024;

/** `null` = leave the lead's status unchanged. Cost of an external verifier is the user's (D38). */
export interface EmailVerifier {
  readonly kind: "mx" | "http" | "millionverifier";
  verify(email: string, signal: AbortSignal): Promise<VerificationStatus | null>;
}

const gone = new Set(["ENOTFOUND", "ENODATA"]);

/** Rejects when `signal` aborts, so a hung lookup cannot hold a worker slot. */
const abortable = <T>(p: Promise<T>, signal: AbortSignal) =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => {
      const stop = () => rej(new Error("verification timed out"));
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    }),
  ]);

/** Syntax, disposable list and MX only. An MX record proves nothing about the mailbox, so it never answers VERIFIED. */
export function mxVerifier(resolveMx: ResolveMx): EmailVerifier {
  return {
    kind: "mx",
    async verify(email, signal) {
      const e = parseEmail(email);
      if (!e) return "INVALID";
      const domain = domainOf(e);
      if (DISPOSABLE_DOMAINS.has(domain)) return "RISKY";
      try {
        const mx = await abortable(resolveMx(domain), signal);
        return mx.length ? null : "INVALID";
      } catch (err) {
        return gone.has((err as { code?: string }).code ?? "") ? "INVALID" : null;
      }
    },
  };
}

const MAPPED: Record<string, VerificationStatus> = {
  valid: "VERIFIED",
  invalid: "INVALID",
  risky: "RISKY",
  catch_all: "CATCH_ALL",
  unknown: "NOT_VERIFIED",
};

/** An error whose `code` is the short reason shown to the user (never a body or key). */
const coded = (code: string) => Object.assign(new Error(code), { code });

/**
 * POSTs `{ email }` to the user's https URL through safeRequest (pinned IP, no redirects, capped body). Private hosts
 * are refused whatever MODE unless ALLOW_PRIVATE_HTTP_HOSTS (M9, D44); cloud metadata always.
 */
export function httpVerifier(
  cfg: { url: string; apiKey: string; statusPath: string },
  request: typeof safeRequest = safeRequest,
  resolve?: (host: string) => Promise<string[]>,
  allowPrivate = false,
): EmailVerifier {
  return {
    kind: "http",
    async verify(email, signal) {
      const u = new URL(cfg.url);
      if (u.protocol !== "https:") throw new Error("verifier url must be https");
      let res;
      try {
        res = await request(cfg.url, {
          method: "POST",
          signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({ email }),
          timeoutMs: TIMEOUT_MS,
          maxResponseBytes: MAX_BODY,
          allowPrivate,
          resolve,
        });
      } catch (e) {
        if (e instanceof HttpOutError)
          throw coded(e.code === "response_too_large" ? "bad_response" : e.code);
        throw e;
      }
      // any error status (a redirect too: never followed) or malformed answer is a visible failure (retry, backoff,
      // lastError), never a quiet "no answer"
      if (res.status >= 300) throw coded(`http_${res.status}`);
      let v: unknown;
      try {
        v = JSON.parse(res.body.toString("utf8"));
      } catch {
        throw coded("bad_response");
      }
      for (const k of cfg.statusPath.split(".")) v = (v as Record<string, unknown> | null)?.[k];
      const status = typeof v === "string" ? MAPPED[v.toLowerCase()] : undefined;
      if (!status) throw coded("bad_status_path");
      return status;
    },
  };
}

export const MILLIONVERIFIER_URL = "https://api.millionverifier.com/api/v3/";

/** MillionVerifier's `result` values; `unknown` is a valid answer that leaves the lead's status unchanged. */
const MV_RESULT: Record<string, VerificationStatus | null> = {
  ok: "VERIFIED",
  catch_all: "CATCH_ALL",
  invalid: "INVALID",
  disposable: "RISKY",
  unknown: null,
};

/** GETs MillionVerifier's v3 API through safeRequest; the top-level `result` field is the whole answer. */
export function millionVerifier(
  cfg: { apiKey: string },
  request: typeof safeRequest = safeRequest,
  resolve?: (host: string) => Promise<string[]>,
  allowPrivate = false,
): EmailVerifier {
  return {
    kind: "millionverifier",
    async verify(email, signal) {
      const q = new URLSearchParams({ api: cfg.apiKey, email, timeout: "8" });
      let res;
      try {
        res = await request(`${MILLIONVERIFIER_URL}?${q}`, {
          method: "GET",
          signal,
          timeoutMs: TIMEOUT_MS,
          maxResponseBytes: MAX_BODY,
          allowPrivate,
          resolve,
        });
      } catch (e) {
        if (e instanceof HttpOutError)
          throw coded(e.code === "response_too_large" ? "bad_response" : e.code);
        throw e;
      }
      if (res.status >= 300) throw coded(`http_${res.status}`);
      let v: unknown;
      try {
        v = JSON.parse(res.body.toString("utf8"));
      } catch {
        throw coded("bad_response");
      }
      const result = (v as { result?: unknown } | null)?.result;
      if (typeof result !== "string") throw coded("bad_status_path");
      const key = result.toLowerCase();
      if (!Object.hasOwn(MV_RESULT, key)) throw coded("bad_status_path");
      return MV_RESULT[key]!;
    },
  };
}

/** Marks the leads PENDING_JOB (the planner and claim wait for them) and remembers what to restore. Skips pending ones. */
export async function queueVerify(
  prisma: Db,
  clock: Clock,
  ws: string,
  actorId: Actor,
  leadIds: string[],
): Promise<{ queued: number }> {
  const now = clock.now();
  const queued =
    await prisma.$executeRaw`UPDATE "Lead" SET "verifyPrevStatus" = "verificationStatus", "verificationStatus" = 'PENDING_JOB', "verifyClaimedAt" = NULL, "verifyAttempts" = 0, "updatedAt" = ${now} WHERE "workspaceId" = ${ws} AND "deletedAt" IS NULL AND "verificationStatus" <> 'PENDING_JOB' AND "id" = ANY(${leadIds})`;
  await audit(prisma, { workspaceId: ws, actorId, at: now }, "lead.verify", undefined, { queued });
  return { queued };
}

const reasonOf = (e: unknown) =>
  String((e as { code?: unknown } | null)?.code ?? (e as Error | null)?.name ?? "error").slice(
    0,
    60,
  );

/**
 * One cron run: restores rows a run claimed and then stalled on for > 30 min, then verifies up to 50 queued leads per
 * workspace. A queued lead nobody picked up yet waits however long the backlog is. The claim transaction only locks,
 * reads and stamps `verifyClaimedAt`; verifier calls happen outside it and each write is conditional on PENDING_JOB.
 * A verifier error keeps the lead queued and retries it with a growing delay; the third failure restores its status.
 */
export async function runVerify(
  prisma: PrismaClient,
  clock: Clock,
  deps: { verifierFor: (ws: string) => Promise<EmailVerifier>; signal?: AbortSignal },
): Promise<{ done: number; changed: number; restored: number }> {
  const out = { done: 0, changed: 0, restored: 0 };
  const now = clock.now();
  out.restored +=
    await prisma.$executeRaw`UPDATE "Lead" SET "verificationStatus" = COALESCE("verifyPrevStatus", 'NOT_VERIFIED'), "verifyPrevStatus" = NULL, "verifyClaimedAt" = NULL, "verifyAttempts" = 0, "updatedAt" = ${now} WHERE "verificationStatus" = 'PENDING_JOB' AND "verifyClaimedAt" < ${new Date(now.getTime() - STUCK_MS)}`;
  const wss = await prisma.$queryRaw<
    { workspaceId: string }[]
  >`SELECT DISTINCT "workspaceId" FROM "Lead" WHERE "verificationStatus" = 'PENDING_JOB' AND "verifyClaimedAt" IS NULL`;
  for (const { workspaceId: ws } of wss) {
    if (deps.signal?.aborted) break;
    const batch = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; email: string; prev: VerificationStatus | null; attempts: number }[]
      >`SELECT "id", "email", "verifyPrevStatus" AS prev, "verifyAttempts" AS attempts FROM "Lead" WHERE "workspaceId" = ${ws} AND "verificationStatus" = 'PENDING_JOB' AND "verifyClaimedAt" IS NULL AND ("verifyAttempts" = 0 OR "updatedAt" + make_interval(mins => "verifyAttempts" * ${BACKOFF_MIN}) <= ${now}) ORDER BY "updatedAt" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED`;
      await tx.lead.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { verifyClaimedAt: now },
      });
      return rows;
    });
    if (!batch.length) continue;
    let verifier: EmailVerifier | null = null;
    let failure: string | null = null;
    try {
      verifier = await deps.verifierFor(ws);
    } catch (e) {
      failure = reasonOf(e); // a broken config counts as a failure for every lead below
    }
    let answered = 0;
    await mapLimit(batch, PARALLEL, async (l) => {
      let result: VerificationStatus | null = null;
      let threw = !verifier;
      if (verifier)
        try {
          const t = AbortSignal.timeout(TIMEOUT_MS);
          result = await verifier.verify(
            l.email,
            deps.signal ? AbortSignal.any([t, deps.signal]) : t,
          );
          answered++;
        } catch (e) {
          if (deps.signal?.aborted) {
            // worker shutdown, not the verifier's fault: release the claim, count nothing
            await prisma.lead.updateMany({
              where: { id: l.id, workspaceId: ws, verificationStatus: "PENDING_JOB" },
              data: { verifyClaimedAt: null },
            });
            return;
          }
          threw = true;
          failure ??= reasonOf(e);
        }
      out.done++;
      const guard = { id: l.id, workspaceId: ws, verificationStatus: "PENDING_JOB" as const };
      if (threw && l.attempts + 1 < MAX_ATTEMPTS) {
        await prisma.lead.updateMany({
          where: guard,
          data: { verifyClaimedAt: null, verifyAttempts: l.attempts + 1, updatedAt: now },
        });
        return;
      }
      const w = await prisma.lead.updateMany({
        where: guard, // edited meanwhile: the edit wins
        data: {
          verificationStatus: result ?? l.prev ?? "NOT_VERIFIED",
          verifyPrevStatus: null,
          verifyClaimedAt: null,
          verifyAttempts: 0,
        },
      });
      if (!w.count) return;
      if (result === null) out.restored++;
      else if (result !== l.prev) out.changed++;
    });
    if (failure) {
      console.error(`lead-verify: workspace ${ws} verifier failed (${failure})`);
      await prisma.workspace.update({
        where: { id: ws },
        data: { verifierLastError: failure, verifierLastErrorAt: now },
      });
    } else if (answered)
      await prisma.workspace.updateMany({
        where: { id: ws, verifierLastError: { not: null } },
        data: { verifierLastError: null, verifierLastErrorAt: null },
      });
  }
  return out;
}

const statusPath = z.string().regex(/^[A-Za-z0-9_.]{1,64}$/);
export const verifierInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("mx") }),
  z.strictObject({
    kind: z.literal("http"),
    url: z
      .url()
      .max(500)
      .refine((u) => u.startsWith("https://"), "url must be https"),
    apiKey: z.string().min(1).max(500).optional(), // omitted = keep the stored key
    statusPath,
  }),
  z.strictObject({
    kind: z.literal("millionverifier"),
    apiKey: z.string().min(1).max(500).optional(), // omitted = keep the stored key
  }),
]);
type Config = { url: string; apiKey: string; statusPath: string };

const readConfig = (enc: string | null): Config | null =>
  enc ? (JSON.parse(decrypt(enc)) as Config) : null;

/** Never returns the apiKey. */
export async function getVerifierSettings(prisma: Db, ws: string) {
  const w = await prisma.workspace.findUniqueOrThrow({
    where: { id: ws },
    select: {
      verifierKind: true,
      verifierConfigEnc: true,
      verifierLastError: true,
      verifierLastErrorAt: true,
    },
  });
  const c = readConfig(w.verifierConfigEnc);
  return {
    kind: w.verifierKind,
    ...(c && { url: c.url, statusPath: c.statusPath, hasApiKey: true }),
    ...(w.verifierLastError && {
      lastError: { reason: w.verifierLastError, at: w.verifierLastErrorAt },
    }),
  };
}

export async function setVerifierSettings(
  prisma: Db,
  clock: Clock,
  ws: string,
  actorId: Actor,
  input: unknown,
) {
  const v = verifierInput.parse(input);
  const old = readConfig(
    (
      await prisma.workspace.findUniqueOrThrow({
        where: { id: ws },
        select: { verifierConfigEnc: true },
      })
    ).verifierConfigEnc,
  );
  // the stored key is never sent to a different host: a new host needs a new key
  if (
    v.kind !== "mx" &&
    !(
      v.apiKey ??
      (old &&
      new URL(old.url).origin === new URL(v.kind === "http" ? v.url : MILLIONVERIFIER_URL).origin
        ? old.apiKey
        : undefined)
    )
  )
    throw new AccountError(400, "api_key_required");
  await prisma.$transaction(async (tx) => {
    await tx.workspace.update({
      where: { id: ws },
      data:
        v.kind === "mx"
          ? { verifierKind: "mx" } // the stored config stays, so switching back needs no re-entry
          : {
              verifierKind: v.kind,
              verifierConfigEnc: encrypt(
                JSON.stringify({
                  url: v.kind === "http" ? v.url : MILLIONVERIFIER_URL,
                  apiKey: v.apiKey ?? old!.apiKey,
                  statusPath: v.kind === "http" ? v.statusPath : "result",
                }),
              ),
            },
    });
    await audit(tx, { workspaceId: ws, actorId, at: clock.now() }, "settings.verifier", ws, {
      kind: v.kind,
    });
  });
}

/** The workspace's configured verifier (`mx` unless an http config is set). */
export async function workspaceVerifier(
  prisma: Db,
  ws: string,
  resolveMx: ResolveMx = (d) => dns.promises.resolveMx(d),
): Promise<EmailVerifier> {
  const w = await prisma.workspace.findUniqueOrThrow({
    where: { id: ws },
    select: { verifierKind: true, verifierConfigEnc: true },
  });
  const c = readConfig(w.verifierConfigEnc);
  if (w.verifierKind === "millionverifier" && c)
    return millionVerifier(
      { apiKey: c.apiKey },
      safeRequest,
      undefined,
      outEnv(getEnv()).allowPrivate,
    );
  return w.verifierKind === "http" && c
    ? httpVerifier(c, safeRequest, undefined, outEnv(getEnv()).allowPrivate)
    : mxVerifier(resolveMx);
}
