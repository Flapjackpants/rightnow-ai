# Handoff

**Phase:** 9 — built on `phase-9-pipeline-integrations`; verified locally (see Tests). Not pushed; `main` not fast-forwarded.
**Current task:** Phase 9 documentation is complete. Open items: live checks with real keys for Apollo, MillionVerifier and HubSpot; the push decision. Phase 9 is not merged.
**Plan:** `docs/IMPLEMENTATION_PLAN.md` rev 3 (approved). Done step plans: `docs/plans/phase-1.md` … `phase-5.md` (+ `phase-4-review.md`, `phase-5-review.md`).
**Tests (Phase 9, 2026-11-05):** `npm test` 2,070 passed, 3 skipped on 3fb1595; lint, typecheck, production build and `E2E_PROD=1 npm run e2e` on 64be281: e2e 91 passed, 6 failed. All 6 also fail on 0b94987 under the same production mode: `a11y.spec.ts:261` (light, dark), `a11y.spec.ts:298` (light), `a11y.spec.ts:350`, `crm.spec.ts:27`, `inbox-thread.spec.ts:40`. CI, `compose-smoke` and `imap-real` have not run on this branch (not pushed). Apollo, MillionVerifier and HubSpot have not been called live.

## Next exact action
Complete final verification for Phase 9, then decide whether to push the branch. Live checks with real keys for Apollo, MillionVerifier and HubSpot remain open.
Carry-forwards into P8: the debt list in Current task. Accepted partials: PS-SYNC-01 (no IMAP IDLE, D48), PS-WARM-08/-18 (D51), PS-SEC-15 (no AV hook, D50); PS-CAMP-14 deferred (D19); PS-DEPLOY-11 is P8-T02.
Dev DBs that applied the branch-edited placement migration `20261029000000_placement` before its index was added need `prisma migrate reset` (checksum drift).
Existing dev DBs keep old pg-boss queue settings (recreate the pg-boss schema to pick up the new heartbeats).
Known env issues: Windows vitest worker crash (exit 3221226505) recurs in random files — rerun alone; the dev machine runs low on RAM — run vitest per project with `--maxWorkers=2`; run Playwright from `apps/web`.

## Interfaces available (Phases 1–2)
Phase 9: `leadCapacity`, `runLeadSources`, `applyReferrals`, `runEscalationCheck`, `runCrmSync`.
Phase 1: `route()` (auth/role/scope/params, CSRF), `startWorker`/`JobDef` `{prisma, clock}`, `createPrisma`,
`createTestDb`/`expectIsolated`, `getEnv`, `encrypt/decrypt`/`ENCRYPTED_COLUMNS`, `audit(tx,…)`, `Clock`.
Phase 2: `MailProvider` (frozen; `packages/providers/src/types.ts`) + contract suite, `createProvider(account,{prisma,…})`,
`accountCredentialStore`/`setCredentials`, `openAccount`, account service (limits/caps clamp, diagnostics, health),
OAuth sessions (Google, Microsoft), IMAP/SMTP connect/reconnect, `sendTestEmail`, `liveVerify`. Rules: see CLAUDE.md.

## External dependencies (need the user)
- **D16 lifted (P4-T05):** the `mail-sync` job writes the freshness watermark (`lastSyncCompletedAt`), so real campaigns now send
  once their accounts have synced and their provider is live-verified (D17, below).
- **Gates real-provider campaign sends (D17, runtime gate; code is built and tested on the Fake):** run `docs/ops/LIVE_VERIFICATION.md` with real credentials — Google OAuth client, Microsoft Entra app,
  IMAP/SMTP test mailbox. Message-ID preservation (Gmail G4, Graph M2/M3) must pass; `scripts/live-verify.ts` records it.
- Docker Desktop not installed on the dev machine (Compose verified only in CI; `.ps1` scripts syntax-checked, never run).
