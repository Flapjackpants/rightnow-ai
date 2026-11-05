# rightnow-ai

A self-hosted, open-source (MIT) cold-email platform. Connect your own Gmail, Microsoft 365 or IMAP/SMTP
mailboxes, warm them up (or re-warm them after a break), run multi-step campaigns, handle every reply in one
inbox, and track deals in a built-in CRM. It runs on your laptop or on a Linux VPS, and your data never leaves
your own database.

**Website:** [rightnow-ai-site.vercel.app](https://rightnow-ai-site.vercel.app/): see how it works, try the
interactive demos, and follow the setup guide.

[![Campaign simulator: a sample lead replies interested, step 3 is cancelled and a CRM deal opens](docs/images/simulator.gif)](https://rightnow-ai-site.vercel.app/#simulator)

*The campaign simulator (sample data). [Try it in your browser](https://rightnow-ai-site.vercel.app/#simulator), no install needed.*

> **Status: complete.** All 8 build phases are done, about 1,900 automated tests and the browser tests pass in
> CI, and sending has been verified live with real mailboxes.

## How to use it

> **Easiest way:** open this repo in [Claude Code](https://claude.com/claude-code) (or any coding assistant)
> and ask *"how do I set this up and use it?"*. It can read the docs and code and walk you through each step
> on your machine.

### 1. Install and start it

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) and git.

```bash
git clone https://github.com/AnalyticDog13/rightnow-ai.git
cd rightnow-ai
cp .env.example .env
```

Fill in `.env`:
- `ENCRYPTION_KEY` and `BETTER_AUTH_SECRET`: run `openssl rand -base64 32` once for each. Windows PowerShell often
  has no `openssl`, so use this there instead, once for each:
  `$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)`
- `SETUP_TOKEN`: any secret of 16+ characters.

Then start it with `scripts/start.sh` (Windows: `powershell -ExecutionPolicy Bypass -File scripts\start.ps1`) and open http://localhost:3000/sign-up.
Create the owner account with your `SETUP_TOKEN`. Teammates join later by invite.

Back up `ENCRYPTION_KEY` along with your database. Without it, the saved mailbox logins can't be read.

A laptop only sends while it is awake. For always-on sending, run it on a VPS with HTTPS:
[docs/ops/VPS.md](docs/ops/VPS.md). Open and click tracking also needs a public HTTPS address.

### 2. Connect your mailboxes

Go to **Accounts** and connect each sending mailbox:
- **Gmail / Google Workspace:** needs a Google OAuth client ([docs/ops/GOOGLE_SETUP.md](docs/ops/GOOGLE_SETUP.md)).
- **Microsoft 365 / Outlook:** needs a Microsoft Entra app ([docs/ops/MICROSOFT_SETUP.md](docs/ops/MICROSOFT_SETUP.md)).
- **Any other provider:** IMAP/SMTP host, username and password (an app password where the provider requires one).

Before the first real campaign from a provider, run its one-time live check:
`npx tsx scripts/live-verify.ts --account <id> --to <another address of yours>`.

### 3. Fix your DNS

Each sending domain needs SPF, DKIM and DMARC records. The **Deliverability** page checks them, plus MX
records and spam blacklists, and tells you what to fix. A missing or broken SPF record blocks launch.

### 4. Warm up your mailboxes

Turn on warm-up for each new mailbox and give it 2 to 4 weeks before real volume. See
[How warm-up works](#how-warm-up-works) below. Campaign volume also ramps up slowly by itself, and a mailbox
that sat idle for a while is re-warmed automatically.

### 5. Import leads and build a campaign

1. **Leads:** import a CSV, map its columns (name, company, custom fields) and the app removes duplicates.
   Add anyone who must never be emailed to the blocklist.
2. **Campaigns:** write step 1 and the follow-ups, with merge fields like `{{firstName}}` and A/B variants. Then
   set the sending days and hours, the time zone, the daily limit and which mailboxes send. In the campaign
   options you can swap the footer's unsubscribe link for an opt-out message ("reply unsubscribe").
3. Send yourself a test email, then launch.

Follow-ups always go from the mailbox that sent step 1. A lead stops getting emails when they reply, bounce
or unsubscribe.

### 6. Work the replies

- **Inbox:** every mailbox in one threaded view. Replies are labelled (interested, out of office,
  unsubscribe...) and you can answer from there.
- **CRM:** interested leads become deals on a Kanban board with revenue tracked back to the campaign.
- **Analytics:** sends, replies, bounces and revenue by campaign, step, variant and mailbox.
- **Automations:** rules like "when a lead replies interested, move it to this stage", plus webhooks and a
  REST API with scoped keys.

### How warm-up works

Built-in warm-up uses **only your own mailboxes**. Every mailbox with warm-up on sends short, plainly
labelled messages to the others, and some of them reply. Volume starts small and grows each day, and the app
records whether each message landed in the inbox or in spam. That inbox rate feeds each mailbox's health
score. It never fakes opens, rescues mail from spam or marks messages important.

What that means:
- One mailbox can't warm up on its own. It needs others to talk to.
- It works best with several mailboxes on different domains, mixed across Gmail and Outlook.
- With only a few mailboxes it builds little reputation. Treat it mainly as an inbox-placement monitor.

**Using an outside warm-up service.** For a stronger warm-up, connect the same mailboxes to a dedicated
warm-up service that runs a large shared network. See [Using an outside warm-up service](docs/ops/EXTERNAL_WARMUP.md) for the limits and sync behavior.
Then:
1. Turn this app's warm-up off for those mailboxes, so the two don't double up.
2. Lower each mailbox's daily campaign limit here to leave room for the service's emails. This app doesn't
   see them, so it can't count them toward the provider's daily cap.
3. Have the service file its warm-up emails under its own label or folder. Any that reach the inbox will show
   up in the unified inbox like normal mail.

Developers can also plug an external pool in through the `WarmupProvider` interface in
`packages/core/src/deliverability/warmup.ts`.

## Responsible use

You are responsible for how you use this software. Before you email anyone you need a lawful basis to do so
(for example CAN-SPAM in the US, GDPR/PECR in the EU and UK, CASL in Canada, as applicable to you and your
recipients). Send only as your own, honestly identified sender. Every campaign email carries a List-Unsubscribe
header, and unsubscribes are always honored. The visible unsubscribe link in the footer can be replaced
per campaign with an opt-out message (campaign options); replies like "unsubscribe" are detected and the lead is suppressed. Your mailbox providers' terms also apply and
can restrict cold email. The software is provided without warranty (see [LICENSE](LICENSE)); nothing here is legal
advice. More detail: [docs/COMPLIANCE.md](docs/COMPLIANCE.md) and [docs/PROVIDER_COMPLIANCE.md](docs/PROVIDER_COMPLIANCE.md).

rightnow.ai is an independent project and is not affiliated with or endorsed by any other email-outreach vendor.
Product names mentioned in the docs are trademarks of their owners.

---

## Technical details

### Features

| Area | Highlights |
|---|---|
| Email accounts | Google (Gmail API), Microsoft 365 / Outlook (Graph), any IMAP/SMTP host; encrypted credentials; per-account limits and health |
| Warm-up & deliverability | Gradual ramp-up, SPF/DKIM/DMARC/MX/blacklist checks, inbox placement tests, bounce monitoring, automatic slow-down; **re-warm-up** for mailboxes that sat idle |
| Campaigns | Unlimited steps, delays, A/B variants, `{{RANDOM \| Hi \| Hello}}` spintax, merge fields with fallbacks, schedules per timezone, account rotation |
| Reliable sending | Postgres-backed queue: quotas reserved atomically, no duplicate sends, safe crash recovery, never sends outside your schedule |
| Offline recovery | After downtime or laptop sleep, each mailbox re-syncs replies, bounces and unsubscribes **before** it may send again |
| Leads | CSV import with mapping and dedupe, lists, Apollo lead sources, lead capacity, customer and region exclusions, referrals, custom fields, tags, suppression/blocklist, optional email verification with MillionVerifier |
| Unified inbox | All mailboxes, threaded, inbox triage, assignment and auto-forward, reply classification, notes, reminders, rich-text replies |
| CRM & analytics | Kanban pipeline, HubSpot sync, opportunities and revenue attributed to campaigns, dashboards, CSV export |
| Automations | Event rules, Slack alerts, escalation re-alerts, signed webhooks, REST API with scoped keys, optional AI drafting with human approval |
| Security | 2FA, invites and roles, audit log, rate limits, CSP, GDPR export and erasure |

Honesty rules built in: no fake engagement, no spoofed senders, no claims that warm-up guarantees inbox
placement, and every campaign email carries a working unsubscribe.

### Architecture

```
apps/web            Next.js app: UI + REST API (/api/v1)
apps/worker         Background jobs: sync, scheduling, sending, warm-up
packages/db         Prisma schema, migrations, test database harness
packages/core       Domain logic (templates, quotas, scheduling, crypto...)
packages/providers  Gmail / Microsoft Graph / IMAP-SMTP adapters
```

PostgreSQL is the only stateful service. It also holds the job queue, so there is no Redis to run or back up.
Reasons for this and other choices: [docs/DECISIONS.md](docs/DECISIONS.md).

### Tech stack

TypeScript, Next.js 16 and React 19, Tailwind CSS 4, PostgreSQL 18 with Prisma 7, pg-boss for jobs,
better-auth for sign-in, imapflow / nodemailer / mailparser for mail, Recharts for charts. Tests use Vitest
with embedded Postgres and Playwright. Deployment is Docker Compose, with Caddy for HTTPS on a VPS. Pinned
versions: [docs/STACK.md](docs/STACK.md).

### Development

Requires Node.js 22.12+ (CI uses Node 24) and npm. Tests need neither Docker nor Postgres: they start a real
embedded Postgres automatically.

```bash
npm ci
cp .env.example .env        # fill in ENCRYPTION_KEY, BETTER_AUTH_SECRET, SETUP_TOKEN, DATABASE_URL
npm run db:deploy           # apply migrations
npm run dev                 # web on http://localhost:3000 + background worker
```

`MAIL_PROVIDER_FAKE=1` in `.env` swaps every provider for a fake in-process mailbox, so the whole pipeline
runs without sending real email ([docs/ops/LOCAL.md](docs/ops/LOCAL.md)).

| Command | What it does |
|---|---|
| `npm test` | Unit and integration tests (Vitest, embedded Postgres) |
| `npm run e2e` | Browser tests (Playwright); first run `npx playwright install chromium` |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm run db:migrate` | Create a migration in development |
| `npm run db:deploy` | Apply migrations |

Operations: backups, restore and upgrades ([docs/ops/LOCAL.md](docs/ops/LOCAL.md)), key rotation
([docs/ops/KEY_ROTATION.md](docs/ops/KEY_ROTATION.md)), recovering after downtime
([docs/ops/OFFLINE_RECOVERY.md](docs/ops/OFFLINE_RECOVERY.md)); external warm-up ([docs/ops/EXTERNAL_WARMUP.md](docs/ops/EXTERNAL_WARMUP.md)).

### Documentation

- [Product spec and feature checklist](docs/PRODUCT_SPEC.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md) · [Progress](docs/PROGRESS.md) · [Decisions](docs/DECISIONS.md)
- [Provider rules and limits (Gmail, Microsoft, SMTP)](docs/PROVIDER_COMPLIANCE.md)
- [Stack and versions](docs/STACK.md)
- [External warm-up service](docs/ops/EXTERNAL_WARMUP.md)

### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (tests, conventional commits, DCO sign-off, security reports). This project
was built with Claude Code following the process in [CLAUDE.md](CLAUDE.md): small tasks, tests first, independent
review, one branch per phase.

## License

[MIT](LICENSE). Third-party dependency licenses: [docs/LICENSES.md](docs/LICENSES.md) and [NOTICE](NOTICE).
