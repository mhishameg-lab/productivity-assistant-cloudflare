# Cloudflare migration deployment

This directory contains the Cloudflare migration implementation for moving the
assistant from Apps Script and Sheets to Workers and D1. Production
infrastructure is provisioned, the production Worker is enabled, and Telegram's
webhook points to the Worker. The Apps Script project has been deleted, so that
deployment is no longer available for rollback.

## Current state

- `src/channels/telegram.js` adapts Telegram updates to a channel-neutral
  message/action envelope.
- `src/core/intent.js` maps that envelope to deterministic application intents
  without Telegram-specific dependencies.
- `migrations/0001_initial.sql` defines the initial D1 model for declared Sheet
  data, append-only histories, channel-neutral records, and idempotent jobs.
  `migrations/0002_focus_sessions.sql` adds durable focus sessions and bounded
  follow-up state. `migrations/0003_calendar_blocks.sql` records user-requested
  Calendar blocks without changing task status.
- `src/index.js` exposes a health route, defaults webhook processing to
  disabled unless production is explicitly enabled, validates the Telegram webhook,
  authorizes the configured user, claims updates idempotently, and dispatches
  the currently migrated commands. Telegram callbacks are acknowledged before
  their business action is processed.
- `/start`, `/today`, `/help`, `/tasks`, and guided `/addtask` capture are
  implemented. Task views sync from Google Tasks before displaying them.
  Explicit task completion updates Google Tasks first and then its D1 mirror.
  Guided capture asks for title, area, priority, deadline, done-test, and
  whether to add a DEEP/WORK/LIFE task to today's Top 3.
  Daily outcome start/definition, focus-action capture, and explicit
  Done/Partial/Blocked decisions are also implemented. Outcome changes are
  append-only; only an explicit Done action can complete a linked Google Task.
  Dropping an outcome records a reason without deleting or cancelling its task.
  A 25/50-minute focus selection schedules a Telegram follow-up; stale follow-
  ups expire after 30 minutes. Done, Partial, Blocked, and Reschedule decisions
  are supported. Reschedule changes a pending Google Task's due date, but does
  not create a Calendar block. Telegram retries only a short, explicit HTTP 429
  retry delay; ambiguous send failures are not retried automatically.
  `/tomorrow`, the shutdown action, and a five-question next-day planning flow
  are implemented. The planning flow creates three linked Google Tasks,
  records the DONE and RISK notes, and recovers uncertain task-creation
  responses without creating duplicates. Calendar event reading for daily plans
  and morning briefings is implemented behind the opt-in
  `GOOGLE_CALENDAR_ENABLED` gate. When Calendar reads and write scopes have
  been approved, task capture exposes an explicit 25/50-minute block action;
  no event is auto-created.
  Automatic appointment reminders, Mini App date/time selection,
  Trello/Obsidian check-ins, and task-level overdue reminder conversations
  remain unmigrated. High-priority email escalation is implemented behind a
  separate disabled gate and requires a prior reminder, at least 24 hours
  overdue by default, and Google Tasks still reporting the task pending.
  Guided `/weekly` reflection saves the five playbook questions in D1;
  `/monthly` records a project decision, reason, and future review date without
  calling Trello. Scheduled numerical weekly/monthly snapshots and Gmail report
  delivery are implemented. Production scheduled messages and Gmail reports
  are enabled. Calendar is temporarily disabled because the configured Google
  OAuth token receives HTTP 403 from the Calendar API; email escalations remain
  separately disabled.
- `wrangler.toml` binds staging and production to separate D1 databases.
  Production is deployed at
  `https://productivity-assistant-production.mhisham-eg.workers.dev`, with
  `ASSISTANT_ENABLED = "true"`. Scheduled prompts and Gmail reports are
  enabled. Calendar is disabled until Google OAuth Calendar scopes/access are
  corrected.
- When `SCHEDULED_JOBS_ENABLED` is true in staging or production, the single
  Cron handler sends the 07:30 briefing, 14:15 work briefing, 23:00
  shutdown, 23:20 five-question planning prompt, and 00:00/00:20/00:45
  confirmation checkpoints in `Africa/Cairo`. It also prepares weekly Friday
  and previous-month reports at 18:00 Cairo, and checks eligible high-priority
  email escalations on even hours. Gmail and escalation gates remain off by
  default. Each rhythm prompt has a
  persistent idempotency key and is not replayed after its scheduled window.
  It uses the most recent private Telegram chat recorded for the authorized
  user; it does not guess or hard-code a chat ID.
- Failed operations are logged without payloads or credentials and produce an
  explicit Telegram warning when delivery is available. The warning asks the
  user to check Google Tasks before retrying uncertain actions.

The Telegram webhook is configured to deliver updates to the production Worker.
The former Apps Script deployment has been deleted and cannot be used for
rollback. The original Google Sheet was not deleted.

## Local checks

Use Node.js 22.13 or later (the tests use Node's built-in SQLite module):

```powershell
npm test --prefix cloudflare
```

## Migration status

The initial D1 schema was reviewed against the declared data-tab headers in the
existing Apps Script `DatabaseSetup.gs`. Each application data tab has a
corresponding D1 table; `Dashboard` is intentionally omitted because it is a
presentation surface, not a data table. Column names are normalized for D1
(for example, `Internal Record ID` maps to `tasks.id`). The schema also has
intentional operational additions: channel-neutral user/conversation/update
tables, scheduled-job state, durable focus sessions and Calendar blocks, task
area metadata, and source-row fields for optional future imports.

The staging database is a fresh start: legacy Google Sheet records, histories,
and logs were not exported or imported, and the original Sheet remains
unchanged.

The staging D1 database `productivity-assistant-staging` is in region `WEUR`.
The separate production D1 database `productivity-assistant-production` is in
region `EEUR`. Both are bound in `wrangler.toml`, and all three schema
migrations have been applied to each. The production Worker is deployed at
`https://productivity-assistant-production.mhisham-eg.workers.dev`; its health
route reports production traffic enabled. The one-time Worker cutover called
Telegram `setWebhook` using the configured bot token and secret, then verified
the URL with `getWebhookInfo`. The one-time flag is disabled after success.
Required secret names are configured in Cloudflare, but secret values are not
inspected by this repository. No Google Sheet data was imported. The Google
Sheet remains unchanged as an archive; the deleted Apps Script deployment is
not available for rollback. Account-level free-tier usage has not been
independently inspected.

## Migration gates still open

1. Verify the Cloudflare account's current free-tier usage;
   account-level usage has not been inspected, so cost compliance is not yet
   certified.
2. Resolve and verify Google OAuth scopes/access for Calendar. The production
   Calendar API currently returns HTTP 403, so Calendar reads and writes are
   disabled. Re-enable only after Calendar access has been validated.
3. Telegram's webhook is configured for
   `https://productivity-assistant-production.mhisham-eg.workers.dev/webhooks/telegram`.

## D1 setup

Staging and production D1 are provisioned and bound in `wrangler.toml`:

- Database: `productivity-assistant-staging`
- Region: `WEUR`
- Binding: `DB`
- Production Worker: `productivity-assistant-production`
- Migrations applied: `0001_initial.sql`, `0002_focus_sessions.sql`, and
  `0003_calendar_blocks.sql`

To inspect or re-apply pending migrations, authenticate with Wrangler and use:

```powershell
npx wrangler whoami
npx wrangler d1 migrations apply productivity-assistant-staging --remote
```

The application tables intentionally contain no legacy Sheet data. Keep all
processing flags set to `"false"` and do not enable the webhook or Cron jobs
until the application is validated against this staging database.

Do not paste OAuth refresh tokens or bot credentials into chat or source files.
Configure them directly as Cloudflare Worker secrets. Set the verified
`PRODUCTIVITY_EMAIL_RECIPIENT` privately as a Worker secret/variable when Gmail
delivery is ready. `GOOGLE_TASK_LIST_ID` remains the configured dedicated Google
Task list ID. The former Apps Script project has been deleted.

## Free-plan scheduling constraints

Cloudflare's official Workers and D1 limits were checked on 2026-11-22:
Workers Free includes 100,000 requests/day, 10 ms CPU per invocation, and up to
five Cron Triggers per account. D1 Free includes up to 500 MB per database and
allows 50 D1 queries per Worker invocation. The project uses one Cron schedule
and limits each run to five focus follow-ups to stay within the query budget.
Account-level usage has not been inspected, so deployment or account cost
cannot be certified from this repository alone. References:
[Workers pricing and limits](https://developers.cloudflare.com/workers/platform/limits/),
[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Required Worker bindings and secrets

These names are configuration contracts only; no values are stored in the
repository. Configure secrets separately for the production Worker:

- D1 binding `DB`.
- Production Worker variable `ASSISTANT_ENABLED` is `"true"`; staging remains
  disabled.
- Production `SCHEDULED_JOBS_ENABLED` is `"true"`; staging remains disabled.
- Worker variable `DEPLOYMENT_STAGE` is `"staging"` for the default deployment
  and `"production"` in the production environment.
- Worker secrets `TELEGRAM_WEBHOOK_SECRET` and `TELEGRAM_BOT_TOKEN`.
- `AUTHORIZED_TELEGRAM_USER_ID` and `GOOGLE_TASK_LIST_ID`.
- Production `GOOGLE_CALENDAR_ENABLED` and
  `GOOGLE_CALENDAR_WRITES_ENABLED` are `"false"` pending correction of the
  Calendar OAuth access (currently HTTP 403). When re-enabled, Calendar blocks
  remain user-triggered; no automatic event creation is enabled.
  `GOOGLE_CALENDAR_ID` is optional; the client defaults to `primary`.
- Production `GOOGLE_GMAIL_ENABLED` is `"true"` for scheduled review reports.
  `EMAIL_ESCALATIONS_ENABLED` remains `"false"` until the recipient and
  escalation policy are confirmed.
- Set `PRODUCTIVITY_EMAIL_RECIPIENT` directly as a Cloudflare Worker variable;
  it is intentionally not stored in source. Scheduled email reports are skipped
  with a system warning if this recipient is not configured. `EMAIL_ESCALATION_HOURS`
  is a D1 setting and defaults to 24.
- Google OAuth secrets `GOOGLE_OAUTH_CLIENT_ID`,
  `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REFRESH_TOKEN`.

The OAuth refresh token is only used in memory for access-token exchange and is
not written to D1 or application logs. Do not paste credentials into chat or
source files.
