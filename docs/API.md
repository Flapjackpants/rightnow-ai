# rightnow AI public API (v1)

Base path `/api/v1`. The machine-readable description is [`docs/openapi.json`](openapi.json), generated from the route
definitions (`npm run openapi`) and served without authentication at `GET /api/v1/openapi.json`. Responses are
documented as plain `200 application/json` (no response schemas yet). The route table at the end is generated from it;
when they differ, `openapi.json` wins.

## Authentication

- **Session cookie** (the web app). State-changing requests must come from the app's own origin (CSRF check).
- **API key**: `Authorization: Bearer rn_<prefix>_<secret>`. Create keys in Settings and pick scopes; the token is shown once.
- **API keys act as MEMBER, and ADMIN routes are session-only.** Every route that needs ADMIN rejects an API key with
  401: connecting, disconnecting, deleting and testing mailboxes, clearing or deleting blocklist entries, placement
  tests, releasing held sends, pipeline stages, API keys, the verifier and workspace settings. They are marked
  "session only" in the table at the end.
- **Scopes** are `<resource>:read` and `<resource>:write` (plus `all:all`). `<resource>:write` covers `create`,
  `update` and `delete`; a route may name the finer scope (`leads:create`) and a `:write` key satisfies it.
  Resources: `leads`, `blocklist`, `campaigns`, `accounts`, `inbox`, `analytics`, `crm`, `automations`, `webhooks`,
  `jobs`, `audit`, `workspace`. A key without the route's scope gets 403. The scope of every route is in the table at
  the end.
- Creating or editing an automation rule or webhook with a key also needs the scopes of what it does (for example a
  `suppress_contact` action needs `blocklist:write`; a webhook for reply events needs `inbox:read`): 403
  `scope_required:<scope>`.
- A route marked `a` or `b` in the table takes either scope; the handler enforces the one the request needs (saved
  views: `inbox:*` or `leads:*`). Some routes also need the scopes of the data they read or write: the AI routes
  (`inbox:read` for thread input, `leads:read` for lead input, `leads:update` for `score`, `crm:create` for `recommend`,
  `campaigns:read` for `draft`, `campaigns:read` and `analytics:read` for `campaign-analysis`), `POST /imports` with a
  `campaignId` (`campaigns:update`), `POST /inbox/threads/{id}/create-lead` (`leads:create`),
  `POST /inbox/threads/bulk` (`blocklist:create` for `blocklist`, `leads:update` for `set_interest`), the
  `GET /analytics/activity` CSV (`leads:read`), and webhook create/update (`inbox:read` for reply
  events, `leads:read` for lead events).
- Reads trim what a key may not see instead of refusing. `GET /leads/{id}/export` leaves out `threads` without
  `inbox:read` and notes, tasks and deals without `crm:read`, and names them in `omitted` (e.g.
  `"omitted": ["threads", "crm"]`). `GET /leads/{id}/timeline` drops its note, task and deal entries without
  `crm:read`. `GET /webhooks/{id}/deliveries` drops body fields without `inbox:read` and the lead's fields (address,
  standard and custom fields) without `leads:read`. `GET /ai/suggestions` hides thread-derived kinds without
  `inbox:read` and PERSONALIZATION and the `lead` block without `leads:read`.

## Errors

Every error is JSON `{ "error": "<message or code>" }`.

| Status | Meaning |
|---|---|
| 400 | Invalid request. A body or query that fails validation returns `{ "error": "Invalid request", "issues": [...] }`; each issue has `path` and `message`, and the machine-readable reason is in `issues[].message` (for example `invalid_header`). Bodies are strict: an unknown key is a 400. A non-JSON body gives `{ "error": "Body must be valid JSON" }`. |
| 401 | No valid session or API key. |
| 403 | Role too low, key lacks the scope, or a cross-origin cookie request. |
| 404 | Not found, or it belongs to another workspace. |
| 409 | Conflict (for example `name_taken`). |
| 412 | Not configured (for example an OAuth provider without credentials). |
| 413 | Payload too large. |
| 429 | Rate limited (see below). |

## Pagination

List endpoints that page return `{ "<items>": [...], "nextCursor": "<id>" | null }` (the items key is named after the
resource, for example `jobs`, `logs`, `deliveries`). Pass the value back as `?cursor=<id>`; `null` means the last page.
`take` or `limit` bounds the page (maximum 100). Treat every cursor as opaque (inbox threads use a
`lastMessageAt|id` string).

## Background jobs (202)

Long operations answer `202 { "jobId": "<id>" }` instead of blocking: `POST /leads/bulk` with a `filter`, imports
(`POST /imports`, which has its own status resource) and, as they ship, AI personalization and placement runs. Poll
`GET /jobs/{id}` (scope `jobs:read`) until `status` is `DONE` or `FAILED`:

```json
{ "id": "...", "kind": "leads_bulk", "status": "RUNNING", "progress": 40, "result": null, "error": null }
```

`status` is `PENDING`, `RUNNING`, `DONE` or `FAILED`. `result` holds the outcome and `error` a short code. One job runs
per workspace at a time; a job that makes no progress for 5 minutes is requeued, and after three requeues it ends
`FAILED`. `GET /jobs` lists them.

## Rate limits

A limited request gets `429` with a `Retry-After` header (seconds until the window ends) and the body
`{"error": "rate_limited"}`. Limits are fixed windows counted in Postgres, so a burst of up to twice a limit is possible
across a window edge.

| What | Limit | Counted per |
|---|---|---|
| Any request with an API key | `API_RATE_LIMIT_PER_MIN` (default 600) per minute | workspace (all its keys share it; session requests are not counted) |
| `POST /webhooks/{id}/test` | 10 per minute | workspace |
| AI calls (`/ai/*` features, the reply classifier, AI jobs) | 30 per minute | workspace |
| `POST /accounts/test-connection` | 10 per minute | user |
| `POST /oauth/{provider}/start` | 20 per minute | user |
| Sign-in (`/api/auth/sign-in/email`) | 5 per minute | client IP |
| Sign-in, failed attempts | 10 per 15 minutes | email address |
| 2FA verify (`/api/auth/two-factor/verify-*`) | 5 per minute; 10 per 15 minutes | client IP; user |
| Other `/api/auth` POSTs | 100 per minute | client IP |
| `POST /api/setup` | 10 per 15 minutes | client IP |
| `POST /api/invite/accept` | 10 per 15 minutes | client IP |
| Push endpoints (`/api/push/gmail`, `/api/push/graph`) | 600 per minute each | client IP |

- The AI limit refuses before the model is called. A feature route answers 429 with `Retry-After` and the body
  `{"error": "rate_limited", "retryAfterSec": <n>}`; an AI job waits and retries; a reply the classifier could not reach
  stays `UNCERTAIN` (AI runs only when a message is first imported). The bucket is shared, so a large personalization
  job can use up the minute's calls, and replies imported meanwhile stay `UNCERTAIN`.
- The failed-sign-in limit is per address, so an attacker who keeps guessing can lock the owner out of password sign-in
  for up to 15 minutes. A successful sign-in does not count.
- Sign-in accepts JSON or a urlencoded form; any other body type is `415` `unsupported_media_type`, and a body without
  an email is `400`.
- Client IP: with `MODE=vps` it is the `X-Real-IP` header that Caddy sets from the TCP peer (the web container only
  listens on `127.0.0.1`). A request without it counts as `unknown`, so all of them share one bucket (fails closed). With
  `MODE=local` no header is trusted and every caller is one client, `local`.
- A push endpoint's 429 makes Pub/Sub or Graph redeliver later; polling keeps every mailbox in sync meanwhile.

## Members, invites and two-factor

- `GET /members` (any role) lists members. `PATCH /members/{id}` (`{role: admin|member|viewer}`), `DELETE /members/{id}`,
  `GET|POST /invites` (`{email, role}`) and `DELETE /invites/{id}` are ADMIN and **session only**: an API key acts as
  MEMBER and never reaches them. Roles are stored in lower case. The OWNER's role and membership are fixed
  (`409 owner_immutable`), nobody removes themselves (`409 cannot_remove_self`), and removing a member revokes the API
  keys they created and deletes their user, so the address can be invited again.
- An invite is the link `/invite/<id>` (no email is sent) and is valid for 7 days. `POST /api/invite/accept
  {invitationId, name, password}` is public: `404 invite_not_found`, `409 invite_used`, `410 invite_expired`,
  `409 user_exists`. The new user always gets the invited email address.
- better-auth's own `/api/auth/organization/*` endpoints (`leave`, `invite-member`, `update-member-role`, ...) are all
  disabled over HTTP (`404`), so members change only through the audited routes above.
- Two-factor (TOTP plus 10 backup codes) is optional per user: Settings > Security, or `/api/auth/two-factor/*`. A user
  who lost both the app and the codes is reset by the operator (`scripts/disable-2fa.ts`, docs/ops/LOCAL.md).
- `GET /audit-logs` and Settings > Audit log are both MEMBER and up (a VIEWER sees neither); the API needs `audit:read`.

## Webhooks

Create webhooks with `POST /webhooks` (scope `webhooks:write`). The signing secret (`whsec_...`) is returned once, on
create and on `rotate-secret`; rotation takes effect immediately with no overlap. Set `format` to `slack` to send formatted text to a Slack Incoming Webhook; its URL is encrypted and masked in API responses. The default `json` format retains the signed JSON payload.

Delivery is at-least-once and unordered, with 8 attempts over about 24 hours; 20 consecutive failures disable the
webhook (`resume` re-enables it). Event names: `email_sent`, `email_opened`, `email_link_clicked`, `reply_received`,
`auto_reply_received`, `email_bounced`, `lead_unsubscribed`, `account_error`, `campaign_completed`, `escalation_overdue`, `deal_won`,
`deal_lost`, `quota_reached`, the interest events `lead_neutral`, `lead_out_of_office`, `lead_interested`,
`lead_meeting_booked`, `lead_meeting_completed`, `lead_closed`, `lead_not_interested`, `lead_wrong_person`,
`lead_lost`, `lead_no_show`, a lead label's name, or `all_events`.

`escalation_overdue` is emitted up to three times when a task with `escalateAfterHours` has no direct answer to the lead. Its payload includes `task_title` and `alert_count`; automation rules can reassign the lead and task.

Payload: `event_id, timestamp, event_type, workspace, campaign_id, campaign_name`, and when relevant `lead_email,
email_account, unibox_url, step, variant, is_first, email_id, email_subject, email_text, email_html,
reply_text_snippet, reply_subject, reply_text, reply_html` plus the lead's fields in snake_case and custom fields.
Unsubscribe links in stored mail bodies are replaced with `[unsubscribe link]`.

### Verifying a delivery

Each request carries:

- `X-RightNow-Event-Id`: the event id (stable across retries).
- `X-RightNow-Timestamp`: unix seconds of this attempt.
- `X-RightNow-Signature: t=<unix s>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<t>." + rawBody)`.

Replay protection: compute the HMAC over `t.<raw body>` (the exact bytes received, before JSON parsing), compare in
constant time, **reject a timestamp more than 300 seconds from your clock**, and **dedupe on `X-RightNow-Event-Id`**,
because a delivery can arrive more than once. The timestamp is refreshed on every attempt, so a late retry still
passes the 300 s check.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(rawBody, header, secret, seenEventIds, eventId) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const want = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const got = Buffer.from(v1, "hex");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
  if (seenEventIds.has(eventId)) return false;
  seenEventIds.add(eventId);
  return true;
}
```

Answer with any 2xx within 10 seconds; redirects are not followed.

## Instantly v2 to rightnow v1 (approximate)

| Instantly v2 | rightnow v1 |
|---|---|
| `/accounts` | `/accounts`, `/accounts/{id}` (+ `pause`, `resume`, `warmup`) |
| `/campaigns`, `/campaigns/{id}/activate`, `/pause` | `/campaigns`, `/campaigns/{id}/launch`, `/pause`, `/resume` |
| `/leads` | `/leads`, `/leads/{id}`, `/leads/bulk` |
| `/lead-lists` | `/lead-lists`, `/lead-lists/{id}/leads` |
| `/emails`, `/emails/reply` | `/inbox/threads`, `/inbox/threads/{id}/reply` |
| `/lead-labels` | `/lead-labels` |
| `/block-lists-entries` | `/blocklist` |
| `/campaigns/analytics` | `/analytics`, `/analytics/accounts`, `/analytics/bounces` |
| `/webhooks`, `/webhook-events` | `/webhooks`, `/webhooks/{id}/deliveries` |
| `/api-keys` | `/api-keys` |
| `/background-jobs/{id}` | `/jobs/{id}` |

## Out of scope

An official SDK, a CLI and an MCP server are not provided (PS-AUTO-14); generate a client from `openapi.json`.

## Routes, roles and scopes

"session only" routes reject API keys. The role is the minimum for that method; keys count as MEMBER.

`assign_owner` accepts a single `userId`, a `round_robin` strategy with `userIds`, or a `territory` strategy with country/region entries and an optional fallback owner. Strategy assignments keep an existing owner.
`forward_to_owner` queues a forward of the latest inbound thread to the lead's current owner. It sends nothing to the prospect and never retries an uncertain send.

<!-- routes:start -->
| Method | Path | Role | Scope |
|---|---|---|---|
| GET | `/accounts` | VIEWER | `accounts:read` |
| POST | `/accounts` | ADMIN | session only |
| GET | `/accounts/{id}` | VIEWER | `accounts:read` |
| PATCH | `/accounts/{id}` | MEMBER | `accounts:update` |
| DELETE | `/accounts/{id}` | ADMIN | session only |
| GET | `/accounts/{id}/campaigns` | VIEWER | `campaigns:read` |
| POST | `/accounts/{id}/credentials` | ADMIN | session only |
| POST | `/accounts/{id}/diagnostics` | MEMBER | `accounts:update` |
| POST | `/accounts/{id}/disconnect` | ADMIN | session only |
| POST | `/accounts/{id}/mark-fixed` | MEMBER | `accounts:update` |
| POST | `/accounts/{id}/pause` | MEMBER | `accounts:update` |
| POST | `/accounts/{id}/resume` | MEMBER | `accounts:update` |
| POST | `/accounts/{id}/resume-full` | MEMBER | `accounts:update` |
| POST | `/accounts/{id}/rewarm` | MEMBER | `accounts:update` |
| DELETE | `/accounts/{id}/rewarm` | MEMBER | `accounts:update` |
| POST | `/accounts/{id}/test-send` | ADMIN | session only |
| GET | `/accounts/{id}/warmup` | VIEWER | `accounts:read` |
| PATCH | `/accounts/{id}/warmup` | MEMBER | `accounts:update` |
| GET | `/accounts/{id}/warmup/stats` | VIEWER | `accounts:read` |
| POST | `/accounts/bulk` | MEMBER | `accounts:update` |
| POST | `/accounts/test-connection` | ADMIN | session only |
| POST | `/ai/campaign-analysis` | MEMBER | `ai:write` |
| POST | `/ai/draft` | MEMBER | `ai:write` |
| POST | `/ai/followup` | MEMBER | `ai:write` |
| POST | `/ai/personalize` | MEMBER | `ai:write` |
| POST | `/ai/recommend` | MEMBER | `ai:write` |
| POST | `/ai/reply-draft` | MEMBER | `ai:write` |
| POST | `/ai/score` | MEMBER | `ai:write` |
| GET | `/ai/status` | VIEWER | `ai:read` |
| GET | `/ai/suggestions` | VIEWER | `ai:read` |
| PATCH | `/ai/suggestions/{id}` | MEMBER | session only |
| POST | `/ai/summary` | MEMBER | `ai:write` |
| GET | `/analytics` | VIEWER | `analytics:read` |
| GET | `/analytics/accounts` | VIEWER | `analytics:read` |
| GET | `/analytics/activity` | VIEWER | `analytics:read` |
| GET | `/analytics/bounces` | VIEWER | `analytics:read` |
| GET | `/analytics/crm` | VIEWER | `analytics:read` |
| GET | `/api-keys` | ADMIN | session only |
| POST | `/api-keys` | ADMIN | session only |
| DELETE | `/api-keys/{id}` | ADMIN | session only |
| GET | `/audit-logs` | MEMBER | `audit:read` |
| GET | `/automations/builtin` | VIEWER | `automations:read` |
| PATCH | `/automations/builtin/{key}` | ADMIN | session only |
| GET | `/automations/rules` | VIEWER | `automations:read` |
| POST | `/automations/rules` | MEMBER | `automations:create` |
| GET | `/automations/rules/{id}` | VIEWER | `automations:read` |
| PATCH | `/automations/rules/{id}` | MEMBER | `automations:update` |
| DELETE | `/automations/rules/{id}` | MEMBER | `automations:delete` |
| GET | `/automations/rules/{id}/runs` | VIEWER | `automations:read` |
| GET | `/blocklist` | VIEWER | `blocklist:read` |
| POST | `/blocklist` | MEMBER | `blocklist:create` |
| DELETE | `/blocklist/{id}` | ADMIN | session only |
| POST | `/blocklist/bulk-delete` | ADMIN | session only |
| POST | `/blocklist/clear` | ADMIN | session only |
| GET | `/blocklist/export` | VIEWER | `blocklist:read` |
| POST | `/blocklist/import` | MEMBER | `blocklist:create` |
| GET | `/campaigns` | VIEWER | `campaigns:read` |
| POST | `/campaigns` | MEMBER | `campaigns:create` |
| GET | `/campaigns/{id}` | VIEWER | `campaigns:read` |
| PATCH | `/campaigns/{id}` | MEMBER | `campaigns:update` |
| DELETE | `/campaigns/{id}` | MEMBER | `campaigns:delete` |
| PUT | `/campaigns/{id}/accounts` | MEMBER | `campaigns:update` |
| POST | `/campaigns/{id}/archive` | MEMBER | `campaigns:update` |
| POST | `/campaigns/{id}/duplicate` | MEMBER | `campaigns:create` |
| GET | `/campaigns/{id}/export` | VIEWER | `campaigns:read` |
| POST | `/campaigns/{id}/launch` | MEMBER | `campaigns:update` |
| GET | `/campaigns/{id}/leads` | VIEWER | `campaigns:read` |
| POST | `/campaigns/{id}/leads` | MEMBER | `campaigns:update` |
| POST | `/campaigns/{id}/leads/{clId}` | MEMBER | `campaigns:update` |
| POST | `/campaigns/{id}/pause` | MEMBER | `campaigns:update` |
| POST | `/campaigns/{id}/preview` | VIEWER | `campaigns:read` |
| POST | `/campaigns/{id}/resume` | MEMBER | `campaigns:update` |
| PUT | `/campaigns/{id}/schedules` | MEMBER | `campaigns:update` |
| GET | `/campaigns/{id}/status` | VIEWER | `campaigns:read` |
| GET | `/campaigns/{id}/steps` | VIEWER | `campaigns:read` |
| POST | `/campaigns/{id}/steps` | MEMBER | `campaigns:update` |
| PATCH | `/campaigns/{id}/steps/{stepId}` | MEMBER | `campaigns:update` |
| DELETE | `/campaigns/{id}/steps/{stepId}` | MEMBER | `campaigns:update` |
| POST | `/campaigns/{id}/steps/{stepId}/variants` | MEMBER | `campaigns:update` |
| PATCH | `/campaigns/{id}/steps/{stepId}/variants/{variantId}` | MEMBER | `campaigns:update` |
| DELETE | `/campaigns/{id}/steps/{stepId}/variants/{variantId}` | MEMBER | `campaigns:update` |
| PUT | `/campaigns/{id}/steps/reorder` | MEMBER | `campaigns:update` |
| POST | `/campaigns/{id}/subsequences` | MEMBER | `campaigns:update` |
| PATCH | `/campaigns/{id}/subsequences/{subId}` | MEMBER | `campaigns:update` |
| POST | `/campaigns/{id}/test-send` | ADMIN | session only |
| POST | `/campaigns/import` | MEMBER | `campaigns:create` |
| GET | `/crm/activity` | VIEWER | `crm:read` |
| GET | `/crm/opportunities` | VIEWER | `crm:read` |
| POST | `/crm/opportunities` | MEMBER | `crm:create` |
| GET | `/crm/opportunities/{id}` | VIEWER | `crm:read` |
| PATCH | `/crm/opportunities/{id}` | MEMBER | `crm:update` |
| DELETE | `/crm/opportunities/{id}` | MEMBER | `crm:delete` |
| GET | `/crm/stages` | VIEWER | `crm:read` |
| POST | `/crm/stages` | ADMIN | session only |
| PATCH | `/crm/stages/{id}` | ADMIN | session only |
| DELETE | `/crm/stages/{id}` | ADMIN | session only |
| GET | `/crm/tasks` | VIEWER | `crm:read` |
| POST | `/crm/tasks` | MEMBER | `crm:create` |
| PATCH | `/crm/tasks/{id}` | MEMBER | `crm:update` |
| DELETE | `/crm/tasks/{id}` | MEMBER | `crm:delete` |
| GET | `/dashboard` | VIEWER | `analytics:read` |
| GET | `/deliverability` | VIEWER | `accounts:read` |
| GET | `/domains` | VIEWER | `accounts:read` |
| PATCH | `/domains/{domain}` | MEMBER | `accounts:update` |
| POST | `/domains/{domain}/check` | MEMBER | `accounts:update` |
| POST | `/imports` | MEMBER | `leads:create` |
| GET | `/imports/{id}` | VIEWER | `leads:read` |
| POST | `/imports/preview` | MEMBER | `leads:create` |
| GET | `/inbox/attachments/{id}` | VIEWER | `inbox:read` |
| GET | `/inbox/macros` | VIEWER | `inbox:read` |
| POST | `/inbox/macros` | MEMBER | `inbox:write` |
| PATCH | `/inbox/macros/{id}` | MEMBER | `inbox:write` |
| DELETE | `/inbox/macros/{id}` | MEMBER | `inbox:write` |
| POST | `/inbox/macros/{id}/render` | VIEWER | `inbox:read` |
| POST | `/inbox/messages/{id}/ai-feedback` | MEMBER | `inbox:write` |
| GET | `/inbox/notes` | VIEWER | `inbox:read` |
| POST | `/inbox/notes` | MEMBER | `inbox:write` |
| PATCH | `/inbox/notes/{id}` | MEMBER | `inbox:write` |
| DELETE | `/inbox/notes/{id}` | MEMBER | `inbox:write` |
| GET | `/inbox/threads` | VIEWER | `inbox:read` |
| GET | `/inbox/threads/{id}` | VIEWER | `inbox:read` |
| PATCH | `/inbox/threads/{id}` | MEMBER | `inbox:write` |
| DELETE | `/inbox/threads/{id}` | MEMBER | `inbox:write` |
| POST | `/inbox/threads/{id}/attach-lead` | MEMBER | `inbox:write` |
| POST | `/inbox/threads/{id}/create-lead` | MEMBER | `inbox:write` |
| POST | `/inbox/threads/{id}/handoff` | VIEWER | `inbox:read` |
| POST | `/inbox/threads/{id}/read-all` | MEMBER | `inbox:write` |
| POST | `/inbox/threads/{id}/reply` | MEMBER | `inbox:write` |
| POST | `/inbox/threads/bulk` | MEMBER | `inbox:write` |
| GET | `/inbox/unread-count` | VIEWER | `inbox:read` |
| GET | `/inbox/views` | VIEWER | `inbox:read` or `leads:read` |
| POST | `/inbox/views` | MEMBER | `inbox:write` or `leads:create` |
| PATCH | `/inbox/views/{id}` | MEMBER | `inbox:write` or `leads:update` |
| DELETE | `/inbox/views/{id}` | MEMBER | `inbox:write` or `leads:delete` |
| GET | `/invites` | ADMIN | session only |
| POST | `/invites` | ADMIN | session only |
| DELETE | `/invites/{id}` | ADMIN | session only |
| GET | `/jobs` | VIEWER | `jobs:read` |
| GET | `/jobs/{id}` | VIEWER | `jobs:read` |
| GET | `/lead-labels` | VIEWER | `leads:read` |
| POST | `/lead-labels` | MEMBER | `leads:create` |
| PATCH | `/lead-labels/{id}` | MEMBER | `leads:update` |
| DELETE | `/lead-labels/{id}` | MEMBER | `leads:delete` |
| GET | `/lead-lists` | VIEWER | `leads:read` |
| POST | `/lead-lists` | MEMBER | `leads:create` |
| PATCH | `/lead-lists/{id}` | MEMBER | `leads:update` |
| DELETE | `/lead-lists/{id}` | MEMBER | `leads:delete` |
| POST | `/lead-lists/{id}/leads` | MEMBER | `leads:update` |
| DELETE | `/lead-lists/{id}/leads` | MEMBER | `leads:update` |
| POST | `/lead-lists/{id}/move` | MEMBER | `leads:update` |
| GET | `/lead-lists/{id}/stats` | VIEWER | `leads:read` |
| GET | `/lead-sources` | ADMIN | session only |
| POST | `/lead-sources` | ADMIN | session only |
| PATCH | `/lead-sources/{id}` | ADMIN | session only |
| DELETE | `/lead-sources/{id}` | ADMIN | session only |
| GET | `/leads` | VIEWER | `leads:read` |
| POST | `/leads` | MEMBER | `leads:create` |
| GET | `/leads/{id}` | VIEWER | `leads:read` |
| PATCH | `/leads/{id}` | MEMBER | `leads:update` |
| DELETE | `/leads/{id}` | MEMBER | `leads:delete` |
| GET | `/leads/{id}/export` | MEMBER | `leads:read` |
| POST | `/leads/{id}/gdpr-delete` | ADMIN | session only |
| GET | `/leads/{id}/timeline` | VIEWER | `leads:read` |
| POST | `/leads/bulk` | MEMBER | `leads:update` |
| GET | `/leads/capacity` | VIEWER | `leads:read` |
| GET | `/leads/export` | VIEWER | `leads:read` |
| POST | `/leads/merge` | MEMBER | `leads:update` |
| POST | `/leads/verify` | MEMBER | `leads:update` |
| GET | `/members` | VIEWER | `workspace:read` |
| PATCH | `/members/{id}` | ADMIN | session only |
| DELETE | `/members/{id}` | ADMIN | session only |
| GET | `/oauth/{provider}/callback` | ADMIN | session only |
| POST | `/oauth/{provider}/start` | ADMIN | session only |
| GET | `/oauth/sessions/{id}` | VIEWER | session only |
| DELETE | `/oauth/sessions/{id}` | ADMIN | session only |
| GET | `/openapi.json` | VIEWER | public |
| GET | `/placement-tests` | VIEWER | `accounts:read` |
| POST | `/placement-tests` | ADMIN | session only |
| GET | `/placement-tests/{id}` | VIEWER | `accounts:read` |
| GET | `/scheduled-messages` | VIEWER | `campaigns:read` |
| POST | `/scheduled-messages/{id}/cancel` | MEMBER | `campaigns:update` |
| POST | `/scheduled-messages/{id}/release` | ADMIN | session only |
| POST | `/scheduled-messages/{id}/retry` | MEMBER | `campaigns:update` |
| GET | `/settings/ai` | ADMIN | session only |
| PUT | `/settings/ai` | ADMIN | session only |
| GET | `/settings/apollo` | ADMIN | session only |
| PUT | `/settings/apollo` | ADMIN | session only |
| GET | `/settings/verifier` | ADMIN | session only |
| PUT | `/settings/verifier` | ADMIN | session only |
| GET | `/settings/workspace` | ADMIN | session only |
| PATCH | `/settings/workspace` | ADMIN | session only |
| GET | `/tags` | VIEWER | `workspace:read` |
| GET | `/webhooks` | VIEWER | `webhooks:read` |
| POST | `/webhooks` | MEMBER | `webhooks:write` |
| GET | `/webhooks/{id}` | VIEWER | `webhooks:read` |
| PATCH | `/webhooks/{id}` | MEMBER | `webhooks:write` |
| DELETE | `/webhooks/{id}` | MEMBER | `webhooks:write` |
| GET | `/webhooks/{id}/deliveries` | VIEWER | `webhooks:read` |
| POST | `/webhooks/{id}/resume` | MEMBER | `webhooks:write` |
| POST | `/webhooks/{id}/rotate-secret` | MEMBER | `webhooks:write` |
| POST | `/webhooks/{id}/test` | MEMBER | `webhooks:write` |
| POST | `/webhooks/deliveries/{id}/redeliver` | MEMBER | `webhooks:write` |
| GET | `/webhooks/overview` | VIEWER | `webhooks:read` |
<!-- routes:end -->
