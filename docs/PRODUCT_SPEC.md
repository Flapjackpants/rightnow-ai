# rightnow.ai Product Specification (Instantly.ai feature parity)

Status: research draft, 2026-10-19. Sources are Instantly's public help center (help.instantly.ai), developer docs (developer.instantly.ai, API v2) and public pages. Nothing here is copied from Instantly beyond short phrases; no Instantly code, assets or branding are reused.

## 0. Introduction

**Goal.** An original, MIT-licensed, self-hosted cold-email platform that reproduces the publicly observable workflows of Instantly.ai: connect mailboxes, warm up/re-warm, build multi-step campaigns, send through reliable queues, manage leads, triage replies in a unified inbox, run a light CRM, report analytics, and automate via rules/webhooks.

**Tenancy.** One business owner at launch, but every row is scoped by `workspaceId` so multiple workspaces can be added later (Instantly itself is workspace-scoped: API keys, blocklists, quotas, analytics are per workspace; S22, S23).

**Honesty constraints (from the master spec; binding on every item below).**
1. No fabricated engagement. Warm-up traffic only between explicitly opted-in/authorized mailboxes, stored separately from customer metrics.
2. No claim that warm-up or any setting guarantees inbox placement; reactivation schedules are labeled "configurable plan".
3. "Provider accepted" is never reported as "delivered".
4. No spam-filter circumvention, no impersonation, no fake sender identities; respect real provider limits.
5. Anything Instantly does that depends on its private infrastructure (warm-up pool, AirMail/DFY mailboxes, SuperSearch database, shared reputation data) is listed in section 19 as not reproducible and is replaced by an honest alternative.
6. Live sending stays behind the Provider Compliance Gate (PS-DEPLOY-14).

**Item format.** `- [ ] PS-<AREA>-NN: requirement — Instantly behavior/defaults (source key)`. Source keys resolve in section 20. "(undocumented)" means Instantly's public docs do not state the behavior; rightnow picks a documented-in-DECISIONS.md default. `[optional]` appears only where the master prompt says optional.

Areas: UI, ACC, WARM, CAMP, SEQ, SEND, LEAD, INBOX, TRACK, CRM, ANALYTICS, AUTO, AI, SEC, REWARM, SYNC, DEPLOY.

**Superseded by `docs/DECISIONS.md` D1:** every mention of Redis/BullMQ in this file (incl. PS-DEPLOY-02/08/10/12, PS-SEND-01/05, PS-REWARM-06/12) means the Postgres job queue (pg-boss + `ScheduledMessage` row claiming). The behavior required by those items still applies.

---

## 1. Technical Architecture (master §1)

- [x] PS-DEPLOY-01: Monorepo with separate packages for web frontend, API, provider integrations, campaign scheduler, sending workers, inbox sync, analytics, CRM — Instantly is a single hosted SaaS; internal structure not public (undocumented).
- [x] PS-DEPLOY-02: Default stack Next.js/React/TS/Tailwind/shadcn-ui, Node backend, PostgreSQL+Prisma, Redis+BullMQ, Auth.js, Recharts, Docker Compose, Vitest+Playwright — master-spec choice, no Instantly counterpart. (Redis/BullMQ → pg-boss, Auth.js → better-auth; see DECISIONS)
- [x] PS-SEC-01: Every table carries `workspaceId`; all queries filtered by it; single-owner UI at launch but workspace switcher data model present — Instantly: workspaces own accounts, leads, campaigns, API keys, blocklists; accounts can be moved between workspaces; workspace members have roles (S23 Workspace, Workspace Member, "Move accounts between workspaces").
- [x] PS-SEC-02: Workspace-scoped API keys with scoped permissions (`resource:action`, e.g. `accounts:create`, `leads:read`, `all:all`) — Instantly API v2 uses bearer keys with scopes of that form (S4, S5, S10).
- [x] PS-DEPLOY-03: Repo ships MIT LICENSE, setup docs, Prisma migrations, Dockerfile/compose, `.env.example`, tests, deployment instructions — master §1.
- [x] PS-DEPLOY-04: REST API v1 prefix `/api/v1`, JSON, bearer auth, 429 on rate-limit, 402-equivalent not needed (no billing) — Instantly API v2: base `/api/v2`, bearer, limits 100 req/s and 6,000 req/min per workspace shared across keys, 429 on excess (S22).
- [x] PS-DEPLOY-05: API error contract: 400 invalid body (reject unknown properties), 401 bad/revoked key, 404, 429 — Instantly schemas set additionalProperties false on create bodies (S3, S4, S5).
- [x] PS-DEPLOY-06: OpenAPI document published for the rightnow API — Instantly publishes OpenAPI (api_v2.json) (S23).

---

## 2. Product Interface (master §2)

- [x] PS-UI-01: Left navigation with exactly: Dashboard, Email Accounts, Warm-Up & Deliverability, Campaigns, Leads, Unified Inbox, CRM, Analytics, Automations, Settings — master §2; Instantly's own nav groups Campaigns, Accounts, Unibox, CRM, Analytics, Lead Finder/SuperSearch (no SuperSearch clone) (S15).
- [x] PS-UI-02: Responsive layouts, searchable/sortable/paginated tables, saved filters, bulk-select action bar — Instantly list views support filter+search and bulk action bars (S14).
- [x] PS-UI-03: Every control wired to real backend behavior; no dead buttons; Playwright smoke test walks each nav item — master §2.
- [x] PS-UI-04: Dashboard widgets: sends today vs capacity, active campaigns progress, reply/positive/bounce rates, account health strip, remaining daily capacity, pending reminders/tasks — master §11 + Instantly workspace analytics (S16).
- [x] PS-UI-05: Original visual design, light/dark theme, accessible components (keyboard, labels, contrast) — master §2.
- [x] PS-UI-06: Global status badges for accounts and campaigns using the status sets in PS-ACC-14 and PS-CAMP-20 — Instantly numeric status enums (S4, S9).
- [x] PS-UI-07: Global date-range and workspace-timezone display; analytics bucketed in UTC unless user chooses otherwise — Instantly reports in UTC (S16).
- [x] PS-UI-08: Tags (custom tags) assignable to accounts and campaigns, filterable everywhere — Instantly custom tags map to accounts/campaigns; `email_tag_list` on campaign limits sending accounts (S3, S23 Custom Tag).

---

## 3. Connected Email Accounts (master §3)

### 3.1 Connection flows
- [x] PS-ACC-01: "Connect with Google" OAuth 2.0 (authorization code, offline access) and Gmail API send/read — Instantly offers Google and Microsoft OAuth init endpoints returning an auth URL (S8).
- [x] PS-ACC-02: OAuth session object: `sessionId`, `authUrl`, 10-minute expiry; client polls status every ~5 s: `pending|success|error|expired`; result consumed on first read; error codes include `account_exists`, `server_error`, `expired` — Instantly OAuth connection flow (S8).
- [x] PS-ACC-03: Microsoft 365/Outlook via Microsoft OAuth + Graph (send, delta read) — Instantly provider code 3 (S4, S8).
- [x] PS-ACC-04: Custom IMAP/SMTP connection: email, first/last name, IMAP host/port/username/password, SMTP host/port/username/password, test-connection before save — Instantly provider code 1 requires all twelve fields (S4).
- [x] PS-ACC-05: Provider enum in rightnow: custom_imap, google, microsoft (AWS/AirMail/DFY from Instantly are out of scope, see section 19) — Instantly codes 1,2,3,4,8,11 (S4).
- [x] PS-ACC-06: Google Workspace and free Gmail both supported; document Google Cloud Console project setup, OAuth consent screen, least-privilege scopes, and verification steps — master §3.
- [x] PS-ACC-07: Refresh tokens and IMAP/SMTP passwords stored encrypted at rest (AES-256-GCM, key from secret store); never returned by the API — Instantly responses omit IMAP/SMTP credentials (S4).
- [x] PS-ACC-08: Reconnect flow keeps account id, settings, history, campaign assignments (no delete+reconnect) — Instantly docs tell users to delete and reconnect after token errors (S18); rightnow deliberately does better (master reactivation §2).
- [x] PS-ACC-09: Revocation: user can disconnect (revoke token at provider, stop jobs, keep history) — master §3.
- [x] PS-ACC-10: Multiple independent mailboxes per workspace; duplicate email blocked with `account_exists` — S8.
- [x] PS-ACC-11: Bulk account management: multi-select pause/resume, set daily limit, set sending gap, set signature, apply tags, enable/disable warm-up, delete — Instantly exposes pause-multiple and enable/disable warm-up for many accounts (S23 Account).

### 3.2 Per-account settings
- [x] PS-ACC-12: Per-account `dailyLimit` (campaign emails/day) — Instantly guidance 30 campaign emails/account/day, 10 warm-up/day; plain-number field, nullable (S25, S4, S18).
- [x] PS-ACC-13: Per-account `sendingGap` in minutes, integer 0–1440 — Instantly `sending_gap` range 0–1440 (S4). Campaign-level min gap default 9 min + random 5 min is separate (PS-CAMP-12).
- [x] PS-ACC-14: Account status enum: Active, Paused, Temporarily paused (auto-resumes), Connection Error, Soft Bounce Error, Sending Error; plus rightnow adds Re-Warming, Inactive, Needs Attention as derived display states — Instantly status 1,2,3,-1,-2,-3 (S4).
- [x] PS-ACC-15: Status message object with provider code, command, response, message for diagnostics (shown in UI) — Instantly `status_message` {code, command, response, e_message, responseCode} (S4).
- [x] PS-ACC-16: "Enable slow ramp" per-account toggle: new accounts start low and gain a fixed amount per day until the daily limit — Instantly: starts at 2 emails and adds 2/day (S25); an Instantly blog says warm-up +1/day and campaign slow ramp +2/day, sources disagree (S24). Use +2/day default, configurable.
- [x] PS-ACC-17: Signature (rich text/HTML) per account, appended to sends — Instantly `signature` field (S4).
- [x] PS-ACC-18: `replyTo` address per account — Instantly `reply_to` (S4).
- [x] PS-ACC-19: Custom tracking domain per account with CNAME verification and status; `skipCnameCheck` escape hatch for admins only — Instantly `tracking_domain_name/status`, `skip_cname_check` (S4); open-tracking guide recommends it per account (S17).
- [x] PS-ACC-20: First/last name per account used by `{{sendingAccountFirstName}}`/`{{sendingAccountLastName}}` variables (see PS-SEQ-12) — Instantly account has first_name/last_name (S4).
- [x] PS-ACC-21: Tags per account; campaigns may restrict sending to accounts with given tags — S3 `email_tag_list`.
- [x] PS-ACC-22: Account-to-campaign mapping view: given an account, list campaigns using it — Instantly "Get campaigns associated with an email" (S23).
- [x] PS-ACC-23: Per-account daily activity and remaining limit shown in the accounts table (sent today / limit / remaining) — master §3; Instantly has daily account analytics (S23).
- [x] PS-ACC-24: "Test account vitals" / connectivity diagnostics: IMAP login, SMTP auth, token validity, MX/SPF/DKIM/DMARC presence, custom-domain CNAME — Instantly "Test domain setup" checks MX, SPF, DKIM, DMARC (S18, S23).
- [x] PS-ACC-25: "Mark as fixed" action clears an error status after the user remediates and a re-test passes — Instantly has "Mark an account as fixed" endpoint (S23).
- [x] PS-ACC-26: Autofix state for transient errors (in progress / failed / succeeded) — Instantly `autofix_failed` tri-state (S4).
- [x] PS-ACC-27: Pause/resume single and multiple accounts; paused accounts excluded from rotation immediately, queued jobs rescheduled — S23.
- [x] PS-ACC-28: Delete account preserves historical emails/events for analytics (soft delete) — undocumented in Instantly; rightnow decision.
- [x] PS-ACC-29: Microsoft SMTP-disabled remediation hint shown on connection error — Instantly help: enable SMTP, remove account, wait ~1 hour, reconnect (S18).
- [x] PS-ACC-30: Provider-specific real limits shown as warnings (Gmail/Workspace/Microsoft); user limit cannot exceed a configurable hard ceiling — master §5.

### 3.3 Inbox synchronization
See section 17 (SYNC) for requirements; account-level items:
- [x] PS-ACC-31: Historical import window per account (default 30 days, configurable) with progress indicator and dedupe — master §3.

---

## 4. Campaign Creation and Automation (master §4)

### 4.1 Lifecycle
- [x] PS-CAMP-01: Create, duplicate, edit, archive, delete, pause, resume campaigns — Instantly has create, activate/resume, stop/pause, duplicate, delete, export to JSON, share/clone from shared (S23 Campaign).
- [x] PS-CAMP-02: Campaign export/import as JSON (sequence + settings, no leads) — Instantly export-to-JSON and create-from-shared (S23).
- [x] PS-CAMP-03: Draft campaigns cannot send; subsequences tab appears only after first launch — Instantly (S13).
- [x] PS-CAMP-04: Campaign statuses: Draft, Active, Paused, Completed, Running Subsequences, Accounts Unhealthy, Bounce Protect, Account Suspended — Instantly codes 0,1,2,3,4,-1,-2,-99 (S9).
- [x] PS-CAMP-05: Campaign "Completed" when every lead has finished the sequence or been stopped; "evergreen" flag keeps it open for new leads — S3 `is_evergreen`, S9.
- [x] PS-CAMP-06: Campaign wizard sections: Leads, Sequences, Schedule, Options (with Sending accounts) — Instantly campaign builder tabs (S1; layout partly undocumented).
- [x] PS-CAMP-07: Assign multiple sending accounts; system rotates among them; no account-count limit — Instantly "Accounts to use" (S1).
- [x] PS-CAMP-08: Campaign can reference lead lists or direct uploads; leads attach to campaign (S5 `campaign`, `list_id`).
- [x] PS-CAMP-09: Per-campaign `owner` (workspace user) for filtering and CRM reporting; custom tags on campaigns — Instantly Owner and Custom Tags (S1, S3 `owned_by`).
- [x] PS-CAMP-10: Positive-lead value `plValue` per campaign (value of each positive lead) feeding pipeline value reports — S3 `pl_value`.

### 4.2 Schedule
- [x] PS-CAMP-11: One or more named schedules per campaign, each with: days of week (seven booleans), from/to time (24h HH:MM), IANA timezone (required); campaign-level optional start_date and end_date (YYYY-MM-DD in campaign timezone) — Instantly `campaign_schedule.schedules[]` min 1, `timing.from/to`, `days` keys "0"–"6" (mapping to weekdays not defined in the docs; rightnow uses 0=Sunday), timezone enum of ~100 zones (S3).
- [x] PS-CAMP-12: Schedule presets: any day/any time, office hours, custom — Instantly options (S1).
- [x] PS-CAMP-13: Min time gap between emails default 9 minutes; random additional time default 5 minutes (so 9–14 min between sends per account); warn below 5 minutes — Instantly (S1, S25); API `email_gap` and `random_wait_max` in minutes (S3).
- [ ] PS-CAMP-14: Lead local-time sending ("send in recipient timezone") — undocumented as a campaign option; optional extension, not parity. (DEFERRED, D19)

### 4.3 Options
- [x] PS-CAMP-15: Daily limit = cap on total campaign emails per day across all assigned accounts; recommend 30 x accounts — Instantly (S1, S25). Effective cap per account = min(account limit, share of campaign limit, warm-up/reactivation allowance).
- [x] PS-CAMP-16: Max new leads per day (`dailyMaxLeads`, integer >= 0): caps how many leads receive Step 1 daily — S1, S3 `daily_max_leads`.
- [x] PS-CAMP-17: Prioritize new leads (default off: follow-ups go first) — S1, S3.
- [x] PS-CAMP-18: Stop sending on reply (recommended on) — stops sequence for the replying lead only — S1.
- [x] PS-CAMP-19: Stop campaign for company on reply: when one lead at a company (same domain) replies, remaining leads at that domain become Completed; auto-replies do not trigger it — S1, S3 `stop_for_company`.
- [x] PS-CAMP-20: Stop on auto-reply (OOO etc.): off by default recommended when using out-of-office smart pause (resume date); when on, auto-reply stops the lead — S1, S3 `stop_on_auto_reply`.
- [x] PS-CAMP-21: Open tracking toggle and link tracking toggle per campaign; global org-level overrides (disable open tracking / always text-only first email) win over campaign settings — S1, S17.
- [x] PS-CAMP-22: Delivery optimization: send as text-only (all steps) and send first email as text-only; enabling text-only disables open tracking and strips images/HTML styling — S1, S3 `text_only`, `first_email_text_only`, S17.
- [x] PS-CAMP-23: Provider matching (`matchLeadEsp`): prefer sender with same ESP as recipient (Gmail to Gmail, Outlook to Outlook); needs at least one matching account — S1, S3. ESP detection for lead stored in lead record (Google, Microsoft, Zoho, Yahoo, Yandex, Other) — S5 ESP codes.
- [x] PS-CAMP-24: ESP routing rules: list of {action send|do_not_send, recipientEsp[all|google|outlook|other], senderEsp[all|google|outlook|other]} evaluated at account selection — S3 `provider_routing_rules`.
- [x] PS-CAMP-25: Insert unsubscribe header (List-Unsubscribe + one-click) toggle; rightnow default ON for compliance — S1 `insert_unsubscribe_header` (default undocumented).
- [x] PS-CAMP-26: Allow risky emails (leads whose verification is Risky/Catch-all) toggle, default off; Disable BounceProtect toggle with warning — S1, S3.
- [x] PS-CAMP-27: BounceProtect: automatically pause campaign (status Bounce Protect) when bounce rate threshold exceeded; rightnow default: pause when hard-bounce rate > 3% over >= 50 sends in rolling 24h (configurable) — Instantly feature exists, threshold undocumented in fetched pages (S21 refers to a "High Bounce Auto-Pause" article).
- [x] PS-CAMP-28: Limit emails per company (domain): caps daily emails to leads sharing a domain; scope per campaign or workspace; mode custom/disabled; min 1 — S1, S3 `limit_emails_per_company_override`.
- [x] PS-CAMP-29: CC and BCC recipient lists on every campaign email (CC visible, BCC hidden) — S1, S3.
- [x] PS-CAMP-30: Auto-optimize A/Z test: pick winning metric (reply rate, click rate, open rate); disable underperforming variants automatically; thresholds undocumented, rightnow requires min sample (default 100 sends per variant) before disabling — S1, S3 `auto_variant_select.trigger`, S20.
- [x] PS-CAMP-31: Reset A/Z variant usage tracking daily (preference) — default balances variant usage over campaign lifetime — S20.
- [x] PS-CAMP-32: Preview personalized message per lead before launch (render with real lead data, spintax resolved, fallback shown) and send-test-email action — master §4; Instantly send-a-test-email (S23, S12).
- [x] PS-CAMP-33: Pre-launch validation: no sending accounts, no leads, missing subject/body, unresolved variable, invalid schedule, unverified tracking domain, compliance gate disabled provider — master §4.
- [x] PS-CAMP-34: Campaign sending status endpoint/UI explains why a campaign is not sending (outside window, quota reached, accounts unhealthy, no eligible leads, startup sync pending) — Instantly "Get campaign sending status" (S23).
- [x] PS-CAMP-35: Campaign-level lead statuses: Active, Paused, Completed, Bounced, Unsubscribed, Skipped — S5.
- [x] PS-CAMP-36: Conflict prevention: a contact already in an active campaign is not added to another unless the user disables dedupe; global rule prevents two active sequences on the same email — master §7; Instantly workspace-wide duplicate check on import (S19).

---

## 5. Sequences, Personalization, A/B, Spintax (master §4)

- [x] PS-SEQ-01: Unlimited ordered steps per sequence; step type `email` only at launch — Instantly step type enum has only `email` (S3).
- [x] PS-SEQ-02: Step delay = number + unit (minutes|hours|days; default unit days); max total delay 366 days; step 1 delay 0 — S3.
- [x] PS-SEQ-03: Delay counted from previous step's actual send time and only fires inside a schedule window — S1/S3 (exact semantics undocumented).
- [x] PS-SEQ-04: Each step has >= 1 variant (A/Z), each with subject and HTML body; up to 26 variants per step; variants can be disabled individually — S3 `v_disabled`, S20 (26 max).
- [x] PS-SEQ-05: Variant assignment is balanced over campaign lifetime by default (new variants catch up); optional daily reset; assignment recorded per send — S20.
- [x] PS-SEQ-06: Follow-up steps may reuse previous subject (empty subject = reply in same thread) — undocumented in fetched pages; rightnow: empty subject on step N>1 sends as threaded reply (In-Reply-To/References).
- [x] PS-SEQ-07: Sequence stops for a lead on reply, unsubscribe, hard bounce, manual removal/status change to non-active, global blocklist hit — S1, S5 statuses; master §4.
- [x] PS-SEQ-08: Out-of-office handling: detect auto-reply, optionally pause the lead and resume sending after the OOO return date ("AI Smart Pause"/OOO Resume); resume date visible in lead details — S1, S14.
- [x] PS-SEQ-09: Subsequences: separate mini-sequences attached to a campaign, triggered by (a) lead status/label (default or custom, multiple allowed), (b) activity: email opened, link clicked, campaign completed without reply, (c) reply keywords (semicolon-separated exact phrases) — S13.
- [x] PS-SEQ-10: Subsequence settings: pre-delay before step 1 (minutes/hours/days), inherits campaign schedule and daily limit by default (custom or "no limit"), optional ignore-account-limits (with warning; rightnow disallows it for warming/re-warming accounts), pause/resume, duplicate, analytics — S13, S3 `pre_delay`. (ignore-account-limits not offered, D19)
- [x] PS-SEQ-11: Only leads labeled after the subsequence is active enter automatically; existing leads can be moved manually; lead has `subsequenceId`; a lead can be removed from a subsequence; sends occur within ~10 minutes of entry if schedule/limits allow — S13, S5, S23.
- [x] PS-SEQ-12: Variables (camelCase, case-sensitive, matching CSV headers): `{{firstName}} {{lastName}} {{companyName}} {{jobTitle}} {{website}} {{phone}} {{personalization}} {{email}}`, custom lead fields by column name, sender variables `{{sendingAccountFirstName}} {{sendingAccountLastName}} {{sendingAccountEmail}}` (rightnow naming; sender variable names are inferred, the fetched Instantly pages did not list them) — S5 payload known keys, S12.
- [x] PS-SEQ-13: `{{industry}}` and other master-listed fields exist as standard lead columns — master §4.
- [x] PS-SEQ-14: Fallback syntax `{{var | fallback}}`; fallbacks can chain (`{{firstName | lastName | for you}}` style) inside spintax options — S12.
- [x] PS-SEQ-15: Spintax `{{RANDOM | a | b | c}}` picks one option per lead, deterministic per (lead, step, variant) so retries do not reshuffle; variables allowed inside options; usable in subject and body — S12.
- [x] PS-SEQ-16: Conditional blocks `{% if var == "value" %}...{% endif %}` (LiquidJS subset), case-sensitive compare; hidden-variable trick not needed since rightnow resolves variables from lead payload directly — S12.
- [x] PS-SEQ-17: `{{personalization}}` is a free-text lead field (typically AI-written opener) inserted verbatim — S5.
- [x] PS-SEQ-18: Template validation: unknown variable, unmatched braces, missing `RANDOM` keyword, empty fallback, variable absent from >0 leads (warn count) — S12 troubleshooting; master §4 validation.
- [x] PS-SEQ-19: Unsubscribe link/variable `{{unsubscribeLink}}` available in body and auto-appended footer if absent when compliance setting on — master §14 (Instantly variable name undocumented).
- [x] PS-SEQ-20: Body stored as HTML with plain-text alternative auto-generated; `<br/>` line breaks — S3.
- [x] PS-SEQ-21: Per-step and per-variant analytics: sent, opened, replied, clicked, reply rate, positive reply rate, opportunities, meetings booked, won; date-range selectable — S20, S23 steps analytics.
- [x] PS-SEQ-22: Reply-dependent branching only via subsequences (no full visual flow builder) — S13.

---

## 6. Backend Email Sending Pipeline (master §5)

- [x] PS-SEND-01: BullMQ queues: per-account send queue, campaign scheduler queue, retry/dead-letter queue, sync queue; jobs persisted in Redis with AOF — master §5.
- [x] PS-SEND-02: Scheduler selects next (lead, step) per campaign honoring: schedule window, campaign daily cap, max-new-leads cap, per-company cap, prioritize-new-leads flag, account cap, account gap — S1, S3.
- [x] PS-SEND-03: Account rotation round-robin weighted by remaining capacity; provider matching and ESP routing applied before rotation — S1, S3.
- [x] PS-SEND-04: Per-account gap = campaign min gap (default 9 min) + uniform random 0..random_wait_max (default 5 min), also >= account `sendingGap` — S1, S4.
- [x] PS-SEND-05: Atomic quota reservation (Redis Lua or Postgres row lock) before enqueue; released on definite failure; counted on provider acceptance; day boundary in campaign/account timezone — master §5.
- [x] PS-SEND-06: Workspace-wide daily quota in addition to per-account/per-campaign — master §5.
- [x] PS-SEND-07: Idempotency key per (leadId, campaignId, step, variant); unique DB constraint; "uncertain" state when a send outcome is unknown after crash; uncertain sends are reconciled against the sent folder before any retry, never blindly resent — master §5, Local-First.
- [x] PS-SEND-08: Worker crash recovery: stalled-job detection, lease expiry, reconciliation of in-flight sends — master §5.
- [x] PS-SEND-09: Provider rate-limit handling: honor 429/`Retry-After`, Gmail/Graph throttling errors, SMTP 4xx; exponential backoff with jitter and max attempts, then mark failed — master §5.
- [x] PS-SEND-10: Message states: scheduled, reserved, sending, provider_accepted, failed, bounced_hard, bounced_soft, delivered_unknown (never "delivered" unless a provider receipt/DSN says so) — master §5.
- [x] PS-SEND-11: Auto-pause account on sustained failure (default: 5 consecutive auth failures or bounce rate > threshold) and set status Sending Error / Soft Bounce Error; auto-pause campaign (Accounts Unhealthy) when all its accounts are unhealthy — S4, S9. (auth failure flags NEEDS_ATTENTION at once, D51)
- [x] PS-SEND-12: Gradual volume ramp-up respected by scheduler (new accounts, re-warming accounts) — S25 slow ramp, REWARM section.
- [x] PS-SEND-13: Jobs continue with browser closed; no sending-related logic in the request path — master §5.
- [x] PS-SEND-14: Headers on outgoing mail: honest From, Reply-To, Message-ID, In-Reply-To/References for follow-ups, List-Unsubscribe when enabled; custom tracking domain used for pixel/link rewriting — S1, S3, S4.
- [x] PS-SEND-15: Sent message is appended to the account's Sent folder (SMTP/IMAP) or visible via provider API so threading and sync see it — master §3.
- [x] PS-SEND-16: Never send when startup reconciliation incomplete (see SYNC) — Local-First.
- [x] PS-SEND-17: Failure monitoring: per-account/per-campaign failure counters, dead-letter view in UI, alerting hook — master §5.
- [x] PS-SEND-18: Send test email to arbitrary address from a chosen account (counts against nothing, flagged as test) — S23.

---

## 7. Warm-Up and Deliverability (master §6)

- [x] PS-WARM-01: Per-account warm-up enable/disable; bulk toggle — S23 enable/disable warm-up for accounts.
- [x] PS-WARM-02: Setting "daily warm-up limit" (max warm-up emails/day), suggested 10 for new accounts, separate from campaign daily limit — S2, S25.
- [x] PS-WARM-03: Setting "increase per day" (ramp): API enum disabled|0|1|2|3|4; UI default 1 (day 1 sends 1, +1 daily until limit) — S2, S4.
- [x] PS-WARM-04: Setting "reply rate %" suggested 30 for new accounts: share of warm-up messages that receive a reply (only meaningful between opted-in participants) — S2.
- [x] PS-WARM-05: "Disable slow warm-up" skips the ramp; for already-warmed accounts only, warn otherwise — S2.
- [x] PS-WARM-06: Weekdays-only mode: do not send warm-up on weekends (still receive) — S2.
- [x] PS-WARM-07: Warm-up filter tag: a label (customizable, "generate random") applied to warm-up messages so they can be auto-filed out of the primary inbox and excluded from inbox sync/analytics; change applies next cycle — S2.
- [ ] PS-WARM-08: Advanced warm-up knobs exist in Instantly: read emulation (headless browser "reading"), open rate %, spam-protection % (rescue from spam), mark-important %, warm custom tracking domain — S2, S4. rightnow honesty rule: only implement what is real between opted-in mailboxes (opening/marking read/rescuing from spam on mailboxes the user owns); do not simulate human behavior to fool filters; document each knob as "cooperative-mailbox action" or "not provided". (PARTIAL: warm custom tracking domain not provided, D51)
- [x] PS-WARM-09: Warm-up traffic is plain text, separate message type, stored in a separate table, excluded from customer analytics, replies, unibox, CRM — S2 (plain text), master §6.
- [x] PS-WARM-10: Warm-up status enum: Paused, Active, Banned, Spam Folder Unknown, Permanent Suspension — Instantly 0,1,-1,-2,-3 (S4). rightnow maps to: Paused, Active, Provider-blocked, Placement-unknown, Suspended.
- [x] PS-WARM-11: Warm-up health/score per account (0–100) — Instantly exposes `stat_warmup_score` (S4); formula undocumented. rightnow formula documented in-app: weighted from hard/soft bounce rate, provider errors, auth DNS status, warm-up reply/receive success between participants, and (if run) inbox-placement tests. Labeled an internal indicator, not a reputation guarantee.
- [x] PS-WARM-12: Warm-up analytics per account per day: sent, received, replied, landed-in-spam (where measurable between cooperative mailboxes), health score trend — S23 warmup analytics.
- [x] PS-WARM-13: Warm-up pool: "integration interface" for external warm-up providers + a self-hosted opt-in peer pool among the user's own mailboxes; no assumption of Instantly's pool — master §6, S17 section.
- [x] PS-WARM-14: Domain authentication checks: SPF, DKIM (selector discovery for Google/Microsoft/custom), DMARC policy, MX, reverse DNS where possible, with fix instructions; re-check on schedule and before campaigns — Instantly "Test domain setup" (S18).
- [x] PS-WARM-15: Bounce monitoring per account (hard, soft, unknown, with reasons) and deliverability warnings when thresholds crossed — S21 bounce types.
- [x] PS-WARM-16: Health-based slowdown: auto-reduce allowance by a configured factor when bounce/error thresholds hit; auto-restore stepwise — master §6.
- [x] PS-WARM-17: Custom warm-up schedule: user-defined per-day volume curve (table of day to volume) in addition to linear increment — master §6 (Instantly only linear increment, undocumented beyond that).
- [ ] PS-WARM-18: [optional] Inbox-placement testing: send a seed test to opted-in seed mailboxes (user-supplied) and report folder (inbox/spam/promotions) per seed ESP, plus blacklist and SpamAssassin report — Instantly has inbox placement tests, analytics, deliverability insights, blacklist/SpamAssassin report, ESP options (S23). (PARTIAL: placement + blacklist done; no SpamAssassin report, D51)
- [x] PS-WARM-19: Blacklist (DNSBL) check for sending IP/domain, listed in diagnostics — S23 blacklist report.
- [x] PS-WARM-20: Warm-up dashboard clearly states what warm-up cannot do (no guarantee of inbox placement) — master §6.
- [x] PS-WARM-21: Recommended defaults surfaced in UI hints: 30 campaign + 10 warm-up per account/day; at least ~2 weeks warm-up for new accounts (Instantly blog says two weeks minimum, four safer for new domains) — S18, S21, S24.

---

## 8. Lead Management (master §7)

- [x] PS-LEAD-01: Lead fields: email (required, unique per workspace unless dedupe off), firstName, lastName, companyName, companyDomain (derived), jobTitle, phone, website, personalization, plValueLead, custom variables (string/number/boolean/null), assignedTo, listId, campaign — S5.
- [x] PS-LEAD-02: Lead status (per campaign): Active, Paused, Completed, Bounced, Unsubscribed, Skipped — S5.
- [x] PS-LEAD-03: Interest status (`interest`): Interested, Meeting Booked, Meeting Completed, Won, Out of Office, Not Interested, Wrong Person, Lost, No Show, (null = plain "Lead"); numeric codes 1,2,3,4,0,-1,-2,-3,-4 — S5, S11. Custom labels with a user-chosen name, color, positive/negative flag, AI description — S28 (custom labels), S7.
- [x] PS-LEAD-04: Setting interest status has side effects: may complete the lead in campaigns, create/update an opportunity, fire automations and subsequences; setting null resets to Lead; processed asynchronously — S11. (P6 opportunity side effect; P7 side effects run as a BackgroundJob)
- [x] PS-LEAD-05: Verification status: Not verified, Verified, Pending, Pending job, Invalid, Risky, Catch-all, Job change — S5. Campaign does not send to Invalid; Risky/Catch-all only when "allow risky" — S1.
- [x] PS-LEAD-06: Enrichment status field (enriched, pending, not available, error) kept for integration hooks — S5.
- [x] PS-LEAD-07: ESP code (Google, Microsoft, Zoho, Yahoo, Yandex, Other, Not found, In queue) and ESG code (Barracuda, Mimecast, Proofpoint, Cisco) detected via MX lookup; used for provider matching — S5. rightnow implements MX-based ESP/ESG detection; "in queue" while pending.
- [x] PS-LEAD-08: Per-lead counters and timestamps: open/reply/click counts, last contact/open/reply/click/interest-change/touch, step and variant of last open/reply/click, last sender — S5.
- [x] PS-LEAD-09: Lead lists: create, rename, delete, move leads between lists and campaigns, list-level verification statistics — S23 Lead List, "Move leads to a campaign or list".
- [x] PS-LEAD-10: CSV import wizard: upload, auto-map columns by header (case-insensitive) with manual remap, choose target list/campaign, preview first rows, show counts of missing/invalid emails, skipped duplicates ("X emails already exist") — S19, S27 (verify option), S5.
- [x] PS-LEAD-11: Email column mandatory; rows with missing/malformed email rejected and counted; unmapped columns become custom fields — S27 (search result).
- [x] PS-LEAD-12: Dedupe options on import: (a) skip if already in workspace, (b) skip if already in campaign, (c) skip if already in list; workspace-wide check default ON; within-file duplicate check always ON — S5 `skip_if_in_*`, S19.
- [x] PS-LEAD-13: Import honors blocklist (emails and domains) automatically and reports the skipped count — S19/S27, S5 `blocklist_id`.
- [x] PS-LEAD-14: Optional "verify on import" toggle calling a pluggable verification provider (hook interface); Instantly charges 0.25 credit/lead for built-in verifier; rightnow has no credits, provider cost is the user's — S27, S5 `verify_leads_on_import`.
- [x] PS-LEAD-15: Built-in local syntax + MX + disposable-domain validation always on; SMTP-probe verification not provided by default (provider-hook only) — master §7.
- [x] PS-LEAD-16: Lead merge (two records into one, keeping history) — S23 "Merge two leads".
- [x] PS-LEAD-17: Bulk actions: assign to users (round-robin option), move, delete, add to blocklist, change interest status, add/remove tag, export selected CSV — S14, S15, S23.
- [x] PS-LEAD-18: Advanced lead filters: status, interest status, verification status, campaign, list, owner, "opened but no reply", last contacted, custom field contains — S17 ("Email opened, No reply" filter), S15, S23 (advanced filtering article exists).
- [x] PS-LEAD-19: Contact history timeline per lead: imports, sends (step/variant/account), opens, clicks, replies, status changes, notes, tasks, campaign attribution — master §7; Instantly "Lead activity" article exists (search result). (imports, sends, opens, clicks, replies, bounces, unsubscribes, status changes done P3/P4; notes and tasks → P6)
- [x] PS-LEAD-20: Blocklist entries: single `value` that is an email or a domain (`isDomain` derived); CRUD, bulk create/delete, CSV download, delete-all; checked at import, campaign scheduling and send time — S10, S23.
- [x] PS-LEAD-21: Global suppression list: unsubscribes, hard bounces, complaints and manual blocks added automatically; durable, survives lead deletion; enforced across all campaigns/workspace — master §7, §12, §14.
- [x] PS-LEAD-22: Import and export of historical conversations from authorized accounts and association with leads by email match — master §7. (sync imports conversations and matches leads by email done P4-T05; export of historical conversations → P7-T03)
- [x] PS-LEAD-23: Conflict prevention: a lead active in campaign A is not enqueued by campaign B (configurable) — master §7.
- [x] PS-LEAD-24: Lead owner assignment (`assignedTo`) used by CRM/inbox filters — S5, S15.
- [x] PS-LEAD-25: Bounced-lead management view: filter bounced leads, reasons, option to remove/re-verify — Instantly "Managing Bounced Leads" article exists (search result).
- [x] PS-LEAD-26: Payload custom variables are added at campaign level so all leads share the same variable set (missing = empty) — S5.

---

## 9. Unified Inbox (master §8)

- [x] PS-INBOX-01: Unified list across all connected accounts, grouped into threads by RFC headers (Message-ID, In-Reply-To, References) with provider thread id as fallback — master §8.
- [x] PS-INBOX-02: Sidebar filters: lead status/label (default + custom), campaign, connected inbox, (AI agent n/a) — S14.
- [x] PS-INBOX-03: "More" views: Primary (replies from known leads), Unread only, Reminders only, Scheduled emails, Sent, Others (replies from non-leads or unmatched addresses) — S14.
- [x] PS-INBOX-04: Replies matched to the lead's most relevant campaign; if ambiguous, the most recently contacted campaign — S14.
- [x] PS-INBOX-05: "Attach lead" for replies from a different address/forward: link to the original lead and move to Primary — S14.
- [x] PS-INBOX-06: Quick filters: has attachment, unread, sent, received, last 7 days; keyword search plus advanced filters: from, to, subject, date, campaign id, read/unread, attachment; recent searches saved — S14.
- [x] PS-INBOX-07: Bulk action bar: mark read/unread, update lead status, add to blocklist, delete; select all on page/read/unread/none — S14.
- [x] PS-INBOX-08: Reply composer: Reply, Reply all (when CC), Forward, rich text, attachments, send from the original mailbox; reply sent through Gmail/Graph/SMTP and stored in thread — S14, S23 reply/forward endpoints. (rich-text formatting → P7-T08; reply/reply-all/forward, attachments, send-from-original-mailbox done P4-T06/T08)
- [x] PS-INBOX-09: Macros/snippets for replies (user-defined templates with variables) — S14 mentions macros as suggestion input.
- [x] PS-INBOX-10: Internal notes per conversation/lead visible only to workspace members — S14.
- [x] PS-INBOX-11: Follow-up reminder per conversation (date/time) with "Reminders only" view and notification — S14; Instantly also adds nudges when a reply may be needed (changelog, search result).
- [x] PS-INBOX-12: Actions: edit lead, set reminder, move to subsequence or other campaign, change interest status from thread header — S14.
- [x] PS-INBOX-13: Lead info panel: step and variant that triggered the thread, resume date for OOO, lead fields, campaign — S14.
- [x] PS-INBOX-14: Read/unread and delete in the inbox are one-way (local only; do not mutate the provider mailbox) — S14. rightnow default same; optional two-way read-state sync later.
- [x] PS-INBOX-15: Deleting a conversation keeps the lead in campaigns; deleting a lead / blocklisting offers: remove all same-domain leads, remove from all campaigns, block future outreach — S14.
- [x] PS-INBOX-16: Reply from deleted lead still shows under Others — S14.
- [x] PS-INBOX-17: Reply detection from headers and provider ids; bounces (DSN/NDR), auto-replies (Auto-Submitted, X-Autoreply, Precedence, OOO text), unsubscribe requests classified separately from genuine replies — master §8; Instantly separates auto-replies from replies in analytics (S9, S16).
- [x] PS-INBOX-18: Genuine reply immediately cancels pending steps of the lead (and company, if option on) via transactional job removal — master §8, S1.
- [x] PS-INBOX-19: Reply categories: interested, not interested, neutral, meeting requested, out of office, unsubscribe, automated response, uncertain; Instantly default labels: Interested, Meeting Booked, Meeting Completed, Won, OOO, Wrong Person, Not Interested, Lost, Neutral (S5, S6); manual correction always allowed and feeds feedback log — master §8. (categories, manual correction and feedback log done P4-T02/T06; AI labels → P7-T05)
- [x] PS-INBOX-20: Deterministic rule classifier (regex/keyword/headers) runs first; optional AI classifier on top ([optional]); thumbs feedback on AI tags — S14, S28. (rule classifier and AI hook done P4-T02; AI classifier and thumbs feedback → P7-T05)
- [x] PS-INBOX-21: Safe email rendering: sanitize HTML (no scripts, remote content blocked by default, link rewrite warnings), plain-text fallback — master §14. (sanitized sandboxed rendering, remote content blocked, plain-text toggle done P4-T08 (D30); link-target warnings → P7-T08)
- [x] PS-INBOX-22: Unread count API/badge — S23 count-unread.
- [x] PS-INBOX-23: Mark all in thread as read — S23.
- [x] PS-INBOX-24: Scheduled (queued) outgoing emails view for the lead, including next planned step and time — S14.

---

## 10. Email Analytics and Event Tracking (master §9)

- [x] PS-TRACK-01: Immutable event log with types: scheduled, send_attempt, provider_accepted, send_failed, bounce_hard, bounce_soft, unsubscribe, reply, auto_reply, open (estimated), click, positive_reply, negative_reply, meeting, opportunity, deal_won, deal_lost — master §9; Instantly webhook event types cover sent/opened/clicked/reply/auto-reply/bounce/unsub (S6). (event log done P4-T01; scheduled/send_attempt kept on ScheduledMessage, not Events (D31); meeting/opportunity/deal events → P6-T01)
- [x] PS-TRACK-02: Event dedupe via unique key (provider message id + event type + timestamp bucket) so repeated notifications do not double count — master §9.
- [x] PS-TRACK-03: [optional] Open tracking via 1x1 pixel served from the (custom) tracking domain; open rate denominator = leads who got step 1 ("sequences started"); text-only clients not counted — S17, S16.
- [x] PS-TRACK-04: Opens flagged as estimated; classify machine opens (known prefetch proxies, Apple Mail Privacy Protection, security scanners, opens within seconds of send) into a separate counter; UI shows "estimated" and never merges into engagement KPIs by default — master §9 (Instantly doc pages fetched do not describe bot/MPP filtering; undocumented).
- [x] PS-TRACK-05: [optional] Link click tracking by rewriting links through the tracking domain; unique and total clicks; clicks within seconds of delivery flagged as likely scanner — S1, S9.
- [x] PS-TRACK-06: Custom tracking domain per account, CNAME required, HTTPS cert provisioned (VPS mode) — S4, S17.
- [x] PS-TRACK-07: Disabling tracking (text-only/delivery optimization) removes pixel and link rewriting — S1, S17.
- [x] PS-TRACK-08: Hard vs soft bounce classification from SMTP codes and DSN (5.x.x hard, 4.x.x soft) plus reason text; unknown bucket — S21 (hard/soft/unknown).
- [x] PS-TRACK-09: Unsubscribe via link, List-Unsubscribe one-click POST, and reply-text detection; immediately suppress and complete lead (status Unsubscribed) — S1, S5.
- [x] PS-TRACK-10: Reports by campaign, sender account, step, variant, recipient segment (ESP, list, tag, custom field), and time period — master §9, S20.
- [x] PS-TRACK-11: Meetings, opportunities, won/lost, revenue events recorded from interest status changes and CRM updates — S11, S15.
- [x] PS-TRACK-12: All timestamps stored UTC; report bucketing UTC by default — S16.
- [x] PS-TRACK-13: Webhook/provider push notifications (Gmail Pub/Sub, Graph subscriptions) are idempotent and verified — master §3/§9.

---

## 11. Sales CRM (master §10)

- [x] PS-CRM-01: CRM area sections: Tasks, Inbox (all activity: email/calls/SMS/tasks), Opportunities, Leads — Instantly CRM tab (S15). rightnow ships Tasks, Activity inbox, Opportunities, Leads; calls/SMS channels are manual log entries only.
- [x] PS-CRM-02: Default pipeline stages (customizable: add, rename, reorder, delete with reassignment): Not Contacted, Contacted, Replied, Interested, Meeting Scheduled, Proposal Sent, Negotiation, Closed Won, Closed Lost — master §10. Instantly's own stages are lead interest statuses plus custom statuses editable in Preferences (S15).
- [x] PS-CRM-03: Interest status to stage mapping (Interested to Interested, Meeting Booked to Meeting Scheduled, Won to Closed Won, Lost to Closed Lost, etc.), configurable — S11 side effects (opportunity created/updated).
- [x] PS-CRM-04: Kanban board of opportunities with drag-and-drop between stages and per-column totals (count and value) — master §10; Instantly blog mentions kanban (S15 context).
- [x] PS-CRM-05: Opportunity record: lead, campaign (origin), stage, deal value, expected close date, owner, notes, tasks, reminders, activity history — master §10; Instantly opportunities have optional deal value, notes, meetings, tasks (S15, S16).
- [x] PS-CRM-06: Opportunity filters: campaign, list, time range, lead owner, stage; search by domain or email — S15.
- [x] PS-CRM-07: Opportunity auto-created when a positive interest status is set (Interested/Meeting Booked/...) if automation on; unique per lead per campaign — S11, S9 ("unique opportunities").
- [x] PS-CRM-08: Tasks with title, due date, assignee, status, linked lead/opportunity; "tasks awaiting approval" view — S15. (P6 view + approve; AI producers P7-T05)
- [x] PS-CRM-09: Leads view with filters (campaign, list, status, owner), create/import lead, custom fields, download selected, assign to teammates with round-robin option — S15.
- [x] PS-CRM-10: Record revenue: deal value (expected), cash collected (actual) on Closed Won; revenue attributed to originating campaign/step/variant/account — master §10, S16 (conversions with cash collected).
- [x] PS-CRM-11: CRM reports: pipeline value, average deal size, annualized value closed, conversion rate by stage, revenue per lead, revenue per campaign — S15 report names (search result), master §10.
- [x] PS-CRM-12: CRM inbox may store non-lead email, with a preference to stop saving it — S15.
- [x] PS-CRM-13: Activity history is append-only and shows stage changes with actor and timestamp — master §10.
- [x] PS-CRM-14: Won/Lost deals feed analytics (conversions, revenue) in real time — master §12.

---

## 12. Analytics Dashboard (master §11)

- [x] PS-ANALYTICS-01: Filters on every view: campaign (multi), account (multi), tags/owner, date range with presets, status (active/completed) — S16.
- [x] PS-ANALYTICS-02: Metric "Total sent": every email sent including follow-ups — S16.
- [x] PS-ANALYTICS-03: Metric "Contacted / sequences started": unique leads that received step 1 (`contacted_count`), plus `new_leads_contacted_count` — S9, S16.
- [x] PS-ANALYTICS-04: Metric "Opened": leads with >= 1 open (`open_count`), unique opens, unique opens by step; open rate = opens / sequences started (pixel-based, estimated) — S9, S17.
- [x] PS-ANALYTICS-05: Metric "Replied": total replies, unique replies (first per lead, excluding auto-replies), unique by step; auto-replies counted separately; toggle "include auto replies"; account-level reply rate = replies / total sent, campaign-level counts replied leads — S9, S16 (Instantly's own definitions differ by view; rightnow documents both and defaults to unique replied leads / leads contacted, with total-sent variant selectable).
- [x] PS-ANALYTICS-06: Metric "Clicked": total, unique, unique-by-step; click rate = sends with >= 1 click — S9, S16.
- [x] PS-ANALYTICS-07: Metric "Bounced" (hard/soft split), "Unsubscribed", "Completed" lead counts — S9.
- [x] PS-ANALYTICS-08: Metrics "Opportunities" (unique, count and total value) and "Positive reply rate" = opportunities / replies; "Conversions" = won opportunities with cash collected — S9, S16.
- [x] PS-ANALYTICS-09: Campaign progress = share of leads that finished the entire sequence — S16.
- [x] PS-ANALYTICS-10: Pipeline value, average deal size, revenue by campaign, revenue per lead — S15 report names, master §10.
- [x] PS-ANALYTICS-11: Daily time series per campaign and per account (sent, opened, replied, clicked, bounced) — S23 daily campaign/account analytics.
- [x] PS-ANALYTICS-12: Step and variant analytics: sent, replied, reply rate, positive reply rate, opportunities, meeting booked, won; recommend long ranges (e.g. last 3 months) for significance; variant toggle to pause underperformers — S20.
- [x] PS-ANALYTICS-13: Bounce breakdown view (hard, soft, unknown, reason) — S21.
- [x] PS-ANALYTICS-14: Account analytics: sent, contacted, opened, replied, combined score; account health, deliverability trend, remaining daily capacity — S16, master §11.
- [x] PS-ANALYTICS-15: Charts (Recharts): volume over time, rates, funnel (sent to replied to positive to meeting to won), A/B bars, health trend; hide/show metrics gear — S16. (P6 charts + metric menu; health sparkline P7-T08b)
- [x] PS-ANALYTICS-16: CSV export of sending activity (lead email, account, step, action, date, link) and of aggregate tables; image share of campaign chart optional — S16.
- [x] PS-ANALYTICS-17: All metrics computed from stored events; no synthetic or placeholder numbers; unit tests assert counts against fixtures — master §11.
- [x] PS-ANALYTICS-18: Metrics display denominators and "estimated" flags in tooltips — master §9.
- [x] PS-ANALYTICS-19: Webhook delivery analytics (success/failure by date) — S23 webhook event overview.

---

## 13. Automation Rules, API, Webhooks (master §12)

- [x] PS-AUTO-01: Rule model: trigger event + optional conditions + ordered actions, per workspace, enable/disable, run log — master §12; Instantly automations triggered by lead interest changes (S11).
- [x] PS-AUTO-02: Triggers: reply received, positive/negative reply, status/label change, unsubscribe, bounce, campaign completed, account error, account quota reached, send-failure threshold, deal won/lost — S6 event list, master §12.
- [x] PS-AUTO-03: Actions: stop sequence, create opportunity, suppress contact globally, pause account, move lead to subsequence/campaign/list, assign owner, add tag, create task, send webhook — master §12, S23. "Defer remaining messages", "update account health/status" and "update revenue analytics" exist only as built-in behaviours (locked built-in rules, PS-AUTO-04), not user-selectable actions.
- [x] PS-AUTO-04: Built-in default rules shipped enabled: positive reply to stop sequence and create opportunity; unsubscribe to global suppression; bounce to stop and update health; quota reached to defer; failure threshold to pause account; deal won to revenue analytics — master §12.
- [x] PS-AUTO-05: Webhook events (names kept compatible): `email_sent, email_opened, email_link_clicked, reply_received, auto_reply_received, email_bounced, lead_unsubscribed, account_error, campaign_completed, lead_neutral, lead_interested, lead_not_interested, lead_meeting_booked, lead_meeting_completed, lead_closed, lead_out_of_office, lead_wrong_person, lead_no_show`, `all_events`, plus custom-label events using the label name as event type — S6, S7.
- [x] PS-AUTO-06: Webhook subscription: target URL (http/https), optional campaign filter (null = all), optional name, event type, custom interest value, custom HTTP headers (e.g. Authorization); list, get, patch, delete, test, resume — S7, S23.
- [x] PS-AUTO-07: Payload shape: JSON POST with `timestamp, event_type, workspace, campaign_id, campaign_name` always; optionally `lead_email, email_account, unibox_url` (reply events), `step` (1-based), `variant` (1-based), `is_first`, `email_id`, `email_subject`, `email_text`, `email_html`, `reply_text_snippet, reply_subject, reply_text, reply_html`, and lead fields merged — S6, S26.
- [x] PS-AUTO-08: Webhook status active/error; disable after repeated delivery failures and record error timestamp; manual resume. Instantly thresholds and retry schedule are undocumented; rightnow: retry with exponential backoff up to 8 attempts over ~24h, disable after 20 consecutive failures — S7 (undocumented thresholds).
- [x] PS-AUTO-09: Outgoing webhooks are HMAC-SHA256 signed (`X-RightNow-Signature`, timestamp, event id) with per-webhook secret; consumers can replay-protect — master §12 (Instantly docs describe custom headers only, no signature: S7, S26).
- [x] PS-AUTO-10: Webhook event log with payload, response code, latency, redelivery button; overview aggregates per day — S23 webhook event.
- [x] PS-AUTO-11: API resources (v1 mirror of Instantly v2): accounts (+warm-up, pause/resume, vitals), campaigns (+analytics, steps analytics, subsequences, duplicate, export), leads (+bulk add/move/delete, merge, interest status), lead lists, lead labels, emails (list/get/reply/forward/patch/unread count), blocklist entries, custom tags, webhooks, analytics, background jobs, audit log, API keys, workspace members — S23.
- [x] PS-AUTO-12: Long-running API operations return a background job id queryable via jobs endpoint (HTTP 202) — S11, S23.
- [x] PS-AUTO-13: Audit log list endpoint — S23.
- [x] PS-AUTO-14: SDK/CLI/MCP are out of scope — S23 (Instantly offers them).

---

## 14. Optional AI Features (master §13)

All AI items are `[optional]`, off by default, provider-pluggable (BYO API key), with human review of recipient-facing drafts by default.

- [x] PS-AI-01: [optional] Email drafting for subject/body with tone and offer inputs — Instantly AI writing helpers, AI Spintax Writer on higher plans (S12).
- [x] PS-AI-02: [optional] Per-lead personalization line written into `{{personalization}}` in bulk with preview and approve-before-send — S5.
- [x] PS-AI-03: [optional] Follow-up suggestions based on thread and lead status — master §13.
- [x] PS-AI-04: [optional] Reply categorization into Instantly-style labels, selectable subset of custom labels the AI may choose, per-label description to tune accuracy, thumbs feedback; deterministic rules remain the fallback — S28, S14.
- [x] PS-AI-05: [optional] AI reply drafts in Inbox from macros/recent mails, shown for human review; autonomous replying and meeting booking OFF and not shipped initially (Instantly AI Reply Agent can send autonomously) — S14.
- [x] PS-AI-06: [optional] Conversation summaries — master §13.
- [x] PS-AI-07: [optional] Lead scoring from engagement + fields with explanation — master §13.
- [x] PS-AI-08: [optional] CRM recommendations (next best action) — master §13.
- [x] PS-AI-09: [optional] Campaign analysis (variant winners, copy critique, deliverability hints) — master §13.
- [x] PS-AI-10: [optional] AI "smart pause" parsing OOO return date to schedule resume — S14.
- [x] PS-AI-11: AI calls are logged (prompt hash, model, cost, reviewer) and never include secrets or token data — master §14.

---

## 15. Security and Compliance (master §14)

- [x] PS-SEC-03: Auth.js sessions (httpOnly, SameSite, rotation), password hashing (argon2id), optional TOTP 2FA, login rate limit — master §14.
- [x] PS-SEC-04: Role-based access (owner, admin, member, read-only); every API checks workspace membership and role — S23 workspace members.
- [x] PS-SEC-05: Secrets from environment/secret manager only; encryption key rotation procedure documented; no secret in logs — master §14.
- [x] PS-SEC-06: Input validation on all endpoints (zod schemas), unknown properties rejected — S3, S4, S5.
- [x] PS-SEC-07: Audit log for security-relevant actions (login, account connect/revoke, API key create, export, delete, setting change) — S23 audit log.
- [x] PS-SEC-08: CSRF protection, strict CSP, SSRF-safe webhook delivery (block private IP ranges) — master §14.
- [x] PS-SEC-09: Unsubscribe link in every campaign email by default (opt-out of auto-footer needs a warning); unsubscribes processed within the next scheduler tick; suppression durable — master §14, S1.
- [x] PS-SEC-10: Honest sender identification: From name/address must be the connected mailbox owner's; no spoofing; physical-address/company footer field for CAN-SPAM-style compliance — master §14.
- [x] PS-SEC-11: Contact-data deletion (GDPR erase): delete lead + events + emails but keep a hashed suppression tombstone — master §14, §7.
- [x] PS-SEC-12: Compliance settings: per-workspace legal footer, region notes (GDPR/CAN-SPAM/CASL) in docs, consent/source field on lead (`uploadMethod`: manual, api, csv) — S5.
- [x] PS-SEC-13: Authorized imports: import wizard requires confirming the user has the right to contact the list — master §14.
- [x] PS-SEC-14: Tenant-isolation tests (cross-workspace read/write attempts fail) — master §1, §14.
- [ ] PS-SEC-15: Safe rendering of inbound HTML/attachments (sanitize, size limits, content-type allowlist, optional AV hook) — master §14. (PARTIAL: no AV hook, D50)
- [x] PS-SEC-16: Do not implement spam-filter circumvention (header spoofing, randomized invisible characters, fake warm-up engagement) — master §14.

---

## 16. Existing Mailbox Reactivation and Re-Warm-Up (master addendum)

Instantly has no dedicated reactivation product: users lower limits manually, rely on warm-up, or delete and reconnect on token errors (S18). Items below are required by the master spec, with Instantly warm-up knobs as inspiration.

- [x] PS-REWARM-01: Per account track: last outbound email date, last campaign activity date, historical sending volume, historical bounce and reply rates, recent provider errors, inactivity duration, previous warm-up config, current SPF/DKIM/DMARC health.
- [x] PS-REWARM-02: Configurable inactivity thresholds (presets 7, 14, 30, 60 days); accounts beyond threshold flagged "Inactive / may benefit from gradual restart".
- [x] PS-REWARM-03: "Re-Warm Account" button on Email Accounts; keeps account id, settings, history; no delete/reconnect required.
- [x] PS-REWARM-04: On start: recheck connectivity (token refresh, IMAP/SMTP), SPF, DKIM, DMARC; block start with explicit reasons if failing (token expired triggers reconnect flow that preserves the account record).
- [x] PS-REWARM-05: Reset campaign sending allowance to a conservative start (default 5/day, configurable) and ramp by a configurable curve (default +2/day, consistent with slow-ramp +2/day in S25) up to the pre-inactivity target.
- [x] PS-REWARM-06: Scheduler reads the allowance from a single source of truth (DB row + Redis counter) so all workers and all campaigns respect it simultaneously.
- [x] PS-REWARM-07: Health gates: pause or reduce allowance (and hold a ramp step) when bounce rate, provider errors, or DNS health cross thresholds; resume stepwise after recovery window.
- [x] PS-REWARM-08: Exit criteria configurable (e.g. allowance reached target AND N consecutive days with bounce < threshold AND no provider errors); then status returns to Active with normal limits.
- [x] PS-REWARM-09: Automatic reactivation protection (setting): before the next campaign send, an account over the threshold gets recommended or auto-applied reduced-volume restart; user chooses recommend vs auto per workspace.
- [x] PS-REWARM-10: Dashboard: status (Active, Inactive, Re-Warming, Paused, Needs Attention), days since last send, current allowance, target volume, progress bar, historical and current deliverability indicators, warnings, estimated schedule labeled "configurable plan, not a guaranteed reputation recovery timeline".
- [x] PS-REWARM-11: Optional warm-up activity only with opted-in participants or external provider; otherwise the volume-ramp workflow is the whole feature (honest mode) — S2 pool is not reproducible.
- [x] PS-REWARM-12: Runs through persistent BullMQ repeatable jobs; works while the user is offline (on a running server) and catches up after downtime without burst-sending.
- [x] PS-REWARM-13: Tests: inactive 30 days, inactive 60 days, reconnect after OAuth token expiry, bounce-rate breach during re-warm, successful return to normal limits.
- [x] PS-REWARM-14: Independent verification that a previously active account is reactivated without losing settings or history (data-preservation test).

---

## 17. Offline Recovery and Inbox Synchronization (master §3 inbox sync + addendum)

- [ ] PS-SYNC-01: Provider sync strategies: Gmail `history.list` + Pub/Sub watch (fallback polling), Microsoft Graph delta queries + change notifications (fallback polling), IMAP IDLE with UID/UIDVALIDITY tracking (fallback polling interval default 2–5 min) — master §3. (PARTIAL: polling P4-T05; Gmail watch + Graph subscriptions P7-T06; no IMAP IDLE, polling only, D48)
- [x] PS-SYNC-02: Persist per-account checkpoint (Gmail historyId, Graph deltaLink, IMAP UIDVALIDITY+last UID) and sync run log.
- [x] PS-SYNC-03: Incremental sync by default; when checkpoint expired/invalid (Gmail history too old, Graph delta token expired, UIDVALIDITY change) fall back to full reconciliation of a bounded window (default window = max(30 days, downtime + margin)).
- [x] PS-SYNC-04: Import both incoming and provider-sent messages (including mail sent outside rightnow) and match to campaign sends by Message-ID/headers to avoid duplicate records.
- [x] PS-SYNC-05: Dedupe by provider message id + RFC Message-ID; threading by headers; idempotent upserts.
- [x] PS-SYNC-06: Detect and apply while offline: replies, auto-replies, bounces (DSN), unsubscribes (incl. List-Unsubscribe mailto), manual deletions, state changes; update campaign/lead status, CRM, analytics.
- [x] PS-SYNC-07: Startup gate: on every process start, sending is blocked (global "sync-pending" flag per account and global) until reconciliation completes "sufficiently" (all accounts reached current checkpoint or are marked failed/excluded); UI shows progress.
- [x] PS-SYNC-08: After sync, recompute stale follow-ups: cancel steps for any lead with a reply/unsub/bounce discovered; reschedule remaining sends into the next valid windows.
- [x] PS-SYNC-09: Never burst-send an offline backlog: overdue sends are re-planned under normal gaps, daily quotas, schedule windows, and re-warm allowances.
- [x] PS-SYNC-10: Uncertain sends (job in `sending` at crash time) reconciled against the provider Sent folder before retrying; unresolved ones held for review, never auto-resent.
- [x] PS-SYNC-11: Mandatory automated tests simulating 1, 7, and 30 days of downtime, including expired history ids, replies/bounces during downtime, and verification of zero duplicate sends and zero missed follow-up cancellations.
- [x] PS-SYNC-12: Document events not reconstructable offline: tracking-pixel opens and link clicks that occur while no tracking endpoint is reachable, real-time webhook events, ephemeral provider notifications — see section 19.
- [x] PS-SYNC-13: Sync health shown per account (last success, lag, errors) and surfaced in account status — master §3.

---

## 18. Local-First and VPS-Ready Deployment

- [x] PS-DEPLOY-07: One codebase, two modes; mode selected by env profile (`MODE=local|vps`).
- [x] PS-DEPLOY-08: Local: Docker Compose runs web, workers, scheduler, Postgres, Redis; named volumes; Redis AOF persistence; start/stop commands; no work while machine asleep, correct recovery afterwards (SYNC).
- [x] PS-DEPLOY-09: VPS: same compose with health checks, restart policies (`unless-stopped`), durable volumes, HTTPS via reverse proxy (Caddy or Traefik with automatic certs), secrets via env files/Docker secrets, ops runbook.
- [x] PS-DEPLOY-10: Scripts for both modes: start, stop, upgrade (migrate then restart), backup (pg_dump + Redis snapshot + encryption-key note), restore; tested.
- [x] PS-DEPLOY-11: Tested local-to-VPS migration procedure (dump, transfer, restore, verify checkpoints, rotate OAuth redirect URIs, DNS/tracking-domain switch, first-start sync gate).
- [x] PS-DEPLOY-12: Health endpoints `/healthz` (liveness) and `/readyz` (db, redis, queue, sync gate status).
- [x] PS-DEPLOY-13: Tracking endpoint must be publicly reachable to record opens/clicks; local mode documents tunnel/limitations.
- [x] PS-DEPLOY-14: Provider Compliance Gate: before enabling live sending, document each provider's current API acceptable-use rules; do not assume a Gmail OAuth app may send unsolicited commercial mail; unsupported channels sit behind a disabled integration interface; campaign creation and tests (dry-run / local SMTP sink) work without live provider access.
- [x] PS-DEPLOY-15: Dry-run/sandbox send mode that exercises the full pipeline against a fake SMTP/Graph/Gmail adapter for tests and demos.
- [x] PS-DEPLOY-16: CI runs Vitest unit/integration and Playwright e2e on Docker services.

---

## Phase 9 additions

- Apollo lead sourcing through your own account.
- MillionVerifier email verification and catch-all handling.
- Lead capacity limits for automated loads.
- Inbox triage for messages from non-leads.
- Customer and region exclusions.
- Referrals detected from fresh replies.
- Slack webhook alerts.
- Lead assignment and auto-forward handoffs.
- Re-alerts for unanswered escalations.
- One-way HubSpot sync.
- External warm-up service guidance; built-in warm-up remains internal.

## 19. Known limitations / not reproducible

1. **Instantly's warm-up pool.** Instantly warm-up exchanges mail with other participating mailboxes; the pool, its sizing, selection and reply behavior are private (S2). rightnow cannot reproduce it. Replacement: gradual volume ramp, optional opted-in peer mailboxes owned by the same user, and optional external providers via an interface. No warm-up can guarantee inbox placement.
2. **Fake-human signals.** Read emulation via headless browsers, forced "mark important", automatic spam rescue at configurable percentages exist in Instantly (S2). rightnow only performs these on mailboxes the user owns and has opted in, and labels them as test traffic; it does not inflate customer engagement metrics.
3. **Warm-up health score formula** is undocumented (S4 exposes only `stat_warmup_score`). rightnow's score is its own transparent formula and not comparable to Instantly's.
4. **AirMail, DFY mailboxes, pre-warmed domains, domain purchase/forwarding** (S23) depend on Instantly infrastructure. Out of scope.
5. **SuperSearch / Lead Finder / AI enrichment / company lists / website visitors** use Instantly's own data, which remains out of scope. rightnow can load leads through your own Apollo account (Phase 9).
6. **Built-in email verification** (0.25 credit/lead, S27) depends on Instantly's verifier. rightnow ships syntax/MX/disposable checks plus a provider hook, and supports MillionVerifier through your own account.
7. **AI Sales Agent, AI Inbox Manager, AI Deliverability Agent** (S23) are autonomous agents. Only optional, human-reviewed AI is in scope.
8. **Tracking-pixel opens and clicks during downtime** are lost: opens/clicks that occur while the tracking domain or server is offline cannot be reconstructed. Replies, bounces, unsubscribes, sent mail are reconstructible from provider mailboxes.
9. **Open tracking is inherently an estimate.** Apple MPP, security scanners and image proxies create false opens; text-only mail cannot register opens. Reply and click-with-human-timing are stronger signals. Instantly's public pages do not describe bot filtering (S17).
10. **Delivered vs accepted.** Providers rarely give delivery receipts; rightnow reports provider-accepted and bounce/DSN outcomes only.
11. **Gmail/Microsoft acceptable use.** Sending unsolicited bulk mail through OAuth-based API apps may be disallowed or require verification; live sending stays gated (PS-DEPLOY-14). Real provider limits override configured limits.
12. **Undocumented Instantly behaviors with rightnow-chosen defaults:** BounceProtect threshold, auto-optimize A/Z sample thresholds, webhook retry/disable policy, weekday key mapping in `days`, whether follow-up delay counts from schedule-adjusted time, default for unsubscribe header and tracking toggles, health-score weights, sender variable names, Instantly CRM stage/value field details (help article "Managing Opportunities" not retrieved).
13. **Source disagreements:** warm-up increment default (1/day in help center, "+2/day slow ramp" for campaigns, example "2,4,6" in blog) (S2, S24, S25); reply-rate definition differs between campaign and account analytics (S16).
14. **Plan-gated features in Instantly** (Hyper Growth/Light Speed: advanced warm-up, prioritize new leads, subsequences, per-company limits, Unibox replying) are all available to rightnow users with no gating.
15. **Local mode** cannot run background work while the computer is off; reactivation, follow-ups and sync resume only after startup reconciliation.
16. Instantly's SDK/CLI/MCP, billing/plan endpoints and agency white-label domain features are not reproduced.

---

## 20. Source keys

All fetched or surfaced 2026-10-19. help = `https://help.instantly.ai/en/articles/`, dev = `https://developer.instantly.ai/`.

- S1: help/9214908-campaign-options
- S2: help/7988514-warmup-settings-explained
- S3: dev/api-reference/campaign/create-campaign.md
- S4: dev/api-reference/account/create-account.md
- S5: dev/api-reference/lead/create-lead.md
- S6: dev/guides/webhook-events.md
- S7: dev/api-reference/webhook/create-webhook.md
- S8: dev/guides/oauth-connection-flow.md
- S9: dev/api-reference/campaign/get-campaigns-analytics.md
- S10: dev/api-reference/blocklistentry/create-block-list-entry.md
- S11: dev/api-reference/lead/update-the-interest-status-of-a-lead.md
- S12: help/9215166-using-spintax (also 6384663-how-to-use-spintax)
- S13: help/7251329-subsequences
- S14: help/6576561-how-to-manage-the-unibox-best-practices-on-how-to-reply-to-leads
- S15: help/9064602-crm-features (also 9064527-instantly-crm)
- S16: help/6602310-analytics
- S17: help/12114788-open-tracking
- S18: help/7896857-how-to-fix-disconnected-email-accounts
- S19: help/7891047-duplicate-lead-detection
- S20: help/6661549-a-z-testing-how-to-create-email-variants
- S21: help/7187587-understanding-and-fixing-campaign-email-bounces
- S22: dev/getting-started/rate-limit.md
- S23: dev/llms.txt (API v2 endpoint index; OpenAPI at https://api.instantly.ai/openapi/api_v2.json)
- S24: help/9214348-how-to-change-the-warmup-settings; https://instantly.ai/blog/7-key-benefits-of-slow-ramp-warmup-cold-email-domains/
- S25: help/6222396-campaign-options (older campaign settings: gap, slow ramp, daily limit; surfaced via search, not fully fetched)
- S26: help/6261906-webhooks
- S27: help/6254215-how-to-import-leads-via-csv and help/6253114-adding-leads-to-a-campaign (surfaced via search only; verify-on-import credit cost)
- S28: help/9712488-ai-custom-reply-labels (surfaced via search only)
