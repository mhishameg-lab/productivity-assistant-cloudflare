# Audit: Telegram Productivity Assistant (Cloudflare Worker + D1)

Date: 2026-11-25  
Baseline test suite: `npm test --prefix cloudflare` — **84 / 84 passing** (`cloudflare/test/worker.test.js`).  
Code changes made during audit: **None** (Step 0 only).

---

## 1. Executive Summary

- **Adding tasks/schedules is rigid:** `/drop` and `/addtask` both open a 5-step guided interview (`title → area → priority → due → done test → Top 3`). `parseQuickCapture` (`add ...`) skips confirmation, hardcodes `WORK`, and lacks time/calendar/fuzzy-match support.
- **Robotic & split voice:** `src/core/voice-bank.js` defines the slang voice (`VOICE_BANK`), but `src/core/voice.js` overwrites key entries (`greeting_morning`, `done_one`, `done_all_three`, `care_break`, etc.) with stiff lines, and neither `assistant.js` nor `companion.js` calls `selectToneTier`.
- **Broken v4 reply keyboard & buttons:** The persistent reply keyboard (`assistant.js:4220-4224`) sends `"▶️ Go"`, `"📝 Drop it"`, `"🧭 Where I'm at"`, `"😴 Zzz"`, `"📱 HQ"`, `"🗓 Plan"`, but `assistant.js:193-207` still matches the old v3 labels (`"▶ Next"`, `"➕ Add"`, `"📋 Today"`, `"🗓 Plan"`). Every persistent keyboard button except `"🗓 Plan"` falls through to `"I couldn't safely match that request..."`.
- **Broken / missing handlers in live menus:**
  - `start_task|<id>` emitted by `/hq` (`assistant.js:3065`) has **no handler** in `handleAction`.
  - `pipeline_settings` emitted by `/pipeline` (`assistant.js:3191`) has **no handler** in `handleAction`.
  - `task_complete|<task.id>` emitted by `/stack` (`assistant.js:3159`) passes the D1 `TASK-...` UUID instead of `google_task_id`, failing the `WHERE google_task_id = ?1` lookup.
  - `/plan` (`intent.js:6`, `scheduled.js:299`) and `/recap` (`intent.js:16`) are registered commands with **no `case` branch** in `assistant.js`, returning `"That workflow is not migrated yet."`.
  - `fr|none|unclear` (`assistant.js:426,4207`) fails `getFocusSession("none")` and replies `"Focus follow-up expired"`.
  - `tomorrow` action emitted by pulse responses (`assistant.js:4176`) has **no handler**.
- **v4 features disabled & incomplete:** `COMPANION_ENABLED`, `USER_REMINDERS_ENABLED`, `WORK_PULSES_ENABLED`, `MINI_APP_ENABLED`, `HTML_EMAILS_ENABLED`, `GOOGLE_CALENDAR_ENABLED`, `GOOGLE_CALENDAR_WRITES_ENABLED`, and `CALENDAR_REMINDERS_ENABLED` are all `"false"` in `cloudflare/wrangler.toml`.
- **Workers AI is underused:** Only used for 13-intent routing (`intent-classifier.js`), daily Top-3 ranking (`daily-prioritizer.js`), weekly/monthly code selection (`review-analyzer.js`), and Gmail follow-up extraction (`email-followups.js`). No entity extraction, no grounded Q&A, no human/slang conversation.

---

## 2. "Features I Asked For Earlier"

| Requested Feature | Status | Evidence & Gaps |
| --- | --- | --- |
| **Name Martino** | **Partial** | `0009_v4_stage1.sql` seeds `display_name = 'Martino'`; `getDisplayName(db)` reads it (`src/core/voice.js:50`). **Gaps:** `src/scheduled.js:215` hardcodes `displayName: "Mohamed"` for reports; `src/index.js:84` hardcodes `name = "there"` for Mini App HTML. Proof: `test/worker.test.js:492`. |
| **US date and AM/PM times** | **Partial** | `src/core/format.js` implements US dates (`Nov 23, 2026`), 12-hour AM/PM (`7:30 AM`), and `Africa/Cairo` via `Intl` (DST-safe). **Gaps:** `assistant.js` (`1053, 2389, 2624`), `reminders.js:125`, and `daily-planner.js` (`63, 74, 96`) still print raw `YYYY-MM-DD` and 24-hour `HH:mm`. Proof: `test/worker.test.js:502`. |
| **Emoji system** | **Partial** | `🔴🟡🟢⚪` and `🔥🧊` and area emojis (`🌱💼🏠📎⋯`) exist in `format.js:188` and `showTaskStack`/`showFullPlan` (`assistant.js:3079,3144`). **Gaps:** `/tasks`, `/overdue`, `/today` omit them; `showTaskStack` marks every task with a due date as `🟢` (not `🔴` for overdue / `🟡` for today). Proof: `test/worker.test.js:450`. |
| **Slang voice** | **Partial** | `src/core/voice-bank.js` has `VOICE_BANK` (`tier1/2/3/C`, slang lines) and `src/core/voice.js:67` has `selectToneTier`. **Gaps:** `VOICE_VARIANTS` in `voice.js:4-39` overwrites `greeting_morning`, `done_one`, `done_all_three`, `care_break`, `google_down`, `nothing_overdue`, `tasks_clear` with robotic strings; `assistant.js` and `companion.js` never invoke `selectToneTier` or `VOICE_BANK` tiers. Proof: `test/worker.test.js:472`. |
| **Reminders in D1** | **Partial** | `0011_v4_stage4_reminders.sql` (`reminders` table) and `src/user-reminders.js` implement parsing, idempotent creation, snooze, done, cancel, make-task. **Gaps:** `USER_REMINDERS_ENABLED = "false"` in `wrangler.toml`; `leaseUntil` is computed (`user-reminders.js:160`) but never saved/checked; 2nd ping repeats every 5 min with no spacing guard; sleep hold not checked; no `Undo` button on creation. Proof: `test/worker.test.js:234,277,315,359,410`. |
| **Dive mode** | **Partial** | `/dive`, `/back`, `سيبني`, `companion_state.dive_until`, `startDive`, `endDive` exist (`src/companion.js:12-79`, `src/core/assistant.js:162,289,479`). **Gaps:** `COMPANION_ENABLED = "false"` in `wrangler.toml`; `processCompanion` never sends `dive_end` when `dive_until` passes; no test for `startDive`/`endDive` execution. Proof: `test/worker.test.js:189` (parser only). |
| **Sleep and wake** | **Partial** | `/zzz`, `sleep_sessions`, preset & custom wake times, early-wake detection, and wake pings exist (`src/companion.js:30-146`, `src/core/assistant.js:116,159,287,454`). **Gaps:** `COMPANION_ENABLED = "false"` in `wrangler.toml`; wake re-ping fires every 5 min up to 3 times with no spacing; reminders are not held during sleep; morning briefing is not timed to wake. Proof: `test/worker.test.js:189` (parser only). |
| **One night message** | **Partial** | `src/core/schedule.js:15-21` routes `23:15` to `night_wrap` (single message) and drops `shutdown`/`next_day_planning`/`planning_confirm` from the cron table. **Gaps:** Dead branches for `shutdown`, `next_day_planning`, and `planning_confirm` remain in `src/scheduled.js:683-726`, and `README.md` still documents the old 3-message schedule (`lines 306-326, 563-565`). Proof: `test/worker.test.js:179`. |
| **/pipeline** | **Partial** | `/pipeline` command and `pipeline_rhythm`/`pipeline_rules`/`pipeline_overview` handlers exist (`assistant.js:282,606,3172`). **Gaps:** `⚙️ Settings now` (`pipeline_settings`) button has no handler; `pipeline_rhythm` claims `Sunday 10:00 AM system status` (doesn't exist) and check-ins/mid-shift that are disabled; `schedule.js` does not drive `reminders.js`, `reports.js`, `escalations.js`, or `pulses.js`. Proof: `test/worker.test.js:179` (constants only). |
| **Check-ins** | **Partial** | `processCompanion` and `checkin_log` exist (`src/companion.js:108-219`, `0012_v4_stage7_companion.sql`). **Gaps:** `COMPANION_ENABLED = "false"` in `wrangler.toml`; `processCompanion` ignores `checkin_minutes`, `checkin_minutes_shift`, `last_proactive_at`, `consecutive_ignored` backoff, `selectToneTier`, and `00:00–00:30` vs `00:30–08:00` quiet hours (fires every 5 min when active); `companion_stuck` emits broken `fr|none|...`; no execution test. Proof: `test/worker.test.js:359` (gate only). |
| **Calendar toggle when adding a task** | **Partial** | Guided `/addtask` shows `Schedule focus time` *after* saving (`assistant.js:2629`) only when `GOOGLE_CALENDAR_WRITES_ENABLED = "true"` (currently `false`). **Gaps:** No inline Calendar toggle/chip during task capture; `parseQuickCapture` has no Calendar support. Proof: `test/worker.test.js:1988,3302`. |

---

## 3. Commands Audit

| Command / Alias | Status | Source File & Location | Test Proof | Notes |
| --- | --- | --- | --- | --- |
| `/hq` | **Partial** | `src/core/intent.js:2`, `src/core/assistant.js:260,3026` | `test/worker.test.js:450` (intent only) | `▶️ Go` emits unhandled `start_task\|<id>`. |
| `/start`, `/today` | **Working** | `src/core/intent.js:17-18`, `src/core/assistant.js:262-264,3196` | `test/worker.test.js:2067` | Old verbose layout; `Show full plan` calls `show_tasks`. |
| `/go`, `/next`, `/focus` | **Working** | `src/core/intent.js:3,15,22`, `src/core/assistant.js:265-268,3707` | `test/worker.test.js:3382` | Starts next open outcome sprint. |
| `/drop`, `/addtask` | **Partial** | `src/core/intent.js:4,20`, `src/core/assistant.js:269-270,354,1503` | `test/worker.test.js:3302` | Rigid 5-step form; no magic capture. |
| `/remind`, `/reminders` | **Partial** | `src/core/intent.js:9-10`, `src/core/assistant.js:284-286,4054`, `src/user-reminders.js` | `test/worker.test.js:234,277,315` | Gated off in `wrangler.toml`; delivery lease incomplete. |
| `/wya` | **Partial** | `src/core/intent.js:5`, `src/core/assistant.js:271-272,3110` | None | Implemented (`showWhereIAm`), untested. |
| `/stack` | **Partial** | `src/core/intent.js:11`, `src/core/assistant.js:273-274,3153` | `test/worker.test.js:450` (formatter only) | Bug: `Done` buttons pass `task.id` instead of `task.google_task_id`. |
| `/tasks` | **Working** | `src/core/intent.js:23`, `src/core/assistant.js:275-276,3440` | `test/worker.test.js:3211` (via `show_tasks`) | Works; ALL CAPS group headings (`OVERDUE`, etc.). |
| `/late`, `/overdue` | **Working** | `src/core/intent.js:12,27`, `src/core/assistant.js:277-278,332,3486` | `test/worker.test.js:2666` | Syncs Google Tasks and lists overdue items. |
| `/mail`, `/inbox` | **Working** | `src/core/intent.js:13,24`, `src/core/assistant.js:279-281,3520` | `test/worker.test.js:2702,2762,3041` | Read-only Gmail triage + evidence-checked AI follow-ups. |
| `/zzz` | **Partial** | `src/core/intent.js:7`, `src/core/assistant.js:287-288,3995`, `src/companion.js` | `test/worker.test.js:189,359` | Gated off; wake re-ping lacks spacing; reminders not held. |
| `/dive` | **Partial** | `src/core/intent.js:8`, `src/core/assistant.js:289-290,4009`, `src/companion.js` | `test/worker.test.js:189,359` | Gated off; missing `dive_end` notification on expiry. |
| `/back` | **Partial** | `src/core/intent.js:43`, `src/core/assistant.js:291-293` | None | Gated off; clears `dive_until`. |
| `/pipeline` | **Partial** | `src/core/intent.js:14`, `src/core/assistant.js:282-283,3172` | `test/worker.test.js:179` (constants only) | `pipeline_settings` button broken; rhythm text inaccurate. |
| `/plan` | **Missing** | `src/core/intent.js:6`, `src/scheduled.js:299` | None | In Telegram menu & `SUPPORTED_COMMANDS`, no `case "plan":` in `assistant.js`. |
| `/recap` | **Missing** | `src/core/intent.js:16` | None | In `SUPPORTED_COMMANDS` (README alias for `/weekly`), no `case "recap":` in `assistant.js`. |
| `/weekly` | **Working** | `src/core/intent.js:31`, `src/core/assistant.js:350-351,1856` | `test/worker.test.js:3813` | 5-question weekly reflection. |
| `/monthly` | **Working** | `src/core/intent.js:32`, `src/core/assistant.js:352-353,1875` | `test/worker.test.js:3857` | Monthly project decision workflow. |
| `/goals` | **Working** | `src/core/intent.js:25`, `src/core/assistant.js:336-337,1527` | `test/worker.test.js:1033` | Lists active OKRs. |
| `/goal` | **Working** | `src/core/intent.js:26`, `src/core/assistant.js:338-339,1514` | `test/worker.test.js:1033` | Guided goal creation interview. |
| `/tomorrow` | **Working** | `src/core/intent.js:19`, `src/core/assistant.js:340-349,3377` | `test/worker.test.js:552` (planner) | Read-only tomorrow plan. |
| `/available` | **Working** | `src/core/intent.js:21`, `src/core/assistant.js:356-361,2784` | `test/worker.test.js:2160,2234` | Advisory free-time planner. |
| `/accountability` | **Working** | `src/core/intent.js:34`, `src/core/assistant.js:334-335,3678` | `test/worker.test.js:2872` | Manual Trello/Obsidian check-in. |
| `/help` | **Working** | `src/core/intent.js:36`, `src/core/assistant.js:298-331` | `test/worker.test.js:858` | Works, but lists unmigrated features (`Review progress`, `Settings`, etc.). |
| `/vibe`, `/tone` | **Partial** | `src/core/intent.js:39-40`, `src/core/assistant.js:377-379,4124` | None | Writes `tone` to `settings`, unused by `companion.js`. |
| `/pings` | **Partial** | `src/core/intent.js:41`, `src/core/assistant.js:294-295,4035` | None | Writes `checkin_minutes` to `settings`, unused by `companion.js`. |
| `/pause` | **Partial** | `src/core/intent.js:42`, `src/core/assistant.js:296-297,4046` | None | `UPDATE`-only on `companion_state` (no-op if row missing). |
| `/quiet`, `/pulses` | **Partial** | `src/core/intent.js:37-38`, `src/core/assistant.js:362-376,4139` | `test/worker.test.js:315` (gate only) | Gated off (`WORK_PULSES_ENABLED = "false"`). |
| `/progress`, `/review`, `/capture`, `/habits`, `/settings` | **Dead** | `src/core/intent.js:28-30,33,35`, `src/core/assistant.js:380-384` | `test/worker.test.js:1258` | No workflows; always return `"That workflow is not migrated yet."`. |

---

## 4. Buttons, Callbacks, Keyboards, and Natural-Language Inputs Audit

| UI Element / Callback | Status | Source File & Location | Test Proof | Notes |
| --- | --- | --- | --- | --- |
| Reply keyboard: `"🗓 Plan"` | **Partial** | `src/core/assistant.js:196,4222` | None | Matches `/^🗓\s*Plan$/i` -> today's `showPlanForDate`. |
| Reply keyboard: `"▶️ Go"`, `"📝 Drop it"`, `"🧭 Where I'm at"`, `"😴 Zzz"`, `"📱 HQ"` | **Dead / Broken** | `src/core/assistant.js:193-207,4220-4224` | None | Code still matches old labels (`"▶ Next"`, `"➕ Add"`, `"📋 Today"`); new labels fall through to unmatched text. |
| Typed shortcuts (`growth`, `work`, `life`, `deep`) | **Working** | `src/core/assistant.js:208,3810` | None | Starts outcome sprint/definition; untested. |
| Quick capture (`add <title> [date] [priority]`) | **Partial** | `src/core/assistant.js:219,3874` | None | Hardcodes `WORK`, no confirmation tap, no time/calendar; untested. |
| Availability phrase (`I have 2 hours free`) | **Working** | `src/core/intent.js:113`, `src/core/assistant.js:229` | `test/worker.test.js:2160` | Deterministic duration + start time prompt. |
| Arabic sleep/dive (`نايم`, `سيبني ...`) | **Partial** | `src/core/assistant.js:159-184`, `src/companion.js:16-20` | `test/worker.test.js:189` | Parser tested; gated off by `COMPANION_ENABLED`. |
| `start_task\|<id>` | **Dead / Broken** | `src/core/assistant.js:3065` | None | Emitted by `/hq`, no handler in `handleAction`. |
| `pipeline_settings` | **Dead / Broken** | `src/core/assistant.js:3191` | None | Emitted by `/pipeline`, no handler in `handleAction`. |
| `tomorrow` | **Dead / Broken** | `src/core/assistant.js:4176,4178,4183` | None | Emitted by `handlePulseAction`, no handler in `handleAction`. |
| `fr\|none\|<reason>` | **Broken** | `src/core/assistant.js:426-428,1247,4207-4209` | None | Emitted by `companion_stuck`/`pulse\|blocked`; fails `getFocusSession("none")`. |
| `task_complete\|<id>` | **Partial** | `src/core/assistant.js:1464,3159,3472,3504`, `src/reminders.js:140` | `test/worker.test.js:3211` | Works on `/tasks`, `/overdue`, reminders; broken on `/stack` (uses `task.id`). |
| `start_outcome\|...` / `outcome_start\|...` | **Working** | `src/core/assistant.js:1094` | `test/worker.test.js:3382` | Both callback prefixes work. |
| `focus_duration\|...`, `focus\|...`, `fr\|<sessionId>\|...` | **Working** | `src/core/assistant.js:1117,1154,1247` | `test/worker.test.js:3382` | Focus timer & result state machine. |
| `outcome_status\|...`, `outcome_block_reason\|...`, `outcome_drop\|...` | **Working** | `src/core/assistant.js:1279,1343,1367` | `test/worker.test.js:3382` | Explicit outcome transitions. |
| `task_area\|...`, `task_priority\|...`, `task_due\|...`, `task_top3\|...` | **Working** | `src/core/assistant.js:1389-1462` | `test/worker.test.js:3302` | Guided task capture steps. |
| `calendar_block\|...`, `calendar_duration\|...` | **Working** | `src/core/assistant.js:958-1059` | `test/worker.test.js:1988` | Disabled in `wrangler.toml` (`GOOGLE_CALENDAR_WRITES_ENABLED = "false"`). |
| `goal_level\|...`, `goal_parent\|...`, `goal_add_key_result`, `goal_finish_key_results`, `goal_save`, `goal_cancel`, `goal_open\|...`, `goal_update\|...`, `goal_link_start\|...`, `goal_select_task\|...`, `goal_link_cancel` | **Working** | `src/core/assistant.js:832-957` | `test/worker.test.js:1033` | Full OKR workflow. |
| `ai_daily_plan\|...`, `ai_recommendation\|...` | **Working** | `src/core/assistant.js:649-672` | `test/worker.test.js:949` | User-triggered Top-3 suggestion & explicit accept/reject. |
| `gmail_followup_task\|...`, `gmail_followup_dismiss\|...` | **Working** | `src/core/assistant.js:674-712` | `test/worker.test.js:2762` | Advisory email follow-up task creation. |
| `accountability_done\|...`, `accountability_missed\|...` | **Working** | `src/core/assistant.js:777-795` | `test/worker.test.js:2872` | Manual Trello/Obsidian check-in. |
| `task_reminder_later\|...`, `cal_prepared\|...`, `cal_dismissed\|...` | **Working** | `src/core/assistant.js:736-776` | `test/worker.test.js:2408,2566` | Reminder responses recorded in `reminder_history`. |
| `night_confirm\|...` | **Partial** | `src/core/assistant.js:493-507` | None | Works for `night_wrap`, no test. |
| `plan_confirm_today` / `plan_confirm_date\|...`, `shutdown_done` | **Working** | `src/core/assistant.js:796-829` | `test/worker.test.js:3740` | `plan_confirm_today` is legacy alias; `shutdown_done` is from dead 23:00 shutdown. |
| `sleep_time\|...`, `sleep_up`, `sleep_back\|...`, `dive_start\|...`, `dive_extend\|...`, `back`, `companion_stuck`, `companion_later` | **Partial** | `src/core/assistant.js:414-492` | `test/worker.test.js:359` (gate only) | Gated off; `companion_stuck` emits broken `fr\|none\|...`. |
| `reminder_time\|...`, `reminder_done\|...`, `reminder_cancel\|...`, `reminder_snooze\|...`, `reminder_task\|...` | **Partial** | `src/core/assistant.js:508-596` | `test/worker.test.js:359` (gate only) | `reminder_done` excludes `'missed'`/`'uncertain'`. |
| `pulse\|...` | **Partial** | `src/core/assistant.js:646,4157` | None | Gated off; `pulse\|blocked` & `tomorrow` buttons broken. |
| `home`, `home_more`, `home_back`, `wya`, `show_tasks`, `goals_show`, `goal_new`, `add_task`, `focus_now`, `plan_my_day`, `plan_next_day_now`, `weekly_start`, `weekly_unfinished`, `monthly_project_review`, `monthly_decision\|...`, `pipeline_overview`, `pipeline_rhythm`, `pipeline_rules` | **Working / Partial** | `src/core/assistant.js:597-1092` | `test/worker.test.js:3211,3813,3857` | Navigation/workflow callbacks (`home_more`, `home_back`, `wya`, `pipeline_*` lack tests). |

---

## 5. Scheduled Messages & Background Workflows Audit

| Scheduled Workflow | Cadence / Trigger | Status | Source File & Location | Test Proof | Notes |
| --- | --- | --- | --- | --- | --- |
| **Focus follow-ups** | Every 5 min (`due_at <= now`, <30m old) | **Working** | `src/scheduled.js:32-131` | `test/worker.test.js:3549` | Atomic lease (`claim_until`), expires >30m old. |
| **Morning briefing** | `08:00` Cairo | **Working** | `src/scheduled.js:525-635`, `src/core/schedule.js:17` | `test/worker.test.js:2284,2360` | Uses old verbose format; collides with `08:00` overdue reminder. |
| **Work pre-shift prompt** | `14:15` Cairo (Mon–Fri) | **Working** | `src/scheduled.js:385,667-681`, `src/core/schedule.js:18` | `test/worker.test.js:3740` | Skips Sat/Sun. |
| **Night wrap** | `23:15` Cairo | **Partial** | `src/scheduled.js:637-665`, `src/core/schedule.js:19` | `test/worker.test.js:179` (route only) | Single night message, no delivery test. |
| **Legacy shutdown / next-day / planning confirm** | Removed from `schedule.js` | **Dead** | `src/scheduled.js:390-397,683-726` | `test/worker.test.js:3740` (direct `processScheduledRhythm`?) | `scheduledJobForCairoTime` never returns `shutdown`, `next_day_planning`, or `planning_confirm`. |
| **Overdue task reminders** | `08:00` Cairo | **Working** | `src/reminders.js:18-233` | `test/worker.test.js:2566,2939` | Enabled; sends a second 8:00 AM message alongside Morning briefing. |
| **Calendar appointment reminders** | 10–15 min before timed event | **Working (Disabled)** | `src/reminders.js:235-383` | `test/worker.test.js:2408,2523` | `CALENDAR_REMINDERS_ENABLED = "false"`. |
| **Weekly & monthly email reports** | Fri `18:00` / 1st `18:00` Cairo | **Working** | `src/reports.js:9-186` | `test/worker.test.js:3914,4080` | Hardcodes `displayName: "Mohamed"` (`scheduled.js:215`). |
| **High-priority email escalations** | Even hours `:00` Cairo | **Working** | `src/escalations.js:10-232` | `test/worker.test.js:4108-4275` | Failure-isolated; prod cycle not yet E2E verified per README. |
| **User D1 reminders** | Every 5 min (`remind_at_utc <= now`) | **Partial (Disabled)** | `src/user-reminders.js:156-264` | `test/worker.test.js:410` | `USER_REMINDERS_ENABLED = "false"`; unused `leaseUntil`, no sleep hold, 2nd ping lacks cooldown. |
| **Companion wake-up & check-ins** | Every 5 min | **Partial (Disabled)** | `src/companion.js:108-219` | `test/worker.test.js:359` (gate only) | `COMPANION_ENABLED = "false"`; no interval/backoff/tier/dive-end logic; quiet check misses `00:00–00:30`. |
| **Work pulses & care note** | Every 5 min (`09:00–14:00`, `15:00–23:00`, `18:30`) | **Partial (Disabled)** | `src/pulses.js:5-223` | None | `WORK_PULSES_ENABLED = "false"`; broken follow-up buttons. |
| **Mini App** | `/app/*` HTTP routes | **Partial (Disabled)** | `src/core/miniapp.js`, `src/index.js:72-135,412-647` | `test/worker.test.js:201,217` | `MINI_APP_ENABLED = "false"`; `/app/rest` & `/app/settings` are placeholders; `/app/home` has `Completed?` typo. |

---

## 6. Dead Code & Duplication Notes

- **Duplicate helpers:**
  - `findTelegramTarget` / `findTarget` is duplicated 4 times (`src/scheduled.js:504`, `src/companion.js:221`, `src/user-reminders.js:266`, `src/pulses.js:234`, `src/reminders.js:385` — 5 copies!).
  - `shiftDateKey` is duplicated 4 times (`src/core/format.js:205`, `src/core/assistant.js:4289`, `src/scheduled.js:796`, `src/reports.js:637`, `src/integrations/google-calendar.js:225` — 5 copies!).
  - `greetingLine` is defined in both `src/core/format.js:102` and `src/core/voice.js:58`.
  - `VOICE_VARIANTS` in `src/core/voice.js` overrides `VOICE_BANK` in `src/core/voice-bank.js`.
  - `formatGoalFocus` and `formatCalendarEvent` are duplicated in `src/core/assistant.js` and `src/scheduled.js`.
- **Dead / unreachable branches:**
  - `scheduled.js:683-726` (`shutdown`, `next_day_planning`, `planning_confirm`) can never be reached via `scheduledJobForCairoTime`.
  - `assistant.js:193,202,205` match old v3 keyboard strings (`▶ Next`, `➕ Add`, `📋 Today`) that `response()` no longer sends.
  - `assistant.js:380-384` + `intent.js:28-30,33,35` (`progress`, `review`, `capture`, `habits`, `settings`).
- **Missing/weak D1 indexes to review in Deliverable 3:**
  - `sleep_sessions(user_id, status, started_at)` has no index (`0012_v4_stage7_companion.sql`).
  - `checkin_log(user_id, sent_at)` has no index (`0012_v4_stage7_companion.sql`).
  - `reminders(user_id, status, remind_at_utc)` only has `(status, remind_at_utc)` (`0011_v4_stage4_reminders.sql`).
  - `work_pulses(user_id, status, sent_at)` only has `UNIQUE(user_id, cairo_date, slot)` (`0008_phase_upgrade.sql`).
