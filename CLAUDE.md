# rightnow-ai

Open-source (MIT), self-hosted alternative to Instantly.ai: cold-email accounts, warm-up/re-warm-up,
campaigns + sequences, leads, unified inbox, CRM, analytics, automations.
Authoritative spec: `rightnow_ai_master_prompt.md` (root). Derived docs live in `docs/`.
Repo: https://github.com/AnalyticDog13/rightnow-ai (branch `main`).

## "Keep going" recovery procedure

When the user says "keep going" (or any session starts mid-project), do exactly this:
1. Read this file, then `docs/HANDOFF.md`, `docs/TASKS.json`, `docs/PROGRESS.md`.
2. `git status`, `git log --oneline -15`, `git branch -a`. Uncommitted changes = interrupted task; inspect, keep usable work.
3. Reconcile `docs/TASKS.json` against the code. First task not `done` is the next task.
4. Re-run only the tests for the interrupted task, then continue the loop in "Development workflow".
5. Never re-plan, restart, or redo `done` tasks unless `docs/IMPLEMENTATION_PLAN.md` is demonstrably obsolete.
Details: `docs/RESUME_INSTRUCTIONS.md`.

## Architecture principles (see `docs/DECISIONS.md` for reasons)

- npm workspaces monorepo: `apps/web` (Next.js UI + API routes), `apps/worker` (background jobs),
  `packages/db` (Prisma), `packages/core` (pure domain logic), `packages/providers` (Gmail / Graph / IMAP-SMTP).
- PostgreSQL is the single source of truth, including the job queue (pg-boss) and the send queue
  (`ScheduledMessage` rows claimed with `FOR UPDATE SKIP LOCKED`). No Redis. Quotas are reserved in the
  same transaction that claims a send, so parallel workers cannot exceed limits or double-send.
- Freshness gate: a mailbox may send only if it synced within `SYNC_MAX_STALENESS_SEC` (covers boot, sleep/wake,
  failing sync). Follow-ups always use the lead's step-1 mailbox. Unknown send outcomes become HELD, never resent.
  No burst-sending of backlog; quotas reserved per stored usage day.
- Same codebase for local (Docker Compose) and VPS (Compose + Caddy HTTPS, backups).
- Secrets only in env vars; OAuth tokens and SMTP passwords encrypted at rest (AES-256-GCM).
- Every query is scoped by `workspaceId` (multi-tenant ready, single owner today).
- No fabricated engagement, no limit circumvention, honest sender identity, unsubscribe always honored.
- `packages/providers` has no DB or Next dependency; `packages/core` owns everything that touches Prisma
  (`accounts/*`, `oauth.ts`, `rotate.ts`). Every `MailProvider` runs `runProviderContract` (`@rightnow/providers/contract`).
- Mail credentials: `EmailAccount.credentialsEnc` is written ONLY through `setCredentials()` (clears the refresh lease,
  bumps `credentialGen`), except the lease-guarded token-refresh write in `accounts/credentials.ts` (must not bump
  `credentialGen`) and the offline `rotate.ts`; connects create/revive rows ONLY through `openAccount()`. Never update
  `credentialsEnc` directly elsewhere.
  `Workspace.verifierConfigEnc` (email-verifier URL + API key) is written ONLY through `setVerifierSettings()`, is in
  `ENCRYPTED_COLUMNS`, is never returned by any API (GET gives `hasApiKey`), and a changed host needs a new key.
  `PUT /settings/verifier` is a session-only ADMIN route. `Workspace.apolloConfigEnc` is written ONLY through `setApolloSettings()`, `Workspace.crmSyncConfigEnc` ONLY through `setCrmSyncSettings()` / `clearCrmSyncSettings()`, and `Webhook.urlEnc` ONLY by the webhook service. All are in `ENCRYPTED_COLUMNS` and never returned by an API; their routes are session-only ADMIN.
- Error taxonomy (`packages/providers/src/errors.ts`): `AuthError` only for genuine auth failures (`invalid_grant`,
  `interaction_required`, a 401 that survives one refresh, explicit scope reasons, SMTP 530/534/535, IMAP auth failure
  that is not throttling). Unknown 4xx/403 on reads, token-endpoint 5xx, `invalid_client` → `TransientBeforeSendError`.
  Anything that may have reached the provider on send → `AmbiguousSendError`, never retried. Errors never carry
  response bodies or tokens. An `AuthError` sets NEEDS_ATTENTION unless the user paused the account.
- Outbound mail hosts: every IMAP/SMTP connect calls `assertPublicHost` and connects to the checked IP with
  `servername`; never `rejectUnauthorized: false`. Graph cursors/page tokens go through `assertGraphUrl`; every Graph
  call sends `Prefer: IdType="ImmutableId"`.
- Worker jobs may scan across workspaces, but every write is conditional on the state they read
  (`updateMany … WHERE <old state>`). Advisory locks use `pg_advisory_xact_lock(<ns>, hashtext(id))`;
  namespaces: 726001 first-owner setup, 726002 test-send, 726003 campaign planner (per campaign id), 726004 enrollment (per workspace id) (register new ones here) (none added in Phase 7 or Phase 9; push uses a unique key). No network call inside a DB transaction.
- `thread_forward` jobs never retry a send; `job.attempts > 0` fails as `forward_uncertain`.
- API keys act as MEMBER: ADMIN-only routes (connect, disconnect, delete, test-send) are session-only.
- Next.js: a URL segment starting with `_` needs a folder named `%5F…` (e.g. `app/api/v1/%5Ffake`).

## Tooling: Superpowers + Ponytail (both installed as Claude Code plugins, user scope)

- Superpowers 7.x: `writing-plans`, `subagent-driven-development`, `test-driven-development`,
  `systematic-debugging`, `requesting-code-review`, `verification-before-completion`.
- Ponytail 5.x (level `full`): smallest complete change, reuse before adding, no speculative abstraction.
  Run `ponytail-review` on each significant task, `ponytail-audit` after each phase, `ponytail-debt` periodically.
  If Ponytail would remove spec-required functionality, keep the feature and simplify the implementation.
- If a session lacks either plugin, follow the same procedures manually and note it in `docs/HANDOFF.md`.

## Model policy

Orchestrator delegates. Subagents get an explicit `model`: `sonnet` by default (implementation, tests, reviews),
`haiku` for mechanical edits / file inspection, `opus` only for concurrency/security design, stuck debugging,
and the final cross-system review. Escalate one task, never the whole project. No unbounded parallel agents
(max 2 concurrent implementers, only on disjoint files).

## Commands

Setup (Windows/macOS/Linux, Node 22.12+; CI and Docker use Node 24):
- `npm ci`: install; `postinstall` runs `prisma generate` (client in `packages/db/src/generated`, gitignored)
- `cp .env.example .env`, then fill in `ENCRYPTION_KEY`, `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), `SETUP_TOKEN` (16+ chars), `DATABASE_URL`

Develop:
- `npm run dev`: web (http://localhost:3000) + worker (health :8081) together via `scripts/dev.mjs` (Ctrl-C stops both). Single app: `npm run dev -w @rightnow/web` / `-w @rightnow/worker`
- `npm run db:migrate`: create/apply a migration (`prisma migrate dev`, reads repo-root `.env`)
- `npm run db:deploy`: apply migrations · `npm run db:generate`: regenerate the client

Verify (every task; no Docker or Postgres needed, tests start embedded Postgres 18):
- `npm test`: all Vitest projects. One project: `npx vitest run --project @rightnow/web`; one file: `npx vitest run apps/web/test/api.test.ts`
- `npm run lint` · `npm run typecheck` (`tsc --noEmit` per workspace)
- `npm run e2e`: Playwright (boots embedded Postgres + `next dev` on :3100). First time: `npx playwright install chromium`.
  On the Windows dev machine `next dev` e2e has a pre-existing overlay failure: use `E2E_PROD=1` (needs a prior `next build` with the Dockerfile placeholder env vars such as `DATABASE_URL`; delete `apps/web/.next` afterwards; Playwright may exit 1 on Windows from the embedded-Postgres temp-dir cleanup even when all tests pass)
- Real IMAP/SMTP contract (CI job `imap-real`, Linux, GreenMail): `MODE=local IMAP_TEST_URL='imap://me:secret@127.0.0.1:3143?smtp=3025&address=me@rn.test' npx vitest run packages/providers/test/imap.real.test.ts`
- Fake mailboxes for dev/e2e: `MAIL_PROVIDER_FAKE=1` (refused when `MODE=vps`), state in `FAKE_MAIL_DIR`; inspect via `GET /api/v1/_fake/mailbox/<address>`
- Live check with real credentials (gates P3-T11): `npx tsx scripts/live-verify.ts --account <id> --to <other address>` (refuses the Fake; see docs/ops/LIVE_VERIFICATION.md)

Docker (not installed on the primary dev machine; verified by CI job `compose-smoke`):
- `scripts/start.sh|.ps1` (`docker compose up -d --build`; adds `--profile vps` when `.env` has `MODE=vps`)
- `scripts/stop.sh|.ps1` (keeps the `pgdata` volume) · `scripts/upgrade.sh|.ps1` (back up first)
- `scripts/backup.sh|.ps1` → `backups/rightnow-<ts>.dump` · `scripts/restore.sh <dump>` / `scripts\restore.ps1 <dump>`
- Key rotation: `OLD_ENCRYPTION_KEY=… NEW_ENCRYPTION_KEY=… npx tsx scripts/rotate-key.ts` (see docs/ops/KEY_ROTATION.md)

CI status (`gh` is not installed): `curl -s "https://api.github.com/repos/AnalyticDog13/rightnow-ai/actions/runs?per_page=1"`

## Development workflow (every task)

1. Pick next task from `docs/TASKS.json`; read its section in `docs/IMPLEMENTATION_PLAN.md` / `docs/plans/`.
2. Dispatch implementer subagent (TDD) → run tests, lint, typecheck.
3. Independent reviewer subagent (spec compliance + Ponytail quality). Fix important findings.
4. Commit (conventional commits, `feat(scope): ...`) on the phase branch `phase-N-<name>`, push to `origin`, update `docs/TASKS.json`
   (status, commit), `docs/PROGRESS.md`, `docs/HANDOFF.md`, and `docs/REVIEW_LOG.md`.
   Stage files by explicit path only (never a directory, `-A` or `.`): parallel agents share the working tree.
5. At the phase gate fast-forward `main` to the phase branch. Never commit secrets, `.env`, or OAuth credentials. No force-push to `main`.

## Docs index

`docs/PRODUCT_SPEC.md` (requirements + Instantly parity checklist) · `docs/IMPLEMENTATION_PLAN.md` (approved plan) ·
`docs/plans/` (per-phase step plans) · `docs/TASKS.json` · `docs/PROGRESS.md` · `docs/HANDOFF.md` ·
`docs/DECISIONS.md` · `docs/REVIEW_LOG.md` · `docs/RESUME_INSTRUCTIONS.md` ·
`docs/ops/` (LOCAL, VPS, GOOGLE_SETUP, MICROSOFT_SETUP, KEY_ROTATION, LIVE_VERIFICATION, OFFLINE_RECOVERY, HUBSPOT_SETUP, EXTERNAL_WARMUP)
