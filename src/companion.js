import {
  cairoDateKey,
  cairoTimeParts,
  durationLabel,
  parseTimeInput,
  shiftDateKey,
  timeLabel
} from "./core/format.js";
import { cairoLocalDateTimeToIso } from "./integrations/google-calendar.js";
import { logSystemEvent } from "./db/channel-repository.js";
import { say, selectToneTier } from "./core/voice.js";

export function parseDiveDuration(text) {
  const input = String(text || "").trim();
  const direct = input.match(/(?:\/dive\s*)?(\d+(?:[.\u066B]\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minutes)?/i);
  if (!direct) {
    if (/سيبني\s*(ساعتين|ساعة|ساعتين)/u.test(input)) {
      return /ساعتين/u.test(input) ? 120 : 60;
    }
    const arabic2 = input.match(/سيبني\s+(\d+)\s*(ساعة|ساعات)/u);
    if (arabic2) return Math.min(720, Math.max(15, Number(arabic2[1]) * 60));
  }
  if (!direct) return null;
  let amount = Number(direct[1].replace("\u066B", "."));
  const unit = (direct[2] || "").toLowerCase();
  const minutes = unit.startsWith("m") ? amount : unit ? amount * 60 : amount * 60;
  if (!Number.isFinite(minutes) || minutes < 15 || minutes > 720) return null;
  return Math.round(minutes);
}

export function parseSleepTime(text, now = new Date()) {
  const input = String(text || "").trim();
  const time = parseTimeInput(input);
  if (!time) return null;
  let date = cairoDateKey(now);
  let due = sleepDateTime(date, time);
  if (!due) return null;
  if (due.getTime() <= now.getTime()) {
    date = shiftDateKey(date, 1);
    due = sleepDateTime(date, time);
    if (!due) return null;
  }
  if (due.getTime() - now.getTime() > 24 * 60 * 60_000) return null;
  return due;
}

function sleepDateTime(dateKey, time) {
  try {
    return new Date(cairoLocalDateTimeToIso(dateKey, time));
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

export async function startDive({ db, user, minutes, now }) {
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 720) {
    throw new RangeError("Dive duration must be from 15 minutes to 12 hours.");
  }
  const until = new Date(now.getTime() + minutes * 60_000);
  await db.prepare(
    `INSERT INTO companion_state (
       user_id, cairo_date, consecutive_ignored, last_kind, last_proactive_at,
       sent_today_count, dive_until, awake_until, updated_at
     ) VALUES (?1, ?2, 0, 'dive', ?3, 0, ?4, NULL, ?5)
     ON CONFLICT(user_id) DO UPDATE SET
       cairo_date=excluded.cairo_date,
       dive_until=excluded.dive_until,
       last_kind='dive',
       updated_at=excluded.updated_at`
  ).bind(user.id, cairoDateKey(now), now.toISOString(), until.toISOString(), now.toISOString()).run();
  return until;
}

export async function endDive(db, userId, now) {
  await db.prepare(
    `UPDATE companion_state SET dive_until=NULL, updated_at=?1
      WHERE user_id=?2`
  ).bind(now.toISOString(), userId).run();
}

export async function startSleep({ db, user, wakeAt, now }) {
  const wake = wakeAt instanceof Date ? wakeAt : new Date(wakeAt);
  if (Number.isNaN(wake.getTime()) || wake.getTime() <= now.getTime() ||
      wake.getTime() - now.getTime() > 24 * 60 * 60_000) {
    throw new RangeError("Wake time must be in the future and within 24 hours.");
  }
  const id = `SLEEP-${crypto.randomUUID()}`;
  await db.prepare(
    `INSERT INTO sleep_sessions (
       id, user_id, started_at, wake_at, status, wake_sent_count
     ) VALUES (?1, ?2, ?3, ?4, 'active', 0)`
  ).bind(id, user.id, now.toISOString(), wake.toISOString()).run();
  await db.prepare(
    `INSERT INTO companion_state (
       user_id, cairo_date, consecutive_ignored, last_kind, last_proactive_at,
       sent_today_count, dive_until, awake_until, updated_at
     ) VALUES (?1, ?2, 0, 'sleep', ?3, 0, NULL, NULL, ?4)
     ON CONFLICT(user_id) DO UPDATE SET
       cairo_date=excluded.cairo_date,
       dive_until=NULL,
       awake_until=NULL,
       last_kind='sleep',
       updated_at=excluded.updated_at`
  ).bind(user.id, cairoDateKey(now), now.toISOString(), now.toISOString()).run();
  return id;
}

export async function processCompanion({
  db,
  telegram,
  now,
  authorizedTelegramUserId,
  googleTasks = null,
  googleCalendar = null,
  enabled = false
}) {
  if (!enabled) return { sent: 0, ignored: 0, cared: 0 };
  const target = await findTarget(db, authorizedTelegramUserId);
  if (!target) return { sent: 0, ignored: 0, cared: 0 };

  const settings = await loadCompanionSettings(db);
  const name = settings.display_name || "Martino";

  const activeSleep = await db.prepare(
    "SELECT id, wake_at, wake_sent_count, last_wake_sent_at FROM sleep_sessions WHERE user_id=?1 AND status='active' ORDER BY started_at DESC LIMIT 1"
  ).bind(target.userId).first();
  if (activeSleep) {
    const wakeAt = Date.parse(activeSleep.wake_at);
    if (now.getTime() >= wakeAt) {
      const sentCount = Number(activeSleep.wake_sent_count || 0);
      if (activeSleep.last_wake_sent_at &&
          now.getTime() - Date.parse(activeSleep.last_wake_sent_at) < 15 * 60_000) {
        return { sent: 0, ignored: 0, cared: 0 };
      }
      if (sentCount >= 3) {
        await db.prepare("UPDATE sleep_sessions SET status='no_answer' WHERE id=?1")
          .bind(activeSleep.id).run();
        return { sent: 0, ignored: 1, cared: 0 };
      }
      await db.prepare(
        `UPDATE sleep_sessions
            SET wake_sent_count=wake_sent_count+1, last_wake_sent_at=?1
          WHERE id=?2 AND status='active'`
      ).bind(now.toISOString(), activeSleep.id).run();
      const wakeKey = sentCount === 0 ? "sleep_wake" : sentCount === 1 ? "sleep_reping_2" : "sleep_reping_3";
      const line = say(wakeKey, { name, time: timeLabel(wakeAt), now }) ||
        `☀️ Rise and shine, ${name}. It's ${timeLabel(wakeAt)}. Ready to get after it?`;
      await telegram.sendAssistantResponse(target.chatId, {
        category: "Sleep wake",
        title: "",
        sections: [{ heading: "", lines: [line] }],
        actions: [[{ label: "☀️ I'm up", action: "sleep_up" }]]
      });
      return { sent: 1, ignored: 0, cared: 0 };
    }
    return { sent: 0, ignored: 0, cared: 0 };
  }

  const state = await db.prepare(
    `SELECT cairo_date, dive_until, paused_until, sent_today_count, consecutive_ignored,
            tier_override_until, last_proactive_at
       FROM companion_state
      WHERE user_id=?1`
  ).bind(target.userId).first();

  if (state && state.dive_until) {
    const diveUntilMs = Date.parse(state.dive_until);
    if (diveUntilMs > now.getTime()) {
      return { sent: 0, ignored: 0, cared: 0 };
    }
    // Dive ended: clear dive_until atomically and send welcome-back notification once.
    const cleared = await db.prepare(
      `UPDATE companion_state
          SET dive_until=NULL, last_kind='dive_end', updated_at=?1
        WHERE user_id=?2 AND dive_until IS NOT NULL
        RETURNING user_id`
    ).bind(now.toISOString(), target.userId).first();
    if (cleared) {
      const line = say("dive_end", { name, now }) || `🎧 Time's up, ${name}. Welcome back. What was the win?`;
      await telegram.sendAssistantResponse(target.chatId, {
        category: "Dive",
        title: "",
        sections: [{ heading: "", lines: [line] }],
        actions: [[
          { label: "▶️ Go", action: "focus_now" },
          { label: "📱 HQ", action: "home" }
        ]]
      });
      return { sent: 1, ignored: 0, cared: 0 };
    }
  }

  if (state && state.paused_until && Date.parse(state.paused_until) > now.getTime()) {
    return { sent: 0, ignored: 0, cared: 0 };
  }

  const date = cairoDateKey(now);
  const sentToday = state && state.cairo_date === date ? Number(state.sent_today_count || 0) : 0;
  const dailyCap = Number(settings.daily_checkin_cap || 18);
  if (sentToday >= dailyCap) {
    return { sent: 0, ignored: 0, cared: 0 };
  }

  const parts = cairoTimeParts(now);
  const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
  if (isWithinTimeWindow(minuteOfDay, settings.quiet_start || "00:30", settings.quiet_end || "08:00")) {
    return { sent: 0, ignored: 0, cared: 0 };
  }

  const inShift = isWithinTimeWindow(minuteOfDay, settings.shift_start || "15:00", settings.shift_end || "23:00");
  const baseIntervalMin = Number(inShift ? (settings.checkin_minutes_shift || 60) : (settings.checkin_minutes ?? 30));
  if (!Number.isFinite(baseIntervalMin) || baseIntervalMin <= 0) {
    return { sent: 0, ignored: 0, cared: 0 };
  }
  const consecutiveIgnored = state ? Number(state.consecutive_ignored || 0) : 0;
  const backoffMultiplier = consecutiveIgnored >= 2 ? Math.min(4, 1 + Math.floor(consecutiveIgnored / 2)) : 1;
  const effectiveIntervalMs = baseIntervalMin * backoffMultiplier * 60_000;
  if (state && state.last_proactive_at &&
      now.getTime() - Date.parse(state.last_proactive_at) < effectiveIntervalMs) {
    return { sent: 0, ignored: 0, cared: 0 };
  }

  let task = null;
  if (googleTasks) {
    try {
      await googleTasks.listAll();
      const row = await db.prepare(
        `SELECT title, due_date, priority
           FROM tasks
          WHERE status='Pending'
          ORDER BY due_date IS NULL, due_date, CASE priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END
          LIMIT 1`
      ).first();
      task = row;
    } catch (error) {
      await logSystemEvent(db, {
        occurredAt: now.toISOString(),
        severity: "WARN",
        component: "Companion",
        eventType: "Check-in Google Tasks unavailable",
        description: "Companion check-in skipped.",
        errorMessage: error && error.message ? String(error.message).slice(0, 300) : "Google Tasks unavailable"
      });
    }
  }
  if (!task) return { sent: 0, ignored: 0, cared: 0 };

  const overdueDays = task.due_date && task.due_date < date
    ? Math.max(1, Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${task.due_date}T00:00:00Z`)) / 86_400_000))
    : 0;
  const tier = selectToneTier({
    consecutiveIgnored,
    overdueDays,
    highPriorityOverdue: task.priority === "High" && overdueDays > 0,
    tone: settings.tone || "cheeky",
    careOverrideUntil: state ? state.tier_override_until : null,
    diveUntil: state ? state.dive_until : null,
    sleepActive: false,
    now,
    wakeTimeMinute: parseHmMinutes(settings.quiet_end || "08:00")
  });
  const text = say(tier, {
    name,
    task: task.title,
    n: Math.max(1, overdueDays || consecutiveIgnored || 1),
    counter: sentToday,
    now
  }) || `Yo ${name}, “${task.title}” is up next. 25 minutes, let's get it.`;

  await telegram.sendAssistantResponse(target.chatId, {
    category: "Check-in",
    title: "",
    sections: [{ heading: "", lines: [text] }],
    actions: [[
      { label: "▶️ Go", action: "focus_now" },
      { label: "🚧 Stuck", action: "companion_stuck" },
      { label: "Later", action: "companion_later" }
    ]]
  });
  await db.prepare(
    `INSERT INTO checkin_log (id, user_id, sent_at, kind, tier, task_ref, status)
     VALUES (?1, ?2, ?3, 'task', ?4, ?5, 'sent')`
  ).bind(`CHECK-${crypto.randomUUID()}`, target.userId, now.toISOString(), tier, task.title).run();
  await db.prepare(
    `INSERT INTO companion_state (
       user_id, cairo_date, consecutive_ignored, last_kind, last_proactive_at,
       sent_today_count, dive_until, awake_until, updated_at
     ) VALUES (?1, ?2, 0, 'checkin', ?3, 1, NULL, NULL, ?4)
     ON CONFLICT(user_id) DO UPDATE SET
       cairo_date=?2,
       last_kind='checkin',
       last_proactive_at=?3,
       sent_today_count=CASE WHEN companion_state.cairo_date=?2 THEN companion_state.sent_today_count+1 ELSE 1 END,
       updated_at=?4`
  ).bind(target.userId, date, now.toISOString(), now.toISOString()).run();
  return { sent: 1, ignored: 0, cared: tier === "tierC" ? 1 : 0 };
}

async function loadCompanionSettings(db) {
  try {
    const res = await db.prepare(
      `SELECT setting_key, setting_value
         FROM settings
        WHERE setting_key IN (
          'display_name','tone','checkin_minutes','checkin_minutes_shift',
          'shift_start','shift_end','quiet_start','quiet_end','daily_checkin_cap'
        )`
    ).all();
    return Object.fromEntries((res.results || []).map(r => [r.setting_key, r.setting_value]));
  } catch {
    return {};
  }
}

function parseHmMinutes(hm) {
  const m = String(hm || "").match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function isWithinTimeWindow(minuteOfDay, startHm, endHm) {
  const start = parseHmMinutes(startHm);
  const end = parseHmMinutes(endHm);
  if (start == null || end == null) return false;
  if (start < end) return minuteOfDay >= start && minuteOfDay < end;
  if (start > end) return minuteOfDay >= start || minuteOfDay < end;
  return false;
}

async function findTarget(db, authorizedTelegramUserId) {
  if (!authorizedTelegramUserId) return null;
  const user = await db.prepare(
    "SELECT id FROM users WHERE channel='telegram' AND external_user_id=?1"
  ).bind(String(authorizedTelegramUserId)).first();
  if (!user) return null;
  const message = await db.prepare(
    `SELECT external_chat_id FROM channel_messages
      WHERE channel='telegram' AND user_id=?1 AND direction='incoming'
      ORDER BY created_at DESC LIMIT 1`
  ).bind(user.id).first();
  return message ? { userId: user.id, chatId: message.external_chat_id } : null;
}
