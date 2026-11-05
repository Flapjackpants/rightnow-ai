import { randomBytes } from "node:crypto";
import { createTestDb } from "@rightnow/db/test-db";
import { afterAll, beforeAll, expect, test } from "vitest";
import { decrypt, ENCRYPTED_COLUMNS, encrypt } from "../src/crypto";
import { rotateColumns } from "../src/rotate";
import { seedAccount, testEnv } from "./accounts-fixture";

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  testEnv();
  db = await createTestDb();
});
afterAll(() => db.drop());

const A = randomBytes(32);
const B = randomBytes(32);

test("ENCRYPTED_COLUMNS lists the account columns", () => {
  expect(ENCRYPTED_COLUMNS).toEqual(
    expect.arrayContaining([
      { model: "EmailAccount", field: "credentialsEnc" },
      { model: "OAuthSession", field: "codeVerifierEnc" },
    ]),
  );
});

test("A to B re-encrypts, keeps nulls, is idempotent; a value under a third key aborts its column", async () => {
  const a1 = await seedAccount(db.prisma, encrypt("c1", A), "1@x.com");
  const a2 = await seedAccount(db.prisma, encrypt("c2", A), "2@x.com");
  const a3 = await seedAccount(db.prisma, null, "3@x.com");
  const s = await db.prisma.oAuthSession.create({
    data: {
      workspaceId: a1.workspaceId,
      createdByUserId: "u",
      provider: "GMAIL",
      stateHash: "h",
      codeVerifierEnc: encrypt("v", A),
      expiresAt: new Date(),
    },
  });

  expect(await rotateColumns(db.prisma, ENCRYPTED_COLUMNS, A, B)).toEqual({
    "EmailAccount.credentialsEnc": 2,
    "OAuthSession.codeVerifierEnc": 1,
    "Workspace.verifierConfigEnc": 0,
    "Webhook.secretEnc": 0,
    "Webhook.headersEnc": 0,
    "Webhook.urlEnc": 0,
    "Workspace.aiConfigEnc": 0,
    "Workspace.apolloConfigEnc": 0,
  });
  const acc = async (id: string) =>
    (await db.prisma.emailAccount.findUniqueOrThrow({ where: { id } })).credentialsEnc;
  expect(decrypt((await acc(a1.id))!, B)).toBe("c1");
  expect(decrypt((await acc(a2.id))!, B)).toBe("c2");
  expect(await acc(a3.id)).toBeNull();
  const sv = await db.prisma.oAuthSession.findUniqueOrThrow({ where: { id: s.id } });
  expect(decrypt(sv.codeVerifierEnc, B)).toBe("v");

  expect(await rotateColumns(db.prisma, ENCRYPTED_COLUMNS, A, B)).toEqual({
    "EmailAccount.credentialsEnc": 0,
    "OAuthSession.codeVerifierEnc": 0,
    "Workspace.verifierConfigEnc": 0,
    "Webhook.secretEnc": 0,
    "Webhook.headersEnc": 0,
    "Webhook.urlEnc": 0,
    "Workspace.aiConfigEnc": 0,
    "Workspace.apolloConfigEnc": 0,
  });

  // two rows back on A plus one under a third key: the column is left exactly as it was
  const before = [encrypt("c1", A), encrypt("c2", A)];
  await db.prisma.emailAccount.update({
    where: { id: a1.id },
    data: { credentialsEnc: before[0] },
  });
  await db.prisma.emailAccount.update({
    where: { id: a2.id },
    data: { credentialsEnc: before[1] },
  });
  const bad = await seedAccount(db.prisma, encrypt("c4", randomBytes(32)), "4@x.com");
  const err = await rotateColumns(db.prisma, ENCRYPTED_COLUMNS, A, B).then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err?.message).toContain("EmailAccount.credentialsEnc");
  expect(err?.message).toContain(bad.id);
  expect([await acc(a1.id), await acc(a2.id)]).toEqual(before);
});

test("Workspace.verifierConfigEnc is rotated", async () => {
  const w = await db.prisma.workspace.create({
    data: { name: "V", slug: "w-rot-ver", verifierConfigEnc: encrypt("{}", A) },
  });
  expect(ENCRYPTED_COLUMNS).toContainEqual({ model: "Workspace", field: "verifierConfigEnc" });
  await rotateColumns(db.prisma, [{ model: "Workspace", field: "verifierConfigEnc" }], A, B);
  const got = await db.prisma.workspace.findUniqueOrThrow({ where: { id: w.id } });
  expect(decrypt(got.verifierConfigEnc!, B)).toBe("{}");
});

test("Workspace.aiConfigEnc is rotated", async () => {
  const w = await db.prisma.workspace.create({
    data: { name: "AI", slug: "w-rot-ai", aiConfigEnc: encrypt("{}", A) },
  });
  expect(ENCRYPTED_COLUMNS).toContainEqual({ model: "Workspace", field: "aiConfigEnc" });
  await rotateColumns(db.prisma, [{ model: "Workspace", field: "aiConfigEnc" }], A, B);
  const got = await db.prisma.workspace.findUniqueOrThrow({ where: { id: w.id } });
  expect(decrypt(got.aiConfigEnc!, B)).toBe("{}");
});

test("Webhook.secretEnc and headersEnc are rotated", async () => {
  const w = await db.prisma.workspace.create({ data: { name: "H", slug: "w-rot-hook" } });
  const h = await db.prisma.webhook.create({
    data: {
      workspaceId: w.id,
      url: "https://h.test",
      events: ["email_sent"],
      secretEnc: encrypt("s", A),
      headersEnc: encrypt("{}", A),
      urlEnc: encrypt("https://hooks.slack.com/services/token", A),
    },
  });
  const cols = ENCRYPTED_COLUMNS.filter((c) => c.model === "Webhook");
  expect(cols.map((c) => c.field)).toEqual(["secretEnc", "headersEnc", "urlEnc"]);
  await rotateColumns(db.prisma, cols, A, B);
  const got = await db.prisma.webhook.findUniqueOrThrow({ where: { id: h.id } });
  expect([decrypt(got.secretEnc, B), decrypt(got.headersEnc!, B), decrypt(got.urlEnc!, B)]).toEqual(
    ["s", "{}", "https://hooks.slack.com/services/token"],
  );
});
