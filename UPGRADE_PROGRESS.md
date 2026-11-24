# Complete Upgrade Progress

## Stage 1: Foundation

- Status: done
- Files touched: `src/core/format.js`, `src/core/voice.js`, `migrations/0009_v4_stage1.sql`, `wrangler.toml`, `test/worker.test.js`
- Tests added: noon/midnight/duration/greeting, US date/time formatting, Martino and hint/tone settings.
- Assumptions: The existing area callback IDs and stored values remain unchanged; only display labels use Growth/Work/Life.

## Stage 2: Voice engine and companion state

- Status: done
- Files touched: `src/core/voice-bank.js`, `src/core/voice.js`, `src/channels/telegram-api.js`, `src/core/intent.js`, `src/core/assistant.js`, `migrations/0010_v4_stage2.sql`, `test/worker.test.js`
- Tests added: tone tiers, gentle/night/sleep suppression, care override, banned words, deterministic voice choice, companion-state table.
- Assumptions: Existing Telegram response objects are rendered with plain titles/headings; key-task and reminder-time bolding will be applied by later dedicated templates.

## Stage 3: Calm Mode

- Status: done
- Files touched: `src/core/intent.js`, `src/core/assistant.js`, `src/channels/telegram-api.js`, `src/scheduled.js`, `test/worker.test.js`
- Tests added: HQ-style aliases, Where I’m at text routing, task-stack formatting and priorities/dates.
- Assumptions: Trello and Obsidian remain data-only and their old commands stay hidden; the full calm home will be polished further by later stages.

## Stage 4: User reminders

- Status: done
- Files touched: `migrations/0011_v4_stage4_reminders.sql`, `src/user-reminders.js`, `src/core/assistant.js`, `src/scheduled.js`, `test/worker.test.js`
- Tests added: reminder parser formats, relative time, future date/time, D1 pending reminder list.
- Assumptions: Sleep hold is completed in Stage 7; Stage 4 reminders use the normal due flow until sleep mode exists.

## Stage 5: Mini App

- Status: done
- Files touched: `src/core/miniapp.js`, `src/index.js`, `src/core/assistant.js`, `test/worker.test.js`
- Tests added: unauthorized Mini App initData is rejected.
- Assumptions: Rest controls remain disabled until Stage 7; settings writes remain chat/D1-backed until their Stage 7 companion flow is complete.

## Stage 6: Night wrap and morning

- Status: done
- Files touched: `src/scheduled.js`, `src/core/assistant.js`, `test/worker.test.js`
- Tests added: scheduled rhythm updated to the single 11:15 PM night wrap and legacy checkpoint compatibility removed.
- Assumptions: Wake-time personal morning scheduling is completed by Stage 7 sleep sessions; until then morning uses 8:00 AM.

## Stage 7: Companion mode

- Status: done
- Files touched: `migrations/0012_v4_stage7_companion.sql`, `src/companion.js`, `src/core/assistant.js`, `src/core/intent.js`, `src/scheduled.js`, `test/worker.test.js`
- Tests added: dive duration formats including Arabic, sleep wake parsing, companion tables and scheduling output.
- Assumptions: Full check-in backoff and wake re-pings remain limited to the Cron-safe implementation provided here; no external alarm or notification guarantee is implied.

## Stage 8: Pipeline explainer

- Status: done
- Files touched: `src/core/schedule.js`, `src/core/assistant.js`, `src/scheduled.js`, `test/worker.test.js`
- Tests added: schedule constants and pipeline/scheduler consistency.
- Assumptions: Pipeline settings remain a read view while Mini App settings writes are completed in the existing chat settings routes.

## Stage 9: Polished emails

- Status: done
- Files touched: `src/core/email.js`, `test/worker.test.js`, `scripts/preview-emails.js`, `README.md`
- Tests added: multipart plain/HTML structure, RFC 2047 subject encoding, escaping and size guard.
- Assumptions: Production email sending remains gated by `HTML_EMAILS_ENABLED=false`; no real or test email was sent.

