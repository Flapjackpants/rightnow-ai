import type { BackgroundJob, Message, PrismaClient } from "@rightnow/db/client";
import { z } from "zod";
import { AccountError } from "../accounts/service";
import type { Clock } from "../clock";
import { sendReply } from "./reply";
import type { SyncDeps } from "./sync";

const input = z.strictObject({ threadId: z.string().min(1), to: z.email() });
const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const forwardHtml = (
  m: Pick<Message, "fromEmail" | "fromName" | "subject" | "sentAt" | "text">,
): string => {
  const body = (m.text || "(no text)").slice(0, 200_000);
  return [
    `<p>Automatically forwarded by rightnow because of a positive reply. Reply to the sender directly at ${escape(m.fromEmail)} so they reach you, not the sending mailbox.</p>`,
    `<p>From: ${escape(m.fromName ?? "")} &lt;${escape(m.fromEmail)}&gt;<br>Date: ${escape(m.sentAt.toISOString())}<br>Subject: ${escape(m.subject)}</p>`,
    ...body.split(/\n{2,}/).map((p) => `<p>${escape(p).replace(/\n/g, "<br>")}</p>`),
  ].join("");
};

export async function runThreadForward(
  prisma: PrismaClient,
  clock: Clock,
  job: BackgroundJob,
  progress: (pct: number) => Promise<void>,
  providerFor: SyncDeps["providerFor"],
): Promise<{ messageId: string }> {
  // A stale requeue may have reached the provider, so a second attempt can duplicate a forward.
  if (job.attempts > 0) throw new AccountError(409, "forward_uncertain");
  await progress(0);
  const parsed = input.safeParse(job.input);
  if (!parsed.success) throw new AccountError(400, "invalid_input");
  const m = await prisma.message.findFirst({
    where: {
      workspaceId: job.workspaceId,
      threadId: parsed.data.threadId,
      direction: "IN",
      thread: { workspaceId: job.workspaceId, deletedAt: null },
    },
    orderBy: [{ sentAt: "desc" }, { id: "desc" }],
  });
  if (!m) throw new AccountError(404, "Not found");
  return sendReply(prisma, clock, { providerFor }, job.workspaceId, null, {
    threadId: parsed.data.threadId,
    mode: "forward",
    to: [parsed.data.to],
    html: forwardHtml(m),
  });
}
