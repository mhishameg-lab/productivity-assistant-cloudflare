import {
  cairoDateKey,
  cairoTimeParts,
  durationLabel,
  parseCairoDateTime,
  parseDateInput,
  shiftDateKey,
  shortDate,
  timeLabel,
  weekdayDay
} from "./format.js";
import {
  guessArea,
  loadAreaKeywordMap,
  matchPendingTasks,
  nextCairoDateForTime,
  parseFastPathCapture,
  resolveWeekdayDate
} from "./capture-router.js";
import { parseWithWorkersAi } from "../ai/capture-parser.js";
import { buildConversationFacts } from "../ai/conversation-responder.js";
import { createUserReminder } from "../user-reminders.js";
import { startDive, startSleep } from "../companion.js";
import { getDisplayName } from "./voice.js";
import { clearConversationState, logSyncEvent, setConversationState } from "../db/channel-repository.js";
import { listPendingTaskPlanningCandidates, syncGoogleTaskMirrors, upsertGoogleTaskMirror } from "../db/google-tasks-repository.js";
import { cairoLocalDateTimeToIso } from "../integrations/google-calendar.js";

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export function displayAreaName(area) {
  return ({
    DEEP: "Growth",
    WORK: "Work",
    LIFE: "Life",
    Admin: "Errands",
    Other: "Other"
  })[area] || "Other";
}

export async function listRecentChatTurns(db, userId, limit = 6) {
  if (!db || !userId) return [];
  try {
    const res = await db.prepare(
      `SELECT role, text, created_at
         FROM chat_turns
        WHERE user_id = ?1
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?2`
    ).bind(userId, limit).all();
    return (res.results || []).reverse();
  } catch {
    return [];
  }
}

export async function appendChatTurn(db, userId, role, text, now) {
  if (!db || !userId || !text) return;
  try {
    await db.prepare(
      `INSERT INTO chat_turns (id, user_id, role, text, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(
      `TURN-${crypto.randomUUID()}`,
      userId,
      role,
      String(text).slice(0, 500),
      now.toISOString()
    ).run();
  } catch {}
}

export async function saveCaptureDraft(db, { userId, intent, payload, now, requestId = null }) {
  const id = `CAP-${crypto.randomUUID().slice(0, 18)}`;
  const reqId = requestId || `REQ-${crypto.randomUUID()}`;
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + DRAFT_TTL_MS).toISOString();
  await db.prepare(
    `INSERT INTO capture_drafts (id, user_id, request_id, intent, payload_json, status, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, ?7)`
  ).bind(id, userId, reqId, intent, JSON.stringify(payload), createdAt, expiresAt).run();
  return { id, requestId: reqId, intent, payload, status: "open" };
}

export async function getCaptureDraft(db, draftId, userId) {
  const row = await db.prepare(
    `SELECT id, user_id, request_id, intent, payload_json, status, expires_at
       FROM capture_drafts
      WHERE id = ?1 AND user_id = ?2`
  ).bind(draftId, userId).first();
  if (!row) return null;
  let payload = {};
  try {
    payload = JSON.parse(row.payload_json);
  } catch {}
  return {
    id: row.id,
    userId: row.user_id,
    requestId: row.request_id,
    intent: row.intent,
    payload,
    status: row.status,
    expiresAt: row.expires_at
  };
}

export async function updateCaptureDraft(db, draftId, payload, { intent = null, status = null } = {}) {
  const sets = ["payload_json = ?1"];
  const binds = [JSON.stringify(payload)];
  let idx = 2;
  if (intent) {
    sets.push(`intent = ?${idx++}`);
    binds.push(intent);
  }
  if (status) {
    sets.push(`status = ?${idx++}`);
    binds.push(status);
  }
  binds.push(draftId);
  await db.prepare(
    `UPDATE capture_drafts SET ${sets.join(", ")} WHERE id = ?${idx}`
  ).bind(...binds).run();
}

export async function routeMagicCapture({
  db,
  user,
  text,
  googleTasks = null,
  googleCalendar = null,
  captureParser = null,
  conversationResponder = null,
  onBeforeAiCall = null,
  userRemindersEnabled = true,
  companionEnabled = true,
  now
}) {
  const keywordMap = await loadAreaKeywordMap(db);
  await appendChatTurn(db, user.id, "user", text, now);

  let parsed = parseFastPathCapture(text, now, keywordMap);
  const needsAi = !parsed || parsed.items.some(item =>
    item.intent === "unknown" ||
    item.confidence < 0.6 ||
    !item.intent
  );

  if (needsAi && captureParser) {
    if (onBeforeAiCall) {
      try {
        await onBeforeAiCall();
      } catch {}
    }
    const recentTurns = await listRecentChatTurns(db, user.id, 6);
    try {
      const aiResult = await captureParser({
        text,
        recentTurns: recentTurns.slice(-3),
        now
      });
      if (aiResult && Array.isArray(aiResult.items) && aiResult.items.length) {
        parsed = aiResult;
      }
    } catch {}
  }

  if (!parsed || !parsed.items || !parsed.items.length) {
    const existing = await findExactPendingTask(db, text, now);
    if (existing) return renderExistingTaskChoice(db, user, existing, text, keywordMap, now);
    return presentUnknownCapture({ db, user, text, now });
  }

  // Multi-item path (2..5 items)
  if (parsed.items.length > 1) {
    const items = parsed.items.slice(0, 5).map(item => ({
      title: item.title || text.slice(0, 120),
      dueDate: item.due_date || null,
      priority: item.priority || "Medium",
      area: item.area || guessArea(item.title || "", keywordMap),
      selected: true
    }));
    const draft = await saveCaptureDraft(db, {
      userId: user.id,
      intent: "multi",
      payload: { items },
      now
    });
    return renderMultiCaptureCard(draft);
  }

  const item = parsed.items[0];
  if (item.confidence < 0.6 || item.intent === "unknown") {
    const existing = await findExactPendingTask(db, text, now);
    if (existing) return renderExistingTaskChoice(db, user, existing, text, keywordMap, now);
    return presentUnknownCapture({ db, user, text, now });
  }

  switch (item.intent) {
    case "sleep":
      return handleCapturedSleep({ db, user, item, companionEnabled, now });
    case "dive":
      return handleCapturedDive({ db, user, item, companionEnabled, now });
    case "reminder":
      return handleCapturedReminder({ db, user, item, userRemindersEnabled, now });
    case "schedule":
      return handleCapturedSchedule({ db, user, item, keywordMap, googleTasks, googleCalendar, now });
    case "done":
      return handleCapturedDone({ db, user, item, googleTasks, now });
    case "reschedule":
      return handleCapturedReschedule({ db, user, item, googleTasks, now });
    case "task":
      return handleCapturedTask({ db, user, item, keywordMap, now });
    case "question":
    case "chat":
      return handleCapturedConversation({
        db,
        user,
        text,
        item,
        googleTasks,
        googleCalendar,
        conversationResponder,
        onBeforeAiCall,
        now
      });
    default:
      return presentUnknownCapture({ db, user, text, now });
  }
}

async function findExactPendingTask(db, text, now) {
  const norm = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const target = norm(text);
  if (!target) return null;
  const pending = await listPendingTaskPlanningCandidates(db, cairoDateKey(now), 50);
  return pending.find(t => t.google_task_id && norm(t.title) === target) || null;
}

async function renderExistingTaskChoice(db, user, existing, rawText, keywordMap, now) {
  const title = String(rawText || existing.title).trim().slice(0, 120);
  const draft = await saveCaptureDraft(db, {
    userId: user.id,
    intent: "task",
    payload: {
      title,
      description: null,
      area: guessArea(title, keywordMap),
      priority: "Medium",
      dueDate: null,
      time: null
    },
    now
  });
  return {
    category: "Task match",
    title: "",
    sections: [{
      heading: "",
      lines: [`“${existing.title}” is already open. Edit it or add a new one?`]
    }],
    actions: [[
      { label: "✏️ Edit it", action: `task_open|${existing.google_task_id}` },
      { label: "➕ Add new", action: `cap_save|${draft.id}` },
      { label: "✖", action: `cap_cancel|${draft.id}` }
    ]]
  };
}

async function presentUnknownCapture({ db, user, text, now }) {
  const draft = await saveCaptureDraft(db, {
    userId: user.id,
    intent: "unknown",
    payload: { rawText: String(text || "").slice(0, 200) },
    now
  });
  return {
    category: "Capture",
    title: "",
    sections: [{
      heading: "",
      lines: ["Not sure what to do with that one. A task, a reminder, or just talking?"]
    }],
    actions: [
      [
        { label: "Task", action: `cap_unk|${draft.id}|task` },
        { label: "Reminder", action: `cap_unk|${draft.id}|rem` }
      ],
      [
        { label: "Just talking", action: `cap_unk|${draft.id}|chat` },
        { label: "✖", action: `cap_cancel|${draft.id}` }
      ]
    ]
  };
}

async function handleCapturedSleep({ db, user, item, companionEnabled, now }) {
  if (!companionEnabled) {
    return simpleReply("Rest mode paused", "Sleep and dive controls are paused right now.");
  }
  if (!item.time) {
    return {
      category: "Sleep",
      title: "",
      sections: [{ heading: "", lines: ["Alright Martino, time to power down. 🌙 When should I wake you?"] }],
      actions: [
        [
          { label: "6:00 AM", action: "sleep_time|06:00" },
          { label: "7:00 AM", action: "sleep_time|07:00" }
        ],
        [
          { label: "8:00 AM", action: "sleep_time|08:00" },
          { label: "Custom", action: "sleep_time|custom" }
        ]
      ]
    };
  }
  const today = cairoDateKey(now);
  let dateKey = today;
  let wake = safeCairoDate(dateKey, item.time);
  if (!wake || wake.getTime() <= now.getTime()) {
    dateKey = shiftDateKey(today, 1);
    wake = safeCairoDate(dateKey, item.time);
  }
  if (!wake) {
    return simpleReply("Sleep", "That Cairo time doesn't exist with the clock change. Pick another wake time.");
  }
  const draft = await saveCaptureDraft(db, {
    userId: user.id,
    intent: "sleep",
    payload: { wakeAtIso: wake.toISOString(), time: item.time },
    now
  });
  return {
    category: "Sleep",
    title: "",
    sections: [{
      heading: "",
      lines: [`Powering down till ${timeLabel(wake)}. 🌙 Start sleep mode?`]
    }],
    actions: [[
      { label: "✅ Yes", action: `cap_sleep_yes|${draft.id}` },
      { label: "⏰ Change", action: `cap_sleep_chg|${draft.id}` },
      { label: "✖", action: `cap_cancel|${draft.id}` }
    ]]
  };
}

async function handleCapturedDive({ db, user, item, companionEnabled, now }) {
  if (!companionEnabled) {
    return simpleReply("Rest mode paused", "Sleep and dive controls are paused right now.");
  }
  const minutes = item.duration_min;
  if (!minutes) {
    return {
      category: "Dive",
      title: "",
      sections: [{ heading: "", lines: ["How long do you want to go quiet?"] }],
      actions: [[
        { label: "1 h", action: "dive_start|60" },
        { label: "2 h", action: "dive_start|120" },
        { label: "3 h", action: "dive_start|180" }
      ]]
    };
  }
  const until = await startDive({ db, user, minutes, now });
  return {
    category: "Dive",
    title: "",
    sections: [{
      heading: "",
      lines: [`Bet. 🎧 Gone for ${durationLabel(minutes)}. Back at ${timeLabel(until)}.`]
    }],
    actions: [[
      { label: "I'm back", action: "back" },
      { label: "+30 min", action: "dive_extend|30" }
    ]]
  };
}

async function handleCapturedReminder({ db, user, item, userRemindersEnabled, now }) {
  if (!userRemindersEnabled) {
    return simpleReply("Reminders paused", "Reminder delivery is paused right now, so nothing was saved.");
  }
  if (item.invalidLocalTime) {
    return simpleReply("Reminder", "That Cairo time skips over the clock change. Pick another time.");
  }
  if (item.pastTime) {
    const draft = await saveCaptureDraft(db, {
      userId: user.id,
      intent: "reminder_past",
      payload: {
        title: item.title || "Reminder",
        time: item.time || "17:00"
      },
      now
    });
    return {
      category: "Reminder",
      title: "",
      sections: [{ heading: "", lines: ["That time's gone. Same time tomorrow?"] }],
      actions: [[
        { label: "✅ Yes", action: `cap_past_tmrw|${draft.id}` },
        { label: "Pick another", action: `cap_past_pick|${draft.id}` }
      ]]
    };
  }
  if (!item.time && !item.exactUtcIso) {
    const draft = await saveCaptureDraft(db, {
      userId: user.id,
      intent: "reminder_need_time",
      payload: {
        title: item.title || "",
        dueDate: item.due_date || null
      },
      now
    });
    await setConversationState(db, user.id, {
      type: "capture_reminder_time",
      draftId: draft.id
    }, now.toISOString());
    return {
      category: "Reminder",
      title: "",
      sections: [{ heading: "", lines: ["When should I ping you?"] }],
      actions: [
        [
          { label: "9:00 AM", action: `cap_rem_time|${draft.id}|09:00` },
          { label: "12:00 PM", action: `cap_rem_time|${draft.id}|12:00` }
        ],
        [
          { label: "5:00 PM", action: `cap_rem_time|${draft.id}|17:00` },
          { label: "Custom", action: `cap_rem_time|${draft.id}|custom` }
        ]
      ]
    };
  }

  let dueAtUtc = item.exactUtcIso;
  if (!dueAtUtc) {
    const dateKey = item.due_date || nextCairoDateForTime(item.time, now);
    if (!dateKey) {
      return simpleReply("Reminder", "That Cairo time skips over the clock change. Pick another time.");
    }
    const due = safeCairoDate(dateKey, item.time);
    if (!due) {
      return simpleReply("Reminder", "That Cairo time skips over the clock change. Pick another time.");
    }
    if (due.getTime() <= now.getTime()) {
      const draft = await saveCaptureDraft(db, {
        userId: user.id,
        intent: "reminder_past",
        payload: { title: item.title || "Reminder", time: item.time },
        now
      });
      return {
        category: "Reminder",
        title: "",
        sections: [{ heading: "", lines: ["That time's gone. Same time tomorrow?"] }],
        actions: [[
          { label: "✅ Yes", action: `cap_past_tmrw|${draft.id}` },
          { label: "Pick another", action: `cap_past_pick|${draft.id}` }
        ]]
      };
    }
    dueAtUtc = due.toISOString();
  }

  if (!item.title) {
    await setConversationState(db, user.id, {
      type: "reminder_text",
      dueAtUtc
    }, now.toISOString());
    return {
      category: "Reminder",
      title: "",
      sections: [{ heading: "", lines: ["What should I ping you about?"] }],
      inputMode: "force_reply",
      inputPlaceholder: "Short reminder"
    };
  }

  const saved = await createUserReminder({
    db,
    user,
    text: item.title,
    dueAtUtc,
    now: now.toISOString()
  });
  return renderReminderSaved(saved, now);
}

export function renderReminderSaved(saved, now) {
  const today = cairoDateKey(now);
  const remDate = cairoDateKey(new Date(saved.dueAtUtc));
  const when = remDate === today
    ? `today at ${timeLabel(saved.dueAtUtc)}`
    : `${weekdayDay(remDate)} at ${timeLabel(saved.dueAtUtc)}`;
  return {
    category: "Reminder",
    title: "",
    sections: [{
      heading: "",
      lines: [`Got it. I'll ping you to ${lowerFirst(saved.text)} ${when}. ⏰`]
    }],
    actions: [[
      { label: "↩ Undo", action: `reminder_undo|${saved.id}` },
      { label: "⏰ Change time", action: `reminder_chg|${saved.id}` }
    ]]
  };
}

async function handleCapturedTask({ db, user, item, keywordMap, now }) {
  const title = item.title || "Untitled task";
  const area = item.area || guessArea(title, keywordMap);
  const priority = item.priority || "Medium";
  const dueDate = item.due_date || null;

  // If the user typed the exact name of an existing open task, offer Edit vs Add new.
  const pending = await listPendingTaskPlanningCandidates(db, cairoDateKey(now), 50);
  const norm = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const exactMatch = pending.find(t => t.google_task_id && norm(t.title) === norm(title));

  const draft = await saveCaptureDraft(db, {
    userId: user.id,
    intent: "task",
    payload: {
      title,
      description: item.description || null,
      area,
      priority,
      dueDate,
      time: item.time || null
    },
    now
  });
  if (exactMatch) {
    return {
      category: "Task match",
      title: "",
      sections: [{
        heading: "",
        lines: [`“${exactMatch.title}” is already open. Edit it or add a new one?`]
      }],
      actions: [[
        { label: "✏️ Edit it", action: `task_open|${exactMatch.google_task_id}` },
        { label: "➕ Add new", action: `cap_save|${draft.id}` },
        { label: "✖", action: `cap_cancel|${draft.id}` }
      ]]
    };
  }
  return renderTaskCard(draft);
}

export function renderTaskCard(draft) {
  const p = draft.payload;
  const statusDot = p.priority === "High" ? "🔴" : p.priority === "Low" ? "⚪" : "🟡";
  const dueText = p.dueDate ? `Due ${weekdayDay(p.dueDate)}` : "No deadline";
  const priText = p.priority && p.priority !== "Medium" ? ` · ${p.priority}` : "";
  return {
    category: "Capture task",
    title: "",
    sections: [{
      heading: "",
      lines: [
        `📝 ${p.title}`,
        `${statusDot} ${dueText} · ${displayAreaName(p.area)}${priText}`
      ]
    }],
    actions: [[
      { label: "✅ Save", action: `cap_save|${draft.id}` },
      { label: "✏ Change", action: `cap_edit|${draft.id}` },
      { label: "✖", action: `cap_cancel|${draft.id}` }
    ]]
  };
}

async function handleCapturedSchedule({ db, user, item, keywordMap, googleTasks, googleCalendar, now }) {
  if (item.invalidLocalTime) {
    return simpleReply("Schedule", "That Cairo time skips over the clock change. Pick another time.");
  }
  if (item.pastTime) {
    const draft = await saveCaptureDraft(db, {
      userId: user.id,
      intent: "schedule_past",
      payload: {
        title: item.title || "Focus block",
        time: item.time || "15:00",
        durationMin: item.duration_min === 25 ? 25 : 50,
        area: item.area || guessArea(item.title || "", keywordMap),
        priority: item.priority || "Medium"
      },
      now
    });
    return {
      category: "Schedule",
      title: "",
      sections: [{ heading: "", lines: ["That time's gone. Same time tomorrow?"] }],
      actions: [[
        { label: "✅ Yes", action: `cap_past_tmrw|${draft.id}` },
        { label: "Pick another", action: `cap_past_pick|${draft.id}` }
      ]]
    };
  }

  const dateKey = item.due_date || (item.time ? nextCairoDateForTime(item.time, now) : cairoDateKey(now));
  const time = item.time;
  if (!time) {
    return handleCapturedTask({ db, user, item, keywordMap, now });
  }
  const startDt = safeCairoDate(dateKey, time);
  if (!startDt || startDt.getTime() <= now.getTime()) {
    const draft = await saveCaptureDraft(db, {
      userId: user.id,
      intent: "schedule_past",
      payload: {
        title: item.title || "Focus block",
        time,
        durationMin: item.duration_min === 25 ? 25 : 50,
        area: item.area || guessArea(item.title || "", keywordMap),
        priority: item.priority || "Medium"
      },
      now
    });
    return {
      category: "Schedule",
      title: "",
      sections: [{ heading: "", lines: ["That time's gone. Same time tomorrow?"] }],
      actions: [[
        { label: "✅ Yes", action: `cap_past_tmrw|${draft.id}` },
        { label: "Pick another", action: `cap_past_pick|${draft.id}` }
      ]]
    };
  }

  const durationMin = item.duration_min === 25 ? 25 : 50;
  const title = item.title || "Focus block";
  const area = item.area || guessArea(title, keywordMap);

  const pending = await listPendingTaskPlanningCandidates(db, cairoDateKey(now), 50);
  const matches = matchPendingTasks(pending, title);
  const matchedTask = matches[0] || null;

  const conflictLine = await checkCalendarConflictLine({
    googleCalendar,
    dateKey,
    startDt,
    durationMin
  });

  const draft = await saveCaptureDraft(db, {
    userId: user.id,
    intent: "schedule",
    payload: {
      title,
      dateKey,
      time,
      durationMin,
      area,
      priority: item.priority || "Medium",
      matchedTaskId: matchedTask ? matchedTask.id : null,
      matchedGoogleTaskId: matchedTask ? matchedTask.google_task_id : null,
      conflictLine
    },
    now
  });
  return renderScheduleCard(draft);
}

export function renderScheduleCard(draft) {
  const p = draft.payload;
  const startDt = safeCairoDate(p.dateKey, p.time);
  const endDt = startDt ? new Date(startDt.getTime() + p.durationMin * 60_000) : null;
  const range = startDt && endDt ? `${timeLabel(startDt)} – ${timeLabel(endDt)}` : p.time;
  const lines = [
    `📅 ${p.title}`,
    `${weekdayDay(p.dateKey)} · ${range} · ${displayAreaName(p.area)}`
  ];
  if (p.conflictLine) lines.push(p.conflictLine);
  return {
    category: "Schedule",
    title: "",
    sections: [{ heading: "", lines }],
    actions: [
      [
        { label: "✅ Add block", action: `cap_sched_add|${draft.id}` },
        { label: "✖", action: `cap_cancel|${draft.id}` }
      ],
      [
        { label: p.durationMin === 25 ? "✓ 25 min" : "25 min", action: `cap_sched_dur|${draft.id}|25` },
        { label: p.durationMin === 50 ? "✓ 50 min" : "50 min", action: `cap_sched_dur|${draft.id}|50` }
      ]
    ]
  };
}

async function handleCapturedDone({ db, user, item, googleTasks, now }) {
  if (googleTasks) {
    try {
      const tasks = await googleTasks.listAll();
      await syncGoogleTaskMirrors(db, tasks, now.toISOString());
    } catch {}
  }
  const pending = await listPendingTaskPlanningCandidates(db, cairoDateKey(now), 50);
  const hint = item.target_hint || item.title || "";
  const matches = matchPendingTasks(pending, hint);
  if (!matches.length) {
    return simpleReply("Done", `Didn't find an open task matching "${hint || "that"}". Check /stack?`);
  }
  if (matches.length === 1) {
    const task = matches[0];
    const draft = await saveCaptureDraft(db, {
      userId: user.id,
      intent: "done",
      payload: { taskId: task.id, googleTaskId: task.google_task_id, title: task.title },
      now
    });
    return {
      category: "Done",
      title: "",
      sections: [{ heading: "", lines: [`Mark “${task.title}” done?`] }],
      actions: [[
        { label: "✅ Yes", action: `cap_done_yes|${draft.id}` },
        { label: "No", action: `cap_cancel|${draft.id}` }
      ]]
    };
  }

  const top3 = matches.slice(0, 3);
  const draft = await saveCaptureDraft(db, {
    userId: user.id,
    intent: "done_pick",
    payload: {
      options: top3.map(t => ({
        taskId: t.id,
        googleTaskId: t.google_task_id,
        title: t.title
      }))
    },
    now
  });
  const rows = [];
  if (top3.length >= 2) {
    rows.push(top3.slice(0, 2).map((t, i) => ({
      label: truncateLabel(t.title, 14),
      action: `cap_done_pick|${draft.id}|${i}`
    })));
  }
  const row2 = [];
  if (top3.length === 3) {
    row2.push({ label: truncateLabel(top3[2].title, 14), action: `cap_done_pick|${draft.id}|2` });
  }
  row2.push({ label: "✖", action: `cap_cancel|${draft.id}` });
  rows.push(row2);
  return {
    category: "Done",
    title: "",
    sections: [{
      heading: "",
      lines: [
        "Which one did you finish?",
        ...top3.map((t, i) => `${i + 1}. ${t.title}`)
      ]
    }],
    actions: rows
  };
}

async function handleCapturedReschedule({ db, user, item, googleTasks, now }) {
  if (googleTasks) {
    try {
      const tasks = await googleTasks.listAll();
      await syncGoogleTaskMirrors(db, tasks, now.toISOString());
    } catch {}
  }
  const pending = await listPendingTaskPlanningCandidates(db, cairoDateKey(now), 50);
  const hint = item.target_hint || item.title || "";
  const matches = matchPendingTasks(pending, hint);
  if (!matches.length) {
    return simpleReply("Reschedule", `Didn't find an open task matching "${hint || "that"}". Check /stack?`);
  }
  const task = matches[0];
  const newDue = item.due_date;
  if (!newDue) {
    return simpleReply("Reschedule", `Move “${task.title}” to what date?`);
  }
  const draft = await saveCaptureDraft(db, {
    userId: user.id,
    intent: "reschedule",
    payload: {
      taskId: task.id,
      googleTaskId: task.google_task_id,
      title: task.title,
      dueDate: newDue
    },
    now
  });
  return {
    category: "Reschedule",
    title: "",
    sections: [{
      heading: "",
      lines: [`Move “${task.title}” to ${weekdayDay(newDue)}?`]
    }],
    actions: [[
      { label: "✅ Yes", action: `cap_resched_yes|${draft.id}` },
      { label: "Pick date", action: `cap_resched_pick|${draft.id}` }
    ]]
  };
}

async function handleCapturedConversation({
  db,
  user,
  text,
  item,
  googleTasks,
  googleCalendar,
  conversationResponder = null,
  onBeforeAiCall = null,
  now
}) {
  const lower = String(text || "").toLowerCase();
  const facts = await buildConversationFacts({ db, user, googleCalendar, now });
  const name = facts.name || "Martino";
  const date = facts.today.date;

  // Workers AI persona (single call, validated output, deterministic fallback below)
  if (conversationResponder) {
    if (onBeforeAiCall) {
      try {
        await onBeforeAiCall();
      } catch {}
    }
    try {
      const aiReply = await conversationResponder({
        text,
        facts,
        recentTurns: facts.recentTurns,
        now
      });
      if (aiReply) {
        await appendChatTurn(db, user.id, "assistant", aiReply, now);
        return simpleReply(item.intent === "question" ? "Answer" : "Chat", aiReply);
      }
    } catch {}
  }

  // Deterministic grounded fallback (still warm and human)
  if (/\b(?:tired|exhausted|drained|stressed|overwhelmed|stuck|burnt out|burned out|sleepy)\b/i.test(lower)) {
    const reply = `Take a breather, ${name}. No rush right now—want to rest or take one tiny step?`;
    await appendChatTurn(db, user.id, "assistant", reply, now);
    return simpleReply("Chat", reply);
  }

  if (item.intent === "question") {
    if (/\b(?:free|busy|calendar|schedule|available)\b/i.test(lower)) {
      const timeMatch = lower.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
      if (facts.calendarStatus === "disabled") {
        const reply = "Calendar's disconnected right now, bro, so I can't check your slots.";
        await appendChatTurn(db, user.id, "assistant", reply, now);
        return simpleReply("Answer", reply);
      }
      if (facts.calendarStatus === "unavailable") {
        const reply = "Calendar didn't answer right now, so I can't check your slots.";
        await appendChatTurn(db, user.id, "assistant", reply, now);
        return simpleReply("Answer", reply);
      }
      const events = facts.calendarEvents || [];
      if (timeMatch) {
        const parsedTime = (await import("./capture-router.js")).parseFlexibleTime(timeMatch[1], now);
        const checkStart = parsedTime ? safeCairoDate(date, parsedTime) : null;
        if (checkStart) {
          const checkEnd = new Date(checkStart.getTime() + 30 * 60_000);
          const hit = events.find(ev => {
            if (ev.allDay) return true;
            const s = Date.parse(ev.startTime || "");
            const e = Date.parse(ev.endTime || "");
            return Number.isFinite(s) && Number.isFinite(e) && s < checkEnd.getTime() && e > checkStart.getTime();
          });
          const reply = hit
            ? `Busy at ${timeLabel(checkStart)}—you've got ${hit.title}.`
            : `Yep, you're free at ${timeLabel(checkStart)}, ${name}.`;
          await appendChatTurn(db, user.id, "assistant", reply, now);
          return simpleReply("Answer", reply);
        }
      }
      const reply = events.length
        ? `You've got ${events.length} thing${events.length === 1 ? "" : "s"} on Calendar today, starting with ${events[0].title}.`
        : `Calendar's wide open today, ${name}.`;
      await appendChatTurn(db, user.id, "assistant", reply, now);
      return simpleReply("Answer", reply);
    }

    if (/\b(?:remind|reminder|reminders|ping)\b/i.test(lower)) {
      const nextRem = (facts.pendingReminders || [])[0];
      const reply = nextRem
        ? `Next ping is “${nextRem.text}” at ${nextRem.timeLabel || "soon"}.`
        : `No reminders queued up right now, ${name}.`;
      await appendChatTurn(db, user.id, "assistant", reply, now);
      return simpleReply("Answer", reply);
    }

    if (/\b(?:overdue|late|behind)\b/i.test(lower)) {
      const overdue = (facts.pendingTasks || []).filter(t => t.overdue);
      const reply = facts.overdueCount
        ? `${facts.overdueCount} overdue right now, starting with ${overdue[0].title}. Want to knock one out?`
        : `Nothing overdue, ${name}. You're caught up.`;
      await appendChatTurn(db, user.id, "assistant", reply, now);
      return simpleReply("Answer", reply);
    }

    const pending = facts.pendingTasks || [];
    if (/\bnext\b/i.test(lower)) {
      const openOutcome = (facts.todayOutcomes || []).find(o => o.status !== "Completed");
      const next = openOutcome ? { title: openOutcome.outcome, dueLabel: null } : pending[0];
      const reply = next
        ? `Next up is ${next.title}${next.dueLabel ? ` (${next.dueLabel})` : ""}. Ready when you are.`
        : `Nothing pending on your list, ${name}. Clean slate.`;
      await appendChatTurn(db, user.id, "assistant", reply, now);
      return simpleReply("Answer", reply);
    }

    if (/\b(?:today|day|plate|plan)\b/i.test(lower)) {
      const dueOrOverdue = pending.filter(t => t.dueDate && t.dueDate <= date);
      const calCount = facts.calendarStatus === "ok" ? (facts.calendarEvents || []).length : 0;
      const calNote = calCount ? ` Plus ${calCount} on Calendar.` : "";
      const reply = dueOrOverdue.length
        ? `Today you've got ${dueOrOverdue.length} task${dueOrOverdue.length === 1 ? "" : "s"}, starting with ${dueOrOverdue[0].title}.${calNote}`
        : `Nothing due today, ${name}.${calNote || " Pretty light day."}`;
      await appendChatTurn(db, user.id, "assistant", reply, now);
      return simpleReply("Answer", reply);
    }

    const top = pending[0];
    const reply = top
      ? `You have ${facts.openTaskCount} open task${facts.openTaskCount === 1 ? "" : "s"}; top one is ${top.title}.`
      : `Your task list is empty right now, ${name}.`;
    await appendChatTurn(db, user.id, "assistant", reply, now);
    return simpleReply("Answer", reply);
  }

  let reply;
  if (/\b(?:thanks|thank you|thx|appreciate)\b/i.test(lower)) {
    reply = `Anytime, ${name}. Got your back.`;
  } else if (/^(?:hey|yo|hi|hello|sup|what'?s up|morning|evening)\b/i.test(lower)) {
    reply = `Yo ${name}, good to hear from you. What's the move?`;
  } else {
    reply = `Hey ${name}, all ears. Drop a task, set a ping, or ask about your day.`;
  }
  await appendChatTurn(db, user.id, "assistant", reply, now);
  return simpleReply("Chat", reply);
}

function renderMultiCaptureCard(draft) {
  const items = draft.payload.items || [];
  const lines = [
    `Found ${items.length} things`,
    ...items.map((item, idx) =>
      `${item.selected ? "☑" : "☐"} ${idx + 1}. ${item.title} · ${displayAreaName(item.area)}`
    )
  ];
  const actions = [];
  if (items.length <= 3) {
    actions.push(items.map((item, idx) => ({
      label: `${item.selected ? "☑" : "☐"} ${idx + 1}`,
      action: `cap_multi_tog|${draft.id}|${idx}`
    })));
    actions.push([
      { label: "✅ Save", action: `cap_multi_save|${draft.id}` },
      { label: "✖", action: `cap_cancel|${draft.id}` }
    ]);
  } else {
    actions.push(items.slice(0, 3).map((item, idx) => ({
      label: `${item.selected ? "☑" : "☐"} ${idx + 1}`,
      action: `cap_multi_tog|${draft.id}|${idx}`
    })));
    actions.push([
      { label: "✅ Save", action: `cap_multi_save|${draft.id}` },
      { label: "✖", action: `cap_cancel|${draft.id}` }
    ]);
  }
  return {
    category: "Capture list",
    title: "",
    sections: [{ heading: "", lines }],
    actions
  };
}

export async function handleCaptureCallback({
  db,
  user,
  identifier,
  googleTasks,
  googleCalendar,
  createCapturedTaskFn,
  conversationResponder = null,
  onBeforeAiCall = null,
  userRemindersEnabled,
  companionEnabled,
  now
}) {
  const parts = identifier.split("|");
  const action = parts[0];
  const draftId = parts[1];

  if (action === "reminder_undo") {
    const remId = parts[1];
    await db.prepare("UPDATE reminders SET status = 'cancelled' WHERE id = ?1 AND user_id = ?2")
      .bind(remId, user.id).run();
    return simpleReply("Reminder", "Undone—dropped that reminder.");
  }

  if (action === "reminder_chg") {
    const remId = parts[1];
    const row = await db.prepare("SELECT id, text FROM reminders WHERE id = ?1 AND user_id = ?2")
      .bind(remId, user.id).first();
    if (!row) return simpleReply("Reminder", "That reminder's gone.");
    await setConversationState(db, user.id, {
      type: "capture_reminder_edit_time",
      reminderId: remId,
      text: row.text
    }, now.toISOString());
    return {
      category: "Reminder",
      title: "",
      sections: [{ heading: "", lines: ["When should I ping you instead?"] }],
      inputMode: "force_reply",
      inputPlaceholder: "5:00 PM or tomorrow 9am"
    };
  }

  const draft = draftId ? await getCaptureDraft(db, draftId, user.id) : null;
  if (!draft) return simpleReply("Capture", "That card's old. Just type what you need.");

  if (action === "cap_cancel") {
    await updateCaptureDraft(db, draft.id, draft.payload, { status: "cancelled" });
    await clearConversationState(db, user.id);
    return simpleReply("Capture", "Dropped it. Nothing saved.");
  }

  if (action === "cap_save") {
    if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
    const p = draft.payload;
    await createCapturedTaskFn({
      db,
      user,
      state: {
        requestId: draft.requestId,
        title: p.title,
        area: p.area || "Other",
        priority: p.priority || "Medium",
        dueDate: p.dueDate || "",
        doneTest: p.description || ""
      },
      addToTop3: false,
      googleTasks,
      googleCalendar: null,
      now,
      clearConversation: true
    });
    await updateCaptureDraft(db, draft.id, p, { status: "saved" });
    const duePhrase = p.dueDate ? `, due ${weekdayDay(p.dueDate)}` : "";
    return simpleReply("Capture saved", `Locked in: ${p.title}${duePhrase}.`);
  }

  if (action === "cap_edit") {
    return {
      category: "Edit capture",
      title: "",
      sections: [{ heading: "", lines: [`📝 ${draft.payload.title} — what do you want to tweak?`] }],
      actions: [
        [
          { label: "Date", action: `cap_field|${draft.id}|date` },
          { label: "Area", action: `cap_field|${draft.id}|area` }
        ],
        [
          { label: "Priority", action: `cap_field|${draft.id}|pri` },
          { label: "Calendar", action: `cap_field|${draft.id}|cal` }
        ]
      ]
    };
  }

  if (action === "cap_field") {
    const field = parts[2];
    if (field === "date") {
      const today = cairoDateKey(now);
      const tmrw = shiftDateKey(today, 1);
      const fri = resolveWeekdayDate("friday", now);
      return {
        category: "Edit capture",
        title: "",
        sections: [{ heading: "", lines: [`Pick a date for “${draft.payload.title}”:`] }],
        actions: [
          [
            { label: "Today", action: `cap_set_due|${draft.id}|${today}` },
            { label: "Tomorrow", action: `cap_set_due|${draft.id}|${tmrw}` }
          ],
          [
            { label: weekdayDay(fri), action: `cap_set_due|${draft.id}|${fri}` },
            { label: "No date", action: `cap_set_due|${draft.id}|none` }
          ]
        ]
      };
    }
    if (field === "area") {
      return {
        category: "Edit capture",
        title: "",
        sections: [{ heading: "", lines: [`Pick an area for “${draft.payload.title}”:`] }],
        actions: [
          [
            { label: "🌱 Growth", action: `cap_set_area|${draft.id}|DEEP` },
            { label: "💼 Work", action: `cap_set_area|${draft.id}|WORK` }
          ],
          [
            { label: "🏠 Life", action: `cap_set_area|${draft.id}|LIFE` },
            { label: "⋯ Other", action: `cap_set_area|${draft.id}|Other` }
          ]
        ]
      };
    }
    if (field === "pri") {
      return {
        category: "Edit capture",
        title: "",
        sections: [{ heading: "", lines: [`Pick priority for “${draft.payload.title}”:`] }],
        actions: [[
          { label: "High", action: `cap_set_pri|${draft.id}|High` },
          { label: "Medium", action: `cap_set_pri|${draft.id}|Medium` },
          { label: "Low", action: `cap_set_pri|${draft.id}|Low` }
        ]]
      };
    }
    if (field === "cal") {
      const p = draft.payload;
      if (p.time) {
        const dateKey = p.dueDate || nextCairoDateForTime(p.time, now) || cairoDateKey(now);
        const startDt = safeCairoDate(dateKey, p.time);
        const conflictLine = startDt
          ? await checkCalendarConflictLine({ googleCalendar, dateKey, startDt, durationMin: 50 })
          : null;
        const nextPayload = {
          title: p.title,
          dateKey,
          time: p.time,
          durationMin: 50,
          area: p.area || "Other",
          priority: p.priority || "Medium",
          conflictLine
        };
        await updateCaptureDraft(db, draft.id, nextPayload, { intent: "schedule" });
        return renderScheduleCard({ ...draft, payload: nextPayload });
      }
      await setConversationState(db, user.id, {
        type: "capture_schedule_time",
        draftId: draft.id
      }, now.toISOString());
      return {
        category: "Schedule",
        title: "",
        sections: [{ heading: "", lines: [`What time for “${p.title}”?`] }],
        actions: [
          [
            { label: "3:00 PM", action: `cap_sched_t|${draft.id}|15:00` },
            { label: "5:00 PM", action: `cap_sched_t|${draft.id}|17:00` }
          ],
          [
            { label: "8:00 PM", action: `cap_sched_t|${draft.id}|20:00` },
            { label: "✖", action: `cap_cancel|${draft.id}` }
          ]
        ]
      };
    }
  }

  if (action === "cap_set_due") {
    const val = parts[2];
    draft.payload.dueDate = val === "none" ? null : val;
    await updateCaptureDraft(db, draft.id, draft.payload);
    return renderTaskCard(draft);
  }
  if (action === "cap_set_area") {
    draft.payload.area = parts[2];
    await updateCaptureDraft(db, draft.id, draft.payload);
    return renderTaskCard(draft);
  }
  if (action === "cap_set_pri") {
    draft.payload.priority = parts[2];
    await updateCaptureDraft(db, draft.id, draft.payload);
    return renderTaskCard(draft);
  }

  if (action === "cap_sched_t") {
    const time = parts[2];
    const p = draft.payload;
    const dateKey = p.dueDate || nextCairoDateForTime(time, now) || cairoDateKey(now);
    const startDt = safeCairoDate(dateKey, time);
    const conflictLine = startDt
      ? await checkCalendarConflictLine({ googleCalendar, dateKey, startDt, durationMin: 50 })
      : null;
    const nextPayload = {
      title: p.title,
      dateKey,
      time,
      durationMin: 50,
      area: p.area || "Other",
      priority: p.priority || "Medium",
      conflictLine
    };
    await clearConversationState(db, user.id);
    await updateCaptureDraft(db, draft.id, nextPayload, { intent: "schedule" });
    return renderScheduleCard({ ...draft, payload: nextPayload });
  }

  if (action === "cap_sched_dur") {
    const durationMin = Number(parts[2]) === 25 ? 25 : 50;
    draft.payload.durationMin = durationMin;
    const startDt = safeCairoDate(draft.payload.dateKey, draft.payload.time);
    draft.payload.conflictLine = startDt
      ? await checkCalendarConflictLine({
          googleCalendar,
          dateKey: draft.payload.dateKey,
          startDt,
          durationMin
        })
      : null;
    await updateCaptureDraft(db, draft.id, draft.payload);
    return renderScheduleCard(draft);
  }

  if (action === "cap_sched_add") {
    if (!googleCalendar || !googleCalendar.createTaskBlock) {
      return simpleReply("Schedule", "Calendar writes aren't turned on right now, so nothing was booked.");
    }
    if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
    const p = draft.payload;
    if (draft.status === "saved") {
      return simpleReply("Schedule", `Already on your calendar: ${p.title} (${weekdayDay(p.dateKey)} at ${timeLabel(safeCairoDate(p.dateKey, p.time))}).`);
    }
    const startDt = safeCairoDate(p.dateKey, p.time);
    if (!startDt || startDt.getTime() <= now.getTime()) {
      return simpleReply("Schedule", "That time's gone. Pick a future slot.");
    }

    let taskId = p.matchedTaskId;
    if (!taskId) {
      const created = await createCapturedTaskFn({
        db,
        user,
        state: {
          requestId: `${draft.requestId}-TASK`,
          title: p.title,
          area: p.area || "Other",
          priority: p.priority || "Medium",
          dueDate: p.dateKey || "",
          doneTest: ""
        },
        addToTop3: false,
        googleTasks,
        googleCalendar: null,
        now,
        clearConversation: false
      });
      const mirror = await db.prepare("SELECT id FROM tasks WHERE title = ?1 ORDER BY updated_at DESC LIMIT 1")
        .bind(p.title).first();
      taskId = (mirror && mirror.id) || `TASK-${draft.requestId}`;
      void created;
    }

    const blockKey = `CAL-${draft.requestId}`;
    const event = await googleCalendar.createTaskBlock({
      idempotencyKey: blockKey,
      title: `Focus: ${p.title}`,
      date: p.dateKey,
      startTime: p.time,
      durationMinutes: p.durationMin,
      description: `Focused work block for ${p.title}.`,
      notBefore: now.toISOString()
    });
    if (!event || !event.id || !event.start || !event.end) {
      throw new Error("Google Calendar returned a focus block without its event details.");
    }
    await db.prepare(
      `INSERT INTO calendar_blocks (
         id, task_id, calendar_request_id, google_event_id, title, start_at, end_at, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(calendar_request_id) DO NOTHING`
    ).bind(
      `BLOCK-${blockKey}`,
      taskId,
      blockKey,
      event.id,
      p.title,
      event.start.dateTime,
      event.end.dateTime,
      now.toISOString()
    ).run();
    await updateCaptureDraft(db, draft.id, p, { status: "saved" });
    return simpleReply(
      "Schedule",
      `Locked in on your calendar: ${p.title}, ${weekdayDay(p.dateKey)} at ${timeLabel(startDt)}. 📅`
    );
  }

  if (action === "cap_done_yes" || action === "cap_done_pick") {
    if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
    const target = action === "cap_done_yes"
      ? draft.payload
      : (draft.payload.options || [])[Number(parts[2])];
    if (!target || !target.googleTaskId) {
      return simpleReply("Done", "Couldn't find that task anymore.");
    }
    const existing = await db.prepare("SELECT id, status FROM tasks WHERE google_task_id = ?1")
      .bind(target.googleTaskId).first();
    if (!existing || existing.status !== "Pending") {
      await updateCaptureDraft(db, draft.id, draft.payload, { status: "saved" });
      return simpleReply("Done", `“${target.title}” is already marked done.`);
    }
    const completed = await googleTasks.complete(target.googleTaskId);
    await upsertGoogleTaskMirror(db, completed, now.toISOString());
    await updateCaptureDraft(db, draft.id, draft.payload, { status: "saved" });
    return simpleReply("Done", `Nice work, Martino. “${target.title}” is done.`);
  }

  if (action === "cap_resched_yes") {
    if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
    const p = draft.payload;
    if (draft.status === "saved") {
      return simpleReply("Reschedule", `Already moved “${p.title}” to ${weekdayDay(p.dueDate)}.`);
    }
    const updated = await googleTasks.reschedule(p.googleTaskId, p.dueDate);
    await upsertGoogleTaskMirror(db, updated, now.toISOString());
    await updateCaptureDraft(db, draft.id, p, { status: "saved" });
    return simpleReply("Reschedule", `Moved “${p.title}” to ${weekdayDay(p.dueDate)}.`);
  }

  if (action === "cap_resched_pick") {
    await setConversationState(db, user.id, {
      type: "capture_resched_date",
      draftId: draft.id
    }, now.toISOString());
    return {
      category: "Reschedule",
      title: "",
      sections: [{ heading: "", lines: [`What date works for “${draft.payload.title}”?`] }],
      inputMode: "force_reply",
      inputPlaceholder: "Friday or 11/28/2026"
    };
  }

  if (action === "cap_rem_time") {
    if (!userRemindersEnabled) return simpleReply("Reminders paused", "Reminder delivery is paused right now.");
    const choice = parts[2];
    if (choice === "custom") {
      await setConversationState(db, user.id, {
        type: "capture_reminder_time",
        draftId: draft.id
      }, now.toISOString());
      return {
        category: "Reminder",
        title: "",
        sections: [{ heading: "", lines: ["Type a time, like 3:00 PM or tomorrow 9am."] }],
        inputMode: "force_reply",
        inputPlaceholder: "3:00 PM"
      };
    }
    const dateKey = draft.payload.dueDate || nextCairoDateForTime(choice, now);
    const due = dateKey ? safeCairoDate(dateKey, choice) : null;
    if (!due || due.getTime() <= now.getTime()) {
      return simpleReply("Reminder", "That time's gone. Pick another one.");
    }
    if (!draft.payload.title) {
      await setConversationState(db, user.id, {
        type: "reminder_text",
        dueAtUtc: due.toISOString()
      }, now.toISOString());
      return {
        category: "Reminder",
        title: "",
        sections: [{ heading: "", lines: ["What should I ping you about?"] }],
        inputMode: "force_reply",
        inputPlaceholder: "Short reminder"
      };
    }
    const saved = await createUserReminder({
      db,
      user,
      text: draft.payload.title,
      dueAtUtc: due.toISOString(),
      now: now.toISOString(),
      requestId: draft.requestId
    });
    await clearConversationState(db, user.id);
    await updateCaptureDraft(db, draft.id, draft.payload, { status: "saved" });
    return renderReminderSaved(saved, now);
  }

  if (action === "cap_past_tmrw") {
    const p = draft.payload;
    const tomorrow = shiftDateKey(cairoDateKey(now), 1);
    if (draft.intent === "reminder_past") {
      if (!userRemindersEnabled) return simpleReply("Reminders paused", "Reminder delivery is paused right now.");
      const due = safeCairoDate(tomorrow, p.time || "17:00");
      if (!due) return simpleReply("Reminder", "That Cairo time skips over the clock change. Pick another time.");
      const saved = await createUserReminder({
        db,
        user,
        text: p.title || "Reminder",
        dueAtUtc: due.toISOString(),
        now: now.toISOString(),
        requestId: draft.requestId
      });
      await updateCaptureDraft(db, draft.id, p, { status: "saved" });
      return renderReminderSaved(saved, now);
    }
    const nextPayload = { ...p, dateKey: tomorrow };
    const startDt = safeCairoDate(tomorrow, p.time);
    nextPayload.conflictLine = startDt
      ? await checkCalendarConflictLine({ googleCalendar, dateKey: tomorrow, startDt, durationMin: p.durationMin || 50 })
      : null;
    await updateCaptureDraft(db, draft.id, nextPayload, { intent: "schedule" });
    return renderScheduleCard({ ...draft, payload: nextPayload });
  }

  if (action === "cap_past_pick") {
    await setConversationState(db, user.id, {
      type: draft.intent === "reminder_past" ? "capture_reminder_time" : "capture_schedule_time",
      draftId: draft.id
    }, now.toISOString());
    return {
      category: "Time",
      title: "",
      sections: [{ heading: "", lines: ["Type the date and time you want."] }],
      inputMode: "force_reply",
      inputPlaceholder: "Tomorrow 5pm"
    };
  }

  if (action === "cap_sleep_yes") {
    if (!companionEnabled) return simpleReply("Rest mode paused", "Sleep and dive controls are paused right now.");
    const wake = new Date(draft.payload.wakeAtIso);
    await startSleep({ db, user, wakeAt: wake, now });
    await updateCaptureDraft(db, draft.id, draft.payload, { status: "saved" });
    const mins = Math.round((wake.getTime() - now.getTime()) / 60_000);
    return simpleReply(
      "Sleep",
      `Locked in. I'll wake you at ${timeLabel(wake)} ⏰ (${durationLabel(mins)} from now). Quiet till then.`
    );
  }

  if (action === "cap_sleep_chg") {
    await setConversationState(db, user.id, { type: "sleep_time_custom" }, now.toISOString());
    return {
      category: "Sleep",
      title: "",
      sections: [{ heading: "", lines: ["What wake time? (like 7:30 AM)"] }],
      inputMode: "force_reply",
      inputPlaceholder: "7:30 AM"
    };
  }

  if (action === "cap_multi_tog") {
    const idx = Number(parts[2]);
    const items = draft.payload.items || [];
    if (items[idx]) items[idx].selected = !items[idx].selected;
    await updateCaptureDraft(db, draft.id, draft.payload);
    return renderMultiCaptureCard(draft);
  }

  if (action === "cap_multi_save") {
    if (!googleTasks) throw new Error("Google Tasks integration is not configured.");
    const selected = (draft.payload.items || []).filter(item => item.selected);
    if (!selected.length) {
      return simpleReply("Capture", "Nothing selected. Dropped it.");
    }
    if (draft.status !== "saved") {
      for (let i = 0; i < selected.length; i++) {
        const item = selected[i];
        await createCapturedTaskFn({
          db,
          user,
          state: {
            requestId: `${draft.requestId}-${i}`,
            title: item.title,
            area: item.area || "Other",
            priority: item.priority || "Medium",
            dueDate: item.dueDate || "",
            doneTest: ""
          },
          addToTop3: false,
          googleTasks,
          googleCalendar: null,
          now,
          clearConversation: false
        });
      }
      await updateCaptureDraft(db, draft.id, draft.payload, { status: "saved" });
    }
    return simpleReply("Capture saved", `Locked in ${selected.length} task${selected.length === 1 ? "" : "s"}.`);
  }

  if (action === "cap_unk") {
    const choice = parts[2];
    const rawText = draft.payload.rawText || "";
    if (choice === "chat") {
      await updateCaptureDraft(db, draft.id, draft.payload, { status: "saved" });
      if (rawText) {
        return handleCapturedConversation({
          db,
          user,
          text: rawText,
          item: { intent: "chat" },
          googleTasks,
          googleCalendar,
          conversationResponder,
          onBeforeAiCall,
          now
        });
      }
      return simpleReply("Chat", "Bet. What's on your mind?");
    }
    if (choice === "rem") {
      if (!userRemindersEnabled) return simpleReply("Reminders paused", "Reminder delivery is paused right now.");
      await updateCaptureDraft(db, draft.id, { title: rawText || "Reminder" }, { intent: "reminder_need_time" });
      return {
        category: "Reminder",
        title: "",
        sections: [{ heading: "", lines: ["When should I ping you?"] }],
        actions: [
          [
            { label: "9:00 AM", action: `cap_rem_time|${draft.id}|09:00` },
            { label: "12:00 PM", action: `cap_rem_time|${draft.id}|12:00` }
          ],
          [
            { label: "5:00 PM", action: `cap_rem_time|${draft.id}|17:00` },
            { label: "Custom", action: `cap_rem_time|${draft.id}|custom` }
          ]
        ]
      };
    }
    if (choice === "task") {
      await setConversationState(db, user.id, { type: "capture_awaiting_text" }, now.toISOString());
      return {
        category: "Capture",
        title: "",
        sections: [{ heading: "", lines: ["What's the move? Type it however you like."] }],
        inputMode: "force_reply",
        inputPlaceholder: "Call Ahmed tomorrow"
      };
    }
  }

  return simpleReply("Capture", "That button's old. Tap /hq for a fresh one.");
}

export async function handleCaptureConversationText({
  db,
  user,
  state,
  text,
  googleTasks,
  googleCalendar,
  captureParser,
  conversationResponder = null,
  onBeforeAiCall,
  userRemindersEnabled,
  companionEnabled,
  createCapturedTaskFn,
  now
}) {
  if (state.type === "capture_awaiting_text") {
    await clearConversationState(db, user.id);
    return routeMagicCapture({
      db,
      user,
      text,
      googleTasks,
      googleCalendar,
      captureParser,
      conversationResponder,
      onBeforeAiCall,
      userRemindersEnabled,
      companionEnabled,
      now
    });
  }

  if (state.type === "capture_reminder_edit_time") {
    const parsed = parseFastPathCapture(`remind me ${state.text} ${text}`, now);
    const item = parsed && parsed.items && parsed.items[0];
    if (!item || !item.time) {
      return simpleReply("Reminder", "Couldn't read that time—try something like 5:00 PM or tomorrow 9am.");
    }
    const dateKey = item.due_date || nextCairoDateForTime(item.time, now);
    const due = dateKey ? safeCairoDate(dateKey, item.time) : null;
    if (!due || due.getTime() <= now.getTime()) {
      return simpleReply("Reminder", "That time's gone. Pick a future time.");
    }
    await db.prepare("UPDATE reminders SET remind_at_utc = ?1, status = 'pending' WHERE id = ?2 AND user_id = ?3")
      .bind(due.toISOString(), state.reminderId, user.id).run();
    await clearConversationState(db, user.id);
    return renderReminderSaved({ id: state.reminderId, text: state.text, dueAtUtc: due.toISOString() }, now);
  }

  if (state.type === "capture_reminder_time") {
    const draft = await getCaptureDraft(db, state.draftId, user.id);
    if (!draft) {
      await clearConversationState(db, user.id);
      return simpleReply("Reminder", "That reminder card expired. Type it again.");
    }
    const parsed = parseFastPathCapture(`remind me ${draft.payload.title || "ping"} ${text}`, now);
    const item = parsed && parsed.items && parsed.items[0];
    let due = null;
    if (item && item.exactUtcIso) {
      due = new Date(item.exactUtcIso);
    } else if (item && item.time) {
      const dk = item.due_date || nextCairoDateForTime(item.time, now);
      due = dk ? safeCairoDate(dk, item.time) : null;
    } else {
      const dt = parseCairoDateTime(text, now);
      if (dt) due = safeCairoDate(dt.dateKey, dt.time);
    }
    if (!due || due.getTime() <= now.getTime()) {
      return simpleReply("Reminder", "Need a future time like 3:00 PM or tomorrow 9am.");
    }
    const saved = await createUserReminder({
      db,
      user,
      text: draft.payload.title || "Reminder",
      dueAtUtc: due.toISOString(),
      now: now.toISOString(),
      requestId: draft.requestId
    });
    await clearConversationState(db, user.id);
    await updateCaptureDraft(db, draft.id, draft.payload, { status: "saved" });
    return renderReminderSaved(saved, now);
  }

  if (state.type === "capture_schedule_time") {
    const draft = await getCaptureDraft(db, state.draftId, user.id);
    if (!draft) {
      await clearConversationState(db, user.id);
      return simpleReply("Schedule", "That card expired. Type it again.");
    }
    const parsed = parseFastPathCapture(`schedule ${draft.payload.title} ${text}`, now);
    const item = parsed && parsed.items && parsed.items[0];
    if (!item || !item.time) {
      return simpleReply("Schedule", "Need a time like 3:00 PM or tomorrow 5pm.");
    }
    const dateKey = item.due_date || nextCairoDateForTime(item.time, now);
    const startDt = dateKey ? safeCairoDate(dateKey, item.time) : null;
    if (!startDt || startDt.getTime() <= now.getTime()) {
      return simpleReply("Schedule", "That time's gone. Pick a future slot.");
    }
    const durationMin = item.duration_min || draft.payload.durationMin || 50;
    const conflictLine = await checkCalendarConflictLine({ googleCalendar, dateKey, startDt, durationMin });
    const nextPayload = {
      ...draft.payload,
      dateKey,
      time: item.time,
      durationMin,
      conflictLine
    };
    await clearConversationState(db, user.id);
    await updateCaptureDraft(db, draft.id, nextPayload, { intent: "schedule" });
    return renderScheduleCard({ ...draft, payload: nextPayload });
  }

  if (state.type === "capture_resched_date") {
    const draft = await getCaptureDraft(db, state.draftId, user.id);
    if (!draft) {
      await clearConversationState(db, user.id);
      return simpleReply("Reschedule", "That card expired. Type it again.");
    }
    const newDue = parseDateInput(text, now) || resolveWeekdayDate(text, now);
    if (!newDue || newDue < cairoDateKey(now)) {
      return simpleReply("Reschedule", "Give me a future date like Friday or 11/28.");
    }
    const updated = await googleTasks.reschedule(draft.payload.googleTaskId, newDue);
    await upsertGoogleTaskMirror(db, updated, now.toISOString());
    await clearConversationState(db, user.id);
    await updateCaptureDraft(db, draft.id, { ...draft.payload, dueDate: newDue }, { status: "saved" });
    return simpleReply("Reschedule", `Moved “${draft.payload.title}” to ${weekdayDay(newDue)}.`);
  }

  return null;
}

async function checkCalendarConflictLine({ googleCalendar, dateKey, startDt, durationMin }) {
  if (!googleCalendar || typeof googleCalendar.listEventsForDate !== "function") return null;
  try {
    const events = await googleCalendar.listEventsForDate(dateKey);
    const startMs = startDt.getTime();
    const endMs = startMs + durationMin * 60_000;
    const conflict = events.find(ev => {
      if (ev.allDay) return true;
      const evStart = Date.parse(ev.startTime || "");
      const evEnd = Date.parse(ev.endTime || "");
      return Number.isFinite(evStart) && Number.isFinite(evEnd) && evStart < endMs && evEnd > startMs;
    });
    if (!conflict) return null;
    const range = conflict.allDay ? "All day" : `${conflict.start} – ${conflict.end}`;
    return `Heads up: ${range} ${conflict.title} overlaps.`;
  } catch {
    return null;
  }
}

function safeCairoDate(dateKey, time) {
  try {
    return new Date(cairoLocalDateTimeToIso(dateKey, time));
  } catch {
    return null;
  }
}

function truncateLabel(text, max) {
  const s = String(text || "").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function lowerFirst(value) {
  const s = String(value || "").trim();
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : "";
}

function simpleReply(category, text) {
  return {
    category,
    title: "",
    sections: [{ heading: "", lines: [text] }],
    actions: [],
    replyKeyboardRows: [
      ["▶️ Go", "📝 Drop it"],
      ["🧭 Where I'm at", "🗓 Plan"],
      ["😴 Zzz", "📱 HQ"]
    ]
  };
}
