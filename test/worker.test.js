import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import { adaptTelegramUpdate, isAuthorizedTelegramWebhook } from "../src/channels/telegram.js";
import {
  resolveAvailableTimeRequest,
  resolveDeterministicTextIntent,
  resolveIntent
} from "../src/core/intent.js";
import {
  claimChannelUpdate,
  finishChannelUpdate,
  getOrCreateChannelUser,
  insertChannelAction,
  insertChannelMessage,
  setConversationState
} from "../src/db/channel-repository.js";
import {
  listPendingTaskPlanningCandidates,
  listPendingTaskMirrors,
  syncGoogleTaskMirrors,
  upsertGoogleTaskMirror
} from "../src/db/google-tasks-repository.js";
import { buildDailyTaskPlan, formatDailyTaskPlan } from "../src/core/daily-planner.js";
import { createGoogleTasksClient } from "../src/integrations/google-tasks.js";
import {
  cairoLocalDateTimeToIso,
  createGoogleCalendarClient
} from "../src/integrations/google-calendar.js";
import { createGoogleGmailClient } from "../src/integrations/google-gmail.js";
import { createGoogleAccessTokenProvider } from "../src/integrations/google-oauth.js";
import { createTelegramApi } from "../src/channels/telegram-api.js";
import { handleAssistantMessage } from "../src/core/assistant.js";
import {
  handleScheduledEvent,
  processDueFocusSessions,
  processScheduledRhythm,
  recordFocusSession
} from "../src/scheduled.js";
import {
  processCalendarAppointmentReminders,
  processOverdueTaskReminders
} from "../src/reminders.js";
import { processScheduledReports } from "../src/reports.js";
import { processHighPriorityEscalations } from "../src/escalations.js";
import { classifyNaturalLanguageIntent } from "../src/ai/intent-classifier.js";
import { prioritizeDailyTasks } from "../src/ai/daily-prioritizer.js";
import { analyzeEmailFollowUps } from "../src/ai/email-followups.js";
import {
  formatReviewRecommendations,
  prioritizeReviewRecommendations
} from "../src/ai/review-analyzer.js";
import { createGoal, updateGoalKeyResult } from "../src/db/goal-repository.js";
import { parseDiveDuration, parseSleepTime } from "../src/companion.js";
import { SCHEDULE, scheduledJobForCairoTime } from "../src/core/schedule.js";
import { buildMultipartAlternative, encodeRfc2047, escapeEmailHtml } from "../src/core/email.js";
import {
  areaLabel,
  longDate,
  parseCairoDateTime,
  parseDateInput,
  parseTimeInput,
  shortDate,
  timeLabel,
  durationLabel,
  greetingLine
} from "../src/core/format.js";
import { say, selectToneTier } from "../src/core/voice.js";
import { VOICE_BANK } from "../src/core/voice-bank.js";
import {
  addTaskPageHtml,
  miniAppResponse,
  planPageHtml,
  validateTelegramInitData,
  timingSafeEqual
} from "../src/core/miniapp.js";
import { formatTaskStack } from "../src/core/assistant.js";
import {
  createUserReminder,
  listPendingUserReminders,
  parseUserReminder,
  processUserReminders
} from "../src/user-reminders.js";

class TestD1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new TestD1Statement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map(statement => statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class TestD1Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new TestD1Statement(this.database, this.sql, values);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) || null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

async function createTestDatabase() {
  const initialSchema = await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
  const focusSessionsMigration = await readFile(new URL("../migrations/0002_focus_sessions.sql", import.meta.url), "utf8");
  const calendarBlocksMigration = await readFile(new URL("../migrations/0003_calendar_blocks.sql", import.meta.url), "utf8");
  const aiUsageMigration = await readFile(new URL("../migrations/0004_ai_usage.sql", import.meta.url), "utf8");
  const goalsMigration = await readFile(new URL("../migrations/0005_goals.sql", import.meta.url), "utf8");
  const aiRecommendationsMigration = await readFile(new URL("../migrations/0006_ai_recommendations.sql", import.meta.url), "utf8");
  const calendarRemindersMigration = await readFile(new URL("../migrations/0007_calendar_reminders.sql", import.meta.url), "utf8");
  const phaseUpgradeMigration = await readFile(new URL("../migrations/0008_phase_upgrade.sql", import.meta.url), "utf8");
  const v4Stage1Migration = await readFile(new URL("../migrations/0009_v4_stage1.sql", import.meta.url), "utf8");
  const v4Stage2Migration = await readFile(new URL("../migrations/0010_v4_stage2.sql", import.meta.url), "utf8");
  const v4Stage4Migration = await readFile(new URL("../migrations/0011_v4_stage4_reminders.sql", import.meta.url), "utf8");
  const v4Stage7Migration = await readFile(new URL("../migrations/0012_v4_stage7_companion.sql", import.meta.url), "utf8");
  const v5CaptureMigration = await readFile(new URL("../migrations/0013_v5_magic_capture.sql", import.meta.url), "utf8");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(initialSchema);
  sqlite.exec(focusSessionsMigration);
  sqlite.exec(calendarBlocksMigration);
  sqlite.exec(aiUsageMigration);
  sqlite.exec(goalsMigration);
  sqlite.exec(aiRecommendationsMigration);
  sqlite.exec(calendarRemindersMigration);
  sqlite.exec(phaseUpgradeMigration);
  sqlite.exec(v4Stage1Migration);
  sqlite.exec(v4Stage2Migration);
  sqlite.exec(v4Stage4Migration);
  sqlite.exec(v4Stage7Migration);
  sqlite.exec(v5CaptureMigration);
  sqlite.exec("PRAGMA foreign_keys = ON;");
  return { sqlite, d1: new TestD1Database(sqlite) };
}

test("v4 Stage 9 multipart email safety, encoding, and escaping", () => {
  const mime = buildMultipartAlternative({
    to: "martino@example.com",
    subject: "Needs attention: HVAC <Test>",
    text: "Plain text",
    html: "<table><td>Safe &amp; sound</td></table>"
  });
  assert.match(mime, /multipart\/alternative/);
  assert.match(mime, /text\/plain; charset=UTF-8/);
  assert.match(mime, /text\/html; charset=UTF-8/);
  assert.ok(mime.length < 90_000);
  assert.equal(escapeEmailHtml("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
  assert.match(encodeRfc2047("Your week, Märtino"), /UTF-8\?B\?/);
});

test("v4 Stage 8 pipeline schedule constants match scheduler routes", () => {
  assert.equal(scheduledJobForCairoTime("08:00"), "morning");
  assert.equal(scheduledJobForCairoTime("14:15"), "work_briefing");
  assert.equal(scheduledJobForCairoTime("23:15"), "night_wrap");
  assert.equal(scheduledJobForCairoTime("12:00"), null);
  assert.equal(SCHEDULE.nightWrap, "11:15 PM");
  assert.equal(SCHEDULE.morningFallback, "8:00 AM");
  assert.equal(SCHEDULE.workPrompt, "2:15 PM");
});

test("v4 Stage 7 dive and sleep parsers fail safely", () => {
  assert.equal(parseDiveDuration("/dive 2h"), 120);
  assert.equal(parseDiveDuration("/dive 90m"), 90);
  assert.equal(parseDiveDuration("leave me alone 1.5 hours"), 90);
  assert.equal(parseDiveDuration("سيبني ساعتين"), 120);
  assert.equal(parseDiveDuration("/dive 14h"), null);
  const now = new Date("2026-11-24T22:00:00.000Z");
  assert.equal(parseSleepTime("07:30", now).toISOString(), "2026-11-25T05:30:00.000Z");
  assert.equal(parseSleepTime("7:30 AM", now).toISOString(), "2026-11-25T05:30:00.000Z");
  assert.equal(parseSleepTime("12:30 AM", new Date("2026-04-23T10:00:00.000Z")), null);
});

test("v4 Stage 5 Mini App rejects unauthorized initData", async () => {
  const { d1 } = await createTestDatabase();
  const response = await worker.fetch(
    new Request("https://example.test/app/api/bootstrap", {
      headers: { "X-Telegram-Init-Data": "bad-data" }
    }),
    {
      DB: d1,
      MINI_APP_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "test-token",
      AUTHORIZED_TELEGRAM_USER_ID: "123"
    }
  );
  assert.equal(response.status, 401);
});

test("Mini App inline scripts satisfy a per-response CSP nonce and forms prevent navigation", async () => {
  const response = miniAppResponse(planPageHtml("Martino"));
  const csp = response.headers.get("Content-Security-Policy");
  const nonce = csp.match(/'nonce-([a-f0-9]+)'/i)?.[1];
  const html = await response.text();
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>/gi)];

  assert.ok(nonce);
  assert.ok(scriptTags.length >= 2);
  for (const [, attributes] of scriptTags) {
    assert.match(attributes, new RegExp(`\\bnonce="${nonce}"`));
  }
  assert.match(csp, /script-src[^;]*'nonce-/);
  assert.match(planPageHtml("Martino"), /e\.preventDefault\(\)/);
  assert.match(addTaskPageHtml("Martino"), /e\.preventDefault\(\)/);
});

test("v4 Stage 4 reminder parser and D1 limits", async () => {
  const now = new Date("2026-11-24T10:00:00.000Z");
  assert.equal(parseUserReminder("remind me in 30 minutes to stretch", now).text, "stretch");
  assert.equal(parseUserReminder("in 2 hours", now).text, "");
  assert.equal(parseUserReminder("tomorrow at 9am", now).dueAtUtc !== null, true);
  assert.equal(parseUserReminder("on Nov 25 at 3 PM", now).dueAtUtc !== null, true);
  assert.equal(parseUserReminder("11/25 3pm", now).dueAtUtc !== null, true);
  assert.equal(parseUserReminder("/remind 5pm call Ahmed", now).text, "call Ahmed");
  assert.equal(parseUserReminder("11/31/2026 3pm", now), null);
  assert.equal(cairoLocalDateTimeToIso("2026-04-24", "01:30"), "2026-04-23T22:30:00.000Z");
  assert.throws(() => cairoLocalDateTimeToIso("2026-04-24", "00:30"), /does not exist/);
  assert.equal(
    parseUserReminder("on Apr 24 at 12:30 AM", new Date("2026-04-23T10:00:00.000Z")).invalidLocalTime,
    true
  );

  const { sqlite, d1 } = await createTestDatabase();
  const user = await getOrCreateChannelUser(d1, "telegram", "reminder-user", now.toISOString());
  const created = await createUserReminder({
    db: d1,
    user,
    text: "Call Ahmed",
    dueAtUtc: "2026-11-24T15:00:00.000Z",
    now: now.toISOString(),
    requestId: "stable-reminder-request"
  });
  assert.equal(created.text, "Call Ahmed");
  const duplicate = await createUserReminder({
    db: d1,
    user,
    text: "",
    dueAtUtc: "2026-11-24T09:00:00.000Z",
    now: now.toISOString(),
    requestId: "stable-reminder-request"
  });
  assert.equal(duplicate.id, created.id);
  assert.equal(duplicate.text, "Call Ahmed");
  assert.equal(duplicate.duplicate, true);
  const pending = await listPendingUserReminders(d1, user.id, 8);
  assert.equal(pending.results.length, 1);
  sqlite.close();
});

test("reminder date-first conversation stores the reminder after collecting text", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-24T10:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "reminder-flow-user", now.toISOString());
  const command = (updateId, text) => adaptTelegramUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 800 },
      from: { id: 801 },
      text
    }
  });
  const prompt = await handleAssistantMessage({
    db: d1,
    user,
    message: command(802, "/remind tomorrow at 9am"),
    googleTasks: null,
    now
  });
  assert.match(prompt.sections[0].lines[0], /what should i remind you about/i);

  const saved = await handleAssistantMessage({
    db: d1,
    user,
    message: command(803, "Call Alice"),
    googleTasks: null,
    now
  });
  assert.match(saved.sections[0].lines[0], /Call Alice/);
  const reminder = sqlite.prepare(
    "SELECT text, remind_at_utc FROM reminders WHERE user_id = ?1"
  ).get(user.id);
  assert.equal(reminder.text, "Call Alice");
  assert.equal(reminder.remind_at_utc, "2026-11-25T07:00:00.000Z");
  sqlite.close();
});

test("disabled reminder and Companion features do not create unscheduled state", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-24T10:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "feature-gate-user", now.toISOString());
  const base = {
    db: d1,
    user,
    googleTasks: null,
    userRemindersEnabled: false,
    companionEnabled: false,
    now
  };
  const command = (updateId, text) => adaptTelegramUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 700 },
      from: { id: 701 },
      text
    }
  });

  const reminder = await handleAssistantMessage({
    ...base,
    message: command(702, "/remind 5pm call Ahmed")
  });
  const dive = await handleAssistantMessage({
    ...base,
    message: command(703, "/dive 1h")
  });
  const pulse = await handleAssistantMessage({
    ...base,
    workPulsesEnabled: false,
    message: command(704, "/quiet 2h")
  });
  assert.match(reminder.sections[0].lines[0], /didn't create a reminder/i);
  assert.match(dive.sections[0].lines[0], /paused right now/i);
  assert.match(pulse.sections[0].lines[0], /turned off right now/i);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM reminders").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM companion_state").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM conversations").get().count, 0);
  sqlite.close();
});

test("Worker enforces disabled reminder and Companion gates on Telegram updates", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, options) => {
    sent.push(JSON.parse(options.body));
    return Response.json({ ok: true, result: { message_id: sent.length } });
  };
  const env = {
    DB: d1,
    DEPLOYMENT_STAGE: "production",
    ASSISTANT_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    AUTHORIZED_TELEGRAM_USER_ID: "801",
    USER_REMINDERS_ENABLED: "false",
    COMPANION_ENABLED: "false",
    WORK_PULSES_ENABLED: "false"
  };
  try {
    for (const [updateId, text] of [[810, "/remind 5pm call Alice"], [811, "/dive 1h"]]) {
      const response = await worker.fetch(new Request("https://example.test/webhooks/telegram", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret"
        },
        body: JSON.stringify({
          update_id: updateId,
          message: {
            message_id: updateId,
            chat: { id: 802 },
            from: { id: 801 },
            text
          }
        })
      }), env);
      assert.equal(response.status, 200);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /didn't create a reminder/i);
  assert.match(sent[1].text, /paused right now/i);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM reminders").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM companion_state").get().count, 0);
  sqlite.close();
});

test("failed reminder delivery is recorded as uncertain and logged", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-24T10:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "reminder-delivery-user", now.toISOString());
  await insertChannelMessage(d1, {
    channel: "telegram",
    conversationId: "reminder-chat",
    externalMessageId: "incoming-1",
    userId: user.id,
    direction: "incoming",
    type: "text",
    createdAt: now.toISOString()
  });
  await d1.prepare(
    `INSERT INTO reminders (
       id, user_id, text, remind_at_utc, status, created_at, request_id
     ) VALUES ('REM-delivery-1', ?1, 'Call back', ?2, 'pending', ?3, 'REQ-delivery-1')`
  ).bind(user.id, new Date(now.getTime() - 60_000).toISOString(), now.toISOString()).run();

  const result = await processUserReminders({
    db: d1,
    telegram: {
      async sendAssistantResponse() {
        throw new Error("Telegram API sendMessage failed with HTTP 503.");
      }
    },
    now,
    authorizedTelegramUserId: "reminder-delivery-user",
    enabled: true
  });

  assert.equal(result.uncertain, 1);
  assert.equal(sqlite.prepare("SELECT status FROM reminders WHERE id='REM-delivery-1'").get().status, "uncertain");
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM system_logs WHERE component='User reminders' AND event_type='Reminder delivery uncertain'").get().count,
    1
  );
  sqlite.close();
});

test("v4 Stage 3 aliases, task stack, and calm layout", () => {
  assert.equal(resolveIntent(adaptTelegramUpdate({
    update_id: 900,
    message: { message_id: 901, chat: { id: 902 }, from: { id: 903 }, text: "/hq" }
  })).name, "hq");
  assert.equal(resolveIntent(adaptTelegramUpdate({
    update_id: 904,
    message: { message_id: 905, chat: { id: 902 }, from: { id: 903 }, text: "/late" }
  })).name, "late");
  assert.equal(resolveDeterministicTextIntent("where am i"), "wya");
  const stack = formatTaskStack([
    { title: "A very important task", status: "Pending", priority: "High", due_date: "2026-11-25" },
    { title: "Low priority task", status: "Pending", priority: "Low", due_date: null }
  ]);
  assert.equal(stack.length, 2);
  assert.match(stack[0], /^🟢/);
  assert.match(stack[0], /🔥/);
  assert.match(stack[0], /due Nov 25, 2026/);
  assert.match(stack[1], /^⚪/);
  assert.match(stack[1], /🧊/);
});

test("v4 Stage 2 voice tiers, safety, companion state, and typography", async () => {
  const now = new Date("2026-11-24T10:00:00.000Z");
  assert.equal(selectToneTier({ consecutiveIgnored: 1, overdueDays: 0, now }), "tier1");
  assert.equal(selectToneTier({ consecutiveIgnored: 2, overdueDays: 0, now }), "tier2");
  assert.equal(selectToneTier({ consecutiveIgnored: 4, overdueDays: 0, now }), "tierC");
  assert.equal(selectToneTier({ consecutiveIgnored: 1, overdueDays: 4, highPriorityOverdue: true, now }), "tier3");
  assert.equal(selectToneTier({ consecutiveIgnored: 3, now }), "tierC");
  assert.equal(selectToneTier({ consecutiveIgnored: 5, tone: "gentle", now }), "tierC");
  assert.equal(selectToneTier({ consecutiveIgnored: 1, now: new Date("2026-11-24T21:30:00.000Z") }), "tier1");
  assert.equal(selectToneTier({ consecutiveIgnored: 1, sleepActive: true, now }), "tier1");
  const text = Object.values(VOICE_BANK).flat().join("\n").toLowerCase();
  for (const banned of ["lazy", "useless", "loser", "failure"]) assert.doesNotMatch(text, new RegExp(banned));
  assert.equal(say("tier1", { name: "Martino", task: "Call Ahmed", now, counter: 0 }),
    say("tier1", { name: "Martino", task: "Call Ahmed", now, counter: 0 }));

  const { sqlite, d1 } = await createTestDatabase();
  assert.equal(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='companion_state'").get().name, "companion_state");
  sqlite.close();
});

test("v4 Stage 1 seeds Martino and V4 display settings", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const name = sqlite.prepare("SELECT setting_value FROM settings WHERE setting_key = 'display_name'").get();
  const tone = sqlite.prepare("SELECT setting_value FROM settings WHERE setting_key = 'tone'").get();
  assert.equal(name.setting_value, "Martino");
  assert.equal(tone.setting_value, "cheeky");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM settings WHERE setting_key LIKE 'area_%_hint'").get().count, 3);
  sqlite.close();
});

test("Phase 1 formatter covers noon, midnight, US dates, and stable voice variants", () => {
  const noon = new Date("2026-11-23T10:00:00.000Z");
  const midnight = new Date("2026-11-22T22:00:00.000Z");
  assert.equal(shortDate("2026-11-23"), "Nov 23, 2026");
  assert.equal(longDate("2026-11-23"), "Monday, November 23, 2026");
  assert.equal(timeLabel(noon), "12:00 PM");
  assert.equal(timeLabel(midnight), "12:00 AM");
  assert.equal(durationLabel(465), "7 h 45 min");
  assert.equal(durationLabel(60), "1 h");
  assert.match(greetingLine("Martino", new Date("2026-11-24T06:00:00.000Z")), /☀️ Good morning, Martino/);
  assert.equal(parseTimeInput("2:30 PM"), "14:30");
  assert.equal(parseTimeInput("2pm"), "14:00");
  assert.equal(parseTimeInput("14:30"), "14:30");
  assert.equal(parseDateInput("11/25/2026", noon), "2026-11-25");
  assert.equal(parseDateInput("Nov 25", noon), "2026-11-25");
  assert.equal(parseDateInput("tomorrow", noon), "2026-11-24");
  assert.equal(parseCairoDateTime("11/25/2026 2:30 PM", noon).time, "14:30");
  assert.equal(areaLabel("DEEP"), "🌱 Growth");
  assert.equal(say("done_one", { name: "Mohamed", task: "Read HVAC chapter", now: noon }),
    "Nice work, Mohamed. “Read HVAC chapter” is done.");
  assert.equal(timingSafeEqual("same", "same"), true);
  assert.equal(timingSafeEqual("same", "diff"), false);
});

test("daily planner separates deadlines, strategic signals, and lower-priority tasks", () => {
  const date = "2026-11-23";
  const plan = buildDailyTaskPlan([
    { title: "Overdue", status: "Pending", priority: "Medium", due_date: "2026-11-21", postponement_count: 0 },
    { title: "Today A", status: "Pending", priority: "Medium", due_date: date, linked_goal_count: 1, linked_goal_title: "Build health", postponement_count: 0 },
    { title: "Today B", status: "Pending", priority: "High", due_date: date, postponement_count: 0 },
    { title: "Today C", status: "Pending", priority: "Low", due_date: date, postponement_count: 0 },
    { title: "Today D", status: "Pending", priority: "Medium", due_date: date, postponement_count: 0 },
    { title: "High priority", status: "Pending", priority: "High", due_date: "2026-11-25", postponement_count: 0 },
    { title: "Goal-linked", status: "Pending", priority: "Medium", due_date: null, linked_goal_count: 1, linked_goal_title: "Build health", postponement_count: 0 },
    { title: "Repeatedly postponed", status: "Pending", priority: "Medium", due_date: null, postponement_count: 3 },
    { title: "Can wait", status: "Pending", priority: "Low", due_date: null, postponement_count: 0 },
    { title: "Already completed", status: "Completed", priority: "High", due_date: date, postponement_count: 0 }
  ], date);

  assert.equal(plan.mustCount, 5);
  assert.deepEqual(plan.must.map(task => task.title), ["Overdue", "Today B", "Today A"]);
  assert.deepEqual(plan.should.map(task => task.title), ["Goal-linked", "High priority", "Repeatedly postponed"]);
  assert.deepEqual(plan.canWait.map(task => task.title), ["Can wait"]);
  const sections = formatDailyTaskPlan(plan, date);
  assert.match(sections.find(section => section.heading === "Deadline load check").lines[0], /5 tasks have deadlines on or before 2026-11-23/);
  assert.match(sections.find(section => section.heading.startsWith("Must do")).lines[2], /supports Build health/);
  assert.match(sections.find(section => section.heading.startsWith("Should do")).lines[0], /supports Build health/);
  assert.match(sections.find(section => section.heading.startsWith("Should do")).lines[2], /postponed 3 times/);
});

test("tomorrow's task plan distinguishes today's deadlines from overdue tasks", () => {
  const plan = buildDailyTaskPlan([
    { title: "Due today", status: "Pending", priority: "Medium", due_date: "2026-11-23" },
    { title: "Due tomorrow", status: "Pending", priority: "Medium", due_date: "2026-11-24" }
  ], "2026-11-24");
  const sections = formatDailyTaskPlan(plan, "2026-11-24", "2026-11-23");
  assert.match(sections[0].heading, /^Must do tomorrow/);
  assert.match(sections[0].lines[0], /Due today · due Nov 23, 2026 before this plan/);
  assert.doesNotMatch(sections[0].lines[0], /overdue/);
});

test("Workers AI classifies only allowlisted intents and reserves daily neuron budget", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  let callCount = 0;
  const ai = {
    async run(model, input) {
      callCount++;
      assert.equal(model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
      assert.equal(input.response_format.type, "json_schema");
      assert.equal(input.max_tokens, 64);
      return { response: "{\"intent\":\"tasks\"}" };
    }
  };
  const first = await classifyNaturalLanguageIntent({
    db: d1,
    ai,
    text: "Show my unfinished tasks",
    now: "2026-11-23T09:00:00.000Z",
    dailyNeuronLimit: 5000
  });
  assert.equal(first, "tasks");

  const usage = sqlite.prepare(
    "SELECT request_count, reserved_neurons, failed_request_count FROM ai_usage_daily WHERE usage_date_utc = '2026-11-23'"
  ).get();
  assert.equal(usage.request_count, 1);
  assert.ok(usage.reserved_neurons > 0 && usage.reserved_neurons <= 5000);
  assert.equal(usage.failed_request_count, 0);

  const blocked = await classifyNaturalLanguageIntent({
    db: d1,
    ai,
    text: "Plan my day",
    now: "2026-11-23T09:01:00.000Z",
    dailyNeuronLimit: 1
  });
  assert.equal(blocked, null);
  assert.equal(callCount, 1);
  sqlite.close();
});

test("Workers AI is never called when it is unavailable and failed classifications are counted", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const disabled = await classifyNaturalLanguageIntent({
    db: d1,
    ai: null,
    text: "What should I focus on?",
    now: "2026-11-23T09:00:00.000Z"
  });
  assert.equal(disabled, null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM ai_usage_daily").get().count, 0);

  const failingAi = {
    async run() {
      throw new Error("Inference unavailable");
    }
  };
  await assert.rejects(
    classifyNaturalLanguageIntent({
      db: d1,
      ai: failingAi,
      text: "What should I focus on?",
      now: "2026-11-23T09:00:00.000Z"
    }),
    /Inference unavailable/
  );
  const usage = sqlite.prepare(
    "SELECT request_count, failed_request_count FROM ai_usage_daily WHERE usage_date_utc = '2026-11-23'"
  ).get();
  assert.equal(usage.request_count, 1);
  assert.equal(usage.failed_request_count, 1);
  sqlite.close();
});

test("Workers AI daily prioritization uses only supplied task IDs and shares the neuron budget", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const tasks = [
    {
      id: "TASK-1",
      title: "Finish proposal",
      description: "Private details excluded from the AI prompt",
      status: "Pending",
      priority: "High",
      due_date: "2026-11-23",
      linked_goal_title: "Grow consulting work",
      postponement_count: 2
    },
    {
      id: "TASK-2",
      title: "Review notes",
      status: "Pending",
      priority: "Medium",
      due_date: null,
      postponement_count: 0
    }
  ];
  let callCount = 0;
  let capturedInput;
  const ai = {
    async run(model, input) {
      callCount++;
      capturedInput = input;
      assert.equal(model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
      assert.equal(input.response_format.type, "json_schema");
      assert.equal(input.max_tokens, 64);
      return { response: "{\"taskIds\":[\"TASK-1\"]}" };
    }
  };
  const recommendation = await prioritizeDailyTasks({
    db: d1,
    ai,
    date: "2026-11-23",
    tasks,
    goals: [{ level: "annual", title: "Build a sustainable business", next_action: "Find a first client" }],
    now: "2026-11-23T09:00:00.000Z"
  });
  assert.deepEqual(recommendation, ["TASK-1"]);
  assert.deepEqual(
    capturedInput.response_format.json_schema.properties.taskIds.items.enum,
    ["TASK-1", "TASK-2"]
  );
  assert.doesNotMatch(capturedInput.prompt, /Private details excluded/);
  assert.match(capturedInput.prompt, /Build a sustainable business/);
  const usage = sqlite.prepare(
    "SELECT request_count, reserved_neurons, failed_request_count FROM ai_usage_daily WHERE usage_date_utc = '2026-11-23'"
  ).get();
  assert.equal(usage.request_count, 1);
  assert.ok(usage.reserved_neurons > 0 && usage.reserved_neurons <= 5000);
  assert.equal(usage.failed_request_count, 0);

  const blocked = await prioritizeDailyTasks({
    db: d1,
    ai,
    date: "2026-11-23",
    tasks,
    now: "2026-11-23T09:01:00.000Z",
    dailyNeuronLimit: 1
  });
  assert.equal(blocked, null);
  assert.equal(callCount, 1);
  sqlite.close();
});

test("Workers AI daily prioritization rejects invented task IDs and counts failures", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  await assert.rejects(
    prioritizeDailyTasks({
      db: d1,
      ai: { async run() { return { response: "{\"taskIds\":[\"NOT-A-CANDIDATE\"]}" }; } },
      date: "2026-11-23",
      tasks: [{ id: "TASK-1", title: "Finish proposal", status: "Pending" }],
      now: "2026-11-23T09:00:00.000Z"
    }),
    /invalid task IDs/
  );
  const usage = sqlite.prepare(
    "SELECT request_count, failed_request_count FROM ai_usage_daily WHERE usage_date_utc = '2026-11-23'"
  ).get();
  assert.equal(usage.request_count, 1);
  assert.equal(usage.failed_request_count, 1);
  sqlite.close();
});

test("Workers AI ranks only evidence-backed weekly and monthly review recommendations", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const metrics = {
    created: 4,
    completed: 1,
    incomplete: 3,
    overdue: 1,
    postponements: 2,
    completionRate: 0.25,
    planning: 40,
    repeatedProblems: [],
    projectDecisions: [],
    goalProgress: [{
      title: "Complete portfolio",
      progressPercent: 25,
      measurementUpdates: 0,
      deadline: "2026-12-01"
    }]
  };
  let prompt = "";
  const recommendations = await prioritizeReviewRecommendations({
    db: d1,
    ai: {
      async run(model, input) {
        prompt = input.prompt;
        const codes = input.response_format.json_schema.properties.recommendationCodes.items.enum;
        assert.ok(codes.includes("open_responsibilities"));
        assert.ok(codes.includes("measure_goal_progress"));
        assert.equal(input.max_tokens, 64);
        return { response: "{\"recommendationCodes\":[\"open_responsibilities\",\"measure_goal_progress\"]}" };
      }
    },
    report: { type: "monthly", start: "2026-10-01", end: "2026-10-31" },
    metrics,
    now: "2026-11-23T09:00:00.000Z"
  });
  assert.deepEqual(recommendations, ["open_responsibilities", "measure_goal_progress"]);
  assert.match(prompt, /Complete portfolio/);
  assert.deepEqual(formatReviewRecommendations(metrics, recommendations, "monthly"), [
    "Choose the most important open responsibility and define its next action before adding more work.",
    "Record a measurable update for an objective that had no key-result measurement this period."
  ]);
  assert.equal(sqlite.prepare(
    "SELECT request_count, failed_request_count FROM ai_usage_daily WHERE usage_date_utc = '2026-11-23'"
  ).get().request_count, 1);
  sqlite.close();
});

test("Workers AI email triage is bounded and returns only exact evidence from supplied threads", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const threads = Array.from({ length: 6 }, (_, index) => ({
    threadId: `email-thread-${index}`,
    from: `sender-${index}@example.test`,
    subject: `Message ${index}`,
    receivedAt: "2026-11-23T09:00:00.000Z",
    bodyText: index === 0
      ? "Please send the signed agreement by Friday, November 27."
      : `No requested action in message ${index}.`
  }));
  let prompt = "";
  let callCount = 0;
  const ai = {
    async run(model, input) {
      callCount++;
      prompt = input.prompt;
      assert.equal(model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
      assert.equal(input.max_tokens, 192);
      assert.equal(input.response_format.json_schema.properties.followUps.maxItems, 5);
      return {
        response: JSON.stringify({
          followUps: [
            {
              threadId: "email-thread-0",
              actionType: "provide_information",
              evidenceQuote: "send the signed agreement",
              deadlineEvidence: "by Friday, November 27"
            },
            {
              threadId: "email-thread-1",
              actionType: "reply",
              evidenceQuote: "Please reply with your availability",
              deadlineEvidence: ""
            },
            {
              threadId: "email-thread-5",
              actionType: "reply",
              evidenceQuote: "No requested action"
            }
          ]
        })
      };
    }
  };
  const results = await analyzeEmailFollowUps({
    db: d1,
    ai,
    threads,
    now: "2026-11-23T09:00:00.000Z"
  });
  assert.deepEqual(results, [{
    threadId: "email-thread-0",
    actionType: "provide_information",
    evidenceQuote: "send the signed agreement",
    deadlineEvidence: "by Friday, November 27"
  }]);
  assert.match(prompt, /Please send the signed agreement/);
  assert.doesNotMatch(prompt, /email-thread-5/);
  assert.equal(callCount, 1);
  assert.equal(sqlite.prepare(
    "SELECT request_count FROM ai_usage_daily WHERE usage_date_utc = '2026-11-23'"
  ).get().request_count, 1);

  const noReadableText = await analyzeEmailFollowUps({
    db: d1,
    ai,
    threads: [{ threadId: "empty-thread", bodyText: "" }],
    now: "2026-11-23T09:00:30.000Z"
  });
  assert.equal(noReadableText, null);
  assert.equal(callCount, 1);

  const limited = await analyzeEmailFollowUps({
    db: d1,
    ai,
    threads,
    dailyNeuronLimit: 1,
    now: "2026-11-23T09:01:00.000Z"
  });
  assert.equal(limited, null);
  assert.equal(callCount, 1);
  sqlite.close();
});

test("natural-language classification routes only to an existing assistant flow", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-23T09:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "ai-intent-user", now.toISOString());
  let classifiedText = "";
  const result = await handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: 8101,
      message: {
        message_id: 8101,
        text: "Give me an overview of my outstanding professional duties",
        chat: { id: "ai-intent-chat" },
        from: { id: "ai-intent-user" }
      }
    }, now.toISOString()),
    googleTasks: { async listAll() { return []; } },
    naturalLanguageClassifier: async text => {
      classifiedText = text;
      return "tasks";
    },
    now
  });
  assert.equal(classifiedText, "Give me an overview of my outstanding professional duties");
  assert.equal(result.category, "Task list");
  assert.match(result.title, /open tasks/i);
  sqlite.close();
});

test("common natural-language requests use deterministic routes before Workers AI", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-23T09:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "deterministic-intent-user", now.toISOString());
  let aiCalls = 0;
  const result = await handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: 8104,
      message: {
        message_id: 8104,
        text: "What should I focus on today?",
        chat: { id: "deterministic-intent-chat" },
        from: { id: "deterministic-intent-user" }
      }
    }, now.toISOString()),
    googleTasks: { async listAll() { return []; } },
    naturalLanguageClassifier: async () => {
      aiCalls++;
      return "unknown";
    },
    now
  });
  assert.equal(resolveDeterministicTextIntent("Prepare me for tomorrow."), "tomorrow");
  assert.equal(resolveDeterministicTextIntent("What am I neglecting?"), "goals");
  assert.equal(resolveDeterministicTextIntent("Do something ambiguous with my work"), null);
  assert.deepEqual(resolveAvailableTimeRequest("I've got two hours available"), { minutes: 120 });
  assert.deepEqual(resolveAvailableTimeRequest("I have 90 minutes free"), { minutes: 90 });
  assert.equal(resolveAvailableTimeRequest("I have some time free"), null);
  assert.equal(aiCalls, 0);
  assert.equal(result.category, "Daily home");
  sqlite.close();
});

test("AI classification failure falls back to a safe generic response", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-23T09:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "ai-fallback-user", now.toISOString());
  const result = await handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: 8105,
      message: {
        message_id: 8105,
        text: "Can you organize the uncertain work around this new request",
        chat: { id: "ai-fallback-chat" },
        from: { id: "ai-fallback-user" }
      }
    }, now.toISOString()),
    naturalLanguageClassifier: async () => {
      throw new Error("Inference unavailable");
    },
    now
  });
  assert.equal(result.category, "Capture");
  assert.match(result.sections[0].lines[0], /Not sure what to do with that one/);
  sqlite.close();
});

test("daily AI recommendation is user-triggered and cannot change Google Task status", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-23T09:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "ai-plan-user", now.toISOString());
  const sourceTask = {
    id: "ai-plan-source-task",
    title: "Prepare customer proposal",
    notes: "Priority: High",
    status: "needsAction",
    due: "2026-11-23T00:00:00.000Z"
  };
  await upsertGoogleTaskMirror(d1, sourceTask, now.toISOString());
  const googleTasks = { async listAll() { return [sourceTask]; } };
  let plannerInput;
  let plannerCalls = 0;
  const aiDailyPlanner = async input => {
    plannerCalls++;
    plannerInput = input;
    return [input.tasks[0].id];
  };
  const sendCallback = (updateId, action) => handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: updateId,
      callback_query: {
        id: `ai-plan-callback-${updateId}`,
        data: action,
        from: { id: "ai-plan-user" },
        message: { message_id: 8102, chat: { id: "ai-plan-chat" } }
      }
    }, now.toISOString()),
    googleTasks,
    aiDailyPlanner,
    now
  });
  const home = await handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: 8102,
      message: {
        message_id: 8102,
        text: "/today",
        chat: { id: "ai-plan-chat" },
        from: { id: "ai-plan-user" }
      }
    }, now.toISOString()),
    googleTasks,
    aiDailyPlanner,
    now
  });
  const recommendationButton = home.actions.flat().find(button =>
    button.action === "ai_daily_plan|2026-11-23"
  );
  assert.ok(recommendationButton);

  const suggestion = await sendCallback(8103, recommendationButton.action);
  assert.equal(suggestion.category, "AI daily recommendation");
  assert.match(suggestion.sections[0].lines[0], /Prepare customer proposal/);
  assert.deepEqual(plannerInput.tasks.map(task => task.id), [plannerInput.tasks[0].id]);
  assert.match(suggestion.sections[1].lines[0], /No task was changed/);
  const decisionButton = suggestion.actions.flat().find(button =>
    button.action.endsWith("|accepted")
  );
  assert.ok(decisionButton);
  const accepted = await sendCallback(8104, decisionButton.action);
  assert.match(accepted.sections[0].lines[0], /Recorded as accepted/);
  assert.equal(sqlite.prepare(
    "SELECT decision FROM ai_recommendations WHERE recommendation_type = 'daily_focus'"
  ).get().decision, "Accepted");

  const repeated = await sendCallback(8105, recommendationButton.action);
  assert.match(repeated.sections[1].lines[1], /Your response: accepted/);
  assert.equal(plannerCalls, 1);
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM ai_recommendations"
  ).get().count, 1);
  assert.equal(sqlite.prepare(
    "SELECT status FROM tasks WHERE google_task_id = 'ai-plan-source-task'"
  ).get().status, "Pending");
  sqlite.close();
});

test("goal interview saves user-defined OKRs, links hierarchy, and appends progress history", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-23T09:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "goals-user", now.toISOString());
  let updateId = 9000;
  const sendText = (text, googleTasks = null) => handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: ++updateId,
      message: {
        message_id: updateId,
        text,
        chat: { id: "goals-chat" },
        from: { id: "goals-user" }
      }
    }, now.toISOString()),
    googleTasks,
    now
  });
  const sendAction = (action, googleTasks = null) => handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: ++updateId,
      callback_query: {
        id: `goals-action-${updateId}`,
        data: action,
        from: { id: "goals-user" },
        message: { message_id: updateId, chat: { id: "goals-chat" } }
      }
    }, now.toISOString()),
    googleTasks,
    now
  });
  const defineGoal = async ({ title, level, parentId, measure }) => {
    const goalCountBefore = sqlite.prepare("SELECT COUNT(*) AS count FROM goals").get().count;
    await sendText("/goal");
    const levelPrompt = await sendText(title);
    assert.ok(levelPrompt.actions.flat().some(button => button.action === `goal_level|${level}`));
    let response = await sendAction(`goal_level|${level}`);
    if (parentId) {
      assert.match(response.title, /parent objective/i);
      response = await sendAction(`goal_parent|${parentId}`);
    }
    assert.match(response.title, /category/i);
    await sendText("Health");
    await sendText("Health foundations");
    await sendText("A personally meaningful health objective.");
    await sendText("To support my energy and wellbeing.");
    await sendText("Reach a baseline of four workout sessions per week.");
    response = await sendText("none");
    assert.equal(response.title, "Add a measurable key result", JSON.stringify(response));
    response = await sendText(measure);
    assert.equal(response.title, "Key result recorded", JSON.stringify(response));
    response = await sendAction("goal_finish_key_results");
    assert.match(response.title, /next action/i, JSON.stringify(response));
    await sendText("Schedule the first session.");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM goals").get().count, goalCountBefore);
    return sendAction("goal_save");
  };

  const emptyGoals = await sendText("/goals");
  assert.equal(emptyGoals.title, "No objectives defined yet");
  assert.equal(emptyGoals.actions[0][0].label, "Start goal interview");
  const lifeVision = await defineGoal({
    title: "Build lasting health",
    level: "life_vision",
    measure: "Weekly exercise sessions | 0 | 3 | sessions"
  });
  assert.equal(lifeVision.category, "Goal details");
  const parent = sqlite.prepare(
    "SELECT id, level FROM goals WHERE title = 'Build lasting health'"
  ).get();
  assert.equal(parent.level, "life_vision");

  const annualObjective = await defineGoal({
    title: "Improve my fitness this year",
    level: "annual",
    parentId: parent.id,
    measure: "Weekly exercise sessions | 0 | 4 | sessions"
  });
  const child = sqlite.prepare(
    "SELECT id, parent_goal_id FROM goals WHERE title = 'Improve my fitness this year'"
  ).get();
  assert.equal(child.parent_goal_id, parent.id);

  const updateButton = annualObjective.actions.flat().find(button => button.action.startsWith("goal_update|"));
  assert.ok(updateButton);
  assert.ok(updateButton.action.length <= 64);
  assert.match((await sendAction(updateButton.action)).title, /Update key result/);
  const updated = await sendText("2");
  assert.match(updated.sections[1].lines[0], /2 \/ 4 sessions · 50%/);

  const history = sqlite.prepare(
    `SELECT h.previous_value, h.current_value
       FROM goal_key_result_history h
       JOIN goal_key_results kr ON kr.id = h.key_result_id
      WHERE kr.goal_id = ?1
      ORDER BY h.current_value`
  ).all(child.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].previous_value, null);
  assert.equal(history[0].current_value, 0);
  assert.equal(history[1].previous_value, 0);
  assert.equal(history[1].current_value, 2);

  const googleTasks = {
    async listAll() {
      return [{ id: "goal-link-source-task", title: "Complete a training session", status: "needsAction" }];
    }
  };
  const taskChoices = await sendAction(`goal_link_start|${child.id}`, googleTasks);
  const taskButton = taskChoices.actions.flat().find(button => button.action.startsWith("goal_select_task|"));
  assert.ok(taskButton);
  assert.ok(taskButton.action.length <= 64);
  const linkedDetail = await sendAction(taskButton.action, googleTasks);
  assert.match(linkedDetail.sections.map(section => section.heading).join(" "), /Linked tasks/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM goal_task_links WHERE goal_id = ?1").get(child.id).count, 1);
  assert.equal(
    sqlite.prepare(
      `SELECT t.status
         FROM goal_task_links l
         JOIN tasks t ON t.id = l.task_id
        WHERE l.goal_id = ?1`
    ).get(child.id).status,
    "Pending"
  );
    const today = await sendText("/today", googleTasks);
    const shouldDo = today.sections.find(section => section.heading.startsWith("Should do"));
    assert.ok(shouldDo.lines.some(line => line.includes("Complete a training session") && line.includes("supports Improve my fitness this year")));
    const planningCandidates = await listPendingTaskPlanningCandidates(d1, "2026-11-23");
    assert.equal(planningCandidates[0].linked_goal_title, "Improve my fitness this year");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM conversations").get().count, 0);
  sqlite.close();
});

test("Telegram adapter produces a channel-neutral message and command", () => {
  const adapted = adaptTelegramUpdate({
    update_id: 123,
    message: {
      message_id: 8,
      text: "/Today@my_bot 2026-11-23",
      chat: { id: 45 },
      from: { id: 67 }
    }
  }, "2026-11-22T10:00:00.000Z");

  assert.deepEqual(adapted, {
    id: "123",
    channel: "telegram",
    user: { externalId: "67" },
    conversation: { externalId: "45" },
    receivedAt: "2026-11-22T10:00:00.000Z",
    message: {
      externalId: "8",
      type: "text",
      text: "/Today@my_bot 2026-11-23",
      command: { name: "today", arguments: "2026-11-23" }
    },
    action: null
  });

  assert.deepEqual(resolveIntent(adapted), {
    type: "command",
    name: "today",
    arguments: "2026-11-23"
  });
});

test("Telegram client retries a rate-limited call once when retry delay is short", async () => {
  let requests = 0;
  const telegram = createTelegramApi("test-token", async () => {
    requests++;
    if (requests === 1) {
      return Response.json({
        ok: false,
        error_code: 429,
        parameters: { retry_after: 0 }
      }, { status: 429 });
    }
    return Response.json({ ok: true, result: { message_id: 45 } });
  });
  const result = await telegram.sendMessage("700", "Scheduled message");
  assert.deepEqual(result, { message_id: 45 });
  assert.equal(requests, 2);
});

test("Telegram unchanged message edits do not trigger duplicate fallback sends", async () => {
  let requests = 0;
  const telegram = createTelegramApi("test-token", async () => {
    requests++;
    return Response.json({
      ok: false,
      description: "Bad Request: message is not modified"
    }, { status: 400 });
  });
  const result = await telegram.editAssistantResponse("700", 45, {
    title: "Same response",
    sections: [{ heading: "", lines: ["No changes"] }]
  });

  assert.equal(result.message_id, 45);
  assert.equal(result.notModified, true);
  assert.equal(requests, 1);
});

test("callback updates become user actions without Telegram types in core intent", () => {
  const adapted = adaptTelegramUpdate({
    update_id: 124,
    callback_query: {
      id: "callback-1",
      data: "task_complete|task-1",
      from: { id: 67 },
      message: { message_id: 9, chat: { id: 45 } }
    }
  });

  assert.deepEqual(resolveIntent(adapted), {
    type: "user_action",
    identifier: "task_complete|task-1",
    externalActionId: "callback-1"
  });
});

test("intent resolver does not mistake unknown commands for supported commands", () => {
  const adapted = adaptTelegramUpdate({
    update_id: 125,
    message: {
      message_id: 10,
      text: "/unknown",
      chat: { id: 45 },
      from: { id: 67 }
    }
  });

  assert.deepEqual(resolveIntent(adapted), {
    type: "unknown_command",
    name: "unknown"
  });
});

test("adapter rejects unsupported Telegram updates", () => {
  assert.throws(() => adaptTelegramUpdate({ update_id: 1 }), /supported message or callback/);
  assert.throws(() => adaptTelegramUpdate({ message: {} }), /update_id/);
});

test("webhook authentication requires an exact configured secret", () => {
  const request = new Request("https://example.test/webhooks/telegram", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "expected" }
  });

  assert.equal(isAuthorizedTelegramWebhook(request, "expected"), true);
  assert.equal(isAuthorizedTelegramWebhook(request, "wrong"), false);
  assert.equal(isAuthorizedTelegramWebhook(request, ""), false);
});

test("Worker health route is staging-only and webhook requires a D1 binding", async () => {
  const response = await worker.fetch(new Request("https://example.test/health"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "staging",
    assistantEnabled: false,
    productionTrafficEnabled: false,
    databaseConfigured: false
  });

  const validUpdate = {
    update_id: 1,
    message: { message_id: 1, chat: { id: 2 }, from: { id: 3 }, text: "/today" }
  };
  const disabledWebhook = await worker.fetch(new Request("https://example.test/webhooks/telegram", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "expected"
    },
    body: JSON.stringify(validUpdate)
  }), {
    TELEGRAM_WEBHOOK_SECRET: "expected",
    TELEGRAM_BOT_TOKEN: "bot-secret",
    DEPLOYMENT_STAGE: "staging",
    ASSISTANT_ENABLED: "true",
    DB: {}
  });

  assert.equal(disabledWebhook.status, 503);
  assert.match((await disabledWebhook.json()).error, /processing is disabled/);
});

test("D1 migration creates the declared data model and key indexes", async () => {
  const { sqlite: database } = await createTestDatabase();

  const tables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  ).all().map(row => row.name);
  for (const table of [
    "users", "conversations", "channel_updates", "channel_messages", "channel_actions",
    "tasks", "task_history", "daily_outcomes", "review_notes", "mini_app_requests",
    "focus_sessions", "calendar_blocks",
    "ai_usage_daily", "ai_recommendations",
    "accountability_routines", "accountability_checkins", "reminder_history",
    "daily_reviews", "weekly_reviews", "monthly_reviews", "email_escalations",
    "system_logs", "settings", "sync_logs", "scheduled_job_runs", "schema_migrations"
  ]) {
    assert.ok(tables.includes(table), `missing table ${table}`);
  }

  const indexes = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index'"
  ).all().map(row => row.name);
  assert.ok(indexes.includes("tasks_status_due_date"));
  assert.ok(indexes.includes("channel_messages_external_message"));
  assert.ok(indexes.includes("calendar_appointment_reminder_unique"));

  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  assert.deepEqual(foreignKeys, []);
  database.close();
});

test("Google Tasks mirror preserves IDs and appends history only for meaningful changes", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const first = await upsertGoogleTaskMirror(d1, {
    id: "google-task-1",
    title: "Write outline",
    notes: "Area: DEEP",
    status: "needsAction",
    due: "2026-11-23T00:00:00.000Z"
  }, "2026-11-22T10:00:00.000Z");
  assert.equal(first.status, "Pending");
  assert.equal(first.changed, true);

  const unchanged = await upsertGoogleTaskMirror(d1, {
    id: "google-task-1",
    title: "Write outline",
    notes: "Area: DEEP",
    status: "needsAction",
    due: "2026-11-23T00:00:00.000Z"
  }, "2026-11-22T10:05:00.000Z");
  assert.equal(unchanged.id, first.id);
  assert.equal(unchanged.changed, false);

  const completed = await upsertGoogleTaskMirror(d1, {
    id: "google-task-1",
    title: "Write outline",
    status: "completed",
    completed: "2026-11-22T10:10:00.000Z"
  }, "2026-11-22T10:10:01.000Z");
  assert.equal(completed.status, "Completed");
  assert.equal(completed.id, first.id);

  const history = sqlite.prepare(
    "SELECT previous_status, new_status FROM task_history WHERE task_id = ?1 ORDER BY occurred_at"
  ).all(first.id).map(row => ({
    previous_status: row.previous_status,
    new_status: row.new_status
  }));
  assert.deepEqual(history, [
    { previous_status: "", new_status: "Pending" },
    { previous_status: "Pending", new_status: "Completed" }
  ]);
  sqlite.close();
});

test("Google Tasks synchronization counts later due-date changes as postponements", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  await syncGoogleTaskMirrors(d1, [{
    id: "postponed-google-task",
    title: "Finish draft",
    status: "needsAction",
    due: "2026-11-23T00:00:00.000Z"
  }], "2026-11-22T10:00:00.000Z");
  await syncGoogleTaskMirrors(d1, [{
    id: "postponed-google-task",
    title: "Finish draft",
    status: "needsAction",
    due: "2026-11-25T00:00:00.000Z"
  }], "2026-11-22T11:00:00.000Z");
  await syncGoogleTaskMirrors(d1, [{
    id: "postponed-google-task",
    title: "Finish draft",
    status: "needsAction",
    due: "2026-11-27T00:00:00.000Z"
  }], "2026-11-22T12:00:00.000Z");
  await syncGoogleTaskMirrors(d1, [{
    id: "postponed-google-task",
    title: "Finish draft",
    status: "needsAction",
    due: "2026-11-28T00:00:00.000Z"
  }], "2026-11-22T13:00:00.000Z");

  const task = sqlite.prepare(
    "SELECT postponement_count FROM tasks WHERE google_task_id = 'postponed-google-task'"
  ).get();
  assert.equal(task.postponement_count, 3);
  const candidates = await listPendingTaskPlanningCandidates(d1, "2026-11-23");
  const plan = buildDailyTaskPlan(candidates, "2026-11-23");
  assert.equal(plan.should[0].title, "Finish draft");
  assert.match(formatDailyTaskPlan(plan, "2026-11-23")
    .find(section => section.heading.startsWith("Should do")).lines[0], /postponed 3 times/);
  sqlite.close();
});

test("Google Tasks synchronization batches large pages and ignores duplicate source IDs", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const tasks = Array.from({ length: 60 }, (_, index) => ({
    id: `google-bulk-${index}`,
    title: `Task ${index}`,
    status: "needsAction"
  }));
  tasks.push(tasks[0]);

  const first = await syncGoogleTaskMirrors(d1, tasks, "2026-11-22T10:00:00.000Z");
  assert.equal(first.length, 60);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 60);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM task_history").get().count, 60);

  const second = await syncGoogleTaskMirrors(d1, tasks, "2026-11-22T11:00:00.000Z");
  assert.equal(second.filter(task => task.changed).length, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM task_history").get().count, 60);
  sqlite.close();
});

test("pending task query orders overdue and due-today items before later work", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  for (const [id, due, priority] of [
    ["late", "2026-11-20", "Low"],
    ["today", "2026-11-22", "Medium"],
    ["later", "2026-11-25", "High"],
    ["unscheduled", null, "High"]
  ]) {
    sqlite.prepare(
      `INSERT INTO tasks (id, google_task_id, title, status, priority, due_date, updated_at)
       VALUES (?, ?, ?, 'Pending', ?, ?, '2026-11-22T10:00:00.000Z')`
    ).run(id, `google-${id}`, id, priority, due);
  }

  const tasks = await listPendingTaskMirrors(d1, "2026-11-22");
  assert.deepEqual(tasks.map(task => task.id), ["late", "today", "later", "unscheduled"]);
  await assert.rejects(() => listPendingTaskMirrors(d1, "bad-date"), /YYYY-MM-DD/);
  sqlite.close();
});

test("channel updates are idempotent and can be retried after failure or expired lease", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const user = await getOrCreateChannelUser(d1, "telegram", "user-1", "2026-11-22T10:00:00.000Z");
  const update = { id: "77", channel: "telegram" };
  const first = await claimChannelUpdate(d1, update, user.id, "2026-11-22T10:00:00.000Z");
  assert.equal(first.claimed, true);
  assert.equal((await claimChannelUpdate(d1, update, user.id, "2026-11-22T10:00:10.000Z")).claimed, false);

  await finishChannelUpdate(d1, update, "failed", "2026-11-22T10:00:20.000Z");
  assert.equal((await claimChannelUpdate(d1, update, user.id, "2026-11-22T10:00:21.000Z")).claimed, true);
  await finishChannelUpdate(d1, update, "processed", "2026-11-22T10:00:22.000Z");
  assert.equal((await claimChannelUpdate(d1, update, user.id, "2026-11-22T10:03:00.000Z")).claimed, false);

  const userAgain = await getOrCreateChannelUser(d1, "telegram", "user-1", "2026-11-22T11:00:00.000Z");
  assert.equal(userAgain.id, user.id);
  sqlite.close();
});

test("communication records deduplicate retries at the message and callback level", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const user = await getOrCreateChannelUser(d1, "telegram", "user-log", "2026-11-22T10:00:00.000Z");
  const incoming = {
    channel: "telegram",
    conversationId: "chat-log",
    externalMessageId: "message-log",
    userId: user.id,
    direction: "incoming",
    type: "text",
    content: "/help",
    createdAt: "2026-11-22T10:00:00.000Z"
  };
  await insertChannelMessage(d1, incoming);
  await insertChannelMessage(d1, incoming);
  const action = {
    channel: "telegram",
    userId: user.id,
    externalActionId: "callback-log",
    identifier: "task_complete|task-1",
    actionName: "task_complete",
    result: "Processing",
    createdAt: "2026-11-22T10:00:00.000Z"
  };
  await insertChannelAction(d1, action);
  await insertChannelAction(d1, { ...action, result: "Processed" });

  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM channel_messages").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM channel_actions").get().count, 1);
  assert.equal(sqlite.prepare("SELECT result FROM channel_actions").get().result, "Processed");
  sqlite.close();
});

test("Google Tasks client refreshes OAuth and lists pages with the configured task list", async () => {
  const calls = [];
  const client = createGoogleTasksClient({
    GOOGLE_OAUTH_CLIENT_ID: "client-test",
    GOOGLE_OAUTH_CLIENT_SECRET: "secret-test",
    GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-test",
    GOOGLE_TASK_LIST_ID: "list/test"
  }, async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "access-test", expires_in: 3600 });
    }
    const page = new URL(String(url)).searchParams.get("pageToken");
    return Response.json(page
      ? { items: [{ id: "task-2", title: "Second" }] }
      : { items: [{ id: "task-1", title: "First" }], nextPageToken: "page-2" });
  }, () => 1_000_000);

  const tasks = await client.listAll();
  assert.deepEqual(tasks.map(task => task.id), ["task-1", "task-2"]);
  const apiCalls = calls.filter(call => call.url.includes("tasks.googleapis.com"));
  assert.equal(apiCalls.length, 2);
  assert.ok(apiCalls.every(call => call.url.includes("/lists/list%2Ftest/tasks")));
  assert.ok(apiCalls.every(call => call.options.headers.Authorization === "Bearer access-test"));
});

test("Google Tasks API failures do not expose response bodies or credentials", async () => {
  const client = createGoogleTasksClient({
    GOOGLE_OAUTH_CLIENT_ID: "failure-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "private-client-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "private-refresh-token",
    GOOGLE_TASK_LIST_ID: "list"
  }, async url => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "temporary-access-token", expires_in: 60 });
    }
    return new Response("sensitive upstream body", { status: 403 });
  }, () => 2_000_000);

  await assert.rejects(() => client.listAll(), error => {
    assert.match(error.message, /HTTP 403/);
    assert.doesNotMatch(error.message, /sensitive|private|temporary/);
    return true;
  });
});

test("Google OAuth errors retain only safe status and allowlisted error codes", async () => {
  const getAccessToken = createGoogleAccessTokenProvider({
    GOOGLE_OAUTH_CLIENT_ID: "oauth-error-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "private-client-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "private-refresh-token"
  }, async () => Response.json({
    error: "invalid_client",
    error_description: "private response details and credentials"
  }, { status: 401 }));

  await assert.rejects(getAccessToken(), error => {
    assert.equal(error.status, 401);
    assert.equal(error.oauthErrorCode, "invalid_client");
    assert.equal(error.oauthRefreshFailure, true);
    assert.match(error.message, /HTTP 401 \(invalid_client\)/);
    assert.doesNotMatch(error.message, /private|credentials/);
    return true;
  });

  const unknownCode = createGoogleAccessTokenProvider({
    GOOGLE_OAUTH_CLIENT_ID: "oauth-unknown-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "private-client-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "private-refresh-token"
  }, async () => Response.json({
    error: "sensitive-custom-code",
    error_description: "private response details"
  }, { status: 400 }));
  await assert.rejects(unknownCode(), error => {
    assert.equal(error.status, 400);
    assert.equal(error.oauthErrorCode, undefined);
    assert.doesNotMatch(error.message, /sensitive|private/);
    return true;
  });
});

test("Gmail API sends UTF-8 reports without exposing credentials or retrying sends", async () => {
  const calls = [];
  const gmail = createGoogleGmailClient({
    GOOGLE_OAUTH_CLIENT_ID: "gmail-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "gmail-client-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "gmail-refresh-secret"
  }, async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "gmail-access-secret", expires_in: 3600 });
    }
    return Response.json({ id: "gmail-message-1", threadId: "gmail-thread-1" });
  }, () => 2_500_000);

  const sent = await gmail.sendText({
    to: "account@example.test",
    subject: "Résumé report",
    body: "Outcome: café\nKeep the next action clear."
  });
  assert.deepEqual(sent, { id: "gmail-message-1", threadId: "gmail-thread-1" });
  const sendCall = calls.find(call => call.url.includes("gmail.googleapis.com"));
  const raw = JSON.parse(sendCall.options.body).raw;
  const mime = new TextDecoder().decode(
    Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0))
  );
  assert.match(mime, /To: account@example\.test/);
  assert.match(mime, /=\?UTF-8\?B\?/);
  const encodedBody = mime.split("\r\n\r\n")[1].replace(/\r\n/g, "");
  const decodedBody = new TextDecoder().decode(
    Uint8Array.from(atob(encodedBody), character => character.charCodeAt(0))
  );
  assert.equal(decodedBody, "Outcome: café\nKeep the next action clear.");
  assert.equal(calls.filter(call => call.url.includes("gmail.googleapis.com")).length, 1);
  assert.doesNotMatch(sendCall.options.body, /gmail-client-secret|gmail-refresh-secret/);
  await assert.rejects(() => gmail.sendText({
    to: "not-an-email",
    subject: "Invalid",
    body: "No send"
  }), /valid email address/);
});

test("Gmail inbox finds unread inbound messages without importance or age filters", async () => {
  const calls = [];
  const gmail = createGoogleGmailClient({
    GOOGLE_OAUTH_CLIENT_ID: "gmail-inbox-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "gmail-inbox-client-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "gmail-inbox-refresh-secret"
  }, async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "gmail-inbox-access", expires_in: 3600 });
    }
    if (String(url).includes("/users/me/profile")) {
      return Response.json({ emailAddress: "me@example.test" });
    }
    if (String(url).includes("/users/me/threads?")) {
      return Response.json({
        threads: [
          { id: "inbound-thread" },
          { id: "answered-thread" },
          { id: "sent-only-thread" }
        ]
      });
    }
    if (String(url).includes("/threads/inbound-thread?")) {
      return Response.json({
        id: "inbound-thread",
        messages: [{
          id: "inbound-message",
          internalDate: "1795435200000",
          labelIds: ["INBOX", "UNREAD"],
          payload: { headers: [
            { name: "From", value: "Alex <alex@example.test>" },
            { name: "Subject", value: "Please review the proposal" },
            { name: "Date", value: "Mon, 23 Nov 2026 10:00:00 +0200" }
          ] }
        }]
      });
    }
    if (String(url).includes("/threads/answered-thread?")) {
      return Response.json({
        id: "answered-thread",
        messages: [
          {
            id: "unread-inbound-message",
            internalDate: "1795435100000",
            labelIds: ["INBOX", "UNREAD"],
            payload: { headers: [
              { name: "From", value: "Alex <alex@example.test>" },
              { name: "Subject", value: "Please review the proposal" },
              { name: "Date", value: "Mon, 23 Nov 2026 09:58:00 +0200" }
            ] }
          },
          {
            id: "answered-message",
            internalDate: "1795435200000",
            labelIds: ["SENT"],
            payload: { headers: [
              { name: "From", value: "Me <me@example.test>" },
              { name: "Subject", value: "Re: Please review the proposal" }
            ] }
          }
        ]
      });
    }
    if (String(url).includes("/threads/sent-only-thread?")) {
      return Response.json({
        id: "sent-only-thread",
        messages: [{
          id: "sent-only-message",
          internalDate: "1795435200000",
          labelIds: ["SENT"],
          payload: { headers: [
            { name: "From", value: "Me <me@example.test>" },
            { name: "Subject", value: "Sent only" }
          ] }
        }]
      });
    }
    throw new Error("Unexpected Gmail request.");
  }, () => 4_000_000);

  const threads = await gmail.listUnreadInboxThreads();
  assert.deepEqual(threads, [
    {
      threadId: "inbound-thread",
      messageId: "inbound-message",
      from: "Alex <alex@example.test>",
      subject: "Please review the proposal",
      receivedAt: "Mon, 23 Nov 2026 10:00:00 +0200"
    },
    {
      threadId: "answered-thread",
      messageId: "unread-inbound-message",
      from: "Alex <alex@example.test>",
      subject: "Please review the proposal",
      receivedAt: "Mon, 23 Nov 2026 09:58:00 +0200"
    }
  ]);
  const apiCalls = calls.filter(call => call.url.includes("gmail.googleapis.com"));
  assert.equal(apiCalls.length, 5);
  assert.ok(apiCalls.every(call => call.options.method === undefined || call.options.method === "GET"));
  assert.ok(apiCalls.some(call => call.url.includes("format=metadata")));
  const threadListCall = apiCalls.find(call => call.url.includes("/users/me/threads?"));
  assert.equal(
    new URL(threadListCall.url).searchParams.get("q"),
    "is:unread"
  );
  assert.equal(new URL(threadListCall.url).searchParams.get("maxResults"), "10");
  assert.ok(apiCalls.every(call => !call.url.includes("format=full")));
  assert.doesNotMatch(JSON.stringify(calls), /gmail-inbox-client-secret|gmail-inbox-refresh-secret/);
  await assert.rejects(() => gmail.listUnreadInboxThreads(0), /from 1 to 10/);
});

test("Gmail message text is fetched separately and only plain text is returned", async () => {
  const calls = [];
  const body = "Please reply by Thursday.";
  const encoded = btoa(body).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const gmail = createGoogleGmailClient({
    GOOGLE_OAUTH_CLIENT_ID: "gmail-body-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "gmail-body-client-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "gmail-body-refresh-secret"
  }, async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "gmail-body-access", expires_in: 3600 });
    }
    return Response.json({
      payload: {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/html", body: { data: btoa("<p>ignored html</p>") } },
          { mimeType: "text/plain", body: { data: encoded } }
        ]
      }
    });
  }, () => 4_000_000);

  assert.equal(await gmail.readMessageText("body-message"), body);
  const messageCall = calls.find(call => call.url.includes("/users/me/messages/"));
  assert.equal(new URL(messageCall.url).searchParams.get("format"), "full");
  assert.equal(new URL(messageCall.url).searchParams.get("fields"), "payload");
  assert.doesNotMatch(JSON.stringify(calls), /gmail-body-client-secret|gmail-body-refresh-secret/);
  await assert.rejects(() => gmail.readMessageText("invalid/id"), /Gmail message ID is invalid/);
});

test("Gmail analysis refuses message responses larger than the fixed byte limit", async () => {
  const gmail = createGoogleGmailClient({
    GOOGLE_OAUTH_CLIENT_ID: "gmail-large-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "gmail-large-client-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "gmail-large-refresh-secret"
  }, async url => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "gmail-large-access", expires_in: 3600 });
    }
    return new Response("{}", { headers: { "content-length": "100001" } });
  }, () => 4_000_000);

  await assert.rejects(
    () => gmail.readMessageText("large-message"),
    /exceeded the analysis size limit/
  );
});

test("Google Calendar reads events for the Cairo-local date, including all-day events", async () => {
  const calls = [];
  const calendar = createGoogleCalendarClient({
    GOOGLE_OAUTH_CLIENT_ID: "calendar-read-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "calendar-read-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "calendar-read-refresh",
    GOOGLE_CALENDAR_ID: "calendar/test"
  }, async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "calendar-access", expires_in: 3600 });
    }
    return Response.json({
      items: [
        {
          id: "timed-event",
          summary: "Focus block",
          start: { dateTime: "2026-11-22T07:00:00Z" },
          end: { dateTime: "2026-11-22T07:50:00Z" }
        },
        {
          id: "all-day-event",
          summary: "Holiday",
          start: { date: "2026-11-22" },
          end: { date: "2026-11-23" }
        }
      ]
    });
  }, () => 3_000_000);

  const events = await calendar.listEventsForDate("2026-11-22");
  assert.deepEqual(events, [
    {
      id: "timed-event",
      title: "Focus block",
      startTime: "2026-11-22T07:00:00Z",
      endTime: "2026-11-22T07:50:00Z",
      allDay: false,
      start: "9:00 AM",
      end: "9:50 AM"
    },
    {
      id: "all-day-event",
      title: "Holiday",
      startTime: "2026-11-22",
      endTime: "2026-11-23",
      allDay: true,
      start: "All day",
      end: ""
    }
  ]);
  const calendarRequest = calls.find(call => call.url.includes("calendar/v3"));
  const query = new URL(calendarRequest.url).searchParams;
  assert.equal(query.get("timeMin"), "2026-11-21T22:00:00.000Z");
  assert.equal(query.get("timeMax"), "2026-11-22T22:00:00.000Z");
  assert.ok(calendarRequest.url.includes("/calendars/calendar%2Ftest/events"));

  await calendar.listEventsForDate("2026-07-22");
  const summerRequest = calls.find(call =>
    call.url.includes("calendar/v3") &&
    new URL(call.url).searchParams.get("timeMin") === "2026-07-21T21:00:00.000Z"
  );
  assert.ok(summerRequest, "uses Cairo daylight-saving offset for summer dates");
});

test("Google Calendar API failures expose only an allowlisted reason and HTTP status", async () => {
  const calendar = createGoogleCalendarClient({
    GOOGLE_OAUTH_CLIENT_ID: "calendar-error-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "private-client-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "private-refresh-token"
  }, async url => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "calendar-error-access", expires_in: 3600 });
    }
    return Response.json({
      error: {
        code: 403,
        message: "private upstream response",
        errors: [{ reason: "insufficientPermissions" }]
      }
    }, { status: 403 });
  }, () => 3_500_000);

  await assert.rejects(() => calendar.listEventsForDate("2026-11-22"), error => {
    assert.equal(error.status, 403);
    assert.equal(error.integration, "Google Calendar");
    assert.equal(error.googleApiReason, "insufficientPermissions");
    assert.match(error.message, /HTTP 403 \(insufficientPermissions\)/);
    assert.doesNotMatch(error.message, /private upstream response|private-refresh-token/);
    return true;
  });
});

test("Google Calendar event creation uses a stable ID and reconciles retries", async () => {
  const calls = [];
  let insertedEvent;
  const calendar = createGoogleCalendarClient({
    GOOGLE_OAUTH_CLIENT_ID: "calendar-write-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "calendar-write-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "calendar-write-refresh"
  }, async (url, options) => {
    const urlString = String(url);
    calls.push({ url: urlString, options });
    if (urlString === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "calendar-write-access", expires_in: 3600 });
    }
    if (options.method === "POST") {
      insertedEvent = JSON.parse(options.body);
      return new Response("already exists", { status: 409 });
    }
    return Response.json({
      id: insertedEvent.id,
      summary: insertedEvent.summary,
      start: insertedEvent.start,
      end: insertedEvent.end
    });
  }, () => 4_000_000);

  const event = await calendar.createEvent({
    idempotencyKey: "outcome-focus-session-1",
    title: "Prepare outreach hypotheses",
    start: "2026-11-23T09:00:00+02:00",
    end: "2026-11-23T09:25:00+02:00",
    description: "DEEP focus block"
  });
  assert.equal(event.summary, "Prepare outreach hypotheses");
  assert.match(event.id, /^a[0-9a-f]{64}$/);
  assert.equal(calls.filter(call =>
    call.url.startsWith("https://www.googleapis.com/calendar/v3/") &&
    call.options.method === "POST"
  ).length, 1);
  assert.equal(calls.filter(call => call.url.includes("/events/") && !call.url.includes("?")).length, 1);
  await assert.rejects(() => calendar.createEvent({
    idempotencyKey: "invalid-time",
    title: "Invalid",
    start: "2026-02-31T09:00:00+02:00",
    end: "2026-02-31T10:00:00+02:00"
  }), /valid offset date-times/);
});

test("Google Calendar focus blocks convert Cairo local time and enforce explicit durations", async () => {
  let created;
  const calendar = createGoogleCalendarClient({
    GOOGLE_OAUTH_CLIENT_ID: "calendar-block-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "calendar-block-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "calendar-block-refresh"
  }, async (url, options) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "calendar-block-access", expires_in: 3600 });
    }
    created = JSON.parse(options.body);
    return Response.json(created);
  }, () => 5_000_000);

  const event = await calendar.createTaskBlock({
    idempotencyKey: "calendar-block-test",
    title: "Focus: Write report",
    date: "2026-11-23",
    startTime: "09:00",
    durationMinutes: 25,
    notBefore: "2026-11-22T10:00:00.000Z"
  });
  assert.equal(created.start.dateTime, "2026-11-23T07:00:00.000Z");
  assert.equal(created.end.dateTime, "2026-11-23T07:25:00.000Z");
  assert.equal(event.summary, "Focus: Write report");
  await assert.rejects(() => calendar.createTaskBlock({
    idempotencyKey: "calendar-block-invalid",
    title: "Invalid",
    date: "2026-11-23",
    startTime: "09:00",
    durationMinutes: 30,
    notBefore: "2026-11-22T10:00:00.000Z"
  }), /duration must be 25 or 50/);
});

test("task scheduling creates a Calendar block only after the user selects a start and duration", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-22T10:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "calendar-action-user", now.toISOString());
  const task = await upsertGoogleTaskMirror(d1, {
    id: "calendar-action-task",
    title: "Write report",
    status: "needsAction"
  }, now.toISOString());
  const calendarCalls = [];
  const googleCalendar = {
    async createTaskBlock(options) {
      calendarCalls.push(options);
      return {
        id: "google-calendar-event-1",
        start: { dateTime: "2026-11-23T07:00:00.000Z" },
        end: { dateTime: "2026-11-23T07:25:00.000Z" }
      };
    }
  };
  const sendText = (updateId, text) => handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        text,
        chat: { id: "calendar-action-chat" },
        from: { id: "calendar-action-user" }
      }
    }, now.toISOString()),
    googleTasks: {
      async listAll() {
        return [{ id: "calendar-action-task", title: "Write report", status: "needsAction" }];
      }
    },
    googleCalendar,
    now
  });
  const sendAction = (updateId, action) => handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: updateId,
      callback_query: {
        id: `calendar-action-${updateId}`,
        data: action,
        from: { id: "calendar-action-user" },
        message: { message_id: updateId, chat: { id: "calendar-action-chat" } }
      }
    }, now.toISOString()),
    googleTasks: {
      async listAll() {
        return [{ id: "calendar-action-task", title: "Write report", status: "needsAction" }];
      }
    },
    googleCalendar,
    now
  });

  assert.match((await sendAction(1, `calendar_block|${task.id}`)).title, /Choose when/);
  const invalidStart = await sendText(2, "not a date");
  assert.match(invalidStart.sections[0].lines[0], /Cairo time/);
  const durationPrompt = await sendText(3, "2026-11-23 09:00");
  assert.match(durationPrompt.title, /Choose a focus duration/);
  assert.equal(calendarCalls.length, 0);
  const result = await sendAction(4, `calendar_duration|${task.id}|25`);

  assert.match(result.title, /Focus time scheduled/);
  assert.equal(calendarCalls.length, 1);
  assert.equal(calendarCalls[0].date, "2026-11-23");
  assert.equal(calendarCalls[0].startTime, "09:00");
  assert.equal(calendarCalls[0].durationMinutes, 25);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM calendar_blocks").get().count, 1);
  assert.equal(sqlite.prepare("SELECT status FROM tasks WHERE id = ?1").get(task.id).status, "Pending");
  sqlite.close();
});

test("daily home includes Calendar appointments when the integration is enabled", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-22T10:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "calendar-home-user", now.toISOString());
  await createGoal(d1, user.id, {
    level: "annual",
    title: "Keep health in my weekly plan",
    description: "Prioritize regular movement.",
    category: "Health",
    whyMatters: "Support wellbeing.",
    targetOutcome: "Consistent movement.",
    startDate: "2026-11-22",
    deadline: null,
    nextAction: "Choose an activity for this week.",
    keyResults: [{
      title: "Movement sessions",
      baselineValue: 0,
      targetValue: 3,
      unit: "sessions"
    }]
  }, now.toISOString());
  const result = await handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: 710,
      message: {
        message_id: 710,
        text: "/today",
        chat: { id: "calendar-home-chat" },
        from: { id: "calendar-home-user" }
      }
    }, now.toISOString()),
    googleTasks: { async listAll() { return []; } },
    googleCalendar: {
      async listEventsForDate(date) {
        assert.equal(date, "2026-11-22");
        return [{
          id: "calendar-home-event",
          title: "Doctor",
          allDay: false,
          start: "14:00",
          end: "14:30"
        }];
      }
    },
    now
  });

  const calendar = result.sections.find(section => section.heading === "Today's calendar");
  assert.deepEqual(calendar.lines, ["14:00–14:30 · Doctor"]);
  const goalFocus = result.sections.find(section => section.heading === "Goal-aligned next actions");
  assert.match(goalFocus.lines[0], /Keep health in my weekly plan/);

  const calendarError = new Error(
    "Google Calendar API request failed with HTTP 403 (insufficientPermissions)."
  );
  calendarError.status = 403;
  calendarError.integration = "Google Calendar";
  calendarError.googleApiReason = "insufficientPermissions";
  const withoutCalendar = await handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: 711,
      message: {
        message_id: 711,
        text: "/today",
        chat: { id: "calendar-home-chat" },
        from: { id: "calendar-home-user" }
      }
    }, now.toISOString()),
    googleTasks: { async listAll() { return []; } },
    googleCalendar: {
      async listEventsForDate() {
        throw calendarError;
      }
    },
    now
  });
  const unavailableCalendar = withoutCalendar.sections.find(
    section => section.heading === "Today's calendar"
  );
  assert.match(unavailableCalendar.lines[0], /insufficientPermissions/);
  assert.match(unavailableCalendar.lines[1], /Reauthorize/);
  assert.ok(withoutCalendar.sections.some(section => section.heading === "Your three outcomes"));
  const calendarLog = sqlite.prepare(
    "SELECT error_message FROM system_logs WHERE component = 'Google Calendar'"
  ).get().error_message;
  assert.equal(calendarLog, "Google API insufficientPermissions (HTTP 403)");
  sqlite.close();
});

test("variable availability planning checks Calendar and uses Workers AI without changing tasks", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-23T09:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "availability-plan-user", now.toISOString());
  const tasks = [
    { id: "availability-task-1", title: "Draft the proposal", status: "needsAction" },
    { id: "availability-task-2", title: "Review project notes", status: "needsAction" }
  ];
  const googleTasks = { async listAll() { return tasks; } };
  let aiCalls = 0;
  const googleCalendar = {
    async listEventsForDate(date) {
      assert.equal(date, "2026-11-23");
      return [{
        id: "availability-event",
        title: "Appointment",
        allDay: false,
        start: "14:30",
        end: "15:00"
      }];
    }
  };
  const sendText = async (updateId, text) => handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        text,
        chat: { id: "availability-plan-chat" },
        from: { id: "availability-plan-user" }
      }
    }, now.toISOString()),
    googleTasks,
    googleCalendar,
    aiDailyPlanner: async ({ tasks: candidates }) => {
      aiCalls++;
      assert.ok(candidates.length >= 2);
      return [...candidates]
        .sort((left, right) => left.title.localeCompare(right.title))
        .map(task => task.id);
    },
    now
  });

  const startPrompt = await sendText(1, "I have two hours free");
  assert.match(startPrompt.title, /When does your free time start/);
  const conflict = await sendText(2, "14:00");
  assert.match(conflict.title, /Calendar is busy/);
  assert.match(conflict.sections[0].lines[0], /Appointment/);
  assert.equal(aiCalls, 0);

  const plan = await sendText(3, "16:00");
  assert.match(plan.title, /free-time focus plan/i);
  assert.deepEqual(plan.sections[0].lines, [
    "16:00–16:50 · Draft the proposal (50 min)",
    "17:00–17:50 · Review project notes (50 min)"
  ]);
  assert.deepEqual(plan.sections.find(section => section.heading === "Breaks").lines, [
    "16:50–17:00 · Break"
  ]);
  assert.match(plan.sections.at(-1).lines[0], /The pending Google Tasks are ranked/);
  assert.match(plan.sections.at(-1).lines[1], /no Calendar events were created/);
  assert.equal(aiCalls, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM calendar_blocks").get().count, 0);
  assert.deepEqual(
    sqlite.prepare("SELECT status FROM tasks ORDER BY google_task_id").all().map(row => row.status),
    ["Pending", "Pending"]
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM conversations").get().count, 0);
  sqlite.close();
});

test("availability planning rejects past starts and all-day Calendar conflicts", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-23T09:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "availability-all-day-user", now.toISOString());
  let calendarUnavailable = false;
  const sendText = async (updateId, text) => handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        text,
        chat: { id: "availability-all-day-chat" },
        from: { id: "availability-all-day-user" }
      }
    }, now.toISOString()),
    googleTasks: { async listAll() { return []; } },
    googleCalendar: {
      async listEventsForDate() {
        if (calendarUnavailable) {
          const error = new Error(
            "Google Calendar API request failed with HTTP 403 (insufficientPermissions)."
          );
          error.status = 403;
          error.integration = "Google Calendar";
          error.googleApiReason = "insufficientPermissions";
          throw error;
        }
        return [{ id: "all-day", title: "Holiday", allDay: true, start: "All day", end: "" }];
      }
    },
    now
  });

  await sendText(1, "/available 60");
  const past = await sendText(2, "10:00");
  assert.match(past.title, /Choose a future start time/);
  const conflict = await sendText(3, "14:00");
  assert.match(conflict.title, /Calendar is busy/);
  assert.match(conflict.sections[0].lines[0], /All day · Holiday/);
  calendarUnavailable = true;
  await sendText(4, "/available 60");
  const unavailable = await sendText(5, "14:00");
  assert.equal(unavailable.category, "Calendar availability unavailable");
  assert.match(unavailable.sections[0].lines[0], /insufficientPermissions/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM calendar_blocks").get().count, 0);
  sqlite.close();
});

test("scheduled morning briefing includes Calendar events when enabled", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const user = await getOrCreateChannelUser(d1, "telegram", "calendar-rhythm-user", "2026-11-22T05:00:00.000Z");
  await createGoal(d1, user.id, {
    level: "annual",
    title: "Protect weekly focus time",
    description: "Make time for important work.",
    category: "Work",
    whyMatters: "Long-term work matters.",
    targetOutcome: "Consistent focus sessions.",
    startDate: "2026-11-22",
    deadline: null,
    nextAction: "Schedule a focus session.",
    keyResults: [{
      title: "Weekly focus sessions",
      baselineValue: 0,
      targetValue: 3,
      unit: "sessions"
    }]
  }, "2026-11-22T05:00:00.000Z");
  await insertChannelMessage(d1, {
    channel: "telegram",
    conversationId: "calendar-rhythm-chat",
    externalMessageId: "calendar-rhythm-inbound",
    userId: user.id,
    direction: "incoming",
    type: "text",
    content: "/today",
    createdAt: "2026-11-22T05:00:00.000Z"
  });
  const sent = [];
  const result = await processScheduledRhythm({
    db: d1,
    telegram: {
      async sendAssistantResponse(chatId, message) {
        sent.push({ chatId, message });
        return { message_id: 900 };
      }
    },
    authorizedTelegramUserId: "calendar-rhythm-user",
    now: new Date("2026-11-22T06:00:00.000Z"),
    googleTasks: {
      async listAll() {
        return [{
          id: "morning-planned-task",
          title: "Send proposal",
          status: "needsAction",
          due: "2026-11-22T00:00:00.000Z"
        }];
      }
    },
    googleCalendar: {
      async listEventsForDate(date) {
        assert.equal(date, "2026-11-22");
        return [{
          id: "calendar-rhythm-event",
          title: "Team stand-up",
          allDay: false,
          start: "09:30",
          end: "10:00"
        }];
      }
    }
  });

  assert.deepEqual(result, { sent: 1, skipped: 0 });
  const calendar = sent[0].message.sections.find(section => section.heading === "Calendar");
  assert.deepEqual(calendar.lines, ["09:30–10:00 · Team stand-up"]);
  const goalFocus = sent[0].message.sections.find(section => section.heading === "Goal-aligned next actions");
  assert.match(goalFocus.lines[0], /Protect weekly focus time/);
  assert.match(goalFocus.lines[0], /Schedule a focus session/);
  const mustDo = sent[0].message.sections.find(section => section.heading.startsWith("Must do today"));
  assert.match(mustDo.lines[0], /Send proposal · due today/);
  sqlite.close();
});

test("scheduled morning briefing omits stale tasks when Google Tasks sync fails", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const user = await getOrCreateChannelUser(d1, "telegram", "task-sync-failure-user", "2026-11-22T05:00:00.000Z");
  await insertChannelMessage(d1, {
    channel: "telegram",
    conversationId: "task-sync-failure-chat",
    externalMessageId: "task-sync-failure-inbound",
    userId: user.id,
    direction: "incoming",
    type: "text",
    content: "/today",
    createdAt: "2026-11-22T05:00:00.000Z"
  });
  await syncGoogleTaskMirrors(d1, [{
    id: "stale-task",
    title: "Do not show stale status",
    status: "needsAction"
  }], "2026-11-22T05:00:00.000Z");

  const sent = [];
  const result = await processScheduledRhythm({
    db: d1,
    telegram: {
      async sendAssistantResponse(chatId, message) {
        sent.push({ chatId, message });
        return { message_id: 901 };
      }
    },
    authorizedTelegramUserId: "task-sync-failure-user",
    now: new Date("2026-11-22T06:00:00.000Z"),
    googleTasks: {
      async listAll() {
        throw new Error("Google Tasks unavailable");
      }
    }
  });

  assert.deepEqual(result, { sent: 1, skipped: 0 });
  const taskStatus = sent[0].message.sections.find(section => section.heading === "Google Tasks");
  assert.match(taskStatus.lines[0], /could not be refreshed/);
  assert.equal(JSON.stringify(sent[0].message).includes("Do not show stale status"), false);
  assert.equal(
    sqlite.prepare("SELECT result FROM sync_logs WHERE operation = 'Synchronize tasks for morning briefing' ORDER BY occurred_at DESC LIMIT 1").get().result,
    "Failed"
  );
  sqlite.close();
});

test("calendar reminders send once in the 15-minute window and record explicit responses", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-23T10:00:00.000Z");
  const user = await getOrCreateChannelUser(
    d1,
    "telegram",
    "calendar-reminder-user",
    now.toISOString()
  );
  await insertChannelMessage(d1, {
    channel: "telegram",
    conversationId: "calendar-reminder-chat",
    externalMessageId: "calendar-reminder-incoming",
    userId: user.id,
    direction: "incoming",
    type: "message",
    createdAt: now.toISOString()
  });
  const sent = [];
  const options = {
    db: d1,
    telegram: {
      async sendAssistantResponse(chatId, message) {
        sent.push({ chatId, message });
        return { message_id: 730 };
      }
    },
    googleCalendar: {
      async listEventsForDate(date) {
        assert.equal(date, "2026-11-23");
        return [
          {
            id: "event-starts-15m",
            title: "Project review",
            startTime: "2026-11-23T10:15:00.000Z",
            start: "12:15",
            allDay: false
          },
          {
            id: "event-starts-12m",
            title: "Client check-in",
            startTime: "2026-11-23T10:12:00.000Z",
            start: "12:12",
            allDay: false
          },
          {
            id: "event-starts-10m",
            title: "Too close for a useful reminder",
            startTime: "2026-11-23T10:10:00.000Z",
            start: "12:10",
            allDay: false
          },
          {
            id: "all-day-event",
            title: "Holiday",
            startTime: "2026-11-23",
            start: "All day",
            allDay: true
          }
        ];
      }
    },
    authorizedTelegramUserId: "calendar-reminder-user",
    now,
    enabled: true
  };

  assert.deepEqual(await processCalendarAppointmentReminders(options), {
    sent: 1, skipped: 0, failed: 0
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "calendar-reminder-chat");
  const reminderLines = sent[0].message.sections[0].lines.join("\n");
  assert.match(reminderLines, /Project review/);
  assert.match(reminderLines, /Client check-in/);
  assert.doesNotMatch(JSON.stringify(sent[0].message), /Too close|Holiday/);
  const reminder = sqlite.prepare(
    `SELECT id, delivery_status, scheduled_at
       FROM reminder_history
      WHERE category = 'Calendar appointment'
        AND related_record_id = 'event-starts-15m'`
  ).get();
  assert.equal(reminder.delivery_status, "Sent");
  assert.equal(reminder.scheduled_at, "2026-11-23T10:00:00.000Z");
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM reminder_history WHERE category = 'Calendar appointment'"
  ).get().count, 2);

  assert.deepEqual(await processCalendarAppointmentReminders(options), {
    sent: 0, skipped: 2, failed: 0
  });
  assert.equal(sent.length, 1);

  const prepared = await handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: 731,
      callback_query: {
        id: "calendar-reminder-prepared",
        data: sent[0].message.actions[0][0].action,
        from: { id: "calendar-reminder-user" },
        message: { message_id: 730, chat: { id: "calendar-reminder-chat" } }
      }
    }, now.toISOString()),
    now
  });
  assert.equal(prepared.category, "Appointment reminder updated");
  const preparedReminderId = sent[0].message.actions[0][0].action.split("|")[1];
  assert.equal(sqlite.prepare(
    "SELECT user_response FROM reminder_history WHERE id = ?1"
  ).get(preparedReminderId).user_response, "Prepared");
  sqlite.close();
});

test("calendar reminder read failures are logged without failing the scheduled run", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-23T10:00:00.000Z");
  const user = await getOrCreateChannelUser(
    d1,
    "telegram",
    "calendar-reminder-error-user",
    now.toISOString()
  );
  await insertChannelMessage(d1, {
    channel: "telegram",
    conversationId: "calendar-reminder-error-chat",
    externalMessageId: "calendar-reminder-error-incoming",
    userId: user.id,
    direction: "incoming",
    type: "message",
    createdAt: now.toISOString()
  });
  const result = await processCalendarAppointmentReminders({
    db: d1,
    telegram: { async sendAssistantResponse() { throw new Error("Should not send"); } },
    googleCalendar: {
      async listEventsForDate() {
        const error = new Error("Google Calendar API request failed with HTTP 403 (accessNotConfigured).");
        error.status = 403;
        error.googleApiReason = "accessNotConfigured";
        throw error;
      }
    },
    authorizedTelegramUserId: "calendar-reminder-error-user",
    now,
    enabled: true
  });
  assert.deepEqual(result, { sent: 0, skipped: 0, failed: 1 });
  assert.equal(sqlite.prepare(
    "SELECT error_message FROM system_logs WHERE component = 'Calendar reminders'"
  ).get().error_message, "Google Calendar accessNotConfigured (HTTP 403)");
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM reminder_history WHERE category = 'Calendar appointment'"
  ).get().count, 0);
  sqlite.close();
});

test("daily overdue reminders sync tasks, deduplicate sends, and record explicit responses", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-23T06:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "overdue-reminder-user", now.toISOString());
  await insertChannelMessage(d1, {
    channel: "telegram",
    conversationId: "overdue-reminder-chat",
    externalMessageId: "overdue-reminder-inbound",
    userId: user.id,
    direction: "incoming",
    type: "text",
    content: "/today",
    createdAt: now.toISOString()
  });
  const sourceTasks = [
    { id: "overdue-high", title: "Send proposal", status: "needsAction", due: "2026-11-20T00:00:00.000Z" },
    { id: "overdue-medium", title: "Review notes", status: "needsAction", due: "2026-11-22T00:00:00.000Z" }
  ];
  const sent = [];
  let listCalls = 0;
  const googleTasks = {
    async listAll() {
      listCalls++;
      return sourceTasks;
    },
    async complete(taskId) {
      const task = sourceTasks.find(item => item.id === taskId);
      return { ...task, status: "completed", completed: now.toISOString() };
    }
  };
  const telegram = {
    async sendAssistantResponse(chatId, message) {
      sent.push({ chatId, message });
      return { message_id: 902 };
    }
  };
  const options = {
    db: d1,
    telegram,
    googleTasks,
    authorizedTelegramUserId: "overdue-reminder-user",
    now,
    enabled: true
  };

  assert.deepEqual(await processOverdueTaskReminders(options), {
    sent: 1, skipped: 0, failed: 0
  });
  assert.equal(listCalls, 1);
  assert.match(sent[0].message.title, /overdue tasks/i);
  assert.equal(sent[0].message.actions.length, 2);
  assert.ok(sent[0].message.actions.flat().every(button => button.action.length <= 64));
  assert.deepEqual(await processOverdueTaskReminders(options), {
    sent: 0, skipped: 1, failed: 0
  });
  assert.equal(listCalls, 1);
  assert.deepEqual(await processOverdueTaskReminders({
    ...options,
    now: new Date("2026-11-23T06:05:00.000Z")
  }), { sent: 0, skipped: 0, failed: 0 });
  assert.equal(listCalls, 1);

  const laterAction = sent[0].message.actions[0][1].action;
  const doneAction = sent[0].message.actions[1][0].action;
  const sendAction = (updateId, action) => handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: updateId,
      callback_query: {
        id: `overdue-reminder-action-${updateId}`,
        data: action,
        from: { id: "overdue-reminder-user" },
        message: { message_id: 1000 + updateId, chat: { id: "overdue-reminder-chat" } }
      }
    }, now.toISOString()),
    googleTasks,
    now
  });
  assert.equal((await sendAction(9401, laterAction)).category, "Reminder deferred");
  assert.equal(
    sqlite.prepare("SELECT status FROM tasks WHERE google_task_id = 'overdue-high'").get().status,
    "Pending"
  );
  assert.equal((await sendAction(9402, doneAction)).title, "Task marked complete in Google Tasks");
  assert.equal(
    sqlite.prepare("SELECT status FROM tasks WHERE google_task_id = 'overdue-medium'").get().status,
    "Completed"
  );
  assert.equal(
    sqlite.prepare("SELECT user_response FROM reminder_history WHERE related_record_id = (SELECT id FROM tasks WHERE google_task_id = 'overdue-high')").get().user_response,
    "Postponed"
  );
  assert.equal(
    sqlite.prepare("SELECT user_response FROM reminder_history WHERE related_record_id = (SELECT id FROM tasks WHERE google_task_id = 'overdue-medium')").get().user_response,
    "Completed"
  );
  sqlite.close();
});

test("/overdue syncs Google Tasks before displaying overdue items", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-23T09:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "overdue-command-user", now.toISOString());
  const result = await handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: 9403,
      message: {
        message_id: 9403,
        text: "/overdue",
        chat: { id: "overdue-command-chat" },
        from: { id: "overdue-command-user" }
      }
    }, now.toISOString()),
    googleTasks: {
      async listAll() {
        return [{
          id: "overdue-command-task",
          title: "Submit signed form",
          status: "needsAction",
          due: "2026-11-20T00:00:00.000Z"
        }];
      }
    },
    now
  });

  assert.equal(result.title, "Pending past their due date");
  assert.match(result.sections[0].lines[0], /Submit signed form · due 2026-11-20/);
  assert.equal(sqlite.prepare("SELECT status FROM tasks WHERE google_task_id = 'overdue-command-task'").get().status, "Pending");
  assert.equal(result.actions[0][0].action, "task_complete|overdue-command-task");
  sqlite.close();
});

test("/inbox uses metadata-only fallback when email analysis is unavailable", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-23T09:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "gmail-triage-user", now.toISOString());
  const send = (updateId, googleGmail) => handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        text: "/inbox",
        chat: { id: "gmail-triage-chat" },
        from: { id: "gmail-triage-user" }
      }
    }, now.toISOString()),
    googleGmail,
    now
  });

  const inbox = await send(9410, {
    async listUnreadInboxThreads(limit) {
      assert.equal(limit, 5);
      return [{
        threadId: "gmail-thread-1",
        messageId: "gmail-message-1",
        from: "Alex <alex@example.test>",
        subject: "Please review",
        receivedAt: "Mon, 23 Nov 2026 10:00:00 +0200"
      }];
    }
  });
  assert.equal(inbox.title, "Unread email conversations");
  assert.match(inbox.sections[0].lines[0], /Alex <alex@example\.test>/);
  assert.match(inbox.sections[0].lines[0], /Subject: Please review/);
  assert.match(inbox.sections[1].lines[0], /No messages were marked read or sent/);
  assert.match(inbox.sections[1].lines[1], /Email follow-up analysis is unavailable/);

  const disabled = await send(9411, null);
  assert.equal(disabled.title, "Read-only inbox access is disabled");
  assert.match(disabled.sections[0].lines[0], /Gmail read-only OAuth scope/);

  const oauthError = new Error("Google OAuth token refresh failed with HTTP 400 (invalid_grant).");
  oauthError.status = 400;
  oauthError.oauthErrorCode = "invalid_grant";
  const failed = await send(9412, {
    async listUnreadInboxThreads() {
      throw oauthError;
    }
  });
  assert.equal(failed.title, "Gmail inbox access unavailable");
  assert.match(failed.sections[0].lines[0], /OAuth invalid_grant \(HTTP 400\)/);
  assert.match(failed.sections[0].lines[1], /Reauthorize Google/);
  const loggedError = sqlite.prepare(
    "SELECT error_message FROM system_logs WHERE component = 'Gmail triage'"
  ).get().error_message;
  assert.equal(loggedError, "OAuth invalid_grant (HTTP 400)");
  sqlite.close();
});

test("/inbox verifies AI email evidence and creates a Google Task only after a button tap", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-23T09:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "gmail-action-user", now.toISOString());
  const thread = {
    threadId: "gmail-thread-1",
    messageId: "gmail-message-1",
    from: "Alex <alex@example.test>",
    subject: "Please review the proposal",
    receivedAt: "Mon, 23 Nov 2026 10:00:00 +0200"
  };
  let analyzedBody = "";
  const googleGmail = {
    async listUnreadInboxThreads() {
      return [thread];
    },
    async readMessageText(messageId) {
      assert.equal(messageId, thread.messageId);
      return "Please review the proposal and send your feedback by Friday.";
    },
    async getThreadSummary(threadId) {
      assert.equal(threadId, thread.threadId);
      return thread;
    }
  };
  const emailFollowUpAnalyzer = async threads => {
    analyzedBody = threads[0].bodyText;
    return [{
      threadId: thread.threadId,
      actionType: "reply",
      evidenceQuote: "send your feedback",
      deadlineEvidence: "by Friday"
    }];
  };
  const inbox = await handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: 9420,
      message: {
        message_id: 9420,
        text: "/inbox",
        chat: { id: "gmail-action-chat" },
        from: { id: "gmail-action-user" }
      }
    }, now.toISOString()),
    googleGmail,
    emailFollowUpAnalyzer,
    now
  });
  assert.equal(analyzedBody, "Please review the proposal and send your feedback by Friday.");
  assert.match(inbox.sections[1].lines[0], /Evidence: “send your feedback”/);
  assert.match(inbox.sections[1].lines[0], /Deadline wording: “by Friday”/);
  assert.equal(inbox.actions[0][0].action, "gmail_followup_task|gmail-thread-1");

  const conversation = { type: "weekly_review", step: 2 };
  await setConversationState(d1, user.id, conversation, now.toISOString());
  const createdTasks = [];
  const googleTaskList = [];
  const googleTasks = {
    async create(title, notes, dueDate) {
      const task = {
        id: "gmail-follow-up-google-task",
        title,
        notes,
        due: dueDate || undefined,
        status: "needsAction"
      };
      createdTasks.push(task);
      googleTaskList.push(task);
      return task;
    },
    async listAll() {
      return googleTaskList;
    }
  };
  const clickCreate = updateId => handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: updateId,
      callback_query: {
        id: `gmail-action-${updateId}`,
        data: inbox.actions[0][0].action,
        from: { id: "gmail-action-user" },
        message: { message_id: 9420, chat: { id: "gmail-action-chat" } }
      }
    }, now.toISOString()),
    googleTasks,
    googleGmail,
    now
  });
  const created = await clickCreate(9421);
  assert.equal(created.title, "Task added");
  assert.equal(createdTasks.length, 1);
  assert.equal(createdTasks[0].title, "Follow up: Please review the proposal");
  assert.match(createdTasks[0].notes, /assistant-request:TASK-GMAIL-gmail-thread-1/);

  await clickCreate(9422);
  assert.equal(createdTasks.length, 1);
  const storedConversation = await d1.prepare(
    "SELECT state_json FROM conversations WHERE user_id = ?1"
  ).bind(user.id).first();
  assert.deepEqual(JSON.parse(storedConversation.state_json), conversation);
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM tasks WHERE google_task_id = 'gmail-follow-up-google-task'"
  ).get().count, 1);
  sqlite.close();
});

test("/accountability records manual Trello and Obsidian check-ins without external APIs", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-22T23:30:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "manual-accountability-user", now.toISOString());
  const sendText = updateId => handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        text: "/accountability",
        chat: { id: "manual-accountability-chat" },
        from: { id: "manual-accountability-user" }
      }
    }, now.toISOString()),
    now
  });
  const sendAction = (updateId, action) => handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: updateId,
      callback_query: {
        id: `manual-accountability-action-${updateId}`,
        data: action,
        from: { id: "manual-accountability-user" },
        message: { message_id: 1000 + updateId, chat: { id: "manual-accountability-chat" } }
      }
    }, now.toISOString()),
    now
  });

  const initial = await sendText(9420);
  assert.equal(initial.title, "Trello and Obsidian check-in");
  assert.equal(initial.sections[0].heading, "2026-11-23");
  assert.equal(initial.actions.length, 2);
  assert.match(initial.sections[0].lines[0], /Trello: Not recorded today/);
  assert.match(initial.sections[0].lines[1], /Obsidian: Not recorded today/);
  const trelloDone = initial.actions[0][0].action;
  const obsidianMissed = initial.actions[1][1].action;
  await sendAction(9421, trelloDone);
  await sendAction(9422, obsidianMissed);
  const updated = await sendText(9423);
  assert.match(updated.sections[0].lines[0], /Trello: Done today/);
  assert.match(updated.sections[0].lines[1], /Obsidian: Not done today/);
  await sendAction(9424, "accountability_missed|ROUTINE-TRELLO");
  const corrected = await sendText(9425);
  assert.match(corrected.sections[0].lines[0], /Trello: Not done today/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM accountability_routines").get().count, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM accountability_checkins").get().count, 2);
  assert.deepEqual(sqlite.prepare(
    "SELECT routine_id, status, confirmation_method FROM accountability_checkins ORDER BY routine_id"
  ).all().map(row => ({
    routine_id: row.routine_id,
    status: row.status,
    confirmation_method: row.confirmation_method
  })), [
    { routine_id: "ROUTINE-OBSIDIAN", status: "Missed", confirmation_method: "Telegram" },
    { routine_id: "ROUTINE-TRELLO", status: "Missed", confirmation_method: "Telegram" }
  ]);
  assert.equal(sqlite.prepare(
    "SELECT MAX(confirmed_at) AS confirmed_at FROM accountability_checkins"
  ).get().confirmed_at, now.toISOString());
  sqlite.close();
});

test("overdue reminder sync failure sends no stale task details", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-23T06:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "overdue-sync-failure-user", now.toISOString());
  await insertChannelMessage(d1, {
    channel: "telegram",
    conversationId: "overdue-sync-failure-chat",
    externalMessageId: "overdue-sync-failure-inbound",
    userId: user.id,
    direction: "incoming",
    type: "text",
    content: "/today",
    createdAt: now.toISOString()
  });
  await syncGoogleTaskMirrors(d1, [{
    id: "stale-overdue-task",
    title: "Stale overdue title",
    status: "needsAction",
    due: "2026-11-20T00:00:00.000Z"
  }], "2026-11-22T06:00:00.000Z");
  const sent = [];
  const result = await processOverdueTaskReminders({
    db: d1,
    telegram: {
      async sendAssistantResponse(chatId, message) {
        sent.push({ chatId, message });
        return { message_id: 903 };
      }
    },
    googleTasks: {
      async listAll() {
        throw new Error("Google Tasks unavailable");
      }
    },
    authorizedTelegramUserId: "overdue-sync-failure-user",
    now,
    enabled: true
  });

  assert.deepEqual(result, { sent: 0, skipped: 0, failed: 1 });
  assert.equal(sent.length, 1);
  assert.match(sent[0].message.title, /were not checked/);
  assert.equal(JSON.stringify(sent[0].message).includes("Stale overdue title"), false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM reminder_history").get().count, 0);
  assert.equal(sqlite.prepare("SELECT result FROM sync_logs WHERE operation = 'Synchronize tasks for overdue reminders'").get().result, "Failed");
  sqlite.close();
});

test("Worker processes an authorized update once and records both directions", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const originalFetch = globalThis.fetch;
  const telegramCalls = [];
  globalThis.fetch = async (url, options) => {
    telegramCalls.push({ url: String(url), options });
    return Response.json({ ok: true, result: { message_id: 501 } });
  };
  const env = {
    DB: d1,
    DEPLOYMENT_STAGE: "production",
    ASSISTANT_ENABLED: "true",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    TELEGRAM_BOT_TOKEN: "bot-secret",
    AUTHORIZED_TELEGRAM_USER_ID: "900"
  };
  const update = {
    update_id: 501,
    message: {
      message_id: 88,
      text: "/help",
      chat: { id: 700 },
      from: { id: 900 }
    }
  };
  const request = () => new Request("https://worker.test/webhooks/telegram", {
    method: "POST",
    headers: {
      "X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(update)
  });

  try {
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const duplicate = await worker.fetch(request(), env);
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { ok: true, duplicate: true });
    assert.equal(telegramCalls.length, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM channel_updates").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM channel_messages").get().count, 2);
    assert.equal(sqlite.prepare(
      "SELECT processing_status FROM channel_updates WHERE external_update_id = '501'"
    ).get().processing_status, "processed");
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test("authorized /inbox request invokes Workers AI when all free-plan gates are enabled", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const originalFetch = globalThis.fetch;
  const telegramMessages = [];
  const messageBody = "Please send the revised contract by Thursday.";
  const encodedBody = btoa(messageBody)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  let aiCalls = 0;
  let aiPrompt = "";
  globalThis.fetch = async (url, options) => {
    const requestUrl = String(url);
    if (requestUrl.includes("api.telegram.org")) {
      telegramMessages.push(JSON.parse(options.body));
      return Response.json({ ok: true, result: { message_id: 992 } });
    }
    if (requestUrl === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "gmail-ai-access", expires_in: 3600 });
    }
    if (requestUrl.includes("/users/me/profile")) {
      return Response.json({ emailAddress: "me@example.test" });
    }
    if (requestUrl.includes("/users/me/threads?")) {
      return Response.json({ threads: [{ id: "ai-thread" }] });
    }
    if (requestUrl.includes("/threads/ai-thread?")) {
      return Response.json({
        id: "ai-thread",
        messages: [{
          id: "ai-unread-message",
          internalDate: "1795435200000",
          labelIds: ["INBOX", "UNREAD"],
          payload: { headers: [
            { name: "From", value: "Alex <alex@example.test>" },
            { name: "Subject", value: "Revised contract" },
            { name: "Date", value: "Mon, 23 Nov 2026 10:00:00 +0200" }
          ] }
        }]
      });
    }
    if (requestUrl.includes("/users/me/messages/ai-unread-message?")) {
      return Response.json({
        payload: { mimeType: "text/plain", body: { data: encodedBody } }
      });
    }
    throw new Error("Unexpected request in /inbox AI integration test.");
  };
  const env = {
    DB: d1,
    DEPLOYMENT_STAGE: "production",
    ASSISTANT_ENABLED: "true",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    TELEGRAM_BOT_TOKEN: "bot-secret",
    AUTHORIZED_TELEGRAM_USER_ID: "900",
    GOOGLE_GMAIL_READ_ENABLED: "true",
    GOOGLE_OAUTH_CLIENT_ID: "gmail-client",
    GOOGLE_OAUTH_CLIENT_SECRET: "gmail-client-secret",
    GOOGLE_OAUTH_REFRESH_TOKEN: "gmail-refresh-secret",
    AI_ENABLED: "true",
    AI_FREE_PLAN_CONFIRMED: "true",
    GMAIL_AI_ANALYSIS_ENABLED: "true",
    AI_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    AI_DAILY_NEURON_LIMIT: "5000",
    AI: {
      async run(model, input) {
        aiCalls++;
        aiPrompt = input.prompt;
        assert.equal(model, env.AI_MODEL);
        return {
          response: {
            followUps: [{
              threadId: "ai-thread",
              actionType: "provide_information",
              evidenceQuote: "send the revised contract",
              deadlineEvidence: "by Thursday"
            }]
          }
        };
      }
    }
  };
  const request = new Request("https://worker.test/webhooks/telegram", {
    method: "POST",
    headers: {
      "X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      update_id: 990,
      message: {
        message_id: 990,
        text: "/inbox",
        chat: { id: 700 },
        from: { id: 900 }
      }
    })
  });

  try {
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(aiCalls, 1);
    assert.match(aiPrompt, /Please send the revised contract by Thursday/);
    assert.match(telegramMessages[0].text, /Potential follow-ups/);
    assert.match(telegramMessages[0].text, /send the revised contract/);
    assert.equal(
      telegramMessages[0].reply_markup.inline_keyboard[0][0].callback_data,
      "gmail_followup_task|ai-thread"
    );
    assert.doesNotMatch(
      JSON.stringify(sqlite.prepare("SELECT content FROM channel_messages").all()),
      /Please send the revised contract/
    );
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test("Worker reports unavailable Google integration without claiming success", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const originalFetch = globalThis.fetch;
  const telegramMessages = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    telegramMessages.push(body.text);
    return Response.json({ ok: true, result: { message_id: 700 } });
  };
  const update = {
    update_id: 703,
    message: {
      message_id: 704,
      text: "/today",
      chat: { id: 700 },
      from: { id: 900 }
    }
  };
  try {
    const response = await worker.fetch(new Request("https://worker.test/webhooks/telegram", {
      method: "POST",
      headers: {
        "X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(update)
    }), {
      DB: d1,
      DEPLOYMENT_STAGE: "production",
      ASSISTANT_ENABLED: "true",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      TELEGRAM_BOT_TOKEN: "bot-secret",
      AUTHORIZED_TELEGRAM_USER_ID: "900"
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, needsAttention: true });
    assert.equal(telegramMessages.length, 1);
    assert.match(telegramMessages[0], /couldn't complete that request/);
    assert.equal(sqlite.prepare(
      "SELECT processing_status FROM channel_updates WHERE external_update_id = '703'"
    ).get().processing_status, "processed_with_error");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM system_logs").get().count, 1);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test("explicit task-completion callback is acknowledged before Google Tasks is updated", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const originalFetch = globalThis.fetch;
  const order = [];
  sqlite.prepare(
    `INSERT INTO tasks (
       id, google_task_id, title, description, status, priority, created_at, updated_at
     ) VALUES ('task-record', 'google-task-complete', 'Finish outline', '', 'Pending',
               'Medium', '2026-11-22T09:00:00.000Z', '2026-11-22T09:00:00.000Z')`
  ).run();
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.includes("/answerCallbackQuery")) {
      order.push("callback-ack");
      return Response.json({ ok: true, result: true });
    }
    if (target === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "completion-access-token", expires_in: 3600 });
    }
    if (target.includes("tasks.googleapis.com") && options.method === "PATCH") {
      order.push("google-task-update");
      return Response.json({
        id: "google-task-complete",
        title: "Finish outline",
        status: "completed",
        completed: "2026-11-22T10:00:00.000Z"
      });
    }
    if (target.includes("/editMessageText")) {
      order.push("telegram-edit");
      return Response.json({
        ok: false,
        description: "Bad Request: message to edit not found"
      }, { status: 400 });
    }
    if (target.includes("/sendMessage")) {
      order.push("telegram-response");
      return Response.json({ ok: true, result: { message_id: 902 } });
    }
    throw new Error("Unexpected network request in test.");
  };

  const update = {
    update_id: 902,
    callback_query: {
      id: "callback-complete",
      data: "task_complete|google-task-complete",
      from: { id: 900 },
      message: { message_id: 901, chat: { id: 700 } }
    }
  };
  try {
    const response = await worker.fetch(new Request("https://worker.test/webhooks/telegram", {
      method: "POST",
      headers: {
        "X-Telegram-Bot-Api-Secret-Token": "webhook-secret",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(update)
    }), {
      DB: d1,
      DEPLOYMENT_STAGE: "production",
      ASSISTANT_ENABLED: "true",
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
      TELEGRAM_BOT_TOKEN: "bot-secret",
      AUTHORIZED_TELEGRAM_USER_ID: "900",
      GOOGLE_OAUTH_CLIENT_ID: "callback-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "callback-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "callback-refresh",
      GOOGLE_TASK_LIST_ID: "task-list"
    });

    assert.equal(response.status, 200);
    assert.ok(order.indexOf("callback-ack") < order.indexOf("google-task-update"));
    assert.ok(order.includes("telegram-edit"));
    assert.ok(order.includes("telegram-response"));
    assert.equal(sqlite.prepare("SELECT status FROM tasks WHERE id = 'task-record'").get().status, "Completed");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM task_history").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM channel_actions").get().count, 1);
    const fallbackLog = sqlite.prepare(
      `SELECT severity, event_type FROM system_logs
        WHERE description = 'Telegram message edit failed; sent a new message'`
    ).get();
    assert.equal(fallbackLog.severity, "WARN");
    assert.equal(fallbackLog.event_type, "Message edit fallback");
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test("guided task capture records a Google Task and Top 3 outcome idempotently", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const user = await getOrCreateChannelUser(d1, "telegram", "capture-user", "2026-11-22T10:00:00.000Z");
  const now = new Date("2026-11-22T10:00:00.000Z");
  const createdTasks = [];
  let simulateLostCreateResponse = true;
  const googleTasks = {
    async create(title, notes, dueDate) {
      const task = {
        id: "created-task-1",
        title,
        notes,
        due: dueDate ? `${dueDate}T00:00:00.000Z` : undefined,
        status: "needsAction"
      };
      createdTasks.push(task);
      if (simulateLostCreateResponse) {
        simulateLostCreateResponse = false;
        throw new Error("Google request response was interrupted.");
      }
      return task;
    },
    async listAll() {
      return createdTasks;
    }
  };
  const send = async (update, text) => handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate(update),
    googleTasks,
    now
  });
  const messageUpdate = (updateId, messageId, text) => ({
    update_id: updateId,
    message: {
      message_id: messageId,
      text,
      chat: { id: 700 },
      from: { id: 900 }
    }
  });
  const callbackUpdate = (updateId, callbackId, action) => ({
    update_id: updateId,
    callback_query: {
      id: callbackId,
      data: action,
      from: { id: 900 },
      message: { message_id: updateId, chat: { id: 700 } }
    }
  });

  assert.equal((await send(messageUpdate(1, 1, "/addtask"))).inputMode, "force_reply");
  assert.match((await send(messageUpdate(2, 2, "Prepare weekly report"))).title, /Choose an area/);
  assert.match((await send(callbackUpdate(3, "area", "task_area|DEEP"))).title, /Choose priority/);
  assert.match((await send(callbackUpdate(4, "priority", "task_priority|High"))).title, /When is this due/);
  assert.match((await send(callbackUpdate(5, "due", "task_due|tomorrow"))).title, /What would count as done/);
  assert.match((await send(messageUpdate(6, 6, "Draft and send the report"))).title, /Top 3/);

  await assert.rejects(
    () => send(callbackUpdate(7, "top3-first", "task_top3|yes")),
    /response was interrupted/
  );
  const recovered = await send(callbackUpdate(8, "top3-retry", "task_top3|yes"));
  assert.match(recovered.title, /Task added/);
  assert.equal(createdTasks.length, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM task_history").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM daily_outcomes").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM mini_app_requests WHERE status = 'Created'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM conversations").get().count, 0);

  const task = sqlite.prepare("SELECT area, priority, due_date, description FROM tasks").get();
  assert.equal(task.area, "DEEP");
  assert.equal(task.priority, "High");
  assert.equal(task.due_date, "2026-11-23");
  assert.match(task.description, /Draft and send the report/);
  sqlite.close();
});

test("daily outcome focus flow creates a task and records explicit outcome decisions", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const user = await getOrCreateChannelUser(d1, "telegram", "outcome-user", "2026-11-22T10:00:00.000Z");
  const now = new Date("2026-11-22T10:00:00.000Z");
  const googleTasksData = [];
  const completedIds = [];
  const googleTasks = {
    async create(title, notes, dueDate) {
      const task = {
        id: "outcome-task-1",
        title,
        notes,
        due: `${dueDate}T00:00:00.000Z`,
        status: "needsAction"
      };
      googleTasksData.push(task);
      return task;
    },
    async complete(taskId) {
      completedIds.push(taskId);
      const task = googleTasksData.find(item => item.id === taskId);
      task.status = "completed";
      task.completed = "2026-11-22T10:30:00.000Z";
      return task;
    },
    async reschedule(taskId, dueDate) {
      const task = googleTasksData.find(item => item.id === taskId);
      task.due = `${dueDate}T00:00:00.000Z`;
      return task;
    },
    async listAll() {
      return googleTasksData;
    }
  };
  const send = async (update, text) => handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate(update),
    googleTasks,
    now
  });
  const messageUpdate = (updateId, text) => ({
    update_id: updateId,
    message: {
      message_id: updateId,
      text,
      chat: { id: 700 },
      from: { id: 900 }
    }
  });
  const callbackUpdate = (updateId, action) => ({
    update_id: updateId,
    callback_query: {
      id: `outcome-callback-${updateId}`,
      data: action,
      from: { id: 900 },
      message: { message_id: updateId, chat: { id: 700 } }
    }
  });

  assert.equal((await send(callbackUpdate(1, "outcome_start|DEEP"))).inputMode, "force_reply");
  const focusPrompt = await send(messageUpdate(2, "Prepare a two-page research brief"));
  assert.match(focusPrompt.title, /Focus started/);
  assert.equal(focusPrompt.inputMode, "force_reply");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);
  assert.equal(sqlite.prepare("SELECT area, status FROM daily_outcomes").get().area, "DEEP");

  const durationPrompt = await send(messageUpdate(3, "Draft the first two sections"));
  assert.match(durationPrompt.title, /Choose a focus block/);
  assert.equal(durationPrompt.actions[0][0].action, "focus_duration|2026-11-22|DEEP|25");
  const selectedDuration = await send(callbackUpdate(4, "focus_duration|2026-11-22|DEEP|25"));
  assert.match(selectedDuration.title, /25-minute/);
  assert.match(selectedDuration.sections[0].lines[1], /follow up around/);
  const focusSession = sqlite.prepare("SELECT id, followup_status FROM focus_sessions").get();
  assert.equal(focusSession.followup_status, "Scheduled");
  assert.equal(
    sqlite.prepare("SELECT due_at FROM focus_sessions").get().due_at,
    "2026-11-22T10:25:00.000Z"
  );

  const sentFollowups = [];
  const scheduler = {
    async sendAssistantResponse(chatId, assistantResponse) {
      sentFollowups.push({ chatId, assistantResponse });
      return { message_id: 990 };
    }
  };
  const followup = await processDueFocusSessions({
    db: d1,
    telegram: scheduler,
    now: new Date("2026-11-22T10:25:00.000Z")
  });
  assert.deepEqual(followup, { sent: 1, considered: 1 });
  assert.equal(sentFollowups[0].chatId, "700");
  assert.equal(sentFollowups[0].assistantResponse.actions[1][1].action, `focus|${focusSession.id}|Reschedule`);
  assert.equal(
    sqlite.prepare("SELECT followup_status FROM focus_sessions").get().followup_status,
    "Sent"
  );
  assert.deepEqual(
    await processDueFocusSessions({
      db: d1,
      telegram: scheduler,
      now: new Date("2026-11-22T10:26:00.000Z")
    }),
    { sent: 0, considered: 0 }
  );
  assert.equal(sentFollowups.length, 1);

  const focusPartial = await send(callbackUpdate(5, `focus|${focusSession.id}|Partial`));
  assert.match(focusPartial.title, /partly done/);
  assert.equal(
    sqlite.prepare("SELECT response_status FROM focus_sessions").get().response_status,
    "Partial"
  );

  await recordFocusSession(d1, {
    id: "FOCUS-reschedule-1",
    userId: user.id,
    chatId: "700",
    date: "2026-11-22",
    area: "DEEP",
    googleTaskId: "outcome-task-1",
    nextAction: "Draft the first two sections",
    durationMinutes: 25,
    startedAt: "2026-11-22T10:00:00.000Z",
    dueAt: "2026-11-22T10:25:00.000Z"
  });
  sqlite.prepare(
    "UPDATE focus_sessions SET followup_status = 'Sent' WHERE id = 'FOCUS-reschedule-1'"
  ).run();
  const reschedulePrompt = await send(callbackUpdate(6, "focus|FOCUS-reschedule-1|Reschedule"));
  assert.equal(reschedulePrompt.inputMode, "force_reply");
  assert.match(reschedulePrompt.sections[0].lines[1], /Calendar block is not created/);
  const rescheduled = await send(messageUpdate(7, "2026-11-24"));
  assert.match(rescheduled.title, /Task due date moved/);
  assert.equal(
    sqlite.prepare("SELECT due_date FROM tasks WHERE google_task_id = 'outcome-task-1'").get().due_date,
    "2026-11-24"
  );
  assert.equal(
    sqlite.prepare("SELECT response_status FROM focus_sessions WHERE id = 'FOCUS-reschedule-1'").get().response_status,
    "Rescheduled"
  );

  const partial = await send(callbackUpdate(8, "outcome_status|2026-11-22|DEEP|Partial"));
  assert.match(partial.title, /partly done/);
  assert.equal(completedIds.length, 0);

  const blocked = await send(callbackUpdate(9, "outcome_status|2026-11-22|DEEP|Blocked"));
  assert.match(blocked.title, /blocking it/);
  await send(callbackUpdate(10, "outcome_block_reason|2026-11-22|DEEP|energy"));
  const completed = await send(callbackUpdate(11, "outcome_status|2026-11-22|DEEP|Completed"));
  assert.match(completed.title, /marked done/);
  assert.deepEqual(completedIds, ["outcome-task-1"]);
  assert.equal(
    sqlite.prepare("SELECT status FROM daily_outcomes ORDER BY rowid DESC LIMIT 1").get().status,
    "Completed"
  );
  assert.equal(
    sqlite.prepare("SELECT status FROM tasks WHERE google_task_id = 'outcome-task-1'").get().status,
    "Completed"
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM task_history").get().count, 3);
  sqlite.close();
});

test("focus scheduler expires stale sessions and stays disabled without both gates", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const user = await getOrCreateChannelUser(d1, "telegram", "scheduler-user", "2026-11-22T09:00:00.000Z");
  await recordFocusSession(d1, {
    id: "FOCUS-stale",
    userId: user.id,
    chatId: "700",
    date: "2026-11-22",
    area: "LIFE",
    nextAction: "Take a walk",
    durationMinutes: 25,
    startedAt: "2026-11-22T09:00:00.000Z",
    dueAt: "2026-11-22T09:29:00.000Z"
  });
  await recordFocusSession(d1, {
    id: "FOCUS-future",
    userId: user.id,
    chatId: "700",
    date: "2026-11-22",
    area: "WORK",
    nextAction: "Review call notes",
    durationMinutes: 25,
    startedAt: "2026-11-22T09:50:00.000Z",
    dueAt: "2026-11-22T10:15:00.000Z"
  });
  const sends = [];
  const result = await processDueFocusSessions({
    db: d1,
    telegram: {
      async sendAssistantResponse(chatId, message) {
        sends.push({ chatId, message });
        return { message_id: 123 };
      }
    },
    now: new Date("2026-11-22T10:00:00.000Z")
  });
  assert.deepEqual(result, { sent: 0, considered: 0 });
  assert.equal(sends.length, 0);
  assert.equal(
    sqlite.prepare("SELECT followup_status FROM focus_sessions WHERE id = 'FOCUS-stale'").get().followup_status,
    "Expired"
  );
  assert.equal(
    sqlite.prepare("SELECT followup_status FROM focus_sessions WHERE id = 'FOCUS-future'").get().followup_status,
    "Scheduled"
  );

  await recordFocusSession(d1, {
    id: "FOCUS-cron-send",
    userId: user.id,
    chatId: "700",
    date: "2026-11-22",
    area: "DEEP",
    nextAction: "Write the first paragraph",
    durationMinutes: 25,
    startedAt: "2026-11-22T09:30:00.000Z",
    dueAt: "2026-11-22T09:55:00.000Z"
  });
  const originalFetch = globalThis.fetch;
  const telegramSends = [];
  globalThis.fetch = async (url, options) => {
    telegramSends.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json({ ok: true, result: { message_id: 124 } });
  };
  try {
    const scheduled = await worker.scheduled(
      { scheduledTime: Date.parse("2026-11-22T10:00:00.000Z") },
      {
        DB: d1,
        DEPLOYMENT_STAGE: "staging",
        ASSISTANT_ENABLED: "true",
        SCHEDULED_JOBS_ENABLED: "true",
        TELEGRAM_BOT_TOKEN: "test-bot-token"
      }
    );
    assert.deepEqual(scheduled, {
      focus: { sent: 1, considered: 1 },
      pulses: { sent: 0, skipped: 0, ignored: 0 },
      userReminders: { sent: 0, snoozed: 0, missed: 0, uncertain: 0 },
      companion: { sent: 0, ignored: 0, cared: 0 },
      rhythm: { sent: 0, skipped: 0 },
      reports: { generated: 0, sent: 0, skipped: 0 },
      escalations: { sent: 0, skipped: 0, failed: 0 },
      calendarReminders: { sent: 0, skipped: 0, failed: 0 },
      taskReminders: { sent: 0, skipped: 0, failed: 0 }
    });
    assert.match(telegramSends[0].url, /\/sendMessage$/);
    assert.equal(telegramSends[0].body.chat_id, "700");
    assert.equal(
      sqlite.prepare("SELECT followup_status FROM focus_sessions WHERE id = 'FOCUS-cron-send'").get().followup_status,
      "Sent"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const skipped = await worker.scheduled(
    { scheduledTime: Date.parse("2026-11-22T10:00:00.000Z") },
    { DEPLOYMENT_STAGE: "staging", SCHEDULED_JOBS_ENABLED: "false" }
  );
  assert.deepEqual(skipped, { skipped: true, reason: "Scheduled jobs are disabled." });
  sqlite.close();
});

test("next-day planning creates three linked Tasks and recovers uncertain creates without duplicates", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const user = await getOrCreateChannelUser(d1, "telegram", "planning-user", "2026-11-22T10:00:00.000Z");
  const now = new Date("2026-11-22T10:00:00.000Z");
  const createdTasks = [];
  let interruptedWorkCreate = true;
  const googleTasks = {
    async create(title, notes, dueDate) {
      const task = {
        id: `google-${createdTasks.length + 1}`,
        title,
        notes,
        due: `${dueDate}T00:00:00.000Z`,
        status: "needsAction"
      };
      createdTasks.push(task);
      if (title === "Prepare outreach hypotheses" && interruptedWorkCreate) {
        interruptedWorkCreate = false;
        throw new Error("Google task response was interrupted.");
      }
      return task;
    },
    async listAll() {
      return createdTasks;
    }
  };
  const send = async (update, text) => handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate(update),
    googleTasks,
    now
  });
  const messageUpdate = (updateId, text) => ({
    update_id: updateId,
    message: {
      message_id: updateId,
      text,
      chat: { id: 700 },
      from: { id: 900 }
    }
  });
  const callbackUpdate = (updateId, action) => ({
    update_id: updateId,
    callback_query: {
      id: `planning-callback-${updateId}`,
      data: action,
      from: { id: 900 },
      message: { message_id: updateId, chat: { id: 700 } }
    }
  });

  assert.equal((await send(callbackUpdate(1, "plan_next_day_now"))).inputMode, "force_reply");
  assert.match((await send(messageUpdate(2, "Finished the onboarding notes"))).title, /2\/5/);
  assert.match((await send(messageUpdate(3, "Complete two chapters"))).title, /3\/5/);
  assert.match((await send(messageUpdate(4, "Prepare outreach hypotheses"))).title, /4\/5/);
  assert.match((await send(messageUpdate(5, "Take a 30-minute walk"))).title, /5\/5/);
  await assert.rejects(
    () => send(messageUpdate(6, "Low energy after the shift")),
    /response was interrupted/
  );
  const planned = await send(messageUpdate(7, "Low energy after the shift"));
  assert.match(planned.title, /Tomorrow has a clear shape/);
  assert.equal(createdTasks.length, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM task_history").get().count, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM daily_outcomes").get().count, 3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM review_notes").get().count, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM conversations").get().count, 0);

  const outcomes = sqlite.prepare(
    "SELECT area, outcome, status, google_task_id FROM daily_outcomes ORDER BY area"
  ).all().map(row => ({ ...row }));
  assert.deepEqual(outcomes, [
    { area: "DEEP", outcome: "Complete two chapters", status: "Planned", google_task_id: "google-1" },
    { area: "LIFE", outcome: "Take a 30-minute walk", status: "Planned", google_task_id: "google-3" },
    { area: "WORK", outcome: "Prepare outreach hypotheses", status: "Planned", google_task_id: "google-2" }
  ]);
  assert.ok(createdTasks.every(task => task.notes.includes("Low energy after the shift")));
  assert.ok(createdTasks.every(task => task.due === "2026-11-23T00:00:00.000Z"));
  assert.equal(
    sqlite.prepare("SELECT answer FROM review_notes WHERE question = 'RISK that could derail the day'").get().answer,
    "Low energy after the shift"
  );
  sqlite.close();
});

test("daily rhythm schedules planning, records its final checkpoint, and deduplicates sends", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const user = await getOrCreateChannelUser(d1, "telegram", "rhythm-user", "2026-11-22T21:00:00.000Z");
  await insertChannelMessage(d1, {
    channel: "telegram",
    conversationId: "700",
    externalMessageId: "rhythm-inbound",
    userId: user.id,
    direction: "incoming",
    type: "text",
    content: "/today",
    createdAt: "2026-11-22T21:00:00.000Z"
  });
  const sent = [];
  const telegram = {
    async sendAssistantResponse(chatId, message) {
      sent.push({ chatId, message });
      return { message_id: 501 + sent.length };
    }
  };
  const start = await processScheduledRhythm({
    db: d1,
    telegram,
    authorizedTelegramUserId: "rhythm-user",
    now: new Date("2026-11-22T21:15:00.000Z")
  });
  assert.deepEqual(start, { sent: 1, skipped: 0 });
  assert.match(sent[0].message.title, /Night wrap/);
  assert.equal(sent[0].chatId, "700");
  assert.deepEqual(
    await processScheduledRhythm({
      db: d1,
      telegram,
      authorizedTelegramUserId: "rhythm-user",
      now: new Date("2026-11-22T21:15:00.000Z")
    }),
    { sent: 0, skipped: 1 }
  );

  const confirmation = await handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: 601,
      callback_query: {
        id: "confirm-plan-601",
        data: "plan_confirm_date|2026-11-23",
        from: { id: "rhythm-user" },
        message: { message_id: 501, chat: { id: "700" } }
      }
    }),
    googleTasks: null,
    now: new Date("2026-11-22T22:03:00.000Z")
  });
  assert.match(confirmation.title, /Plan confirmed/);
  assert.equal(
    sqlite.prepare("SELECT planning_completed FROM daily_reviews WHERE review_date = '2026-11-23'").get().planning_completed,
    1
  );
  assert.deepEqual(
    await processScheduledRhythm({
      db: d1,
      telegram,
      authorizedTelegramUserId: "rhythm-user",
      now: new Date("2026-11-22T22:20:00.000Z")
    }),
    { sent: 0, skipped: 0 }
  );
  assert.equal(sent.length, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM scheduled_job_runs").get().count, 1);
  sqlite.close();
});

test("weekly review records the five guided reflection answers", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-22T10:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "weekly-user", now.toISOString());
  const send = (updateId, text) => handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        text,
        chat: { id: "weekly-chat" },
        from: { id: "weekly-user" }
      }
    }, now.toISOString()),
    googleTasks: null,
    now
  });

  assert.match((await send(1, "/weekly")).title, /Weekly review 1\/5/);
  const answers = [
    "DEEP 4 days, WORK 5, LIFE 3; clearer after planning.",
    "Low energy after work.",
    "Schedule the paperwork.",
    "Try a 25-minute start before checking messages.",
    "Review the language-learning project."
  ];
  let result;
  for (let index = 0; index < answers.length; index++) {
    result = await send(index + 2, answers[index]);
  }

  assert.match(result.title, /Weekly reflection saved/);
  const notes = sqlite.prepare(
    "SELECT review_type, review_date, question, answer FROM review_notes ORDER BY id"
  ).all();
  assert.equal(notes.length, 5);
  assert.ok(notes.every(note => note.review_type === "Weekly" && note.review_date === "2026-11-22"));
  assert.equal(notes[1].answer, answers[1]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM conversations").get().count, 0);
  sqlite.close();
});

test("monthly project review requires a decision, reason, and future review date", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-22T10:00:00.000Z");
  const user = await getOrCreateChannelUser(d1, "telegram", "monthly-user", now.toISOString());
  const sendText = (updateId, text) => handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: updateId,
      message: {
        message_id: updateId,
        text,
        chat: { id: "monthly-chat" },
        from: { id: "monthly-user" }
      }
    }, now.toISOString()),
    googleTasks: null,
    now
  });
  const sendAction = (updateId, action) => handleAssistantMessage({
    db: d1,
    user,
    message: adaptTelegramUpdate({
      update_id: updateId,
      callback_query: {
        id: `monthly-action-${updateId}`,
        data: action,
        from: { id: "monthly-user" },
        message: { message_id: updateId, chat: { id: "monthly-chat" } }
      }
    }, now.toISOString()),
    googleTasks: null,
    now
  });

  assert.match((await sendText(1, "/monthly")).title, /Choose a project/);
  assert.match((await sendText(2, "Language-learning project")).title, /Language-learning project/);
  assert.match((await sendAction(3, "monthly_decision|pause")).title, /Record the decision reason/);
  assert.match((await sendText(4, "Pause until work schedule is stable.")).title, /Set a review date/);
  const invalidDate = await sendText(5, "2026-11-20");
  assert.match(invalidDate.sections[0].lines[0], /future date like 11\/25\/2026/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM review_notes").get().count, 0);
  const result = await sendText(6, "2026-12-15");

  assert.match(result.title, /Project decision recorded/);
  assert.match(result.sections[0].lines[0], /pause/);
  const note = sqlite.prepare(
    "SELECT review_type, question, answer, related_area FROM review_notes"
  ).get();
  assert.equal(note.review_type, "Monthly project decision");
  assert.equal(note.question, "pause: Language-learning project; review date 2026-12-15");
  assert.equal(note.answer, "Pause until work schedule is stable.");
  assert.equal(note.related_area, "Language-learning project");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM conversations").get().count, 0);
  sqlite.close();
});

test("scheduled weekly and monthly reports save D1 snapshots and send at most once", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const reportUser = await getOrCreateChannelUser(d1, "telegram", "report-user", "2026-11-24T10:00:00.000Z");
  const goalId = await createGoal(d1, reportUser.id, {
    level: "quarterly",
    title: "Publish the portfolio",
    description: "Create a body of work.",
    category: "Career",
    whyMatters: "Build professional opportunities.",
    targetOutcome: "A published portfolio.",
    startDate: "2026-11-24",
    deadline: "2027-02-01",
    nextAction: "Choose the first project.",
    keyResults: [{
      title: "Published projects",
      baselineValue: 0,
      targetValue: 4,
      unit: "projects"
    }]
  }, "2026-11-24T10:00:00.000Z");
  const keyResult = sqlite.prepare(
    "SELECT id FROM goal_key_results WHERE goal_id = ?1"
  ).get(goalId);
  await updateGoalKeyResult(
    d1,
    reportUser.id,
    goalId,
    keyResult.id,
    2,
    "2026-11-25T10:00:00.000Z"
  );
  await upsertGoogleTaskMirror(d1, {
    id: "report-completed-task",
    title: "Complete report",
    status: "completed",
    completed: "2026-11-27T14:00:00.000Z",
    due: "2026-11-27T00:00:00.000Z"
  }, "2026-11-25T10:00:00.000Z");
  await upsertGoogleTaskMirror(d1, {
    id: "report-overdue-task",
    title: "Renew insurance",
    status: "needsAction",
    due: "2026-11-28T00:00:00.000Z"
  }, "2026-11-25T10:00:00.000Z");
  const goalTask = await upsertGoogleTaskMirror(d1, {
    id: "report-goal-task",
    title: "Publish portfolio sample",
    status: "needsAction",
    due: "2026-12-02T00:00:00.000Z"
  }, "2026-11-25T10:00:00.000Z");
  await d1.prepare(
    `INSERT INTO goal_task_links (goal_id, task_id, linked_at)
     VALUES (?1, ?2, ?3)`
  ).bind(goalId, goalTask.id, "2026-11-25T10:00:00.000Z").run();
  await upsertGoogleTaskMirror(d1, {
    id: "report-high-task",
    title: "Send client proposal",
    status: "needsAction"
  }, "2026-11-25T10:00:00.000Z", { priority: "High" });
  await upsertGoogleTaskMirror(d1, {
    id: "report-postponed-task",
    title: "Review draft",
    status: "needsAction"
  }, "2026-11-25T10:00:00.000Z");
  await d1.prepare(
    "UPDATE tasks SET postponement_count = 3 WHERE google_task_id = 'report-postponed-task'"
  ).run();
  await upsertGoogleTaskMirror(d1, {
    id: "report-low-task",
    title: "Browse new stationery",
    status: "needsAction"
  }, "2026-11-25T10:00:00.000Z", { priority: "Low" });
  await d1.prepare(
    `INSERT INTO daily_reviews (review_date, planning_completed, accountability_score)
     VALUES ('2026-11-23', 1, 80)`
  ).run();
  await d1.prepare(
    `INSERT INTO accountability_routines (
       id, name, frequency, scheduled_time, active_status
     ) VALUES ('ROUTINE-TRELLO', 'Trello updates', 'Daily', '18:00', 'Active')`
  ).run();
  await d1.prepare(
    `INSERT INTO accountability_checkins (
       id, routine_id, activity_date, status
     ) VALUES ('checkin-report-1', 'ROUTINE-TRELLO', '2026-11-23', 'Completed')`
  ).run();

  const sent = [];
  const googleTasks = {
    async listAll() {
      return [{
        id: "report-completed-task",
        title: "Complete report",
        status: "completed",
        completed: "2026-11-27T14:00:00.000Z",
        due: "2026-11-27T00:00:00.000Z"
      }];
    }
  };
  const gmail = {
    async sendText(message) {
      sent.push(message);
      return { id: `gmail-report-${sent.length}` };
    }
  };
  const aiReviewCalls = [];
  const aiReviewRecommendations = async ({ report, metrics }) => {
    aiReviewCalls.push(report.type);
    assert.ok(metrics.planning < 80);
    return ["planning_rhythm"];
  };
  const weeklyNow = new Date("2026-11-27T16:00:00.000Z");
  const weekly = await processScheduledReports({
    db: d1,
    googleTasks,
    gmail,
    recipient: "account@example.test",
    aiReviewRecommendations,
    now: weeklyNow
  });
  assert.deepEqual(weekly, { generated: 1, sent: 1, skipped: 0 });
  assert.match(sent[0].subject, /Weekly productivity review/);
  assert.match(sent[0].body, /Tasks created \/ completed: 6 \/ 1/);
  assert.match(sent[0].body, /Quarterly objective: Publish the portfolio — 50%; 1 measurement update/);
  assert.match(sent[0].body, /Top priorities for next week \(2026-11-30 to 2026-12-06; suggestions, not scheduled\)/);
  assert.match(sent[0].body, /1\. Renew insurance — due 2026-11-28/);
  assert.match(sent[0].body, /2\. Publish portfolio sample — due 2026-12-02; supports Publish the portfolio/);
  assert.match(sent[0].body, /3\. Send client proposal — high priority/);
  assert.doesNotMatch(sent[0].body, /Browse new stationery/);
  assert.match(sent[0].body, /AI-ranked evidence-based suggestions/);
  assert.match(sent[0].body, /Protect a short, realistic planning block/);
  assert.equal(
    sqlite.prepare("SELECT tasks_completed, recommendations FROM weekly_reviews WHERE week_starting_date = '2026-11-23'").get().tasks_completed,
    1
  );
  assert.match(sqlite.prepare(
    "SELECT recommendations FROM weekly_reviews WHERE week_starting_date = '2026-11-23'"
  ).get().recommendations, /AI-ranked: Protect a short, realistic planning block/);
  assert.deepEqual(await processScheduledReports({
    db: d1,
    googleTasks,
    gmail,
    recipient: "account@example.test",
    aiReviewRecommendations,
    now: weeklyNow
  }), { generated: 0, sent: 0, skipped: 1 });
  assert.equal(sent.length, 1);

  const monthly = await processScheduledReports({
    db: d1,
    googleTasks,
    gmail,
    recipient: "account@example.test",
    aiReviewRecommendations,
    now: new Date("2026-11-01T16:00:00.000Z")
  });
  assert.deepEqual(monthly, { generated: 1, sent: 1, skipped: 0 });
  assert.equal(
    sqlite.prepare("SELECT month FROM monthly_reviews").get().month,
    "2026-10"
  );
  assert.equal(sent.length, 2);
  assert.deepEqual(aiReviewCalls, ["weekly", "monthly"]);
  sqlite.close();
});

test("scheduled reports fall back to deterministic content when AI review fails", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const sent = [];
  const result = await processScheduledReports({
    db: d1,
    googleTasks: { async listAll() { return []; } },
    gmail: {
      async sendText(message) {
        sent.push(message);
        return { id: "deterministic-report" };
      }
    },
    recipient: "account@example.test",
    aiReviewRecommendations: async () => {
      throw new Error("Inference unavailable");
    },
    now: new Date("2026-11-27T16:00:00.000Z")
  });
  assert.deepEqual(result, { generated: 1, sent: 1, skipped: 0 });
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /Weekly productivity review/);
  assert.doesNotMatch(sent[0].body, /AI-ranked evidence-based suggestions/);
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM system_logs WHERE event_type = 'AI review unavailable'"
  ).get().count, 1);
  sqlite.close();
});

test("email escalations target only reminded, overdue high-priority tasks and deduplicate sends", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-25T10:00:00.000Z");
  const high = await upsertGoogleTaskMirror(d1, {
    id: "escalation-high",
    title: "Send proposal",
    status: "needsAction",
    due: "2026-11-23T00:00:00.000Z"
  }, "2026-11-20T10:00:00.000Z", { priority: "High" });
  await upsertGoogleTaskMirror(d1, {
    id: "escalation-no-reminder",
    title: "No prior reminder",
    status: "needsAction",
    due: "2026-11-22T00:00:00.000Z"
  }, "2026-11-20T10:00:00.000Z", { priority: "High" });
  await upsertGoogleTaskMirror(d1, {
    id: "escalation-medium",
    title: "Medium priority",
    status: "needsAction",
    due: "2026-11-22T00:00:00.000Z"
  }, "2026-11-20T10:00:00.000Z", { priority: "Medium" });
  await d1.prepare(
    `INSERT INTO reminder_history (
       id, category, related_record_id, delivery_status
     ) VALUES ('prior-task-reminder', 'Overdue task', ?1, 'Sent')`
  ).bind(high.id).run();

  const sent = [];
  const googleTasks = {
    async listAll() {
      return [
        { id: "escalation-high", title: "Send proposal", status: "needsAction", due: "2026-11-23T00:00:00.000Z" },
        { id: "escalation-no-reminder", title: "No prior reminder", status: "needsAction", due: "2026-11-22T00:00:00.000Z" },
        { id: "escalation-medium", title: "Medium priority", status: "needsAction", due: "2026-11-22T00:00:00.000Z" }
      ];
    }
  };
  const gmail = {
    async sendText(message) {
      sent.push(message);
      return { id: "escalation-email-1" };
    }
  };
  const options = {
    db: d1,
    googleTasks,
    gmail,
    recipient: "account@example.test",
    now,
    enabled: true
  };

  assert.deepEqual(await processHighPriorityEscalations(options), {
    sent: 1, skipped: 1, failed: 0
  });
  assert.match(sent[0].subject, /Send proposal/);
  assert.match(sent[0].body, /Time overdue: 60 hours/);
  assert.equal(
    sqlite.prepare("SELECT delivery_result FROM email_escalations WHERE task_id = ?1").get(high.id).delivery_result,
    "Sent"
  );
  assert.equal(sqlite.prepare("SELECT status FROM tasks WHERE id = ?1").get(high.id).status, "Pending");
  assert.equal(sqlite.prepare("SELECT escalation_status FROM tasks WHERE id = ?1").get(high.id).escalation_status, "Escalated");
  assert.deepEqual(await processHighPriorityEscalations(options), {
    sent: 0, skipped: 1, failed: 0
  });
  assert.equal(sent.length, 1);
  sqlite.close();
});

test("missing escalation configuration is logged and skipped without aborting scheduled work", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const result = await processHighPriorityEscalations({
    db: d1,
    googleTasks: null,
    gmail: null,
    recipient: null,
    now: new Date("2026-11-25T10:00:00.000Z"),
    enabled: true
  });

  assert.deepEqual(result, { sent: 0, skipped: 0, failed: 1 });
  const log = sqlite.prepare(
    `SELECT event_type, error_message FROM system_logs
      WHERE component = 'Email escalation'`
  ).get();
  assert.equal(log.event_type, "Escalation not configured");
  assert.equal(
    log.error_message,
    "Missing: Google Tasks, Gmail, PRODUCTIVITY_EMAIL_RECIPIENT"
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM scheduled_job_runs").get().count, 0);
  sqlite.close();
});

test("Google Tasks escalation failure is recorded without aborting independent scheduled work", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async input => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({
        access_token: "scheduled-test-token",
        expires_in: 3600
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.startsWith("https://tasks.googleapis.com/")) {
      return new Response("{}", { status: 503 });
    }
    throw new Error("Unexpected scheduled integration request.");
  };
  try {
    const result = await handleScheduledEvent({
      scheduledTime: Date.parse("2026-11-23T12:00:00.000Z")
    }, {
      DB: d1,
      DEPLOYMENT_STAGE: "production",
      ASSISTANT_ENABLED: "true",
      SCHEDULED_JOBS_ENABLED: "true",
      TELEGRAM_WEBHOOK_CUTOVER_ENABLED: "false",
      TELEGRAM_BOT_TOKEN: "scheduled-test-telegram-token",
      GOOGLE_CALENDAR_ENABLED: "false",
      GOOGLE_GMAIL_ENABLED: "true",
      GOOGLE_OAUTH_CLIENT_ID: "scheduled-test-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "scheduled-test-secret",
      GOOGLE_OAUTH_REFRESH_TOKEN: "scheduled-test-refresh",
      GOOGLE_TASK_LIST_ID: "scheduled-test-list",
      PRODUCTIVITY_EMAIL_RECIPIENT: "recipient@example.test",
      EMAIL_ESCALATIONS_ENABLED: "true",
      CALENDAR_REMINDERS_ENABLED: "false",
      TASK_REMINDERS_ENABLED: "false",
      AI_ENABLED: "false"
    }, {});

    assert.deepEqual(result.escalations, { sent: 0, skipped: 0, failed: 1 });
    assert.deepEqual(result.calendarReminders, { sent: 0, skipped: 0, failed: 0 });
    assert.equal(requestedUrls.filter(url => url.startsWith("https://tasks.googleapis.com/")).length, 3);
    assert.equal(requestedUrls.some(url => url.startsWith("https://gmail.googleapis.com/")), false);
    assert.equal(
      sqlite.prepare(
        "SELECT status FROM scheduled_job_runs WHERE job_key LIKE 'email-escalations:%'"
      ).get().status,
      "Failed"
    );
    assert.equal(
      sqlite.prepare(
        "SELECT COUNT(*) AS count FROM system_logs WHERE component = 'Email escalation' AND event_type = 'Escalation cycle failed'"
      ).get().count,
      1
    );
    assert.equal(
      sqlite.prepare(
        "SELECT COUNT(*) AS count FROM system_logs WHERE component = 'Scheduler' AND event_type = 'Scheduled run failed'"
      ).get().count,
      0
    );
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test("uncertain email escalation is not automatically sent again", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const now = new Date("2026-11-25T10:00:00.000Z");
  const task = await upsertGoogleTaskMirror(d1, {
    id: "uncertain-escalation-task",
    title: "Review agreement",
    status: "needsAction",
    due: "2026-11-23T00:00:00.000Z"
  }, "2026-11-20T10:00:00.000Z", { priority: "High" });
  await d1.prepare(
    `INSERT INTO reminder_history (
       id, category, related_record_id, delivery_status
     ) VALUES ('uncertain-prior-reminder', 'Overdue task', ?1, 'Sent')`
  ).bind(task.id).run();

  let sendAttempts = 0;
  const options = {
    db: d1,
    googleTasks: {
      async listAll() {
        return [{
          id: "uncertain-escalation-task",
          title: "Review agreement",
          status: "needsAction",
          due: "2026-11-23T00:00:00.000Z"
        }];
      }
    },
    gmail: {
      async sendText() {
        sendAttempts++;
        const error = new Error("Gmail response was lost.");
        error.outcomeUncertain = true;
        throw error;
      }
    },
    recipient: "account@example.test",
    enabled: true
  };

  const first = await processHighPriorityEscalations({
    ...options,
    now: new Date("2026-11-25T10:00:00.000Z")
  });
  const second = await processHighPriorityEscalations({
    ...options,
    now: new Date("2026-11-25T12:00:00.000Z")
  });
  assert.deepEqual(first, { sent: 0, skipped: 0, failed: 1 });
  assert.deepEqual(second, { sent: 0, skipped: 1, failed: 0 });
  assert.equal(sendAttempts, 1);
  assert.equal(
    sqlite.prepare("SELECT delivery_result FROM email_escalations WHERE task_id = ?1").get(task.id).delivery_result,
    "Uncertain"
  );
  assert.equal(
    sqlite.prepare("SELECT escalation_status FROM tasks WHERE id = ?1").get(task.id).escalation_status,
    "Needs review"
  );
  sqlite.close();
});
