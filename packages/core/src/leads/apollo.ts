import { HttpOutError, safeRequest } from "@rightnow/providers";
import { z } from "zod";

const text200 = z.string().trim().min(1).max(200);
export const leadSourceFilters = z
  .strictObject({
    personTitles: z.array(text200).max(50).optional(),
    personLocations: z.array(text200).max(50).optional(),
    personSeniorities: z
      .array(
        z.enum([
          "owner",
          "founder",
          "c_suite",
          "partner",
          "vp",
          "head",
          "director",
          "manager",
          "senior",
          "entry",
        ]),
      )
      .max(10)
      .optional(),
    organizationLocations: z.array(text200).max(50).optional(),
    employeeRanges: z
      .array(z.string().regex(/^\d{1,7},\d{1,7}$/))
      .max(10)
      .optional(),
    keywords: z.string().trim().min(1).max(200).optional(),
  })
  .refine((f) => Object.values(f).some((v) => v?.length), "filter_required");
export type LeadSourceFilters = z.infer<typeof leadSourceFilters>;
export type ApolloOpts = {
  request?: typeof safeRequest;
  allowPrivate?: boolean;
  resolve?: (h: string) => Promise<string[]>;
  signal?: AbortSignal;
};
export class ApolloError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export type ApolloPerson = {
  id: string;
  email: string | null;
  emailStatus: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  country: string | null;
  state: string | null;
  companyName: string | null;
  website: string | null;
  industry: string | null;
};

const searchReply = z
  .object({
    total_entries: z.number().int().nonnegative(),
    people: z.array(z.object({ id: z.string(), has_email: z.boolean().optional() }).loose()),
  })
  .loose();
const nullable = z.string().nullable().optional();
const match = z
  .object({
    id: z.string(),
    email: nullable,
    email_status: nullable,
    first_name: nullable,
    last_name: nullable,
    title: nullable,
    country: nullable,
    state: nullable,
    organization: z
      .object({ name: nullable, website_url: nullable, industry: nullable })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();
const enrichReply = z.object({ matches: z.array(match.nullable()) }).loose();

async function post(apiKey: string, path: string, body: string, o: ApolloOpts) {
  try {
    const r = await (o.request ?? safeRequest)(`https://api.apollo.io/api/v1${path}`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body,
      timeoutMs: 30_000,
      maxResponseBytes: 4 * 1024 * 1024,
      allowPrivate: o.allowPrivate ?? false,
      resolve: o.resolve,
      signal: o.signal,
    });
    if (r.status >= 300)
      throw new ApolloError(
        r.status === 401
          ? "apollo_auth"
          : r.status === 403
            ? "apollo_plan"
            : r.status === 429
              ? "rate_limited"
              : `apollo_http_${r.status}`,
      );
    try {
      return JSON.parse(r.body.toString("utf8")) as unknown;
    } catch {
      throw new ApolloError("bad_response");
    }
  } catch (e) {
    if (e instanceof ApolloError) throw e;
    throw new ApolloError(e instanceof HttpOutError ? e.code : "network");
  }
}

export async function apolloSearch(
  apiKey: string,
  f: LeadSourceFilters,
  page: number,
  o: ApolloOpts = {},
): Promise<{ total: number; people: { id: string; hasEmail: boolean }[] }> {
  const q = new URLSearchParams();
  const arrays = {
    personTitles: "person_titles[]",
    personLocations: "person_locations[]",
    personSeniorities: "person_seniorities[]",
    organizationLocations: "organization_locations[]",
    employeeRanges: "organization_num_employees_ranges[]",
  } as const;
  for (const [field, param] of Object.entries(arrays))
    for (const v of f[field as keyof typeof arrays] ?? []) q.append(param, v);
  if (f.keywords) q.set("q_keywords", f.keywords);
  q.set("page", String(page));
  q.set("per_page", "100");
  q.append("contact_email_status[]", "verified");
  const parsed = searchReply.safeParse(
    await post(apiKey, `/mixed_people/api_search?${q}`, "{}", o),
  );
  if (!parsed.success) throw new ApolloError("bad_response");
  return {
    total: parsed.data.total_entries,
    people: parsed.data.people.map((p) => ({ id: p.id, hasEmail: p.has_email !== false })),
  };
}

export async function apolloEnrich(
  apiKey: string,
  ids: string[],
  o: ApolloOpts = {},
): Promise<ApolloPerson[]> {
  if (ids.length > 10) throw new ApolloError("too_many_ids");
  const parsed = enrichReply.safeParse(
    await post(
      apiKey,
      "/people/bulk_match",
      JSON.stringify({ details: ids.map((id) => ({ id })) }),
      o,
    ),
  );
  if (!parsed.success) throw new ApolloError("bad_response");
  return parsed.data.matches
    .filter((m) => m !== null)
    .map((m) => ({
      id: m.id,
      email: m.email ?? null,
      emailStatus: m.email_status ?? null,
      firstName: m.first_name ?? null,
      lastName: m.last_name ?? null,
      title: m.title ?? null,
      country: m.country ?? null,
      state: m.state ?? null,
      companyName: m.organization?.name ?? null,
      website: m.organization?.website_url ?? null,
      industry: m.organization?.industry ?? null,
    }));
}
