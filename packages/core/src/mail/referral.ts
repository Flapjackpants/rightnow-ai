import { Prisma, type Lead, type Message, type ReplyCategory } from "@rightnow/db/client";
import { audit } from "../audit";
import type { Clock } from "../clock";
import { companyDomainOf } from "../leads/domain";
import { suppressedEmails } from "../leads/suppression";
import { parseEmail } from "../leads/validate";
import { stripQuoted } from "./quoted";

type Tx = Prisma.TransactionClient;
const PHRASE =
  /\b(?:cc'?ing|cc'?d|copying|looping in|looped in|colleague|reach out to|please contact|contact|speak (?:to|with)|talk to|get in touch with|please email|handles this|responsible for|wrong person|not the right (?:person|contact)|no longer (?:with|at|works)|left the company)\b/gi;
const ADDRESS = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const ROLE =
  /^(?:no-?reply|do-?not-?reply|mailer-daemon|postmaster|info|sales|support|hello|contact|admin|help|billing|office|team)$/i;

/** Pure. Returns addresses to create and whether a person must look for the contact. */
export function extractReferrals(p: {
  text: string | null;
  cc: string[];
  category: ReplyCategory | null;
  leadEmail: string;
  own: string[];
}): { emails: string[]; needsTask: boolean } {
  const body = stripQuoted(p.text ?? "");
  const paragraphs = body.split(/\n\s*\n/);
  const matches = paragraphs.map((part) => [...part.matchAll(PHRASE)]);
  const triggered = p.category === "WRONG_PERSON" || matches.some((m) => m.length > 0);
  if (!triggered) return { emails: [], needsTask: false };

  const candidates = [...p.cc];
  for (let i = 0; i < paragraphs.length; i++) {
    const part = paragraphs[i]!;
    for (const address of part.matchAll(ADDRESS)) {
      if (
        matches[i]!.some((phrase) => {
          const start = phrase.index!;
          const end = start + phrase[0].length;
          const addrStart = address.index!;
          const addrEnd = addrStart + address[0].length;
          return Math.max(0, start - addrEnd, addrStart - end) <= 120;
        })
      )
        candidates.push(address[0]);
    }
  }
  const domain = companyDomainOf(p.leadEmail);
  const own = new Set(p.own.map((email) => email.toLowerCase()));
  const emails: string[] = [];
  for (const raw of candidates) {
    const email = parseEmail(raw);
    if (
      !email ||
      !domain ||
      companyDomainOf(email) !== domain ||
      email === p.leadEmail.toLowerCase() ||
      own.has(email) ||
      ROLE.test(email.split("@")[0]!) ||
      emails.includes(email)
    )
      continue;
    emails.push(email);
    if (emails.length === 3) break;
  }
  return { emails, needsTask: p.category === "WRONG_PERSON" && emails.length === 0 };
}

/** In the caller's transaction. Writes only for a usable result. */
export async function applyReferrals(
  tx: Tx,
  clock: Clock,
  ws: string,
  m: Pick<Message, "text" | "cc">,
  lead: Lead,
  category: ReplyCategory | null,
): Promise<void> {
  const own = (
    await tx.emailAccount.findMany({ where: { workspaceId: ws }, select: { email: true } })
  ).map((a) => a.email);
  const result = extractReferrals({ text: m.text, cc: m.cc, category, leadEmail: lead.email, own });
  const blocked = result.emails.length
    ? await suppressedEmails(tx, ws, result.emails)
    : new Set<string>();
  let created = 0;
  let linked = 0;
  for (const email of result.emails.filter((e) => !blocked.has(e))) {
    const existing = await tx.lead.findFirst({
      where: { workspaceId: ws, email, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      const r = await tx.lead.updateMany({
        where: { id: existing.id, workspaceId: ws, referredById: null, NOT: { id: lead.id } },
        data: { referredById: lead.id },
      });
      linked += r.count;
    } else {
      const r = await tx.lead.createMany({
        skipDuplicates: true,
        data: [
          {
            workspaceId: ws,
            email,
            referredById: lead.id,
            companyName: lead.companyName,
            companyDomain: companyDomainOf(email),
            website: lead.website,
            industry: lead.industry,
            country: lead.country,
            region: lead.region,
            lawfulBasis: lead.lawfulBasis,
            ownerId: lead.ownerId,
            source: "referral",
            tags: ["referral"],
            labels: [],
          },
        ],
      });
      created += r.count;
    }
  }
  const now = clock.now();
  if (result.needsTask)
    await tx.task.create({
      data: {
        workspaceId: ws,
        title: "Find the right contact for this referral",
        leadId: lead.id,
        assigneeId: lead.ownerId,
        dueAt: new Date(now.getTime() + 86_400_000),
        createdAt: now,
      },
    });
  if (created || linked || result.needsTask)
    await audit(tx, { workspaceId: ws, at: now }, "lead.referral", lead.id, {
      created,
      linked,
      task: result.needsTask ? 1 : 0,
    });
}
