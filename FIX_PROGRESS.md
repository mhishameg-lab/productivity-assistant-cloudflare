# Fix and Focus (v5) Progress Log

## Step 0: Audit
- Audited `cloudflare/README.md`, source modules, migrations `0001`–`0012`, and `test/worker.test.js`.
- Wrote `cloudflare/AUDIT.md` covering all commands, buttons/callbacks, scheduled workflows, and the 11 previously requested features.
- Baseline: `84 / 84` tests passing.

## Deliverable 1: Magic capture
- Added additive migration `cloudflare/migrations/0013_v5_magic_capture.sql` (`capture_drafts`, `chat_turns`, `area_keyword_map` setting).
- Added `cloudflare/src/core/prompts.js` (Section 9 data module for parser prompt, persona prompt, and Section 9.3 banned phrases).
- Added `cloudflare/src/core/capture-router.js` (deterministic fast path for tasks, reminders, schedules, done, reschedule, sleep, dive, questions, chat, multi-item, relative weekdays, flexible times, and fuzzy task matching).
- Added `cloudflare/src/ai/capture-parser.js` (single-call Workers AI parser with strict schema validation, no retry, D1 usage reservation).
- Added `cloudflare/src/core/magic-capture.js` (unified draft cards, edit-in-place chips, idempotent Google Tasks & Calendar execution only on tap, deterministic grounded conversation fallback).
- Added `sendChatAction` in `src/channels/telegram-api.js` and wired `captureParser` + `onBeforeAiCall` in `src/index.js` and `src/core/assistant.js`.
- Updated `parseSleepTime`/`startSleep` horizon in `src/companion.js` to 24h so afternoon sleep prefill (e.g. `2:00 PM` -> `7:30 AM` tomorrow) works cleanly.
- Updated `src/user-reminders.js` button label (`📝 Make task`) to comply with 14-char button limit.
- Added `cloudflare/test/golden-conversations.test.js` covering all 20 golden conversations, tone/button checks, invalid AI JSON rejection, pre-tap write safety, double-tap idempotency, and Cairo DST handling.

## Deliverable 2: Human conversation
- Added `cloudflare/src/ai/conversation-responder.js` (`buildConversationFacts`, `generateConversationalReply`, `validateConversationReply`) using `PERSONA_SYSTEM_PROMPT`, grounded D1/Calendar/reminder facts, `usage-ledger.js` neuron reservation, single-call execution (no retry), and strict banned-phrase/length/emoji validation.
- Wired `conversationResponder` in `src/index.js`, `src/core/assistant.js`, and `src/core/magic-capture.js` (`handleCapturedConversation` + `cap_unk|chat`), preserving `onBeforeAiCall` typing indicator and multi-turn `chat_turns` continuity.
- Upgraded deterministic conversation fallbacks in `magic-capture.js` (overdue, reminders, next, today, calendar, tired/care, casual greetings) and removed remaining banned/robotic phrases in `src/core/assistant.js`.
- Added Deliverable 2 tests in `cloudflare/test/golden-conversations.test.js` covering grounded Workers AI Q&A, invalid AI output fallback, multi-turn `chat_turns`, and deterministic fallbacks.

## Deliverable 3: Time-based features that never fail
- Added additive migration `cloudflare/migrations/0014_v5_time_reliability.sql` (`reminders.claim_until` for atomic lease & stale-`sending` recovery).
- Updated `cloudflare/src/user-reminders.js`: sleep-session hold, atomic `claim_until` lease + stale lease recovery, bounded oldest-first queries (`LIMIT 10` / `LIMIT 5`), and `sent_at` update on 2nd ping so `missed` waits 10 min after 2nd ping.
- Updated `cloudflare/src/companion.js`: `dive_end` notification on dive expiry, 15-min spacing between wake re-pings using `VOICE_BANK`, settings-driven quiet hours (`00:30–08:00`), shift intervals (`checkin_minutes` / `checkin_minutes_shift`), `consecutive_ignored` backoff, daily cap with Cairo date rollover, and `selectToneTier` integration.
- Fixed `fr|none|<reason>` (`companion_stuck`) and `/pause` upsert in `cloudflare/src/core/assistant.js`, and replaced hardcoded `"Mohamed"` in `cloudflare/src/scheduled.js` with `getDisplayName(env.DB)`.
- Added Deliverable 3 tests in `cloudflare/test/golden-conversations.test.js`.

## Deliverable 4: Cleanup
- Wired missing `/plan` and `/recap` command routes in `cloudflare/src/core/assistant.js`.
- Fixed `/stack` `task_complete` callback to emit `task.google_task_id` instead of D1 `task.id`.
- Added handlers for `start_task|<id>`, `pipeline_settings`, and `tomorrow` in `assistant.js`, and removed the inaccurate Sunday status line from `pipeline_rhythm`.
- Removed dead `shutdown`, `next_day_planning`, and `planning_confirm` branches from `buildScheduledRhythmPrompt` in `cloudflare/src/scheduled.js`.
- Replaced hardcoded `"there"` in `cloudflare/src/index.js` Mini App HTML with `getDisplayName(env.DB)`.
- Added Deliverable 4 verification tests in `cloudflare/test/golden-conversations.test.js`.
