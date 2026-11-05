import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestDb, expectIsolated } from "@rightnow/db/test-db";
import { getFakeProvider } from "@rightnow/providers";
import { createFirstOwner } from "../lib/setup";

const TOKEN = "t".repeat(20);
const PASSWORD = "correct horse battery";
const ORIGIN = "http://localhost:3100";
let db: Awaited<ReturnType<typeof createTestDb>>;
let workspaceId: string;
let cookie: string;
let r: Record<string, Record<string, (req: Request, rc?: unknown) => Promise<Response>>>;

const req = (
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = { cookie },
) =>
  new Request(`${ORIGIN}/api/v1/inbox/${url}`, {
    method,
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const p = (id: string) => ({ params: Promise.resolve({ id }) });
const setRole = (role: string) =>
  db.prisma.member.updateMany({ where: { workspaceId }, data: { role } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper: bodies are asserted field by field
const json = async (res: Response) => (await res.json()) as Record<string, any>;

beforeAll(async () => {
  db = await createTestDb();
  Object.assign(process.env, {
    MODE: "local",
    MAIL_PROVIDER_FAKE: "1",
    FAKE_MAIL_DIR: mkdtempSync(join(tmpdir(), "rn-web-inbox-")),
    DATABASE_URL: db.url,
    APP_URL: ORIGIN,
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    BETTER_AUTH_SECRET: "x".repeat(40),
    SETUP_TOKEN: TOKEN,
  });
  const { auth } = await import("../lib/auth");
  r = {
    threads: await import("../app/api/v1/inbox/threads/route"),
    thread: await import("../app/api/v1/inbox/threads/[id]/route"),
    readAll: await import("../app/api/v1/inbox/threads/[id]/read-all/route"),
    attach: await import("../app/api/v1/inbox/threads/[id]/attach-lead/route"),
    createLead: await import("../app/api/v1/inbox/threads/[id]/create-lead/route"),
    reply: await import("../app/api/v1/inbox/threads/[id]/reply/route"),
    bulk: await import("../app/api/v1/inbox/threads/bulk/route"),
    unread: await import("../app/api/v1/inbox/unread-count/route"),
    attachment: await import("../app/api/v1/inbox/attachments/[id]/route"),
    notes: await import("../app/api/v1/inbox/notes/route"),
    note: await import("../app/api/v1/inbox/notes/[id]/route"),
    macros: await import("../app/api/v1/inbox/macros/route"),
    macro: await import("../app/api/v1/inbox/macros/[id]/route"),
    render: await import("../app/api/v1/inbox/macros/[id]/render/route"),
    views: await import("../app/api/v1/inbox/views/route"),
    view: await import("../app/api/v1/inbox/views/[id]/route"),
  } as unknown as typeof r;
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
});
afterAll(async () => {
  await db.drop();
});

const T = new Date("2026-10-20T10:00:00Z");

/** An account, a lead, and a thread with one inbound message that has an attachment. */
async function seed(ws: string) {
  const P = db.prisma;
  const tag = randomBytes(4).toString("hex");
  const a = await P.emailAccount.create({
    data: {
      workspaceId: ws,
      provider: "SMTP",
      email: `me-${tag}@send.test`,
      fromName: "Me",
      firstName: "Meg",
      lastName: "Self",
      capTier: "SMTP",
      providerCap: 100,
    },
  });
  const lead = await P.lead.create({
    data: { workspaceId: ws, email: `lead-${tag}@lead.test`, firstName: "Dana" },
  });
  const t = await P.thread.create({
    data: {
      workspaceId: ws,
      accountId: a.id,
      subject: "Hello",
      leadId: lead.id,
      lastMessageAt: T,
      lastInboundAt: T,
      lastInboundKind: "REPLY",
      isRead: false,
      hasAttachment: true,
    },
  });
  const m = await P.message.create({
    data: {
      workspaceId: ws,
      accountId: a.id,
      threadId: t.id,
      rfcMessageId: `<m-${tag}@lead.test>`,
      references: [],
      direction: "IN",
      folder: "INBOX",
      fromEmail: lead.email,
      to: [a.email],
      cc: [],
      subject: "Hello",
      text: "Interested",
      sentAt: T,
      kind: "REPLY",
      leadId: lead.id,
      attachments: {
        create: [
          { filename: "deck v1.pdf", contentType: "text/html", size: 4, data: Buffer.from("<b>1") },
        ],
      },
    },
    include: { attachments: true },
  });
  return { a, lead, t, m, att: m.attachments[0]! };
}

/** A mailbox and a stranger's reply: no lead is linked yet. */
async function triage(ws: string) {
  const P = db.prisma;
  const tag = randomBytes(4).toString("hex");
  const a = await P.emailAccount.create({
    data: {
      workspaceId: ws,
      provider: "SMTP",
      email: `triage-${tag}@send.test`,
      fromName: "Me",
      firstName: "Me",
      lastName: "Self",
      capTier: "SMTP",
      providerCap: 100,
    },
  });
  const t = await P.thread.create({
    data: {
      workspaceId: ws,
      accountId: a.id,
      subject: "Hello",
      lastMessageAt: T,
      lastInboundAt: T,
      lastInboundKind: "REPLY",
      isRead: false,
    },
  });
  await P.message.create({
    data: {
      workspaceId: ws,
      accountId: a.id,
      threadId: t.id,
      rfcMessageId: `<triage-${tag}@acme.test>`,
      references: [],
      direction: "IN",
      folder: "INBOX",
      fromEmail: "dana@acme.test",
      fromName: "Dana Smith",
      to: [a.email],
      cc: [],
      subject: "Hello",
      text: "Tell me more",
      sentAt: T,
      kind: "REPLY",
    },
  });
  return t;
}

it("reads for a viewer, writes for members; thread GET never carries attachment data", async () => {
  const s = await seed(workspaceId);
  await setRole("VIEWER");
  const list = await r.threads!.GET!(req("GET", "threads"));
  expect(list.status).toBe(200);
  const body = await json(list);
  expect(body.threads.map((t: { id: string }) => t.id)).toContain(s.t.id);
  expect(JSON.stringify(body)).not.toContain('"data"');
  const one = await r.thread!.GET!(req("GET", "x"), p(s.t.id));
  expect(one.status).toBe(200);
  const detail = await json(one);
  expect(detail.messages[0].attachments[0]).toMatchObject({ filename: "deck v1.pdf", size: 4 });
  expect(JSON.stringify(detail)).not.toContain('"data"');
  expect(detail.lead).toMatchObject({ id: s.lead.id });
  expect((await r.unread!.GET!(req("GET", "x"))).status).toBe(200);
  expect(await json(await r.unread!.GET!(req("GET", "x")))).toMatchObject({ remindersDue: 0 });

  expect((await r.thread!.PATCH!(req("PATCH", "x", { isRead: true }), p(s.t.id))).status).toBe(403);
  expect((await r.reply!.POST!(req("POST", "x", undefined, { cookie }), p(s.t.id))).status).toBe(
    403,
  );
  expect(
    (await r.bulk!.POST!(req("POST", "x", { ids: [s.t.id], action: "read" }), p(s.t.id))).status,
  ).toBe(403);
  expect((await r.notes!.POST!(req("POST", "x", { threadId: s.t.id, body: "n" }))).status).toBe(
    403,
  );
  await setRole("MEMBER");
  const patched = await r.thread!.PATCH!(
    req("PATCH", "x", { isRead: true, category: "NEUTRAL" }),
    p(s.t.id),
  );
  expect(patched.status).toBe(200);
  expect(await json(patched)).toMatchObject({ isRead: true, categorySource: "USER" });
  expect((await r.thread!.PATCH!(req("PATCH", "x", { nope: 1 }), p(s.t.id))).status).toBe(400);
});

it("create-lead from a triage thread: member session and leads:create for a key", async () => {
  const first = await triage(workspaceId);
  await setRole("VIEWER");
  expect((await r.createLead!.POST!(req("POST", "x"), p(first.id))).status).toBe(403);
  await setRole("MEMBER");
  const ok = await r.createLead!.POST!(req("POST", "x"), p(first.id));
  expect(ok.status).toBe(200);
  const body = await json(ok);
  expect(body).toMatchObject({ created: true });
  expect(await db.prisma.lead.findUniqueOrThrow({ where: { id: body.leadId } })).toMatchObject({
    email: "dana@acme.test",
    firstName: "Dana",
    lastName: "Smith",
    source: "inbox_triage",
  });

  const { createApiKey } = await import("@rightnow/core");
  const bearer = async (name: string, scopes: string[]) => ({
    authorization: `Bearer ${(await createApiKey(db.prisma, workspaceId, name, scopes)).token}`,
  });
  const plain = await triage(workspaceId);
  const inboxOnly = await bearer("triage-inbox", ["inbox:write"]);
  const refused = await r.createLead!.POST!(req("POST", "x", undefined, inboxOnly), p(plain.id));
  expect(refused.status).toBe(403);
  expect((await json(refused)).error).toBe("scope_required:leads:create");
  const both = await bearer("triage-both", ["inbox:write", "leads:create"]);
  expect((await r.createLead!.POST!(req("POST", "x", undefined, both), p(plain.id))).status).toBe(
    200,
  );
});

it("API keys: bulk blocklist and set_interest need the scope of what they change (m13)", async () => {
  const s = await seed(workspaceId);
  const { createApiKey } = await import("@rightnow/core");
  const key = async (...scopes: string[]) => ({
    authorization: `Bearer ${(await createApiKey(db.prisma, workspaceId, "k", scopes)).token}`,
  });
  const post = async (body: object, h: Record<string, string>) => {
    const res = await r.bulk!.POST!(req("POST", "x", { ids: [s.t.id], ...body }, h), p(s.t.id));
    return [res.status, res.status === 403 ? (await json(res)).error : ""];
  };
  const w = await key("inbox:write");
  expect(await post({ action: "read" }, w)).toEqual([200, ""]);
  expect(await post({ action: "blocklist" }, w)).toEqual([403, "scope_required:blocklist:create"]);
  expect(await post({ action: "set_interest", interestStatus: 1 }, w)).toEqual([
    403,
    "scope_required:leads:update",
  ]);
  const all = await key("inbox:write", "blocklist:create", "leads:update");
  expect((await post({ action: "blocklist" }, all))[0]).toBe(200);
  expect((await post({ action: "set_interest", interestStatus: 1 }, all))[0]).toBe(200);
});

it("API keys: inbox:read cannot write or reply, inbox:write can", async () => {
  const s = await seed(workspaceId);
  const { createApiKey } = await import("@rightnow/core");
  const ro = {
    authorization: `Bearer ${(await createApiKey(db.prisma, workspaceId, "ro", ["inbox:read"])).token}`,
  };
  const rw = {
    authorization: `Bearer ${(await createApiKey(db.prisma, workspaceId, "rw", ["inbox:write"])).token}`,
  };
  expect((await r.threads!.GET!(req("GET", "threads?view=all", undefined, ro))).status).toBe(200);
  expect((await r.thread!.PATCH!(req("PATCH", "x", { isRead: true }, ro), p(s.t.id))).status).toBe(
    403,
  );
  const body = new FormData();
  body.set("mode", "reply");
  body.set("html", "<p>x</p>");
  const asForm = async (headers: Record<string, string>) => {
    const wrapped = new Response(body);
    const bytes = await wrapped.arrayBuffer();
    return new Request(`${ORIGIN}/api/v1/inbox/x`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": wrapped.headers.get("content-type")!,
        "content-length": String(bytes.byteLength),
      },
      body: bytes,
    });
  };
  expect((await r.reply!.POST!(await asForm(ro), p(s.t.id))).status).toBe(403);
  expect((await r.thread!.PATCH!(req("PATCH", "x", { isRead: false }, rw), p(s.t.id))).status).toBe(
    200,
  );
  // a write key that cannot read
  expect((await r.threads!.GET!(req("GET", "threads", undefined, rw))).status).toBe(403);
});

it("reply route: multipart in, Fake provider out, size and length rules", async () => {
  const s = await seed(workspaceId);
  const multipart = async (fields: Record<string, string>, withLength = true, extra = 0) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    f.append("attachments", new File([new Uint8Array(10)], "n.txt", { type: "text/plain" }));
    const wrapped = new Response(f);
    const bytes = await wrapped.arrayBuffer();
    return new Request(`${ORIGIN}/api/v1/inbox/x`, {
      method: "POST",
      headers: {
        cookie,
        origin: ORIGIN,
        "content-type": wrapped.headers.get("content-type")!,
        ...(withLength && { "content-length": String(bytes.byteLength + extra) }),
      },
      body: bytes,
    });
  };
  const ok = await r.reply!.POST!(
    await multipart({ mode: "reply", html: "<p>hi Dana</p>" }),
    p(s.t.id),
  );
  expect(ok.status).toBe(200);
  const { messageId } = await json(ok);
  expect(await db.prisma.message.findUniqueOrThrow({ where: { id: messageId } })).toMatchObject({
    direction: "OUT",
    to: [s.lead.email],
  });
  expect(await getFakeProvider(s.a.email).sentRaw()).toHaveLength(1);
  expect(
    (await r.reply!.POST!(await multipart({ mode: "reply", html: "x" }, false), p(s.t.id))).status,
  ).toBe(411);
  expect(
    (
      await r.reply!.POST!(
        await multipart({ mode: "reply", html: "x" }, true, 30 * 1024 * 1024),
        p(s.t.id),
      )
    ).status,
  ).toBe(413);
  const bad = await r.reply!.POST!(await multipart({ mode: "forward", html: "x" }), p(s.t.id));
  expect(bad.status).toBe(400);
  expect(await json(bad)).toMatchObject({ error: "to_required" });
  const cap = await seed(workspaceId);
  await db.prisma.emailAccount.update({ where: { id: cap.a.id }, data: { providerCap: 2 } });
  await db.prisma.accountDailyUsage.create({
    data: {
      accountId: cap.a.id,
      day: new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`),
      sent: 1,
    },
  });
  const full = await r.reply!.POST!(await multipart({ mode: "reply", html: "x" }), p(cap.t.id));
  expect(full.status).toBe(409);
  expect(await json(full)).toMatchObject({ error: "provider_cap" });
});

it("attachment download: attachment disposition, nosniff, a safe type and the stored bytes", async () => {
  const s = await seed(workspaceId);
  const res = await r.attachment!.GET!(req("GET", "x"), p(s.att.id));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toMatch(
    /^attachment; filename="deck v1\.pdf"; filename\*=UTF-8''deck%20v1\.pdf$/,
  );
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).toContain("sandbox");
  expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("<b>1");
  await db.prisma.attachment.update({
    where: { id: s.att.id },
    data: { data: null, truncated: true },
  });
  expect((await r.attachment!.GET!(req("GET", "x"), p(s.att.id))).status).toBe(410);
});

it("notes, macros and views: CRUD, validation, and the macro render fills the first name", async () => {
  const s = await seed(workspaceId);
  const note = await json(
    await r.notes!.POST!(req("POST", "x", { threadId: s.t.id, body: "call back" })),
  );
  expect(note).toMatchObject({ threadId: s.t.id, body: "call back" });
  expect((await r.notes!.POST!(req("POST", "x", { body: "none" }))).status).toBe(400);
  expect(
    (await json(await r.notes!.GET!(req("GET", `notes?threadId=${s.t.id}`)))).notes,
  ).toHaveLength(1);
  expect(
    (await json(await r.note!.PATCH!(req("PATCH", "x", { body: "edited" }), p(note.id)))).body,
  ).toBe("edited");
  expect((await r.note!.DELETE!(req("DELETE", "x"), p(note.id))).status).toBe(200);
  expect((await r.note!.DELETE!(req("DELETE", "x"), p(note.id))).status).toBe(404);

  const macro = await json(
    await r.macros!.POST!(
      req("POST", "x", {
        name: "Greet",
        body: "Hi {{firstName}}, {{sendingAccountFirstName}} here",
      }),
    ),
  );
  expect((await r.macros!.POST!(req("POST", "x", { name: "Greet", body: "dup" }))).status).toBe(
    409,
  );
  const out = await json(
    await r.render!.POST!(req("POST", "x", { threadId: s.t.id }), p(macro.id)),
  );
  expect(out.text).toBe("Hi Dana, Meg here");
  expect(out.html).toContain("Hi Dana");
  expect(
    (await json(await r.macros!.GET!(req("GET", "macros")))).macros.map(
      (m: { name: string }) => m.name,
    ),
  ).toContain("Greet");
  expect(
    (await json(await r.macro!.PATCH!(req("PATCH", "x", { body: "new" }), p(macro.id)))).body,
  ).toBe("new");

  const view = await json(
    await r.views!.POST!(
      req("POST", "x", { name: "Mine", filters: { view: "unread", category: "INTERESTED" } }),
    ),
  );
  expect(view.filters).toMatchObject({ view: "unread", category: "INTERESTED", limit: 50 });
  expect(
    (await r.views!.POST!(req("POST", "x", { name: "Bad", filters: { view: "nope" } }))).status,
  ).toBe(400);
  expect((await r.view!.PATCH!(req("PATCH", "x", { name: "Renamed" }), p(view.id))).status).toBe(
    200,
  );
  expect((await r.view!.DELETE!(req("DELETE", "x"), p(view.id))).status).toBe(200);
  expect((await r.macro!.DELETE!(req("DELETE", "x"), p(macro.id))).status).toBe(200);
});

it("saved views carry a scope: lead views take lead filters and stay out of the inbox list", async () => {
  const mk = (body: unknown) => r.views!.POST!(req("POST", "x", body));
  const eu = await json(
    await mk({
      name: "EU leads",
      scope: "leads",
      filters: { tag: "eu", verificationStatus: "VERIFIED" },
    }),
  );
  expect(eu).toMatchObject({
    scope: "leads",
    filters: { tag: "eu", verificationStatus: "VERIFIED" },
  });
  const inbox = await mk({ name: "EU leads", filters: { view: "all" } }); // same name, other scope
  expect(inbox.status).toBe(200);
  expect((await mk({ name: "Bad", scope: "leads", filters: { view: "all" } })).status).toBe(400);
  expect((await mk({ name: "Bad", filters: { tag: "eu" } })).status).toBe(400);
  expect((await mk({ name: "EU leads", scope: "leads", filters: {} })).status).toBe(409);
  const names = async (q: string) =>
    (await json(await r.views!.GET!(req("GET", `views${q}`)))).views.map(
      (v: { id: string }) => v.id,
    );
  expect(await names("?scope=leads")).toEqual([eu.id]);
  expect(await names("")).not.toContain(eu.id);
  expect(
    (await r.view!.PATCH!(req("PATCH", "x", { filters: { view: "all" } }), p(eu.id))).status,
  ).toBe(400); // a lead view cannot take inbox filters
  await db.prisma.inboxView.deleteMany({ where: { name: "EU leads" } });
});

it("saved views: the key scope follows the view's scope (inbox:* for inbox views, leads:* for leads views)", async () => {
  const { createApiKey } = await import("@rightnow/core");
  const bearer = async (name: string, scopes: string[]) => ({
    authorization: `Bearer ${(await createApiKey(db.prisma, workspaceId, name, scopes)).token}`,
  });
  const inboxKey = await bearer("vi", ["inbox:read", "inbox:write"]);
  const leadsKey = await bearer("vl", ["leads:read", "leads:write"]);
  const lv = await json(
    await r.views!.POST!(
      req("POST", "x", { name: "Scoped leads", scope: "leads", filters: { tag: "eu" } }),
    ),
  );
  const iv = await json(
    await r.views!.POST!(req("POST", "x", { name: "Scoped inbox", filters: { view: "all" } })),
  );
  const st = async (res: Promise<Response>) => (await res).status;

  // an inbox-only key is refused on leads views, on every verb
  expect(await st(r.views!.GET!(req("GET", "views?scope=leads", undefined, inboxKey)))).toBe(403);
  expect(
    await st(
      r.views!.POST!(req("POST", "x", { name: "k", scope: "leads", filters: {} }, inboxKey)),
    ),
  ).toBe(403);
  expect(await st(r.view!.PATCH!(req("PATCH", "x", { name: "k2" }, inboxKey), p(lv.id)))).toBe(403);
  expect(await st(r.view!.DELETE!(req("DELETE", "x", undefined, inboxKey), p(lv.id)))).toBe(403);
  // ...and keeps working on inbox views
  expect(await st(r.views!.GET!(req("GET", "views", undefined, inboxKey)))).toBe(200);
  expect(
    await st(r.view!.PATCH!(req("PATCH", "x", { name: "Scoped inbox 2" }, inboxKey), p(iv.id))),
  ).toBe(200);

  // a leads-only key is refused on inbox views and allowed on leads views
  expect(await st(r.views!.GET!(req("GET", "views", undefined, leadsKey)))).toBe(403);
  expect(
    await st(r.views!.POST!(req("POST", "x", { name: "k", filters: { view: "all" } }, leadsKey))),
  ).toBe(403);
  expect(await st(r.view!.PATCH!(req("PATCH", "x", { name: "k3" }, leadsKey), p(iv.id)))).toBe(403);
  expect(await st(r.view!.DELETE!(req("DELETE", "x", undefined, leadsKey), p(iv.id)))).toBe(403);
  expect(await st(r.views!.GET!(req("GET", "views?scope=leads", undefined, leadsKey)))).toBe(200);
  const made = await r.views!.POST!(
    req("POST", "x", { name: "By key", scope: "leads", filters: { q: "a" } }, leadsKey),
  );
  expect(made.status).toBe(200);
  expect(
    await st(r.view!.PATCH!(req("PATCH", "x", { name: "By key 2" }, leadsKey), p(lv.id))),
  ).toBe(200);
  expect(await st(r.view!.DELETE!(req("DELETE", "x", undefined, leadsKey), p(lv.id)))).toBe(200);
  await db.prisma.inboxView.deleteMany({
    where: { name: { in: ["Scoped inbox 2", "By key"] } },
  });
});

it("workspace isolation on every route", async () => {
  const other = (
    await db.prisma.workspace.create({
      data: { name: "O", slug: `o-${randomBytes(3).toString("hex")}` },
    })
  ).id;
  const f = await seed(other);
  const note = await db.prisma.note.create({
    data: { workspaceId: other, threadId: f.t.id, body: "x" },
  });
  const macro = await db.prisma.macro.create({
    data: { workspaceId: other, name: "m", body: "b" },
  });
  const view = await db.prisma.inboxView.create({
    data: { workspaceId: other, name: "v", filters: {} },
  });
  const mine = await seed(workspaceId);
  const status = async (res: Promise<Response>) => (await res).status;

  expect(await status(r.thread!.GET!(req("GET", "x"), p(f.t.id)))).toBe(404);
  expect(await status(r.thread!.PATCH!(req("PATCH", "x", { isRead: true }), p(f.t.id)))).toBe(404);
  expect(await status(r.thread!.DELETE!(req("DELETE", "x"), p(f.t.id)))).toBe(404);
  expect(await status(r.readAll!.POST!(req("POST", "x"), p(f.t.id)))).toBe(404);
  expect(await status(r.attach!.POST!(req("POST", "x", { leadId: mine.lead.id }), p(f.t.id)))).toBe(
    404,
  );
  expect(await status(r.attach!.POST!(req("POST", "x", { leadId: f.lead.id }), p(mine.t.id)))).toBe(
    404,
  );
  const form = new FormData();
  form.set("mode", "reply");
  form.set("html", "x");
  const wrapped = new Response(form);
  const bytes = await wrapped.arrayBuffer();
  const reply = new Request(`${ORIGIN}/x`, {
    method: "POST",
    headers: {
      cookie,
      origin: ORIGIN,
      "content-type": wrapped.headers.get("content-type")!,
      "content-length": String(bytes.byteLength),
    },
    body: bytes,
  });
  expect(await status(r.reply!.POST!(reply, p(f.t.id)))).toBe(404);
  expect(await status(r.attachment!.GET!(req("GET", "x"), p(f.att.id)))).toBe(404);
  expect(await status(r.note!.PATCH!(req("PATCH", "x", { body: "y" }), p(note.id)))).toBe(404);
  expect(await status(r.note!.DELETE!(req("DELETE", "x"), p(note.id)))).toBe(404);
  expect(await status(r.notes!.POST!(req("POST", "x", { threadId: f.t.id, body: "y" })))).toBe(404);
  expect(await status(r.macro!.PATCH!(req("PATCH", "x", { body: "y" }), p(macro.id)))).toBe(404);
  expect(await status(r.macro!.DELETE!(req("DELETE", "x"), p(macro.id)))).toBe(404);
  expect(
    await status(r.render!.POST!(req("POST", "x", { threadId: mine.t.id }), p(macro.id))),
  ).toBe(404);
  expect(await status(r.render!.POST!(req("POST", "x", { threadId: f.t.id }), p(macro.id)))).toBe(
    404,
  );
  expect(await status(r.view!.PATCH!(req("PATCH", "x", { name: "y" }), p(view.id)))).toBe(404);
  expect(await status(r.view!.DELETE!(req("DELETE", "x"), p(view.id)))).toBe(404);

  const bulk = await json(
    await r.bulk!.POST!(req("POST", "x", { ids: [f.t.id], action: "delete" })),
  );
  expect(bulk.affected).toBe(0);
  expect(
    (await db.prisma.thread.findUniqueOrThrow({ where: { id: f.t.id } })).deletedAt,
  ).toBeNull();

  // lists never show another workspace
  const ids = (await json(await r.threads!.GET!(req("GET", "threads?view=all")))).threads.map(
    (t: { id: string }) => t.id,
  );
  expect(ids).not.toContain(f.t.id);
  expect(await json(await r.notes!.GET!(req("GET", `notes?threadId=${f.t.id}`)))).toEqual({
    notes: [],
  });
  const names = (await json(await r.macros!.GET!(req("GET", "macros")))).macros.map(
    (m: { id: string }) => m.id,
  );
  expect(names).not.toContain(macro.id);

  const { listThreads, listNotes, listMacros, listViews } = await import("@rightnow/core");
  await expectIsolated({
    prisma: db.prisma,
    seed: async (ws) => {
      const x = await seed(ws);
      await db.prisma.note.create({ data: { workspaceId: ws, threadId: x.t.id, body: "n" } });
      await db.prisma.macro.create({ data: { workspaceId: ws, name: "m", body: "b" } });
      await db.prisma.inboxView.create({ data: { workspaceId: ws, name: "v", filters: {} } });
    },
    read: async (ws) => [
      ...(await listThreads(db.prisma, ws, { view: "all" })),
      ...(await listNotes(db.prisma, ws, {})),
      ...(await listMacros(db.prisma, ws)),
      ...(await listViews(db.prisma, ws)),
    ],
  });
});
