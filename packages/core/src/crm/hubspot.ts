import { HttpOutError, safeRequest } from "@rightnow/providers";
import { z } from "zod";

const BASE = "https://api.hubapi.com";
export type HubspotOpts = {
  request?: typeof safeRequest;
  allowPrivate?: boolean;
  resolve?: (h: string) => Promise<string[]>;
  signal?: AbortSignal;
};
export class HubspotError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const codeFor = (status: number) =>
  status === 401
    ? "hubspot_auth"
    : status === 403
      ? "hubspot_scope"
      : status === 429
        ? "rate_limited"
        : status === 207
          ? "hubspot_partial"
          : `hubspot_http_${status}`;
const result = z
  .object({
    results: z.array(
      z
        .object({ id: z.string(), properties: z.record(z.string(), z.unknown()).optional() })
        .loose(),
    ),
  })
  .loose();
async function call(
  token: string,
  path: string,
  method: "GET" | "POST",
  body: unknown,
  o: HubspotOpts,
) {
  try {
    return await (o.request ?? safeRequest)(BASE + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      timeoutMs: 30_000,
      maxResponseBytes: 8 * 1024 * 1024,
      allowPrivate: o.allowPrivate ?? false,
      resolve: o.resolve,
      signal: o.signal,
    });
  } catch (e) {
    throw new HubspotError(e instanceof HttpOutError ? e.code : "request_failed");
  }
}
function parse(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString());
  } catch {
    throw new HubspotError("bad_response");
  }
}
async function upsert(
  token: string,
  kind: "contacts" | "deals",
  inputs: { id: string; properties: Record<string, string> }[],
  o: HubspotOpts,
) {
  const out = new Map<string, string>();
  for (let i = 0; i < inputs.length; i += 100) {
    const batch = inputs.slice(i, i + 100);
    const idProperty = kind === "contacts" ? "email" : "rightnow_id";
    const res = await call(
      token,
      `/crm/v3/objects/${kind}/batch/upsert`,
      "POST",
      {
        inputs: batch.map((x) => ({
          id: x.id,
          idProperty,
          properties: { ...x.properties, [idProperty]: x.id },
        })),
      },
      o,
    );
    if (res.status !== 200) throw new HubspotError(codeFor(res.status));
    const parsed = result.safeParse(parse(res.body));
    if (!parsed.success || parsed.data.results.length !== batch.length)
      throw new HubspotError(parsed.success ? "hubspot_partial" : "bad_response");
    const byId = new Map(parsed.data.results.map((x) => [x.properties?.[idProperty], x.id]));
    for (const x of batch) {
      const id = byId.get(x.id);
      if (typeof id !== "string") throw new HubspotError("hubspot_partial");
      out.set(x.id, id);
    }
  }
  return out;
}
export async function upsertContacts(
  token: string,
  inputs: { email: string; properties: Record<string, string> }[],
  o: HubspotOpts = {},
): Promise<Map<string, string>> {
  return upsert(
    token,
    "contacts",
    inputs.map((x) => ({ id: x.email.toLowerCase(), properties: x.properties })),
    o,
  );
}
export async function upsertDeals(
  token: string,
  inputs: { rightnowId: string; properties: Record<string, string> }[],
  o: HubspotOpts = {},
): Promise<Map<string, string>> {
  return upsert(
    token,
    "deals",
    inputs.map((x) => ({ id: x.rightnowId, properties: x.properties })),
    o,
  );
}
export async function associateDeals(
  token: string,
  pairs: { dealId: string; contactId: string }[],
  o: HubspotOpts = {},
): Promise<void> {
  for (let i = 0; i < pairs.length; i += 100) {
    const res = await call(
      token,
      "/crm/v4/associations/deals/contacts/batch/associate/default",
      "POST",
      {
        inputs: pairs
          .slice(i, i + 100)
          .map((x) => ({ from: { id: x.dealId }, to: { id: x.contactId } })),
      },
      o,
    );
    if (res.status !== 200) throw new HubspotError(codeFor(res.status));
  }
}
export async function ensureDealProperty(token: string, o: HubspotOpts = {}): Promise<void> {
  const got = await call(token, "/crm/v3/properties/deals/rightnow_id", "GET", undefined, o);
  if (got.status === 200) return;
  if (got.status !== 404) throw new HubspotError(codeFor(got.status));
  const made = await call(
    token,
    "/crm/v3/properties/deals",
    "POST",
    {
      groupName: "dealinformation",
      name: "rightnow_id",
      label: "rightnow ID",
      type: "string",
      fieldType: "text",
      hasUniqueValue: true,
    },
    o,
  );
  if (made.status !== 201 && made.status !== 409) throw new HubspotError(codeFor(made.status));
}
const pipelinesResponse = z
  .object({
    results: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          stages: z.array(z.object({ id: z.string(), label: z.string() }).loose()),
        })
        .loose(),
    ),
  })
  .loose();
export async function hubspotPipelines(
  token: string,
  o: HubspotOpts = {},
): Promise<{ id: string; label: string; stages: { id: string; label: string }[] }[]> {
  const res = await call(token, "/crm/v3/pipelines/deals", "GET", undefined, o);
  if (res.status !== 200) throw new HubspotError(codeFor(res.status));
  const parsed = pipelinesResponse.safeParse(parse(res.body));
  if (!parsed.success) throw new HubspotError("bad_response");
  return parsed.data.results.map((p) => ({
    id: p.id,
    label: p.label,
    stages: p.stages.map((s) => ({ id: s.id, label: s.label })),
  }));
}
const companyPage = z
  .object({
    results: z.array(
      z.object({ properties: z.object({ domain: z.string().nullish() }).loose() }).loose(),
    ),
    paging: z
      .object({ next: z.object({ after: z.string() }).loose() })
      .loose()
      .optional(),
  })
  .loose();
export async function customerDomains(token: string, o: HubspotOpts = {}): Promise<string[]> {
  const domains: string[] = [];
  let after: string | undefined;
  do {
    const res = await call(
      token,
      "/crm/v3/objects/companies/search",
      "POST",
      {
        filterGroups: [
          { filters: [{ propertyName: "lifecyclestage", operator: "EQ", value: "customer" }] },
        ],
        properties: ["domain"],
        limit: 200,
        ...(after && { after }),
      },
      o,
    );
    if (res.status !== 200) throw new HubspotError(codeFor(res.status));
    const page = companyPage.safeParse(parse(res.body));
    if (!page.success) throw new HubspotError("bad_response");
    domains.push(
      ...page.data.results.flatMap((x) => (x.properties.domain ? [x.properties.domain] : [])),
    );
    after = page.data.paging?.next?.after;
  } while (after && Number(after) < 9800);
  return domains;
}
