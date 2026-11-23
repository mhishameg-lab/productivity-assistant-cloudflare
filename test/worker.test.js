import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import { adaptTelegramUpdate, isAuthorizedTelegramWebhook } from "../src/channels/telegram.js";
import { resolveIntent } from "../src/core/intent.js";
import {
  claimChannelUpdate,
  finishChannelUpdate,
  getOrCreateChannelUser,
  insertChannelAction,
  insertChannelMessage
} from "../src/db/channel-repository.js";
import {
  listPendingTaskMirrors,
  syncGoogleTaskMirrors,
  upsertGoogleTaskMirror
} from "../src/db/google-tasks-repository.js";
import { createGoogleTasksClient } from "../src/integrations/google-tasks.js";
import { createGoogleCalendarClient } from "../src/integrations/google-calendar.js";
import { createGoogleGmailClient } from "../src/integrations/google-gmail.js";
import { createTelegramApi } from "../src/channels/telegram-api.js";
import { handleAssistantMessage } from "../src/core/assistant.js";
import {
  processDueFocusSessions,
  processScheduledRhythm,
  recordFocusSession
} from "../src/scheduled.js";
import { processScheduledReports } from "../src/reports.js";
import { processHighPriorityEscalations } from "../src/escalations.js";

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
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(initialSchema);
  sqlite.exec(focusSessionsMigration);
  sqlite.exec(calendarBlocksMigration);
  sqlite.exec("PRAGMA foreign_keys = ON;");
  return { sqlite, d1: new TestD1Database(sqlite) };
}

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
      start: "09:00",
      end: "09:50"
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
  sqlite.close();
});

test("scheduled morning briefing includes Calendar events when enabled", async () => {
  const { sqlite, d1 } = await createTestDatabase();
  const user = await getOrCreateChannelUser(d1, "telegram", "calendar-rhythm-user", "2026-11-22T05:00:00.000Z");
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
    now: new Date("2026-11-22T05:30:00.000Z"),
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
    assert.match(telegramMessages[0], /couldn't confirm that action/);
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
    assert.equal(sqlite.prepare("SELECT status FROM tasks WHERE id = 'task-record'").get().status, "Completed");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM task_history").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM channel_actions").get().count, 1);
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
      rhythm: { sent: 0, skipped: 0 },
      reports: { generated: 0, sent: 0, skipped: 0 },
      escalations: { sent: 0, skipped: 0, failed: 0 }
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
    now: new Date("2026-11-22T21:20:00.000Z")
  });
  assert.deepEqual(start, { sent: 1, skipped: 0 });
  assert.match(sent[0].message.title, /Plan tomorrow — 1\/5/);
  assert.equal(sent[0].chatId, "700");
  assert.equal(
    JSON.parse(sqlite.prepare("SELECT state_json FROM conversations WHERE user_id = ?1").get(user.id).state_json).type,
    "next_day_done"
  );
  assert.deepEqual(
    await processScheduledRhythm({
      db: d1,
      telegram,
      authorizedTelegramUserId: "rhythm-user",
      now: new Date("2026-11-22T21:20:00.000Z")
    }),
    { sent: 0, skipped: 1 }
  );

  const checkpoint = await processScheduledRhythm({
    db: d1,
    telegram,
    authorizedTelegramUserId: "rhythm-user",
    now: new Date("2026-11-22T22:00:00.000Z")
  });
  assert.deepEqual(checkpoint, { sent: 1, skipped: 0 });
  assert.match(sent[1].message.title, /Planning confirmation/);

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
    { sent: 0, skipped: 1 }
  );
  assert.equal(sent.length, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM scheduled_job_runs").get().count, 2);
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
  assert.match(invalidDate.sections[0].lines[0], /future date as YYYY-MM-DD/);
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
  await upsertGoogleTaskMirror(d1, {
    id: "report-completed-task",
    title: "Complete report",
    status: "completed",
    completed: "2026-11-27T14:00:00.000Z",
    due: "2026-11-27T00:00:00.000Z"
  }, "2026-11-25T10:00:00.000Z");
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
  const weeklyNow = new Date("2026-11-27T16:00:00.000Z");
  const weekly = await processScheduledReports({
    db: d1,
    googleTasks,
    gmail,
    recipient: "account@example.test",
    now: weeklyNow
  });
  assert.deepEqual(weekly, { generated: 1, sent: 1, skipped: 0 });
  assert.match(sent[0].subject, /Weekly productivity review/);
  assert.match(sent[0].body, /Tasks created \/ completed: 1 \/ 1/);
  assert.equal(
    sqlite.prepare("SELECT tasks_completed FROM weekly_reviews WHERE week_starting_date = '2026-11-23'").get().tasks_completed,
    1
  );
  assert.deepEqual(await processScheduledReports({
    db: d1,
    googleTasks,
    gmail,
    recipient: "account@example.test",
    now: weeklyNow
  }), { generated: 0, sent: 0, skipped: 1 });
  assert.equal(sent.length, 1);

  const monthly = await processScheduledReports({
    db: d1,
    googleTasks,
    gmail,
    recipient: "account@example.test",
    now: new Date("2026-11-01T16:00:00.000Z")
  });
  assert.deepEqual(monthly, { generated: 1, sent: 1, skipped: 0 });
  assert.equal(
    sqlite.prepare("SELECT month FROM monthly_reviews").get().month,
    "2026-10"
  );
  assert.equal(sent.length, 2);
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
