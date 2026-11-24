import { cairoDateKey, cairoTimeParts, durationLabel, parseTimeInput, timeLabel } from "./core/format.js";
import { insertChannelMessage, logSystemEvent } from "./db/channel-repository.js";

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
  const date = cairoDateKey(now);
  const due = new Date(cairoDateTimeToUtc(date, time));
  if (due.getTime() <= now.getTime()) due.setUTCDate(due.getUTCDate() + 1);
  if (due.getTime() - now.getTime() > 14 * 60 * 60_000) return null;
  return due;
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
      wake.getTime() - now.getTime() > 14 * 60 * 60_000) {
    throw new RangeError("Wake time must be in the future and within 14 hours.");
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

  const activeSleep = await db.prepare(
    "SELECT id, wake_at, wake_sent_count FROM sleep_sessions WHERE user_id=?1 AND status='active' ORDER BY started_at DESC LIMIT 1"
  ).bind(target.userId).first();
  if (activeSleep) {
    const wakeAt = Date.parse(activeSleep.wake_at);
    if (now.getTime() >= wakeAt) {
      if (Number(activeSleep.wake_sent_count) >= 3) {
        await db.prepare("UPDATE sleep_sessions SET status='no_answer' WHERE id=?1")
          .bind(activeSleep.id).run();
        return { sent: 0, ignored: 1, cared: 0 };
      }
      await db.prepare(
        `UPDATE sleep_sessions
            SET wake_sent_count=wake_sent_count+1, last_wake_sent_at=?1
          WHERE id=?2 AND status='active'`
      ).bind(now.toISOString(), activeSleep.id).run();
      await telegram.sendAssistantResponse(target.chatId, {
        category: "Sleep wake",
        title: "",
        sections: [{ heading: "", lines: [`☀️ Rise and shine, Martino. It's ${timeLabel(wakeAt)}. Ready to get after it?`] }],
        actions: [[{ label: "☀️ I'm up", action: "sleep_up" }]]
      });
      return { sent: 1, ignored: 0, cared: 0 };
    }
    return { sent: 0, ignored: 0, cared: 0 };
  }

  const state = await db.prepare(
    "SELECT dive_until, paused_until, sent_today_count, consecutive_ignored FROM companion_state WHERE user_id=?1"
  ).bind(target.userId).first();
  if (state && state.dive_until && Date.parse(state.dive_until) > now.getTime()) {
    return { sent: 0, ignored: 0, cared: 0 };
  }
  if (state && state.paused_until && Date.parse(state.paused_until) > now.getTime()) {
    return { sent: 0, ignored: 0, cared: 0 };
  }
  const date = cairoDateKey(now);
  const cap = await db.prepare("SELECT setting_value FROM settings WHERE setting_key='daily_checkin_cap'")
    .first();
  if (state && Number(state.sent_today_count) >= Number(cap ? cap.setting_value : 18)) {
    return { sent: 0, ignored: 0, cared: 0 };
  }
  const hour = Number(cairoTimeParts(now).hour);
  if (hour >= 0 && hour < 8) return { sent: 0, ignored: 0, cared: 0 };

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

  const text = `Yo Martino, “${task.title}” is up next. 25 minutes, let's get it.`;
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
     VALUES (?1, ?2, ?3, 'task', 'tier1', ?4, 'sent')`
  ).bind(`CHECK-${crypto.randomUUID()}`, target.userId, now.toISOString(), task.title).run();
  await db.prepare(
    `INSERT INTO companion_state (
       user_id, cairo_date, consecutive_ignored, last_kind, last_proactive_at,
       sent_today_count, dive_until, awake_until, updated_at
     ) VALUES (?1, ?2, 0, 'checkin', ?3, 1, NULL, NULL, ?4)
     ON CONFLICT(user_id) DO UPDATE SET
       cairo_date=?2,
       last_kind='checkin',
       last_proactive_at=?3,
       sent_today_count=sent_today_count+1,
       updated_at=?4`
  ).bind(target.userId, date, now.toISOString(), now.toISOString()).run();
  return { sent: 1, ignored: 0, cared: 0 };
}

function cairoDateTimeToUtc(dateKey, time) {
  const [hour, minute] = time.split(":").map(Number);
  const utc = new Date(`${dateKey}T${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00Z`);
  const offset = /^(3|4|5|6|7|8|9|10)$/.test(String(utc.getUTCMonth() + 1)) ? 180 : 120;
  return new Date(utc.getTime() - offset * 60_000).toISOString();
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
