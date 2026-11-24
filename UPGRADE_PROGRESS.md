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
