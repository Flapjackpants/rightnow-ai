# Review log

Newest last. Each entry: date · subject · reviewer (agent/model) · verdict · findings · resolution.

## 2026-10-19 · Plan review round 1 · independent agent (opus, fresh context) · **Changes Required**
Critical: C1 startup gate misses sleep/wake (→ freshness gate in claim SQL); C2 per-account readiness misses
cross-mailbox replies (→ sticky sender, company-stop freshness, re-route step 1 only); C3 UNCERTAIN "not found" resent
(→ re-search after 15 min then HELD; Graph draft+send); C4 quota reservation day/leak (→ stored usage days, upsert
reservation in savepoints, campaign usage rows). Important: ambiguous-error classification, claimToken leases,
re-plan by revive, re-warm before first send, compliance (unsubscribe, physical address) moved into P3, ~40 parity
fields/features added, injected clock, E2E mapping, SETUP_TOKEN + roles + API scopes, rfcMessageId dedupe, attachments
in Postgres, 50 % provider-cap clamp, task splits + Opus for dispatcher/sender. Minor items applied (Cc/Bcc counted,
bounce threshold 3 %, Redis mentions superseded, postgres 18, suppression hash, push auth, phase branches).
Resolution: plan rev 2 + phase-1 rev 2.

## 2026-10-19 · Plan review round 2 · same independent agent (opus) · **Changes Required**
C1–C4 resolved. New Critical C5: claim SQL lacked campaign status/endAt, schedule-window re-check, and first-of-day
allowance guard. Important: recovery on lease alone, late-accept accounting, freshness watermark = sync start,
re-warm derived on the fly (no startup dependency), API 5xx → UNCERTAIN, one-message-per-transaction claims (deadlock).
Minor: sticky on SENT, new-lead/per-company limits in planner, synthetic Message-ID, stale-claim guard, health names,
clock file, argon2 decision (D8), attachment column exclusion. Resolution: plan rev 3.

## 2026-10-19 · Plan review round 3 · same independent agent (opus) · **APPROVED**
C5, I-A..I-D and round-2 minors resolved; no new Critical/Important. Four minor notes applied directly (P5-T05 wording,
late accept after manual release, claimToken on stale-claim release, first-sync window). Plan rev 3 is the approved plan.

## 2026-10-19 · P1-T01 monorepo scaffold · task reviewer (sonnet) · **Approved**
Spec ✅, quality approved. Minors deferred: Node engines vs CI version, Prettier not enforced, README link ahead of P1-T06.

## 2026-10-19 · P1-T02 db package + harness · task reviewer (sonnet) · Spec ❌ → fixed → **Approved**
Missing expectIsolated helper; dotenv read packages/db/.env (elevated to Important); DB_POOL_MAX NaN. All addressed in
b56a5b0 (scoped re-review). Minors deferred: client throws at import without DATABASE_URL, AuditLog cascade on workspace delete.

## 2026-10-19 · P1-T03 crypto/env/clock/key rotation · task reviewer (sonnet) · **Approved**
Crypto verified correct. 7 minors deferred (see ledger); tsx accepted.

## 2026-10-19 · P1-T04 web shell + auth · task reviewer (sonnet) · Needs fix → **Approved**
next build verified. Fixed: org self-creation (allowUserToCreateOrganization=false) + VIEWER invite test. Deferred: invite acceptance → P7-T07; Origin check → P1-T07; setup rate limit → P7-T07.

## 2026-10-19 · P1-T05 worker skeleton · task reviewer (sonnet) · Needs fixes → **Approved**
Fixed: idempotent teardown, startup partial-failure cleanup, injected clock + heartbeat/503/startup-failure tests.

## 2026-10-19 · P1-T06 Docker/compose/scripts · task reviewer (sonnet) · Spec ❌ → fixed → **Approved**
Critical restore.ps1 data-loss path fixed; dump validation + safety backup; 0600 backups; non-root image; explicit migrate; CI asserts can fail. .ps1 scripts syntax-checked only (never executed: no Docker on Windows).

## 2026-10-19 · P1-T07 API keys/audit/readyz · task reviewer (sonnet) · **Approved**
Security checks passed (CSPRNG tokens, hash lookup, workspace-scoped revoke/list, fail-closed CSRF). Minors deferred to phase-gate triage.

## 2026-10-19 · Phase 1 gate · whole-branch review (opus) + ponytail audit · Fix first → **Approved**
I1 dev script, I2 org deletion disabled, I3 tx-client audit/apikeys atomic, I4 route params, I5 job deps, I6 createPrisma factory — fixed b595457..47d6aec, scoped re-review clean. I7 → P2-T02. M1–M4 → P2-T01 preliminary cleanup.

### Phase 1 rulings (from the SDD ledger)
- | P1-T02 ↔ P1-T04 | Workspace model vs better-auth organization | T02 creates Workspace; T04 maps better-auth organization modelName→workspace and reconciles fields. Ruling: T04 owns the reconciliation migration — avoids guessing better-auth schema in T02 — cost if wrong: one extra migration. |
- | P1-T03 ↔ P1-T04/T05/T07 | `getEnv()` | T03 defines the env schema; later tasks extend it (SETUP_TOKEN, WORKER_HEALTH_PORT). Ruling: each task adds its vars to env.ts + .env.example. |
- | P1-T04 ↔ P1-T07 | `route()` auth modes | T04 defines `auth: "session-or-apikey"` + `scope`; T07 implements apikey verification. Ruling: T04 ships the option with apikey path returning 401 until T07 — cost if wrong: none. |
- | P1-T06 | entrypoint `migrate` | needs prisma CLI in the image → keep prisma as a dependency of @rightnow/db (not dev). Ruling recorded for T06 dispatch. |
- P1-T02: dispatched (sonnet), BASE 8ef0af3. Ruling: prisma CLI in dependencies of @rightnow/db — Docker migrate needs it — cost if wrong: slightly larger image
- P1-T02: review spec ❌ (expectIsolated missing). Ruling: dotenv-path minor elevated to Important — root .env is the documented location, db:migrate would fail for users — cost if wrong: a few lines of churn.
- P1-T03 pre-dispatch Ruling: rotate-key iterates an exported ENCRYPTED_COLUMNS list (empty now; P2+ tasks append) — no encrypted columns exist yet — cost if wrong: script refactor later.
- P1-T03 pre-dispatch Ruling: getEnv() validates shared vars (DATABASE_URL, ENCRYPTION_KEY, MODE, APP_URL, DB_POOL_MAX, SYNC_MAX_STALENESS_SEC); app-only vars (BETTER_AUTH_SECRET, SETUP_TOKEN, WORKER_HEALTH_PORT) validated by web/worker via exported schema extension — avoids worker requiring web secrets — cost if wrong: minor.
- P1-T03: Ruling: accept tsx devDependency (plan already runs worker with tsx); added to STACK.md
- P1-T04: Ruling: invite-acceptance flow deferred to P7-T07 (single owner at launch per spec) — cost if wrong: invited users cannot join until P7.
- P1-T06 pre-dispatch Ruling: compose-smoke uses /api/healthz after restore (readyz arrives in P1-T07, which then switches the CI check) — plan ordering defect — cost if wrong: none
- P1-T06: Ruling: raised minors to fix round (CI restore check can't fail; ps1 LASTEXITCODE; nested .env in image; .env.example DOMAIN/POSTGRES_PASSWORD) — data-safety/secret-leak class — cost if wrong: a little extra churn
- P1-T06: Ruling: accepted deviations — restore drops/recreates DB (pg_restore --clean fails on pg-boss partitions); plain next start image (worker/migrate need full node_modules)
- PHASE GATE Ruling: single Opus whole-branch review combining SDD final review + ponytail-audit lens — avoids two full-repo passes — cost if wrong: a less specialized simplicity audit
- PHASE GATE Ruling: fix I1–I6 now (I1/I2 block merge; I3–I6 are interfaces Phase 2 builds on — cheaper now); I7 (key rotation vs compose) → P2-T02 — cost if wrong: small rework in P2-T02
- PHASE GATE Ruling: M1–M4 (CSRF APP_URL via getWebEnv, minPasswordLength 12, dead requireWorkspace kind param, unused web devDeps) carried into P2-T01 dispatch as preliminary cleanup — no second fix wave per SDD — cost if wrong: minors live a few more commits

### Phase 1 deferred minors (triaged in PHASE-GATE review)
- P1-T01: minor (deferred): engines node >=22.12 vs CI Node 24 (README too) — align later
- P1-T01: minor (deferred): prettier configured but not enforced in lint/CI
- P1-T01: minor (deferred): README links docs/ops/LOCAL.md before P1-T06 creates it (resolved by P1-T06)
- P1-T02: minor (deferred): prisma client created at import time throws without DATABASE_URL
- P1-T02: minor (deferred): AuditLog onDelete Cascade deletes audit trail with workspace
- P1-T02: minor (deferred): DB_POOL_MAX parseInt accepts "5abc"/negatives
- P1-T03: minor (deferred): lenient base64 in key/payload parsing; missing tag/IV-flip + empty-plaintext tests; rotate-key errors lack model/row; rotate-key outside typecheck; env.test replaces process.env; getEnv validates full schema on default-key crypto; formatting noise
- P1-T04: minor (deferred): /api/setup no rate limit; better-auth rate limit keyed on spoofable XFF, in-memory store (→ P7-T07)
- P1-T04: minor (deferred): viewer rejection tests use bare rejects.toThrow (not FORBIDDEN-specific)
- P1-T05: minor (deferred): pool size hard-coded 5 ignores DB_POOL_MAX; index.ts exports schema from side-effect file; healthz select 1 no timeout
- P1-T05: minor (deferred): no test for createQueue failure path (same catch as EADDRINUSE)
- P1-T06: minor (deferred): backup only mentions ENCRYPTION_KEY in a comment
- P1-T06: minor (deferred): restore.sh $dir resolved before cd (fails closed from scripts/ dir); restore blocked if current DB unreadable
- P1-T07: minor (deferred): lastUsedAt write on every request incl. 403 (throttle); audit not atomic with key create/revoke; no direct scopeAllows unit test; APP_URL host mismatch (127.0.0.1 vs localhost) → 403 on writes, document; sign-in audit lacks IP/UA/failures; readyz no rate limit; key-list select duplicated; 2b3e902 alone fails typecheck

## 2026-10-19 · Phase 2 step plan review round 1 · independent agent (opus) · **Changes Required**
1 Critical (sync paging cursor could lose replies), 12 Important (Graph ImmutableId, refresh-token handling, SSRF/TLS for IMAP-SMTP, interface gaps, Gmail scope decision, Graph revoke, cross-process fake, P2-T02 split + opus), 12 Minor. Full: docs/plans/phase-2-review.md. Planner revising.

## 2026-10-19 · Phase 2 step plan review round 2 · same independent agent (opus) · **APPROVED**
C1 + 12 Important resolved. 3 new Important (lease cleared on disconnect/reconnect, Graph deleteDraft only isDraft, GreenMail CI TLS/folders) appended to plan as Revision 3.

## 2026-10-20 · P2-T01 provider interface/MIME/Fake/contract · task reviewer (sonnet) · fixes → **Approved**
Pre-review interface fixes (receiver ids, reopen, IPv6 byte parsing); round 1: ::1 loopback, MIME CRLF + reserved headers + Bcc-leak check, zero-assertion guard, SSRF ranges, Fake clearFailures, env empty flags, Retry-After decimals.

## 2026-10-20 · P2-T02a credential store/refresh lease/key rotation · task reviewer (opus) · fixes → **Approved**
Plan defect fixed (lease overrun returned stale token → retry lease). Round 1: reconnect-during-failed-refresh race, toApiAccount allowlist, no writes to soft-deleted accounts.

## 2026-10-20 · P2-T02b Google OAuth connect · task + security reviewer (opus) · fixes → **Approved**
Security pass on state/PKCE/redirects/secrets/polling. Fixed: provider-mismatch reconnect, popup-closed polling, concurrent revive race, Playwright catch-all, provider_unavailable outage code.

## 2026-10-20 · P2-T03 Gmail provider · task reviewer (sonnet) · 2 fix rounds → **Approved**
findSent searches all mail incl. trash (overrode brief: no-duplicate-sends), labelAdded tracked (spam→inbox replies), 403 mapping narrowed so quota/policy 403s never disconnect mailboxes.

## 2026-10-20 · P2-T04 account service/API/UI · task reviewer (sonnet) · 3 fix rounds → **Approved**
Autofix conditional write, explicit :write scope, bulk clamp warnings, diagnostics in tx + audit, most-severe check wins, thrown AuthError/scope_missing → NEEDS_ATTENTION unless user-paused, shared numeric validator.

## 2026-10-20 · P2-T05 Microsoft Graph connect + provider · task reviewer (sonnet) · 1 fix round → **Approved**
Draft id carried on all post-draft errors, cleanup only when definitely unsent (isDraft guard), invalid_client = app-config not mailbox auth (Google too), guest #EXT# UPN rejected, gap clamp tested.

## 2026-10-20 · P2-T06 IMAP/SMTP provider + connect · task reviewer (opus) · 1 fix round → **Approved**
SSRF/TLS/credential handling verified. Fixed: IMAP throttle/outage at LOGIN not AuthError, listMessages paging + SINCE tz loss, shared openAccount (clears provider state), EAUTH codes, workspace-scoped creds, DNS rebind transient, byte-level STARTTLS + password-scrub tests.

## 2026-10-21 · P2-T07 test-send + live verification · task reviewer (sonnet) · 1 fix round → **Approved**
Atomic per-account rate limit (advisory xact lock, send outside tx), live-verify refuses Fake, LIVE_VERIFICATION complete, Retry-After header, recipient errors excluded from health.

## 2026-10-21 · Phase 2 gate · whole-branch review (opus) + ponytail audit · Fix first → **Approved**
0 Critical, 10 Important, 17 Minor. Fixed: user pause wins over auth failure, Google token 4xx parity with Microsoft, credential-read failure non-auth, live-verify Compose mode + real Message-ID comparison, SMTP/IMAP reconnect (PS-ACC-08). Deferred: I-7/I-9 → P4-T05, I-8 → P3-T11. CLAUDE.md updated with phase-2 rules.

### Phase 2 rulings (from the SDD ledger)
- | T04 ↔ T02b/T05/T06 | account service (reconnect keeps id) | T04 depends on T02b; T05/T06 call the same service. Ruling: T04 runs before T05/T06 (order in TASKS.json) — cost if wrong: none. |
- P2-T01: Ruling: receiveSpam returns {rfcMessageId} (no magic id); harness gains reopen() for true fresh-instance resume; assertPublicHost normalizes mapped IPv6 by bytes — interface cheapest to fix now — cost if wrong: minor churn
- P2-T01: Ruling: accept contract suite exported from @rightnow/providers/contract (keeps vitest out of runtime) and per-process failNext
- P2-T01: Ruling: raised minors — contract suite zero-assertion pass, SSRF ranges + DNS error wrap, Fake auth_revoked sticky, env empty-string flag, Retry-After decimals — each bites a later task or security — cost if wrong: small churn
- P2-T01: fix round 1 done 0016267 (CI green). Ruling: List-Unsubscribe* stay settable via headers (brief makes headers their only channel; CRLF guard still applies) — cost if wrong: caller could set a bad unsubscribe header, which P3-T08 owns anyway. Scoped re-review dispatched
- P2-T02a: Ruling: plan defect in D13 step 3 — returning stale creds after lease overrun can flag account AuthError; retry lease acquisition instead — spec "never silently disconnect" outranks plan text — cost if wrong: slightly longer waits under contention
- P2-T02a: Ruling: accept rotate null-skip fix; credential writes must go through setCredentials (carry to P2-T02b/T04/T05/T06); missing-creds throws plain Error; lease-wait timeout → TransientBeforeSendError
- P2-T02a: Ruling: raise M-3 (toApiAccount allowlist) and M-4 (setCredentials skips soft-deleted) — secret-leak/resurrection class — cost if wrong: minor churn
- P2-T02b: Ruling: single opus review = task review + planned opus security review of oauth.ts — avoids two passes — cost if wrong: none
- P2-T02b: Ruling: raised minors — concurrent revive race (integrity), Playwright testMatch silently skipping specs, Google 5xx → retryable — cost if wrong: minor churn
- P2-T02b: fix round 1 done e883ec4 (CI green). Ruling: ratify new OAuth error code provider_unavailable — user-facing distinction outage vs failed sign-in — cost if wrong: one enum value. Ruling: revive loser returns account_exists without retry (retry would find the live row) — accepted.
- P2-T03: Ruling: createProvider takes prisma as required dep (avoid import-time DB connection) — deviation from brief's optional deps — cost if wrong: one signature tweak
- P2-T03: Ruling: override brief — findSent searches all mail incl. spam/trash, confirms SENT label/From — spec no-duplicate-sends outranks plan text — cost if wrong: slightly broader search
- P2-T03: Ruling: raise minor labelsAdded tracking (reply moved SPAM→INBOX otherwise never synced → follow-up to replier) — cost if wrong: extra history types
- P2-T04: fix round 1 done 259994b (CI green). Ruling: user PAUSE wins over auth-failure NEEDS_ATTENTION in diagnostics (error kept in lastError) — brief silent — cost if wrong: paused account's auth issue less prominent until resumed
- P2-T05: Ruling: raised minors — invalid_client on refresh is app-config not mailbox AuthError (would flag every mailbox); guest #EXT# UPN never stored as email; minGapSec PATCH test — cost if wrong: small churn
- P2-T06: Ruling: raised minors — EAUTH non-535 not AuthError; smtpCredentials workspace filter (tenant isolation); DNS rebind at send → transient not permanent; security tests must prove claims — cost if wrong: small churn
- P2-T06: fix round 1 done ..05faa53 (CI green 3 jobs). Ruling: OAuth revive takes display names from fresh connect — reflects current mailbox — cost if wrong: user-edited name overwritten on revive. Scoped re-review dispatched
- P2-T07: Ruling: raised minor — recipient-level failures must not bump account errorCount24h/health — cost if wrong: small churn
- P2-T07: Ruling: test-send failures (outage/rate-limit/ambiguous) don't count toward account health — health driven by real sends + diagnostics — cost if wrong: an outage seen only via test-send isn't reflected in health
- PHASE 2 GATE Ruling: I-6 SMTP/IMAP reconnect built now in the fix wave (PS-ACC-08 requires reconnection) — cost if wrong: small scope addition before merge
- PHASE 2 GATE Ruling: I-7, I-9 → P4-T05; I-8 → P3-T11; I-5 bookkeeping + CLAUDE.md additions by controller

### Phase 2 deferred minors
- P2-T01: minor (deferred): store.ts stale-lock reap racy/untested; limit<=0 & garbage page tokens unvalidated; contract gaps (since case, mid-paging arrival, cursor to reopened instance); FakeOAuthClient loginHint unencoded; Fake timestamps not clock-injected; prettier noise env.ts; weak e2e 11-char assertion
- P2-T01: minor (deferred): Fake lock EPERM retry surfaces genuine permission errors after ~50 s
- P2-T02a: minor (deferred): per-process clock skew for lease (benign); rotate script backs up before stopping web/worker; rerun w/o printed key misleading; .ps1 unclear error when ENCRYPTION_KEY missing; schema tests no RED evidence
- P2-T02b: minor (deferred): fragile isUniqueViolation regex; GOOGLE_SETUP mentions row reconnect action before it exists (P2-T04 adds); revive sets lifecycle ACTIVE (not in brief)
- P2-T03: minor (deferred): ~20 MB page bound not enforced; diagnostics misleading scope_missing on store failure; index.ts export placement; locate ignores duplicate hits; empty page with hasMore:true possible
- P2-T03: minor (deferred): no test for labelsAdded TRASH skip
- P2-T04: minor (deferred): autofix IN_PROGRESS can stick after crash; applyLimits reads cur outside tx; aria-selected on tr invalid; e2e order-dependent; better-auth sign-in rate limit 5/min constrains e2e
- P2-T05: minor (deferred): non-send 4xx → PermanentSendError naming; e2e worker-retry re-sign-in; delta "changed" ignored (move to Deleted Items may not reach removed) → P4-T05 note
- P2-T06: minor (deferred): test-connection no rate limit + returns banner (ADMIN-only) → P7-T07; SSL vs STARTTLS mismatch reported as cert problem
- P2-T07: minor (deferred): live-verify 60 s wall limit/no per-call timeouts; locate/changes SENT check on self-send; S5/G9 impractical on real host; fake route not workspace-scoped (ADMIN-only, flag-gated)
- P2-T07: minor (deferred): setSending(false) not in finally (button can stick on thrown call)

### Phase 2 carry-forwards
- P2-T01: carry-forward to P2-T06: assertPublicHost must block IPv4-compatible ::a.b.c.d (non-::/::1) via embedded-v4 check
- P2-T02a: carry-forward (binding) to P2-T02b/T03/T04/T05/T06 briefs: disconnect, soft delete, reconnect ONLY via setCredentials
- P2-T02a: carry-forward to P2-T02b/T04: connect/reconnect routes must check setCredentials boolean and return an error on false
- P2-T02b: carry-forward to P2-T04/T05: OAuth scope check must branch per provider
- P2-T02b: carry-forward to P2-T07: live verify popup flow with real Google (COOP)
- P2-T02b: carry-forward to P2-T04: Cancel should invalidate server OAuthSession (now UI-only); re-click Connect after Cancel can leave a stale poll loop running
- P2-T03: carry-forward to P2-T07: live-verify Gmail history shape, in:anywhere/in:sent queries, format=minimal labelIds, error envelopes, Message-ID preservation, Bcc in stored sent copy
- P2-T03: carry-forward to P4-T01: Gmail may re-report the same providerMessageId after labelAdded — ingest must dedupe (rfcMessageId/providerMessageId) and update folder
- P2-T03: carry-forward to P4-T05/P5-T02: persistent TransientBeforeSendError on reads (e.g. policy 403) must be attempt-capped and escalated to account health, never retried forever
- P2-T04: carry-forward to P2-T05: Microsoft account create must apply MS365/OUTLOOK_COM minGapSec floor (3 s)
- P2-T05: carry-forward to P2-T07: live-verify Graph shapes (Message-ID + draft id survive into Sent Items, @removed reasons, 403 codes) per P2-T05 report
- P2-T05: carry-forward to P3-T11: sender persists ProviderError.providerMessageId onto ScheduledMessage.providerMessageId (findSent hint for Graph)
- P2-T05: carry-forward to P4-T05: Graph delta "changed" ignored — move to Deleted Items may not reach removed

## 2026-10-21 · Phase 3 step plan review round 1 · independent agent (opus) · **Changes Required**
2 Critical (cancelled HELD row re-planned → double send; claim lacked current-step check → stale main-sequence follow-up after subsequence entry), 12 Important (D18 blocklist-as-hard-bounce, account errors pause leads not account, UNCERTAIN without time cap, planner/claim deadlock, one bad row blocks all workspaces, …), 19 Minor. D16/D17 sound and unbypassable; D18 fits frozen interface. Planner revising.

## 2026-10-21 · Phase 3 step plan review round 2 · same independent agent (opus) · **APPROVED**
0 Critical, 0 Important, 7 Minor (appended to plan as Revision 3). Deviations accepted (rotation-first split; import files documented). D16 sending blocked until P4 sync; D17 ProviderVerification gate; D18 rev 2 scope; D19.

## 2026-10-21 · P3-T01 leads service/API · task reviewer (sonnet) · 1 fix round → **Approved**
Merge row locks, full isolation tests, set-based bulk with 30 s timeout, Suppression→Lead lock order, GDPR in-flight test fails loudly (real-table test owned by P3-T09).

## 2026-10-21 · P3-T02 CSV import/export + ESP · task reviewer (sonnet) · 1 fix round → **Approved**
List dedupe implemented, campaign dedupe 400 until P3-T06, parser errors surfaced, stale-job attempt cap, deadlock batch retry, export formula guard keeps numbers.

## 2026-10-21 · P3-T03 lists/blocklist/Leads UI · task reviewer (sonnet) · 2 fix rounds → **Approved**
D20 (GDPR_ERASURE/COMPLAINT non-removable on every path incl. GDPR reason upgrade; UNSUBSCRIBE removal needs attestation), MANUAL-only bulk clear, persistent bulk messages, Bounced view params, export never truncates.

## 2026-10-21 · Chore: flaky CI e2e · implementer (sonnet), controller-reviewed
Root cause (likely): better-auth 5/min sign-in rate limit across specs. Fix: shared API sign-in session + CI retries 2 + github reporter + trace on failure.

## 2026-10-21 · P3-T04 template engine · task reviewer (sonnet) · 1 fix round → **Approved**
Fallback-brace validation, renderSubject (single-line, no HTML) as the only subject path, independent subject/body seeds, template-injection via lead data impossible (values never re-parsed).

## 2026-10-21 · P3-T05 campaign service/API · task reviewer (sonnet) · 1 fix round → **Approved**
Merged cc/bcc cap, launch checks over usable accounts only, unsubscribe reachability via shared isPrivate, relaunch/resume re-validate. physicalAddress settings owned by P3-T08.

## 2026-10-21 · P3-T07 schedule math · task reviewer (sonnet, with probes) · 1 fix round → **Approved**
DST spring-forward/fall-back, overnight windows, multi-timezone earliest, dayKey at midnight, empty schedules throw; windows wholly inside a DST gap skipped.

## 2026-10-21 · P3-T08 unsubscribe/footer/physical address · task reviewer (sonnet, compliance lens) · 1 fix round → **Approved**
HMAC tokens (constant-time, no enumeration), RFC 8058 one-click POST (no cookies, idempotent, enrollments UNSUBSCRIBED), GET never unsubscribes, footer always carries address, List-Unsubscribe(-Post) per mode, lock order + retry.

## 2026-10-21 · P3-T06 sequences/enrollment/duplicate/export · task reviewer (sonnet) · 3 fix rounds → **Approved**
Claim re-check contract for T09/T10b, active-campaign edit guards, merge/delete stop enrollments, conflict rule covers unhealthy states + launch re-check, merge move honors suppression/conflict, lock order 726004 before Lead rows.

## 2026-10-21 · P3-T09 quota + dispatcher claim · task reviewer (opus, adversarial) · 1 fix round → **Approved**
No double-send, over-quota, outside-window or unretried-deadlock path. Fixed: claimed rows kept on late error, lock order documented as D21 (SM→CL→usage→EA), post-lock eligibility re-check, claim indexes, DB unique (campaignLeadId,stepId), deterministic campaign/workspace cap tests, lock-wait treated as busy.

## 2026-10-21 · P3-T10a rotation/explainer/status · task reviewer (sonnet) · 1 fix round → **Approved**
Shared accountOk + companyGateOk + remainingToday predicates across claim, pickAccount and explainer; constant-query rotation; blocking flag; pickAccount null = not now.

## 2026-10-21 · P3-T10b planner · task reviewer (opus, adversarial) · 1 fix round → **Approved**
C-1 batch starvation fixed (paging, per-constraint exclusion, 1 h durable back-off), single-pass edit re-render, deleteStep locks rows; D22 records the step-1 delete and removeFromSubsequence deviations.

## 2026-10-21 · P3-T11a sender · task reviewer (opus, adversarial) · 1 fix round → **Approved** (sonnet re-review)
No duplicate-send path: provider call outside transactions, every post-send write conditional on claimToken, late accept never resends, reservations committed or released exactly once. Fixed: C advance() could revive a STOPPED last-step lead into a completed_no_reply subsequence (now only QUEUED/ACTIVE/PAUSED advance); I SMTP 5.1.x sender-side rejections (MAIL FROM/AUTH or "sender" text) no longer suppress the lead; `variant!` finding confirmed false positive (claim cancels null/inactive variant as stale), assertion removed and pinned by test. Deferred: SEND_LEASE_SEC floor → P3-T11b; cc-caused rejection → P5; 429 attempt cap kept; hard-delete mid-send reservation stays on that day's usage.

## 2026-10-21 · P3-T11b recovery + HELD API · task reviewer (opus, adversarial) · 1 minor-fix round → **Approved** (sonnet re-review)
No resend path: recovery never resends, every write conditional on state/claimToken, reservations settled exactly once across recover/found/held/release/cancel/late-accept. Rulings: a throwing findSent counts as an attempt, but the 24 h cap holds only after ≥2 attempts ≥15 min apart; pg-boss heartbeat + 15 s monitor/supervise (dead job failed in ~25 s) accepted as minimal. Round 1: HELD release session-only ADMIN (may send a second copy), listScheduled exposes search history, multistep E2E asserts sent-copy count. Deferred: Graph draft cleanup on the cap path; lead-import heartbeat; old dev-DB queue settings.

## 2026-10-21 · P3-T12 campaign builder UI · task reviewer (sonnet) · 1 minor-fix round → **Approved** (sonnet re-review)
Preview uses the sender's own renderForLead (preview = sent), HTML in a sandboxed iframe, test-send and HELD release session-only ADMIN with the "may already have been delivered" confirm, workspace-scoped. Rulings: test-send copies carry dead unsubscribe text (a live token could opt the real lead out); extra Cancelled tab, save-time template errors, no reorder UI accepted. Round 1: readable preview errors, blank follow-up subject previews as the planner's "Re:", /scheduled stale-response guard, "Finished" column.

## 2026-10-21 · P3-T13 ramp, workspace caps, lead timeline · task reviewer (sonnet) → **Approved**
Every allowance consumer (claim, pickAccount, explainer, planner, toApiAccount) goes through effectiveAllowance, so the ramp cannot be bypassed; timeline workspace-scoped. Ruling: re-enabling slow ramp restarts it (rampStartedAt stamped on each off→on), overriding the brief's "only when null", because a mailbox must not jump to full volume after a ramp toggle. Deferred: bulk interest changes write no per-lead audit row, so they are absent from the timeline.

## 2026-10-21 · Phase 3 gate · whole-branch reviewer (opus) + ponytail-audit · 1 fix wave → **Ready with fixes applied**
No critical findings; no duplicate-send, over-send or outside-window path. Fixed: I-1 graceful stop (stop signal before claims, pg-boss stop timeout 90 s, compose grace 100 s); I-2 HELD release clears `uncertainAt` so a later cancel is re-planned; I-3 unassigned sticky mailbox pauses the lead SEND_FAILED and the explainer says so; I-4 COMPLETED campaigns resume; M-1 user-path lock inversions retried; M-2 stale check right before send; M-3 SMTP To refused with Cc accepted is a failure; M-4 test-send refuses suppressed recipients; M-5 preview never shows a live unsubscribe link; M-7 planner sweeps SCHEDULED rows of archived/completed/deleted campaigns; M-8 revival resets attempts; M-9 lead-import heartbeat; audit A1/A2/A6/A8/A9/A11. D25 records the policies. Deferred: M-6 claim re-check of ESP rules/tags → P5; audit planner split, idempotencyKey drop, committedToday caching, bulk-interest cap, recomputeDue loop. Each must-fix has a test verified to fail with its fix reverted.

## 2026-10-21 · Phase 3 gate · opus whole-branch review + ponytail audit + opus scoped re-review → **Approved, merged**
Review: 0 Critical, 4 Important, 9 Minor; no duplicate/over-quota/outside-window path. Fixed in one wave (02facdb, D25): I-1 graceful shutdown (stop claiming on SIGTERM, 90 s stop bound), I-2 released HELD row with dead variant no longer strands the lead, I-3 sticky mailbox unassigned → leads paused + surfaced in explainer (D23), I-4 COMPLETED campaign resumable with launch checks; M-1..M-5, M-7..M-9; audit A1 shared open-state constant, A2 one stop-and-cancel helper, A6 partial-index test, A8 launch fallback removed, unused exports deleted. Deferred: M-6 → P5-T02; planner split, idempotencyKey drop, committedToday caching, bulk-interest cap, recomputeDue loop. Re-review new minors: N-1 Cc multi-copy on To 4xx (blocking for P4-T05), N-2 no bulk resume after re-assign (P5-T02), N-3 resume after end date (P4-T05). Parity 126/316.

## 2026-10-21 · Phase 4 plan · independent opus plan review → **Revise → Revision 2 applied**
1 Critical, 12 Important, 18 Minor (`docs/plans/phase-4-review.md`). C1 multi-run historical/full import kept no cursor and set the watermark from the last run (fix: cursor + startedAt in syncProgress). I1 applyInbound order (stops → subsequence → interest → counters → suppression → event), I2 Cc bounce, I3 tx-level optOutTx + direct SYNC error write, I4 own-Message-ID match for SENT copies, I5 rfcMessageId index, I6 lease renewal + time budget, I7 date guard only for unthreaded mail, I8 non-lead company stop only when threaded, I9 not-interested false positives, I10 opened/clicked triggers, I11 GDPR erase/merge of mail, I12 T07 (f) vs company gate. All 31 folded into the plan as a binding Revision 2 table; TASKS.json models/deps updated.
- P4-T01 (8221d0b): mail schema (Thread/Message/Attachment/Event/SyncRun), ingest + threading (D17 fallback, own-id match), event store with ACCEPTED backfill, GDPR erase/merge of mail. Review: spec ✅, 0 C/I, 8 minor (ledger).
- P4-T04 (1d27c95, bcdb714, fc1664f): signed open pixel + click redirect (open-redirect safe), machine/scanner flags, tracking domains via Caddy on-demand TLS (+ CI caddy validate), ACTIVITY subsequence triggers. Review: 1 Important (Caddy respond order) + 1 new Important (malformed href throw) fixed in 2 rounds; deviation: no TDD RED evidence.
- P4-T02 (d4c1c31, 2fab48b): rule classifier (DSN D27 classes, auto-reply + OOO dates, unsubscribe, interest) with 49-email corpus. Review: 3 Important false-positive findings (unsubscribe, not-interested, localised quotes) fixed in 1 round.
- P4-T03 (87bcd58, 1795246): stop rules (reply/company/OOO/unsubscribe/bounce, keyword+status subsequences, M17 settle of UNCERTAIN/HELD on reply), D26/D27. Opus review: 1 Important (M17 settle before stops inverted D21) + 3 minor behaviour bugs fixed in 1 round. Implementer was interrupted once and relaunched from the saved partial diff.
- P4-T05 (e17520e, dbd1eea): mail-sync job (incremental/full/historical, C1 multi-run watermark, lease renewal, escalation), N-1 partial-accept, N-3 ended-campaign resume, I-7/I-9 provider fixes. **D16 lifted: accounts become fresh, campaigns send (real providers still gated by D17).** Opus review: 3 Important (import byte cap, D18 scope copy, NUL poison) fixed in 1 round.
- P4-T07 (6cfbd26): 1/7/30-day × cold-boot/sleep downtime suite (replies incl. cross-mailbox + company, DSN bounce, mailto unsubscribe, expired cursor, mid-flight UNCERTAIN, quota spreading, stale-account control campaign) + docs/ops/OFFLINE_RECOVERY.md. Found no bugs (mutation-checked). Opus review: approved, minors (doc accuracy) for the gate wave.
- P4-T06 (cdfd496, 6497e29): inbox API (threads/views/search/bulk/unread/notes/macros/saved views/attach-lead/attachments, reply+forward with D29). Review: 1 Important (post-send storage failure → 500 invited resend) + read-all scoped to thread (ruling) fixed in 1 round; deviation: first pass without TDD RED.
- P4-T08 (f6c4df6): unified inbox UI (sandboxed CSP message frame, cid→data, composer with attachments + macros picker, lead panel, views, bulk, notes, reminders, delete-lead dialog) + inbox-thread.spec.ts incl. inert-rendering. Review: approved; minors to gate wave.

## 2026-10-22 · Phase 4 gate · opus whole-branch review + ponytail audit + opus scoped re-review → **Approved, merged**
Final review: 1 Critical (bounce-classifier regex ReDoS froze the worker), 3 Important (oversized ids poison a mailbox, GDPR erase gaps, composer duplicate send), 9 Minor; audit 5 must / 9 should / 4 nice. One 14-item fix wave (2684bbc..44f768c): bounded regexes + 64 KB cap, id/address sanitizing, header-only placeholder after 3 failed runs, GDPR erase of all mail traces, composer send guards, no-target bounces never suppress, reply usage reservation + per-thread reply lease, Attachment index, list snippets, OOO year fix, tracking/category/bounce minors, stale copy, D28–D31, macro manage UI. Re-review: 14/14 addressed + 1 new Important (multibyte Message-ID vs byte index limit) fixed in 2eb4ade. CI had been red since P4-T08 (inbox e2e on Linux next-dev: spec matched the note textarea and reloaded before save; retries re-imported Fake mail) — fixed c69b96c; CI green. Deferred minors are in the Phase 4 ledger summary below and carried to P5–P7. Parity 171/316.

### Phase 4 ledger summary (rulings and deferred minors; the SDD workspace is deleted after merge)
- Ruling: T02 and T04 run as 2 parallel implementers — CLAUDE.md allows max 2 concurrent implementers on disjoint files and their file sets are disjoint — if wrong, a git index collision costs one re-commit (staging is by explicit path).
- Ruling: task briefs come from brief.sh instead of scripts/task-brief (headings are "P4-TNN", not "Task N") — same content contract — if a brief misses a Revision row the reviewer gets the same brief, so the gap would surface at the final review.
- Ruling: T02 minor 4 (OOO date edge cases incl. "feedback 12 July") goes into fix round 1 — same regexes being edited, and a false date pauses follow-ups — costs one slightly larger fix diff if wrong.
- Ruling: T04 missing RED evidence is recorded as a process deviation, not re-done — rewriting tests to fail first would prove nothing about the existing code — cost if wrong: tests that never failed may assert too little (reviewer judged coverage adequate).
- Ruling: T04 ⚠️ enterSubsequence→cancelOpenRows after CampaignLead lock is fine — cancelRows uses FOR UPDATE SKIP LOCKED, never waits (planner-exception pattern, D21) — cost if wrong: a deadlock retried by withTxRetry.
- Ruling: T04 minor 2 (unsubscribe skip vs key rotation) folded into fix round 1 — one-line change in the file being edited — cost: slightly larger fix diff.
- Ruling: T03 minors 1–3 (HELD claimToken "", empty phrase matches all, keyword reply revives user-PAUSED lead) + D26 note + 2 test assertions folded into fix round 1 — they are behaviour bugs in the same block — cost: larger fix diff.
- Ruling: poison messages are sanitized (strip \u0000, invalid Date → provider internal date or syncStartedAt), not quarantined — keeps "never skipped silently" and needs no new product surface — cost if wrong: another unforeseen poison class still blocks a mailbox until escalation (visible as SYNC error).
- Ruling: T05 minors 1 (AI hook re-call + timeout race), 5 (log code only — privacy), 6 (D24 lists) folded into fix round 1 — small, same files — cost: larger fix diff.
- Ruling: read-all marks only the one thread (PS-INBOX-23 literal) — lead-wide marking silently hides other conversations — cost if wrong: user clicks once per thread.
- Ruling: T06 missing TDD RED recorded as process deviation (2nd sonnet implementer to skip it); fix round must show RED — cost: none beyond review trust.
- Ruling: T06 minors forward size-before-data, providerFor AuthError → recordProviderError, I9 undo condition folded into fix round 1 — small, same files, correctness/memory — cost: larger diff.
- Ruling: poison messages → after 3 consecutive failed runs ingest a header-only placeholder (still stop-ruled) and move the cursor — supersedes the T05 sanitize-only ruling now that more poison classes exist — cost if wrong: a placeholder hides a body the user may want (visible as placeholder + SyncRun note).
- Ruling: no-target bounce records the Event only, never suppresses (PA #4, reverses M15 part) — From is unauthenticated — cost: a real bounce for a never-mailed address goes unsuppressed (harmless: we never mail it).
- Ruling: replies reserve usage before sending and allow one reply in flight per thread (advisory namespace 726005) — closes D29 overshoot + double-click — cost: a stuck in-flight marker must expire (fixer documents).
- Ruling: thread category change lifts NOT_INTERESTED suppression only for ADMIN (D20) — cost: members must ask an admin.
- Ruling: PS-INBOX-09 minimal macro manage dialog built now — spec item, small — cost: UI polish later.
- Ruling: not fixed (by design/deferred): attachments in Postgres (master plan: backups include them); API-key forward to any address (spec feature, scoped key); lease renewal per message → P7-T05; query count, near-copies, test-only options, historical-read, search/unread polling → P7 polish.
- Ruling: residual multibyte Message-ID is load-bearing (one hostile mail freezes a mailbox) → smallest change: byte-length id check + placeholder uses synthetic id; dispatched to a small sonnet fixer (no second full wave) — cost: none beyond one small commit.
- Ruling: placeholder always uses a synthetic id — it can no longer self-match our own Sent copy (step 0) and two identical bodiless messages could collapse — accepted, rare; replies still thread via In-Reply-To — cost: an occasional outsideApp placeholder for one of our own sends.
- Task 1: minor (deferred): dispatch.ts:409 claim-error FAILED writes no SEND_FAILED event
- Task 1: minor (deferred): no cross-workspace isolation test for matchMessage
- Task 1: minor (deferred): OUT copy without In-Reply-To may open a 2nd thread when recordOutboundMessage failed
- Task 1: minor (deferred): SEND_FAILED uses new Date() not clock; extra findUnique per send
- Task 1: minor (deferred): ingest repeats step-0 own-send lookup
- Task 1: minor (deferred): no test that resolveUncertain writes OUT Message + ACCEPTED
- Task 1: minor (deferred): Event has no FK to Workspace
- Task 2: minor (deferred): corpus lacks ES/DE month names, x-auto-response-suppress OOF, x-autorespond cases
- Task 4: minor (deferred): withTracking regex skips malformed href (safe); only &amp; decoded
- Task 4: minor (deferred): tracking routes swallow DB errors without a log line
- Task 4: minor (deferred): no sender test for APP_URL fallback; no check-route test for soft-deleted account
- Task 4: minor (deferred): fix diff reformatted unrelated lines
- Task 2: minor (deferred): ≥3 `Word:` lines rule can cut an all-key/value reply → UNCERTAIN (safe fallback)
- Task 2: minor (deferred): UNSUB negation list only matches straight apostrophe (don’t)
- Task 2: minor (deferred): recall drops (I'll pass on this; unsubscribe in long body) — deliberate precision trade
- Task 3: minor (deferred): recipient-fallback bounce lookup ignores UNCERTAIN sends (note in D27 later)
- Task 3: minor (deferred): INTEREST_CHANGED dedupe key collides under fixed clock (matches fixed names)
- Task 3: minor (deferred): no concurrent twin-ingest test (decision 2 reasoned only)
- Task 3: minor (deferred): acceptTx SENT-row token compare null vs "" could double creditSent if an UNCERTAIN row ever has a null token (no production path); fix with (m.claimToken ?? "") compare
- Task 5: minor (deferred): no test for Stopped mid-page
- Task 5: minor (deferred): AuthError on user-paused account retried every poll with no backoff
- Task 5: minor (deferred): `more` accounts sort last in syncDue and may starve within the 50 s budget
- Task 5: minor (deferred): syntheticMessageId hashes a fallback date → headerless+dateless message may re-ingest after FULL reconcile
- Task 5: minor (deferred): Graph rn-cut token up to ~15 KB in syncProgress; readCapped checks after each chunk
- Task 5: minor (deferred): hung-classifier test waits a real 10 s
- Task 6: minor (deferred): D29 check doesn't reserve → concurrent replies can overshoot half-cap together (recorded in DECISIONS)
- Task 6: minor (deferred): M16 reuse path drops uploaded attachments / keeps outsideApp from sync
- Task 6: minor (deferred): attach-lead to a different lead leaves event on first lead; interest/lastEngagement not applied on attach path
- Task 6: minor (deferred): filename* encoding leaves '()*; bulk blocklist can include mailer-daemon
- Task 7: minor (deferred): ticks equal the 600 s gap so gap assertion only catches same-tick bursts; sticky-mailbox check compares against campaignLead.accountId; console filter hides all sync errors
- Task 7: minor (watch): suite ~4–5 min; watch CI timing (quota.test timeout under parallel load)
- Task 8: minor (deferred): fake sync route updateMany unscoped (test-only); no test for its 404 refusal; form text dropped in rendered view; no confirm on delete conversation; same-domain delete take=200 silently partial
- Gate: minor (deferred): GDPR erase deletes inbound mail from other leads that cc'd the erased person (over-reach, defensible); ILIKE substring over-redacts other events' meta; bounce settleSent after suppress() (Suppression before usage vs D21, same as M17 path, withTxRetry covers); bounce loads full ScheduledMessage row; stoprules keyword/stripQuoted run on uncapped text (linear); providerFor refresh not covered by reply lease timeout
- P5-T01 (cf92ae5, 8b65f8b): DNS checks (SPF lookup count, DKIM selectors, DMARC, MX, DNSBL, PTR) with injected resolver, DomainCheck, daily recheck, launch gate (SPF block, others overridable). Review: 2 Important (DNSBL partial result reported ok; IP-literal regex) + fail-open minors + CI e2e Save-button collision fixed in 1 round.
- P5-T02 (286076a, d48a2da): health score + snapshot, throttle/restore, pause (≥50-send floor, resume-anchored windows), decaying provider errors, DNS-block cap, BounceProtect, ACCOUNTS_UNHEALTHY, ARF complaints, M-6/N-2/Cc/lastError carry-forwards. Opus review: 2 Important (complaints on FBL mailbox; forged untargeted reports counted) + error-stacking minors fixed in 1 round.
- P5-T03 (fa7614f, 355ffb2): honest warm-up peer pool (D36): plain-text self-identifying sends, reply rate, read-only placement measurement, D17-gated, excluded from inbox/events/stop rules by Message-ID + In-Reply-To/References/DSN original id, WarmupMessage storage, drawer section + bulk toggle. Opus review: 1 Important (waiting replies abandoned → reply rate far below setting) + minors fixed in 1 round. First implementer stalled (login expiry) and a fixer was stopped (laptop close); both relaunched from saved partial work.
- P5-T04 (795ba36, 8d94c83, 4444b7d): inbox placement tests (D37) to the user's own opted-in seed accounts, rendered like a test send (no tracking/unsubscribe), D17-gated, quota counted like manual replies with a guarded upsert (M10), latest finished test feeds health. Review: 2 Important (provider failure stranded PLANNED rows; SENT rows of unlocatable seeds never expired) + scoping/health minors + CI-only test-send e2e OAuth-redirect race fixed in 1 round. Implementer stopped twice (laptop close); relaunched from saved work.
- P5-T08 (4d58c4e, 4539165, fe3e624): pluggable EmailVerifier (D38) with MX and HTTPS vendor verifiers (SSRF-checked, key encrypted in `Workspace.verifierConfigEnc`, ADMIN session-only settings), PENDING_JOB leads skipped by planner/claim (Rev I9), verifyOnImport marks leads pending inside the import tx (closes the planner race). Review: 2 Important (queued backlog reverted unverified after 30 min; silent verifier failures) fixed in round 1 (claim timestamp, retry with cap, lastError, new host requires new key); round 2 made vendor HTTP ≥400 and malformed responses visible failures (overrides the brief's "500 → null"). Verifier settings UI carried to P5-T07.
- P5-T05 (80c7f09): inactivity detection (D33, 30 d default, AUTO) computed in the reconcileAccount caught-up tx, warm-up not activity, `returnToService` helper (state-guarded resume WHERE, health reset moved from resumeAccount) on all six resume/reconnect paths, SYNC-under-SOFT_BOUNCE strip, re-warm allowance via existing guarded usage reservation. Opus review: approved, 0 Critical/Important; minors carried into P5-T06.
- P5-T06 (d4291a3): re-warm mode (D32) — start with connectivity + DNS recheck (network outside tx), optional warm-up during re-warm with restore-if-unchanged (M12), health throttle holds the ramp (≥50-send floor), completion, 30-day downtime scenario; PS-ACC-16 met. Implementer found and fixed an in-flight pre-downtime send counting as a ramp day. Opus review: approved, 0 Critical/Important; test-assertion and Fake-provider DNS minors carried into P5-T07.
- P5-T07 (46afd67, 7da9006): deliverability and reactivation dashboard (per-account health/warm-up/re-warm/DNS/placement overview in 8 batched queries, health sparkline), bounce threshold + health slowdown settings UI, verifier settings UI (write-only key, lastError), explicit `skipDns` for the Fake provider only, T06 exact ramp assertions. Implementer restarted after the machine slept. Review: 1 Important (overview warm-up eligibility ignored the live-verified provider check) + minors fixed in 1 round.
- Phase 5 gate: opus whole-branch review (0 C / 2 I / 8 M: PENDING_JOB leads consumed the planner's per-tick budget; warm-up locate window stalled on unlocatable rows) + ponytail audit (14 findings: duplicate complaints per lead, no floor on the BounceProtect complaint branch, full-table verify scan, unbounded DNS recheck, N×M peer ranking, health rewrote every row). Fix wave f54c611, 1d3947f, 5945d89 (10 items: one D34 bounce/complaint predicate counted once per lead, planner excludes verifying leads + `leads_verifying` reason, 24 h MISSING sweep for all warm-up kinds before locate, lifecycle lock `FOR NO KEY UPDATE` (no deadlock vs claim), verify job gets the shutdown signal, per-item isolation + logging in health/warm-up/DNS jobs, verify partial index, grouped peer ranking, conditional health writes). Opus re-review: 10/10 addressed, no new findings.
- Phase 5 rulings summary: DNS "block" caps at healthSlowdownPct rather than stopping (Rev I11); settings UI for thresholds and the verifier delivered in T07; verifyOnImport marks leads pending inside the import tx; vendor HTTP ≥ 400 is a visible, retried verifier failure (overrides the plan's "500 → null"); missing per-test RED evidence recorded as a process deviation (T03, T04, T07); minors folded into fix rounds where they were correctness. Deferred to P7: see HANDOFF carry-forwards.
- P6-T01a (0b5bf7c, 2f2ebbc): pipeline stages, opportunities (one per lead+campaign), interest-to-stage hook inside reply ingest under a SAVEPOINT (fresh replies only, after the duplicate check, ON CONFLICT DO NOTHING, values capped, non-retryable errors audited `crm.hook_failed`), revenue fields, single workspace currency (D40). Opus review: 1 Important (stage kind change raced a move-in → wrong won/lost bookkeeping) + 7 minors fixed in 1 round with forced-interleaving tests. Rulings: automatic reply classification never moves a closed deal; kind change takes FOR UPDATE on the edited stage (no lock cycle, recorded in D21).
- P6-T01b (eb1d54a, 3eaa45c): tasks with due-date reminders (today/overdue at workspace-local midnight, DST-tested), logged calls/activity, keyset-paged activity feed, lead timeline (D41). Review: 3 Important (feed 500 for a deleted/unknown/foreign deal; a real-clock test that would fail after 2026-11-05; merge lost the merged-away lead's history) fixed in 1 round — feed follows `Lead.mergedIntoId` chains instead of rewriting audit rows; unknown/foreign deal → empty 200 (no existence leak).
- P6-T02 (a7fd83b, ff1097a): CRM UI — accessible pipeline board (keyboard "Move to stage", aria-live announcements, focus kept on the moved card), opportunity drawer with attribution, tasks/activity tabs, pipeline settings. Review: 5 Important (focus lost after a move; no rollback when move + reload fail; task errors swallowed; order-coupled revenue e2e; fake keyboard e2e) + minors fixed in 1 round.
- P6-T03 (168c77d, 470161b): analytics, dashboard and export queries — event-based metrics (D34 predicates reused), groupBy campaign/step/variant/account/day/ESP with tz-aware day buckets, CRM revenue report, capacity, keyset-streamed CSV activity export. Review: 1 Important (first-contact flag compared against range start, so follow-ups inflated per-day/per-step `contacted`; totals were right) + 1 minor (duplicate CSV `line` helper) fixed in 1 round. Known: per-row `contacted` can exceed the distinct-lead total when one lead is first-mailed by two campaigns in range (I6 semantics; explain in T04 UI).
- P6-T04 (5dcc13f, ddef453): Dashboard + Analytics pages (Recharts, pinned 3.10.1, per plan), URL-state filters, metric menu, variant toggle, CSV downloads, contacted-vs-total note. Review: 1 Important (unknown `?tz=` threw RangeError and crashed the page) + 4 minors (client CSV near-copy → shared dependency-free `@rightnow/core/csv`; mouse-only rate tooltips; Metrics menu Escape/focus; variant fetch race) fixed in 1 round.
- Phase 6 gate (96cf571, 8384bd5, fe9404d, + drawer label): opus whole-branch review PASS WITH FIXES (I1 current pipeline counted deals of soft-deleted leads; minors: two "Won" definitions on one page, Task FK indexes, tasks on deleted leads, merge double meetings, stage-route auth wording) + ponytail audit (analytics page ran the heavy event query 6× per load → 2 via grouped single-scan request; bulk interest measured 1000 leads 2.5–2.8 s, no change; AuditLog expression indexes; timeline reuses crmActivity; CSV mid-stream failure marker; shared isPrismaCode/notFound; activity titles joined; board days in workspace tz). 14/14 fixed, scoped re-review clean; deleted-task timeline label fixed by controller. Deferred: see HANDOFF carry-forwards.
- P7-T01a (199f50c, 17fe6fa, dff21db): automation engine — Event table as outbox (`dispatchedAt`, SKIP LOCKED claim, savepoint per event + per rule, poison events stamped `dispatchError`), producers (ACCOUNT_ERROR, CAMPAIGN_COMPLETED, QUOTA_REACHED…), actions, rules service with per-action API-key scopes, `event-dispatch` job (heartbeat). Review (opus): 1 Important (transient errors in the per-event fallback stamped → events lost) + minors (D43 no-rule stamp, recordProviderError non-atomic, duplicate code helper, diagnostics test). Re-review: 1 Important (solo P2028 always transient → endless retry) → fixed with lock_timeout 10 s (lock waits stay pending as 55P03; a solo tx timeout is stamped with FAILED runs). 2 fix rounds.
- P7-T01b (29d929f, f2c2b25): automation routes (rules CRUD + runs, built-ins session-only ADMIN), Automations page (Rules/Built-in/Runs), rule editor, e2e; `crmAutoOpportunity` now written only through the Built-in tab; `route()` passes server-side API-key scopes to handlers. Review: 2 Important (rule delete without confirm; editor crashed on an action type it had no entry for) + 4 minors fixed in 1 round; drift test pins client trigger/action tables to core.
- P7-T02a (901b1e0, fd7c69d): webhook core — `safeRequest` (one lookup, IP pinned via `lookup`, SNI/Host from URL, no redirects, private/metadata/NAT64/6to4/IPv4-mapped refused; metadata + link-local blocked even with ALLOW_PRIVATE_HTTP_HOSTS), per-attempt HMAC over `t.<body>`, encrypted secrets/headers, SKIP LOCKED delivery claim + conditional result write, backoff, auto-disable, `webhook-deliver` job, GDPR FK cascade + payload purge, minimal `retention` job; verifier moved onto `safeRequest`. Review (opus, pentest): 3 Important (send_webhook on a reply rule bypassed inbox:read; lead custom fields overrode the payload envelope and could crash dispatch; delivery log exposed reply bodies to webhooks:read keys) + minors (Alibaba/Oracle metadata, >256 KB payload, docs) fixed in 1 round; security re-review clean.
- P7-T02b (dafbfb4, f84b83a): webhook routes (webhooks:read/write, caller scopes passed so delivery logs strip reply bodies for keys without inbox:read), Webhooks tab (form, deliveries, redeliver, test, overview chart), reserved label names, STANDARD_FIELDS so custom fields can't pose as payload fields, send_webhook select, `_fake/echo` e2e target (refused in vps). Review: spec ✅, no Important; 4 minors fixed (stale/UTC overview, redeliver pagination + feedback, redeliver audit, case-insensitive reserved names). Test-send rate limit → T07a.
- P7-T03a (003e363, 294f5e2, 2d5dc42): background jobs (202 + polling, SKIP LOCKED claim, one RUNNING per workspace, progress-based stale reclaim fenced by `attempts`), filter-based bulk leads, audit-logs/tags/members routes, lead data export, retention purges AutomationRun + BackgroundJob. Review: 2 Important (export included other leads' whole threads + notes when the lead was cc'd — privacy; no fencing so a stalled run could write over its re-claimed successor) + minors (filter path validated late, missing expectIsolated, schema alignment) fixed in 1 round; controller widened the export filter to unassigned threads. R13 AI retryAfterSec moved to T05b.
- P7-T03b (11b454c, 520a9ec): OpenAPI generated from core zod (`npm run openapi`, drift test, public `/openapi.json`), 15 `z.unknown()` bodies replaced by core schemas, scope audit, `docs/API.md` (errors, webhook signing/replay, 202 jobs, cursors, scopes; route table generated between markers). Review: 2 Important (scope audit's ADMIN branch could never fail — 11 ADMIN routes still accepted API keys; hand-written route table could drift) fixed: the 11 routes are session-only (keys now 401), the audit fails on any non-session ADMIN/OWNER handler, verb/method check added.
- P7-T04 (f413e23, 7958b48): A/B auto-optimize (hourly, pooled two-proportion z ≥ 1.96 with ≥ 100 sends per side, winner metric reply/click/open via the D34 predicates, never pauses the best, re-activated variants wait for +100 sends) and daily variant reset; Campaign FOR NO KEY UPDATE → variants FOR NO KEY UPDATE, planner rows on a just-paused variant cancelled at claim (quota-neutral) and re-planned. Review (opus): 1 Important (best picked before the sample floor → a low-n variant froze the step) + minors (variant lock vs FK KEY SHARE deadlock, legacy free-text winner metric broke Options save, replan balance double count documented) fixed in 1 round. R2 crash test: registration-only, accepted (hourly cron, heartbeat recovery proven in crash.test).
- P7-T05a (1f4e278, bbb7f19, d0db75d): AI foundation — encrypted AI settings (verifier pattern, session-only ADMIN PUT), one OpenAI-compatible client through `safeRequest`, AiCall log (prompt hash, tokens, cost), suggestions with the single approval path `reviewSuggestion` (race-safe, MEMBER+), AI reply classifier outside any tx with lease renewal per call, aiSelectable labels via LABEL_ADDED, AI OOO date (≤ 90 days), thumbs feedback, GDPR purge. Controller brief error corrected per R16 (escapeTemplate dropped; approved text renders literally). Review: no Critical/Important; minors fixed (single-writer test widened and proven to bite, historical imports skip AI, per-run classifier cache, 404 on approve for a deleted lead). CI caught an ambiguous "API key" label on the settings page (verifier + AI) → AI labels renamed.
- P7-T05b (dc64029, 31bffd6): AI features — step drafts, bulk personalization job (dedupe, Retry-After sleep in heartbeated slices, abort-aware), follow-ups, reply drafts, summaries, lead score (clamped), CRM recommendations as AWAITING_APPROVAL tasks, campaign analysis; fake AI endpoint for e2e. Every recipient-facing kind stays PENDING; single-writer test unchanged. Review: 2 Important (review rows didn't identify the lead — "Approve all shown" could write text for unidentified leads; 50-row cap without paging) + minors fixed; controller ruling: suggestion approve/reject is session-only (an API key is not a human reviewer).
- P7-T06a (dab6bd1, c7a6a0e): push sources — Gmail watch + Graph subscriptions behind `PushSource` (frozen MailProvider untouched), `push-renew` job (24 h window, Graph 404 re-create, FAILED + audit, AuthError via recordProviderError), unique accountId + conditional writes for concurrent runs (loser unsubscribes Graph only), clientState stored as sha256 only, account push status line. Review: 3 Important (U+FFFD mojibake in the status line; renew vs disconnect race left an orphan row + live Graph subscription; partial test runs reported as complete) + minors (renew starvation order, NULL placeholder externalId, counters, schema format churn, expired/not-configured view) fixed in 1 round. Controller restored 175 EOL-only files a whole-directory prettier run left in the tree.
- P7-T06b (d855a44, ced2573): public push endpoints `/api/push/gmail|graph` — Google OIDC JWT (jose 6.2.12, RS256 pinned, hard-coded JWKS via safeRequest with refetch limit, iss/aud/email/email_verified/exp enforced; the service-account email is the real binding), Graph validationToken echo (text/plain, capped) + constant-time clientState hash check incl. lifecycle events, coalescing `syncRequestedAt` flag (no provider call in the request), 1 MB capped reader, non-lead mail preference. Security review (opus): no Critical/Important; minors fixed (placeholder retry honoured dropNonLead, malformed payload after a verified JWT → 204 to stop redelivery, ACTIVE-only Gmail match). Route rate limits → T07a.
- P7-T07a (4d07254, 5c9f564): Postgres rate limits (`hit()` single atomic upsert, fixed window, retention purge), CSP with per-request 128-bit nonce + strict-dynamic (all pages dynamic, I6), security headers, client IP from Caddy's X-Real-IP only in vps (XFF never read; IPv6 /64), limits on setup, auth sign-in (per IP + per email) and 2FA (per user), webhook test, /api/push/* (600/min/IP, 429 → redelivery), AI 30/min, test-connection (banner trimmed to 120 chars). Security review (opus): 2 Important bypasses — form-encoded sign-in skipped the email bucket; duplicate/quoted two_factor cookie skipped the 2FA bucket — fixed by parsing exactly as better-auth/better-call do (better-call 1.4.2 pinned) and failing closed; minors fixed.
- P7-T07b (bf75495, 945521b, f9ffba7): 2FA (better-auth twoFactor; secrets + backup codes encrypted, backup codes single-use, per-user verify limit on all 3 paths against the real plugin), organization endpoints disabled over HTTP (I4), OWNER immutable, invites (ADMIN session-only, acceptance bound to the invited email, single-use, expiring), member removal (keys revoked first, audited, user deleted only without other memberships), audit view (MEMBER, page = API), Lead.uploadMethod server-set, npm audit gate in CI (prod: 0). Security review (opus): 1 CRITICAL — invitation id (the secret) written as AuditLog.target let a MEMBER/audit:read key take a pending ADMIN invite — fixed (target = email; migration scrubs pre-fix rows); 3 Important (pre-migration keys of removed members kept working → createdById backfill; non-atomic removal; removed users' history shown as "system") + minors fixed over 2 rounds.
- P7-T09 (c2b9378, 92540d5): carry-forwards — placement runs as a BackgroundJob (202 + polling UI, effective allowance, 3/h via hit() with release on refusal, all-or-nothing: a throttled account gets 409 provider_cap), warm-up target scaled under a health cap, BounceProtect complaint floor on the 30-day count, rewarmExitBouncePct, tracking_cname vitals check, meetings distinct per (lead, campaign), currency vs deal edit closed with FOR KEY SHARE, one domainOf(), inbox ≤ 6 queries, Lead(mergedIntoId) index, LOCAL/compliance doc gaps. Review: 2 Important (queued placement sent from an account paused/flagged/deleted meanwhile → re-check at job start; currency race was real, D51 wording corrected) + minors fixed. Controller ruling: placement stays all-or-nothing (partial seed sets skew placement results).
- P7-T08a (2040b69, 44c6cf6): a11y.spec (axe wcag2a/aa on every section light + dark, drawers/editors/forms; no rule disabled; 1 violation — CRM board scroll region — fixed), nav smoke, skip link, keyboard/focus management on inline forms, table conventions on 6 lists, tag filters, saved filters on Leads (InboxView.scope), label editor with aiSelectable. Review: 2 Important (client-side sort on cursor-paged lists misleading → Leads server-side sort with id tie-break, Blocklist/Scheduled "sorted within N loaded rows" hint; saved views gated by inbox:* regardless of scope → per-scope key check via `alsoScopes` + handler enforcement) + minors fixed.
- P7-T08b (75a34bc, 40f5e24): reply composer rich text (server-side sanitize-html 2.17.7 allowlist, text part derived), link-target warnings via a session-only `/link-check` interstitial (no scripts in the D30 frame; credentialed/userinfo hrefs always routed, no Continue), health sparkline + D34 formula disclosure, Failed/dead-letter view, DNS chip deep link, banner copy, analytics today/layout, file splits. Review: 2 Important (userinfo-spoof href bypassed the warning; visible-text matching evadable by punctuation/prose/IDN) + minors (empty sanitized reply via API, bulk cancel on Failed) fixed; full e2e 95/95.
- Phase 7 gate (2126bb8, 6ee63da, 78b8346, 685f4ad, e8e5dde, d76a612): opus whole-branch review PASS WITH FIXES (I1 AI routes exposed inbox/lead data without inbox:read/leads:read; I2 lead export with leads:read returned inbox + CRM; I3 webhook URL change kept custom headers; I4 GDPR residue in BackgroundJob; minors M1–M9) + ponytail audit (A1 erasure ILIKE scans in the lead-lock tx; A2 per-webhook cap; A3 test seams in prod; A7 job expiry; A8–A12). Round A (opus) security/correctness, round B (sonnet) cleanup incl. env-coupled placement job found by the controller. Opus re-review of A+B: 2 Important (timeline leaked CRM notes to leads:read keys; deliveries leaked lead fields to webhooks:read keys) + minors → round C. CI green on d76a612. Deferred to P8: buildPayload/createProvider getEnv(), failed API-key lookup limit, push sync spacing floor, recommend dedupe.
- P8-T00 (95757f3): Phase 7 debt: appUrl threaded dispatchEvents → buildPayload (default getEnv), failed API-key lookups limited per IP after verification fails (valid keys never counted), 15 s push sync spacing floor (Gmail + Graph; skipped pushes covered by the 120 s poll), recommend dedupe vs AWAITING_APPROVAL/OPEN tasks and within one answer. Interrupted once (machine closed), finished by a fresh implementer; 6 tests RED via src stash. Review (sonnet): approve, 3 style minors not taken.
- P8-T01 (b8b958e, 399fd3f): placement polling e2e (real PlacementManager 15 s poll via page.clock, seeds match placementRunJob rows; passed first run, proven discriminating by a poll-interval mutation; full e2e 96/96) + executed resume drill. Review (sonnet): 2 Important (beforeAll not retry-safe under CI retries; drill cleanup could kill the 5433 dev DB / whole-file revert) + minors fixed; retry-safety proven with --repeat-each=2.
- P8-T02 (ac78018, b40d5d7): local-to-VPS migration check in compose-smoke (core migration-check seed/verify via openAccount + setCredentials, inert NEEDS_ATTENTION/ERROR fixture account, deterministic attachment bytes; seed before Backup, verify after Restore, wrong-key must fail, rotate-key re-encrypted 1 + verify under the new key), VPS.md migration checklist, D52, PS-DEPLOY-11 ticked. Review (sonnet): 2 Important (wrong-key step passed on any failure → requires the decrypt message, key resolved outside the try; checklist allowed two instances sending → stop local before backup) + minor fixed. CI compose-smoke ran every new step green.
- P8-T03 (84956d2, a78b8bd, d79fb20, e734704, 794ddd4, 0e9e76a, 0ab1bb7): final cross-system review, 3 rounds (opus). Round 1: 0 BLOCKER, 2 SIGNIFICANT (S1 restore of an older backup re-sends steps; S2 leads:create key enrolls via /imports campaignId), 16 MINOR → fix round 1 (restore pauses active campaigns, scope checks, beforeRequest transient errors, two-key test-send lock, docs); accepted m2, m4, m5, m12, m16. Round 2: S1-R SIGNIFICANT (resume re-sends post-dump steps) + n1-n4 → fix round 2 (D53 derived campaign Message-ID, sender settles from a synced outbound Sent copy instead of sending; quota committed; pause reason "restore"; IMAP credential load wrapped; CI pause proof; API.md scopes). Round 3: all closed, 0 BLOCKER/SIGNIFICANT; R3-1 docs (resume only after every mailbox synced since the restore) fixed in 0ab1bb7; R3-2 informational. Verdict: READY FOR RELEASE (real-provider campaign sending still gated on D17 live verification). CI green on 794ddd4.
- P8-T04 (032f9cb, a89b052): release legal check. Review (sonnet): PASS, 5 Minor (devOptional entries counted, legal-reading wording, ad-hoc extraction script undisclosed, NOTICE said MIT/ISC listed, README line splice); 4 wording fixes applied by controller in a89b052, README splice left (cosmetic). Controller verified the README unsubscribe claim (campaigns/schema.ts toggle accepts only true, D19).
- Phase 8 gate: CI (check incl. tests, lint, typecheck, Playwright; compose-smoke; imap-real) green on the final commit; T03 opus final review replaced the ponytail-audit reviewer per plan; main fast-forwarded to phase-8-final.

## Phase 9 (2026-11-05)

- P9-T01 (3dc6d2b): MillionVerifier and catch-all handling.
- P9-T02 (74bbc8f): Inbox triage for non-lead mail.
- P9-T03 (de6f68e): Customer and region exclusions.
- P9-T04 (caa6a43): Automated lead capacity.
- P9-T05 (4bd2eec): Apollo source core and job.
- P9-T06 (89b38e8): Apollo settings API and UI.
- P9-T07 (2c4faa3): Referral detection.
- P9-T08 (8debc42): Slack webhook alerts.
- P9-T09 (901dda3): Round-robin and territory assignment.
- P9-T10 (745ff01): Auto-forward and handoff template.
- P9-T11 (32dbaa8): Re-alerts for unanswered escalations.
- P9-T12 (49a0e77): HubSpot sync core and job.
- P9-T13 (d75bc41): HubSpot settings API and UI.
- P9-T14: External warm-up guide and project records.

Phase 9 differed from the usual workflow: T3 workers built it (DeepSeek for P9-T01, T02 and part of T03; the free pool was exhausted on 2026-11-05 at 01:42 EST, and Codex `gpt-6-sol` handled work from then on). The Opus orchestrator read each stage diff instead of using a separate reviewer subagent. `ponytail-audit` was not run. The orchestrator fixed: T02 name fields sliced to 200 against a 100 limit (spec error); T03 unassigned country codes were accepted; T05 pages advanced past people left by a low credit cap, `apollo_no_emails` fired for existing leads, and new sources sorted last; T09 `automations-meta` test did not allow UI-only types (spec gap); T12 one unreadable config stopped the whole sync.
