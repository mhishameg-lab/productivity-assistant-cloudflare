import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { adaptTelegramUpdate } from "../src/channels/telegram.js";
import { getOrCreateChannelUser } from "../src/db/channel-repository.js";
import { upsertGoogleTaskMirror } from "../src/db/google-tasks-repository.js";
import { handleAssistantMessage } from "../src/core/assistant.js";
import { processCompanion, startDive, startSleep } from "../src/companion.js";
import { processUserReminders } from "../src/user-reminders.js";
import { insertChannelMessage } from "../src/db/channel-repository.js";
import { parseWithWorkersAi, validateCaptureResponse } from "../src/ai/capture-parser.js";
import {
  buildConversationFacts,
  generateConversationalReply,
  validateConversationReply
} from "../src/ai/conversation-responder.js";
import { BANNED_PHRASES } from "../src/core/prompts.js";
import { timeLabel } from "../src/core/format.js";

// Wed, Nov 25, 2026, 2:00 PM Africa/Cairo (UTC+2)
const NOW = new Date("2026-11-25T12:00:00.000Z");

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

async function createDb() {
  const dir = new URL("../migrations/", import.meta.url);
  const files = (await readdir(dir)).filter(f => f.endsWith(".sql")).sort();
  const sqlite = new DatabaseSync(":memory:");
  for (const file of files) {
    sqlite.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  sqlite.exec("PRAGMA foreign_keys = ON;");
  return { sqlite, d1: new TestD1Database(sqlite) };
}

function responseText(res) {
  const parts = [];
  if (res.title) parts.push(res.title);
  for (const sec of res.sections || []) {
    if (sec.heading) parts.push(sec.heading);
    for (const line of sec.lines || []) parts.push(line);
  }
  return parts.join("\n").trim();
}

function assertToneChecks(res, { maxWords = 40 } = {}) {
  const text = responseText(res);
  assert.ok(text.length > 0, "Reply must not be empty");
  const words = text.split(/\s+/).filter(Boolean);
  assert.ok(words.length <= maxWords, `Too many words (${words.length} > ${maxWords}): ${text}`);
  for (const banned of BANNED_PHRASES) {
    assert.ok(!text.includes(banned), `Reply contains banned phrase "${banned}": ${text}`);
  }
  // Emoji count beyond status emoji (🔴🟡🟢⚪) and list/check emoji (☑☐)
  const stripped = text.replace(/[🔴🟡🟢⚪☑☐]/gu, "");
  const emojis = stripped.match(/\p{Extended_Pictographic}/gu) || [];
  assert.ok(emojis.length <= 1, `Too many non-status emojis (${emojis.length}): ${text}`);

  // Button constraints (Section 6.5)
  const rows = res.actions || [];
  assert.ok(rows.length <= 2, `Too many button rows (${rows.length})`);
  for (const row of rows) {
    assert.ok(row.length <= 3, `Too many buttons in row (${row.length})`);
    if (row.length === 3) {
      for (const btn of row) {
        assert.ok([...btn.label].length <= 8, `3-button row label too long (${btn.label})`);
      }
    } else {
      for (const btn of row) {
        assert.ok([...btn.label].length <= 14, `Button label > 14 chars (${btn.label})`);
      }
    }
  }
}

let updateSeq = 1000;
function textMsg(text) {
  const id = ++updateSeq;
  return adaptTelegramUpdate({
    update_id: id,
    message: { message_id: id, chat: { id: 500 }, from: { id: 501 }, text }
  }, NOW.toISOString());
}

function tapAction(data) {
  const id = ++updateSeq;
  return adaptTelegramUpdate({
    update_id: id,
    callback_query: {
      id: `cb-${id}`,
      data,
      from: { id: 501 },
      message: { message_id: id, chat: { id: 500 } }
    }
  }, NOW.toISOString());
}

test("20 golden conversations (Deliverable 1 Magic Capture + tone & button checks)", async () => {
  const { sqlite, d1 } = await createDb();
  const user = await getOrCreateChannelUser(d1, "telegram", "501", NOW.toISOString());

  const createdTasks = [];
  const completedIds = [];
  const rescheduled = [];
  const createdEvents = [];
  let typingCalls = 0;

  // Seed existing pending tasks for #11, #12, #13, #14
  await upsertGoogleTaskMirror(d1, {
    id: "gt-upflex",
    title: "Upflex - GTMx outreach",
    status: "needsAction",
    due: "2026-11-25T00:00:00.000Z"
  }, NOW.toISOString(), { area: "WORK", priority: "High" });
  await upsertGoogleTaskMirror(d1, {
    id: "gt-python",
    title: "Python Revision",
    status: "needsAction",
    due: "2026-11-26T00:00:00.000Z"
  }, NOW.toISOString(), { area: "DEEP", priority: "Medium" });

  const googleTasks = {
    async listAll() {
      return [
        { id: "gt-upflex", title: "Upflex - GTMx outreach", status: completedIds.includes("gt-upflex") ? "completed" : "needsAction", due: "2026-11-25T00:00:00.000Z" },
        { id: "gt-python", title: "Python Revision", status: "needsAction", due: "2026-11-26T00:00:00.000Z" },
        ...createdTasks
      ];
    },
    async create(title, notes, dueDate) {
      const task = {
        id: `gt-new-${createdTasks.length + 1}`,
        title,
        notes,
        due: dueDate ? `${dueDate}T00:00:00.000Z` : undefined,
        status: "needsAction"
      };
      createdTasks.push(task);
      return task;
    },
    async complete(id) {
      completedIds.push(id);
      return { id, title: "Upflex - GTMx outreach", status: "completed", completed: NOW.toISOString() };
    },
    async reschedule(id, dueDate) {
      rescheduled.push({ id, dueDate });
      return { id, title: "Python Revision", status: "needsAction", due: `${dueDate}T00:00:00.000Z` };
    }
  };

  const googleCalendar = {
    async listEventsForDate(date) {
      if (date === "2026-11-25") {
        return [{
          id: "ev-5pm",
          title: "Team Sync",
          allDay: false,
          startTime: "2026-11-25T15:00:00.000Z", // 5:00 PM Cairo
          endTime: "2026-11-25T16:00:00.000Z",
          start: "5:00 PM",
          end: "6:00 PM"
        }];
      }
      return [];
    },
    async createTaskBlock(opts) {
      const start = "2026-11-26T13:00:00.000Z";
      const end = new Date(Date.parse(start) + opts.durationMinutes * 60_000).toISOString();
      const ev = { id: `cal-${createdEvents.length + 1}`, summary: opts.title, start: { dateTime: start }, end: { dateTime: end } };
      createdEvents.push(ev);
      return ev;
    }
  };

  const mockedAi = {
    async run(_model, { prompt }) {
      if (prompt.includes("ذكرني اتصل بأحمد الساعة 5")) {
        return {
          response: JSON.stringify({
            items: [{
              intent: "reminder",
              title: "Call Ahmed",
              description: null,
              due_date: "2026-11-25",
              time: "17:00",
              duration_min: null,
              priority: null,
              area: null,
              target_hint: null,
              confidence: 0.95
            }]
          })
        };
      }
      return {
        response: JSON.stringify({
          items: [{
            intent: "unknown",
            title: null,
            description: null,
            due_date: null,
            time: null,
            duration_min: null,
            priority: null,
            area: null,
            target_hint: null,
            confidence: 0.3
          }]
        })
      };
    }
  };

  const send = text => handleAssistantMessage({
    db: d1,
    user,
    message: textMsg(text),
    googleTasks,
    googleCalendar,
    captureParser: ({ text: t, recentTurns, now }) => parseWithWorkersAi({
      db: d1, ai: mockedAi, text: t, recentTurns, now
    }),
    onBeforeAiCall: async () => { typingCalls++; },
    now: NOW
  });

  const tap = data => handleAssistantMessage({
    db: d1,
    user,
    message: tapAction(data),
    googleTasks,
    googleCalendar,
    now: NOW
  });

  // 1. remind me to call Ahmed at 5
  const r1 = await send("remind me to call Ahmed at 5");
  assertToneChecks(r1);
  assert.match(responseText(r1), /call Ahmed/i);
  assert.match(responseText(r1), /5:00 PM/);
  assert.equal(r1.actions[0][0].label, "↩ Undo");
  assert.equal(r1.actions[0][1].label, "⏰ Change time");

  // 2. remind me in 30 min to stretch
  const r2 = await send("remind me in 30 min to stretch");
  assertToneChecks(r2);
  assert.match(responseText(r2), /2:30 PM/);

  // 3. remind me tomorrow 9am pay the internet bill
  const r3 = await send("remind me tomorrow 9am pay the internet bill");
  assertToneChecks(r3);
  assert.match(responseText(r3), /Thu, Nov 26/);
  assert.match(responseText(r3), /9:00 AM/);

  // 4. remind me to stretch (missing time)
  const r4 = await send("remind me to stretch");
  assertToneChecks(r4);
  assert.match(responseText(r4), /When should I ping you\?/);
  assert.equal(r4.actions[0][0].label, "9:00 AM");
  const r4Save = await tap(r4.actions[1][0].action); // 5:00 PM
  assertToneChecks(r4Save);
  assert.match(responseText(r4Save), /5:00 PM/);

  // 5. remind me yesterday at 5
  const r5 = await send("remind me yesterday at 5");
  assertToneChecks(r5);
  assert.match(responseText(r5), /That time's gone\. Same time tomorrow\?/);

  // 6. call Ahmed tomorrow (no Google write before tap!)
  const beforeCount6 = createdTasks.length;
  const r6 = await send("call Ahmed tomorrow");
  assertToneChecks(r6);
  assert.equal(createdTasks.length, beforeCount6);
  assert.match(responseText(r6), /Call Ahmed/);
  assert.match(responseText(r6), /Thu, Nov 26/);
  const r6Save = await tap(r6.actions[0][0].action);
  assertToneChecks(r6Save);
  assert.equal(createdTasks.length, beforeCount6 + 1);
  // Double-tap idempotency
  const r6Dup = await tap(r6.actions[0][0].action);
  assertToneChecks(r6Dup);
  assert.equal(createdTasks.length, beforeCount6 + 1);

  // 7. finish the Upflex brief by Friday, high priority
  const r7 = await send("finish the Upflex brief by Friday, high priority");
  assertToneChecks(r7);
  assert.match(responseText(r7), /Fri, Nov 27/);
  assert.match(responseText(r7), /High/);
  assert.match(responseText(r7), /Work/);

  // 8. study python revision tomorrow 3pm 50 min (no calendar write before tap!)
  const beforeEv8 = createdEvents.length;
  const r8 = await send("study python revision tomorrow 3pm 50 min");
  assertToneChecks(r8);
  assert.equal(createdEvents.length, beforeEv8);
  assert.match(responseText(r8), /Thu, Nov 26/);
  assert.match(responseText(r8), /3:00 PM – 3:50 PM/);
  assert.match(responseText(r8), /Growth/);
  const r8Add = await tap(r8.actions[0][0].action);
  assertToneChecks(r8Add);
  assert.equal(createdEvents.length, beforeEv8 + 1);

  // 9. block 25 min today 8pm for revit practice
  const r9 = await send("block 25 min today 8pm for revit practice");
  assertToneChecks(r9);
  assert.match(responseText(r9), /8:00 PM – 8:25 PM/);

  // 10. multi-item 3 lines
  const beforeCount10 = createdTasks.length;
  const r10 = await send("buy milk\nrenew passport\ncall mom");
  assertToneChecks(r10);
  assert.match(responseText(r10), /Found 3 things/);
  assert.equal(createdTasks.length, beforeCount10);
  const r10Save = await tap(r10.actions[1][0].action);
  assertToneChecks(r10Save);
  assert.equal(createdTasks.length, beforeCount10 + 3);

  // 11. done with the Upflex task (only completes after Yes)
  const r11 = await send("done with the Upflex task");
  assertToneChecks(r11);
  assert.match(responseText(r11), /Mark “Upflex - GTMx outreach” done\?/);
  assert.equal(completedIds.length, 0);
  const r11Yes = await tap(r11.actions[0][0].action);
  assertToneChecks(r11Yes);
  assert.deepEqual(completedIds, ["gt-upflex"]);

  // 12. move the python task to Friday (only reschedules after Yes)
  const r12 = await send("move the python task to Friday");
  assertToneChecks(r12);
  assert.match(responseText(r12), /Move “Python Revision” to Fri, Nov 27\?/);
  assert.equal(rescheduled.length, 0);
  const r12Yes = await tap(r12.actions[0][0].action);
  assertToneChecks(r12Yes);
  assert.deepEqual(rescheduled, [{ id: "gt-python", dueDate: "2026-11-27" }]);

  // 13. what's next?
  const r13 = await send("what's next?");
  assertToneChecks(r13);
  assert.match(responseText(r13), /Python Revision|Call Ahmed/);

  // 14. what do I have today?
  const r14 = await send("what do I have today?");
  assertToneChecks(r14);
  assert.match(responseText(r14), /Calendar|task/i);

  // 15. am I free at 5?
  const r15 = await send("am I free at 5?");
  assertToneChecks(r15);
  assert.match(responseText(r15), /Team Sync/);
  assert.match(responseText(r15), /5:00 PM/);

  // 16. I'm tired
  const r16 = await send("I'm tired");
  assertToneChecks(r16);
  assert.match(responseText(r16), /breather|rest|tiny step/i);

  // 17. asdf (AI path -> unknown -> one friendly question)
  const r17 = await send("asdf");
  assertToneChecks(r17);
  assert.match(responseText(r17), /Not sure what to do with that one/);
  assert.ok(typingCalls >= 1);

  // 18. Arabic reminder (AI path -> English reply)
  const r18 = await send("ذكرني اتصل بأحمد الساعة 5");
  assertToneChecks(r18);
  assert.match(responseText(r18), /Call Ahmed/i);
  assert.match(responseText(r18), /5:00 PM/);

  // 19. leave me alone for 2 hours
  const r19 = await send("leave me alone for 2 hours");
  assertToneChecks(r19);
  assert.match(responseText(r19), /4:00 PM/);
  // Clear dive so #20 works cleanly
  await tap("back");

  // 20. going to sleep, wake me at 7:30
  const r20 = await send("going to sleep, wake me at 7:30");
  assertToneChecks(r20);
  assert.match(responseText(r20), /7:30 AM/);
  const r20Yes = await tap(r20.actions[0][0].action);
  assertToneChecks(r20Yes);
  assert.match(responseText(r20Yes), /7:30 AM/);

  sqlite.close();
});

test("invalid or hallucinated AI JSON is rejected once (no retry) and falls back to clarifying question", async () => {
  const { sqlite, d1 } = await createDb();
  const user = await getOrCreateChannelUser(d1, "telegram", "ai-bad", NOW.toISOString());
  let calls = 0;

  const badAi = {
    async run() {
      calls++;
      return { response: "Sure! Here is your JSON: {not valid" };
    }
  };

  const res = await handleAssistantMessage({
    db: d1,
    user,
    message: textMsg("maybe something later idk"),
    captureParser: ({ text, recentTurns, now }) => parseWithWorkersAi({
      db: d1, ai: badAi, text, recentTurns, now
    }),
    now: NOW
  });
  assert.equal(calls, 1);
  assertToneChecks(res);
  assert.match(responseText(res), /Not sure what to do with that one/);

  // Hallucinated fields must be rejected by validator
  assert.equal(validateCaptureResponse({
    response: { items: [{ intent: "delete_all", title: "x", confidence: 0.9 }] }
  }, NOW), null);
  assert.equal(validateCaptureResponse({
    response: { items: [{ intent: "task", title: "x", description: null, due_date: "2026-02-30", time: null, duration_min: null, priority: null, area: null, target_hint: null, confidence: 0.9 }] }
  }, NOW), null);

  sqlite.close();
});

test("Task card edit-in-place, /drop entry, and DST-safe Cairo date rejection", async () => {
  const { sqlite, d1 } = await createDb();
  const user = await getOrCreateChannelUser(d1, "telegram", "edit-user", NOW.toISOString());

  // /drop and 📝 Drop it share the exact prompt
  const dropCmd = await handleAssistantMessage({
    db: d1, user, message: textMsg("/drop"), googleTasks: null, now: NOW
  });
  const dropBtn = await handleAssistantMessage({
    db: d1, user, message: textMsg("📝 Drop it"), googleTasks: null, now: NOW
  });
  assertToneChecks(dropCmd);
  assertToneChecks(dropBtn);
  assert.equal(responseText(dropCmd), "What's the move? Type it however you like.");
  assert.equal(responseText(dropBtn), "What's the move? Type it however you like.");

  // Create task draft and tweak Area via ✏ Change
  const card = await handleAssistantMessage({
    db: d1, user, message: textMsg("review notes tomorrow"), googleTasks: null, now: NOW
  });
  const editMenu = await handleAssistantMessage({
    db: d1, user, message: tapAction(card.actions[0][1].action), googleTasks: null, now: NOW
  });
  assertToneChecks(editMenu);
  const areaPicker = await handleAssistantMessage({
    db: d1, user, message: tapAction(editMenu.actions[0][1].action), googleTasks: null, now: NOW
  });
  assertToneChecks(areaPicker);
  const updatedCard = await handleAssistantMessage({
    db: d1, user, message: tapAction(areaPicker.actions[0][0].action), googleTasks: null, now: NOW
  });
  assertToneChecks(updatedCard);
  assert.match(responseText(updatedCard), /Growth/);

  // DST spring-forward nonexistent Cairo time (2026-04-24 00:30) is rejected safely
  const dstNow = new Date("2026-04-23T12:00:00.000Z");
  const dstRes = await handleAssistantMessage({
    db: d1,
    user,
    message: textMsg("remind me on Apr 24 at 12:30 AM to check meter"),
    now: dstNow
  });
  assertToneChecks(dstRes);
  assert.match(responseText(dstRes), /clock change|Pick another time/i);

  // Valid post-DST time (2026-04-24 01:30 = 22:30Z on Apr 23)
  const validDst = await handleAssistantMessage({
    db: d1,
    user,
    message: textMsg("remind me on Apr 24 at 1:30 AM to check meter"),
    now: dstNow
  });
  assertToneChecks(validDst);
  assert.match(responseText(validDst), /1:30 AM/);
  assert.equal(timeLabel("2026-04-23T22:30:00.000Z"), "1:30 AM");

  sqlite.close();
});

test("Deliverable 2: Workers AI human conversation, grounded FACTS, validation, and deterministic fallback", async () => {
  const { sqlite, d1 } = await createDb();
  const user = await getOrCreateChannelUser(d1, "telegram", "chat-user", NOW.toISOString());

  await upsertGoogleTaskMirror(d1, {
    id: "gt-upflex-2",
    title: "Upflex - GTMx outreach",
    status: "needsAction",
    due: "2026-11-24T00:00:00.000Z" // overdue
  }, NOW.toISOString(), { area: "WORK", priority: "High" });

  await d1.prepare(
    "INSERT INTO reminders (id, user_id, text, remind_at_utc, status, created_at, request_id) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6)"
  ).bind("REM-1", user.id, "Drink water", "2026-11-25T15:00:00.000Z", NOW.toISOString(), "REQ-REM-1").run();

  const googleCalendar = {
    async listEventsForDate() {
      return [{
        title: "Team Sync",
        allDay: false,
        startTime: "2026-11-25T14:00:00.000Z", // 4:00 PM Cairo
        endTime: "2026-11-25T14:30:00.000Z"
      }];
    }
  };

  // 1. Validate output guardrails (AI proposes, code decides)
  assert.equal(validateConversationReply({ response: "As an AI, I cannot check." }), null);
  assert.equal(validateConversationReply({ response: "According to FACTS: you have 1 task." }), null);
  assert.equal(validateConversationReply({ response: "x".repeat(401) }), null);
  assert.equal(
    validateConversationReply({ response: "Yo Martino! 💪🔥🎉 Upflex outreach is overdue, let's knock it out." }),
    "Yo Martino! 💪 Upflex outreach is overdue, let's knock it out."
  );

  // 2. Grounded Workers AI call receives real FACTS + recent turns + triggers typing indicator
  const aiPrompts = [];
  let typingCalls = 0;
  const mockAi = {
    async run(model, input) {
      aiPrompts.push({ model, prompt: input.prompt });
      return { response: "Yo Martino, Upflex - GTMx outreach is overdue from yesterday. Knock it out first? 💪" };
    }
  };
  const conversationResponder = ({ text, facts, recentTurns, now }) =>
    generateConversationalReply({ db: d1, ai: mockAi, text, facts, recentTurns, now, dailyNeuronLimit: 5000 });

  const q1 = await handleAssistantMessage({
    db: d1,
    user,
    message: textMsg("what's next?"),
    googleCalendar,
    conversationResponder,
    onBeforeAiCall: () => { typingCalls += 1; },
    now: NOW
  });
  assertToneChecks(q1);
  assert.equal(typingCalls, 1);
  assert.equal(aiPrompts.length, 1);
  assert.match(aiPrompts[0].prompt, /Upflex - GTMx outreach/);
  assert.match(aiPrompts[0].prompt, /Team Sync/);
  assert.match(aiPrompts[0].prompt, /Drink water/);
  assert.match(responseText(q1), /Upflex - GTMx outreach/);

  // 3. Invalid AI output (banned phrase) falls back deterministically with no retry
  const badAi = {
    async run() {
      return { response: "As an AI language model, here is your JSON." };
    }
  };
  const badResponder = ({ text, facts, recentTurns, now }) =>
    generateConversationalReply({ db: d1, ai: badAi, text, facts, recentTurns, now, dailyNeuronLimit: 5000 });

  const q2 = await handleAssistantMessage({
    db: d1,
    user,
    message: textMsg("am I free at 4pm?"),
    googleCalendar,
    conversationResponder: badResponder,
    now: NOW
  });
  assertToneChecks(q2);
  assert.match(responseText(q2), /Busy at 4:00 PM.*Team Sync/);

  // 4. Multi-turn continuity stored in chat_turns (last 3 turns passed to AI)
  const q3 = await handleAssistantMessage({
    db: d1,
    user,
    message: textMsg("do I have overdue tasks?"),
    googleCalendar,
    conversationResponder,
    now: NOW
  });
  assertToneChecks(q3);
  assert.equal(aiPrompts.length, 2);
  assert.match(aiPrompts[1].prompt, /Recent chat:/);
  assert.match(aiPrompts[1].prompt, /am I free at 4pm\?/);

  // 5. AI off / budget exhausted deterministic friendly fallbacks
  const overdueFallback = await handleAssistantMessage({
    db: d1,
    user,
    message: textMsg("do I have overdue tasks?"),
    googleCalendar,
    conversationResponder: null,
    now: NOW
  });
  assertToneChecks(overdueFallback);
  assert.match(responseText(overdueFallback), /1 overdue/);

  const remFallback = await handleAssistantMessage({
    db: d1,
    user,
    message: textMsg("what reminders do I have?"),
    googleCalendar,
    conversationResponder: null,
    now: NOW
  });
  assertToneChecks(remFallback);
  assert.match(responseText(remFallback), /Drink water.*5:00 PM/);

  const tiredFallback = await handleAssistantMessage({
    db: d1,
    user,
    message: textMsg("I'm exhausted bro"),
    googleCalendar,
    conversationResponder: null,
    now: NOW
  });
  assertToneChecks(tiredFallback);
  assert.match(responseText(tiredFallback), /breather/i);

  const facts = await buildConversationFacts({ db: d1, user, googleCalendar, now: NOW });
  assert.equal(facts.name, "Martino");
  assert.equal(facts.overdueCount, 1);
  assert.equal(facts.calendarEvents.length, 1);

  sqlite.close();
});

test("Deliverable 3: reminders sleep-hold, stale lease recovery, dive_end, wake spacing, and check-in backoff", async () => {
  const { sqlite, d1 } = await createDb();
  const user = await getOrCreateChannelUser(d1, "telegram", "time-user", NOW.toISOString());
  await insertChannelMessage(d1, {
    channel: "telegram",
    conversationId: "time-chat",
    externalMessageId: "msg-time-1",
    userId: user.id,
    direction: "incoming",
    type: "text",
    createdAt: NOW.toISOString()
  });

  const sent = [];
  const telegram = {
    async sendAssistantResponse(chatId, payload) {
      sent.push({ chatId, payload });
      return { message_id: sent.length };
    }
  };

  // 1. Sleep holds reminders until wake
  const wakeAt = new Date(NOW.getTime() + 60 * 60_000); // 3:00 PM Cairo
  await startSleep({ db: d1, user, wakeAt, now: NOW });
  await d1.prepare(
    `INSERT INTO reminders (id, user_id, text, remind_at_utc, status, created_at, request_id)
     VALUES ('REM-SLEEP-1', ?1, 'Take meds', ?2, 'pending', ?3, 'REQ-SLEEP-1')`
  ).bind(user.id, new Date(NOW.getTime() + 10 * 60_000).toISOString(), NOW.toISOString()).run();

  const whileAsleep = await processUserReminders({
    db: d1,
    telegram,
    now: new Date(NOW.getTime() + 20 * 60_000),
    authorizedTelegramUserId: "time-user",
    enabled: true
  });
  assert.equal(whileAsleep.sent, 0);
  assert.equal(sent.length, 0);

  // Wake ping 1 at wakeAt, then re-ping blocked within 15 min, allowed at +15 min
  const wake1 = await processCompanion({
    db: d1, telegram, now: wakeAt, authorizedTelegramUserId: "time-user", enabled: true
  });
  assert.equal(wake1.sent, 1);
  const wakeTooSoon = await processCompanion({
    db: d1, telegram, now: new Date(wakeAt.getTime() + 5 * 60_000), authorizedTelegramUserId: "time-user", enabled: true
  });
  assert.equal(wakeTooSoon.sent, 0);
  const wake2 = await processCompanion({
    db: d1, telegram, now: new Date(wakeAt.getTime() + 15 * 60_000), authorizedTelegramUserId: "time-user", enabled: true
  });
  assert.equal(wake2.sent, 1);
  assert.match(sent[1]?.payload?.sections?.[0]?.lines?.[0] || "", /still out/i);

  // Mark user awake, then held reminder delivers; stale 'sending' lease recovers
  await d1.prepare("UPDATE sleep_sessions SET status='woke', acked_at=?1 WHERE user_id=?2")
    .bind(wakeAt.toISOString(), user.id).run();
  const afterWake = await processUserReminders({
    db: d1, telegram, now: new Date(wakeAt.getTime() + 20 * 60_000), authorizedTelegramUserId: "time-user", enabled: true
  });
  assert.equal(afterWake.sent, 1);

  // Stale 'sending' lease recovery
  await d1.prepare(
    `INSERT INTO reminders (id, user_id, text, remind_at_utc, status, created_at, claim_until, request_id)
     VALUES ('REM-STALE-1', ?1, 'Stale lease', ?2, 'sending', ?3, ?4, 'REQ-STALE-1')`
  ).bind(
    user.id,
    new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    NOW.toISOString(),
    new Date(NOW.getTime() - 60_000).toISOString()
  ).run();
  const recovered = await processUserReminders({
    db: d1, telegram, now: new Date(wakeAt.getTime() + 25 * 60_000), authorizedTelegramUserId: "time-user", enabled: true
  });
  assert.equal(recovered.sent, 1);

  // 2. Dive end notification fires once when dive_until passes
  sent.length = 0;
  const diveStart = new Date(wakeAt.getTime() + 30 * 60_000);
  await startDive({ db: d1, user, minutes: 30, now: diveStart });
  const duringDive = await processCompanion({
    db: d1, telegram, now: new Date(diveStart.getTime() + 15 * 60_000), authorizedTelegramUserId: "time-user", enabled: true
  });
  assert.equal(duringDive.sent, 0);
  const afterDive = await processCompanion({
    db: d1, telegram, now: new Date(diveStart.getTime() + 35 * 60_000), authorizedTelegramUserId: "time-user", enabled: true
  });
  assert.equal(afterDive.sent, 1);
  assert.match(sent[0].payload.sections[0].lines[0], /Time's up, Martino/i);

  // 3. Quiet hours: 00:15 Cairo is active; 01:00 Cairo is quiet
  await upsertGoogleTaskMirror(d1, {
    id: "gt-late-1",
    title: "Late task",
    status: "needsAction",
    due: "2026-11-24T00:00:00.000Z"
  }, NOW.toISOString(), { area: "WORK", priority: "High" });
  const googleTasks = { async listAll() { return []; } };
  const quietRun = await processCompanion({
    db: d1,
    telegram,
    now: new Date("2026-11-25T23:00:00.000Z"), // 01:00 AM Cairo
    authorizedTelegramUserId: "time-user",
    googleTasks,
    enabled: true
  });
  assert.equal(quietRun.sent, 0);

  // 4. companion_stuck -> fr|none|unclear works & /pause upserts companion_state
  const stuckRes = await handleAssistantMessage({
    db: d1, user, message: tapAction("fr|none|unclear"), companionEnabled: true, now: NOW
  });
  assert.match(responseText(stuckRes), /25 minutes/i);
  const pauseRes = await handleAssistantMessage({
    db: d1, user, message: textMsg("/pause"), companionEnabled: true, now: NOW
  });
  assert.match(responseText(pauseRes), /paused for 2 hours/i);

  sqlite.close();
});

test("Deliverable 4: cleanup routes (/plan, /recap, start_task, pipeline_settings, tomorrow, /stack google_task_id)", async () => {
  const { sqlite, d1 } = await createDb();
  const user = await getOrCreateChannelUser(d1, "telegram", "cleanup-user", NOW.toISOString());

  await upsertGoogleTaskMirror(d1, {
    id: "gt-stack-1",
    title: "Finish proposal",
    status: "needsAction",
    due: "2026-11-25T00:00:00.000Z"
  }, NOW.toISOString(), { area: "WORK", priority: "High" });

  const googleTasks = {
    async listAll() {
      return [{ id: "gt-stack-1", title: "Finish proposal", status: "needsAction", due: "2026-11-25T00:00:00.000Z" }];
    }
  };

  // /plan and /recap commands route cleanly
  const planRes = await handleAssistantMessage({
    db: d1, user, message: textMsg("/plan"), googleTasks, now: NOW
  });
  assert.match(responseText(planRes), /Finish proposal|Today's plan/i);

  const recapRes = await handleAssistantMessage({
    db: d1, user, message: textMsg("/recap"), googleTasks, now: NOW
  });
  assert.match(responseText(recapRes), /Weekly|1\/5|completed/i);

  // /stack uses google_task_id in task_complete action
  const stackRes = await handleAssistantMessage({
    db: d1, user, message: textMsg("/stack"), googleTasks, now: NOW
  });
  assert.equal(stackRes.actions[0][0].action, "task_complete|gt-stack-1");

  // start_task|<id>, pipeline_settings, and tomorrow callbacks all resolve
  const startRes = await handleAssistantMessage({
    db: d1, user, message: tapAction("start_task|gt-stack-1"), googleTasks, now: NOW
  });
  assert.match(responseText(startRes), /Finish proposal/);

  const settingsRes = await handleAssistantMessage({
    db: d1, user, message: tapAction("pipeline_settings"), now: NOW
  });
  assert.match(responseText(settingsRes), /Martino/);

  const tmrwRes = await handleAssistantMessage({
    db: d1, user, message: tapAction("tomorrow"), googleTasks, now: NOW
  });
  assert.match(responseText(tmrwRes), /Tomorrow's plan/i);

  sqlite.close();
});

test("User UX upgrades: /start guide, exact-name edit prompt, task detail & rename, /remind chips, brainstorm 7am/10pm & vault", async () => {
  const { sqlite, d1 } = await createDb();
  const user = await getOrCreateChannelUser(d1, "telegram", "ux-user", NOW.toISOString());

  // 1. /start gives guide (not task dump) + compact icon reply keyboard
  const startRes = await handleAssistantMessage({
    db: d1, user, message: textMsg("/start"), now: NOW
  });
  assert.match(responseText(startRes), /Here's how we roll/i);
  assert.deepEqual(startRes.replyKeyboardRows, [
    ["▶️", "📝", "⏰", "🎧"],
    ["📋", "📥", "🧠", "📱"]
  ]);

  // 2. Typing exact name of existing task offers Edit vs Add new
  let currentTitle = "Call Ahmed";
  await upsertGoogleTaskMirror(d1, {
    id: "gt-ahmed",
    title: currentTitle,
    status: "needsAction",
    due: "2026-11-26T00:00:00.000Z"
  }, NOW.toISOString(), { area: "WORK", priority: "Medium" });

  const googleTasks = {
    async listAll() {
      return [{ id: "gt-ahmed", title: currentTitle, status: "needsAction", due: "2026-11-26T00:00:00.000Z" }];
    },
    async update(id, patch) {
      currentTitle = patch.title;
      return { id, title: currentTitle, status: "needsAction", due: "2026-11-26T00:00:00.000Z" };
    }
  };

  const dupMatch = await handleAssistantMessage({
    db: d1, user, message: textMsg("Call Ahmed"), googleTasks, now: NOW
  });
  assert.match(responseText(dupMatch), /already open/i);
  assert.equal(dupMatch.actions[0][0].action, "task_open|gt-ahmed");

  // 3. Tapping task_open shows detail card (Crushed it / Rename / Deadline) and rename updates Google Tasks
  const detail = await handleAssistantMessage({
    db: d1, user, message: tapAction("task_open|gt-ahmed"), googleTasks, now: NOW
  });
  assert.match(detail.actions[0][0].label, /Crushed it/);
  assert.equal(detail.actions[0][1].action, "task_rename|gt-ahmed");

  await handleAssistantMessage({
    db: d1, user, message: tapAction("task_rename|gt-ahmed"), googleTasks, now: NOW
  });
  const renamed = await handleAssistantMessage({
    db: d1, user, message: textMsg("Call Ahmed about Upflex"), googleTasks, now: NOW
  });
  assert.match(responseText(renamed), /Renamed to “Call Ahmed about Upflex”/);

  // 4. /remind without args shows /dive-style quick chips
  const remMenu = await handleAssistantMessage({
    db: d1, user, message: textMsg("/remind"), now: NOW
  });
  assert.equal(remMenu.actions[0][0].action, "rem_quick|30m");

  // 5. Brainstorm multi-message capture saves to brainstorms table on Save
  await handleAssistantMessage({
    db: d1, user, message: textMsg("🧠"), now: NOW
  });
  const part1 = await handleAssistantMessage({
    db: d1, user, message: textMsg("Idea 1: HVAC calculator SaaS for Egypt contractors"), now: NOW
  });
  assert.match(responseText(part1), /Got part 1/);
  const part2 = await handleAssistantMessage({
    db: d1, user, message: textMsg("Idea 2: pair it with B2B SDR outreach"), now: NOW
  });
  assert.match(responseText(part2), /Got part 2/);
  const savedBrn = await handleAssistantMessage({
    db: d1, user, message: tapAction("brainstorm_save"), now: NOW
  });
  assert.match(responseText(savedBrn), /brainstorm vault/i);
  const row = sqlite.prepare("SELECT content FROM brainstorms WHERE user_id = ?1").get(user.id);
  assert.match(row.content, /HVAC calculator SaaS/);
  assert.match(row.content, /B2B SDR outreach/);

  sqlite.close();
});
