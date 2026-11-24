import {
  cairoDateKey,
  parseDateInput,
  parseTimeInput,
  shortDate,
  shiftDateKey,
  timeLabel
} from "./core/format.js";
import { cairoLocalDateTimeToIso } from "./integrations/google-calendar.js";
import { insertChannelMessage, logSystemEvent } from "./db/channel-repository.js";

export function parseUserReminder(text, now = new Date()) {
  let input = String(text || "").trim();
  input = input.replace(/^\/?remind(?: me)?(?: to)?\s*/i, "").trim();
  if (!input) return null;
  const timeFirst = input.match(/^(\d{1,2}(?::\d{2})?\s*(?:am|pm)|[01]\d:[0-5]\d|2[0-3]:[0-5]\d)\s+(.+)$/i);
  if (timeFirst) {
    const time = parseTimeInput(timeFirst[1]);
    const dateKey = nextCairoDateForTime(time, now);
    if (!dateKey) {
      return { text: timeFirst[2].trim().slice(0, 200), dueAtUtc: null, invalidLocalTime: true };
    }
    const dueAtUtc = cairoDateTimeToUtc(dateKey, time);
    if (!dueAtUtc) {
      return { text: timeFirst[2].trim().slice(0, 200), dueAtUtc: null, invalidLocalTime: true };
    }
    const due = new Date(dueAtUtc);
    if (due.getTime() <= now.getTime()) return { text: timeFirst[2].trim().slice(0, 200), dueAtUtc: null, pastTime: true };
    return { text: timeFirst[2].trim().slice(0, 200), dueAtUtc };
  }
  if (/^in\s+(\d+(?:\.\d+)?)\s+(minute|minutes|min|mins|hour|hours|hrs)\s+(?:to\s+)?(.+)$/i.test(input)) {
    const match = input.match(/^in\s+(\d+(?:\.\d+)?)\s+(minute|minutes|min|mins|hour|hours|hrs)\s+(?:to\s+)?(.+)$/i);
    const amount = Number(match[1]);
    const hours = /hour|hr/i.test(match[2]);
    const minutes = Math.round(amount * (hours ? 60 : 1));
    const due = new Date(now.getTime() + minutes * 60_000);
    return { text: match[3].trim().slice(0, 200), dueAtUtc: due.toISOString(), seconds: minutes * 60 };
  }
  const relativeOnly = input.match(/^in\s+(\d+(?:\.\d+)?)\s+(minute|minutes|min|mins|hour|hours|hrs)$/i);
  if (relativeOnly) {
    const amount = Number(relativeOnly[1]);
    const hours = /hour|hr/i.test(relativeOnly[2]);
    const minutes = Math.round(amount * (hours ? 60 : 1));
    const due = new Date(now.getTime() + minutes * 60_000);
    return { text: "", dueAtUtc: due.toISOString(), seconds: minutes * 60 };
  }

  let reminderText = input;
  let time = null;
  let dateKey = null;

  const slashDateTime = input.match(/^(\d{1,2}\/\d{1,2}(?:\/\d{4})?)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)|[01]\d:[0-5]\d|2[0-3]:[0-5]\d)$/i);
  if (slashDateTime) {
    dateKey = parseDateInput(slashDateTime[1], now);
    time = parseTimeInput(slashDateTime[2]);
    if (!dateKey || !time) return null;
    reminderText = "";
  }

  const namedDateTime = input.match(/^on\s+(.+?\d{1,2}(?:,\s*\d{4})?)\s+at\s+(.+)$/i);
  if (namedDateTime) {
    dateKey = parseDateInput(namedDateTime[1].replace(/^on\s+/i, ""), now);
    time = parseTimeInput(namedDateTime[2]);
    if (!dateKey || !time) return null;
    reminderText = "";
  }

  const tomorrowTime = input.match(/^tomorrow\s+(?:at\s+)?(.+)$/i);
  if (tomorrowTime) {
    dateKey = parseDateInput("tomorrow", now);
    time = parseTimeInput(tomorrowTime[1]);
    reminderText = "";
  }

  const endTime = input.match(/^(.*?\S)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)|[01]\d:[0-5]\d|2[0-3]:[0-5]\d)$/i);
  if (endTime && !time) {
    reminderText = endTime[1].replace(/^call\s+/i, "call ");
    time = parseTimeInput(endTime[2]);
  }

  if (!time) {
    return { text: reminderText.replace(/^to\s+/i, "").trim().slice(0, 200), dueAtUtc: null };
  }
  if (!dateKey) dateKey = nextCairoDateForTime(time, now);
  if (!dateKey) {
    return { text: reminderText.slice(0, 200), dueAtUtc: null, invalidLocalTime: true };
  }
  const dueAtUtc = cairoDateTimeToUtc(dateKey, time);
  if (!dueAtUtc) {
    return { text: reminderText.slice(0, 200), dueAtUtc: null, invalidLocalTime: true };
  }
  const due = new Date(dueAtUtc);
  if (due.getTime() <= now.getTime()) return { text: reminderText.slice(0, 200), dueAtUtc: null, pastTime: true };
  return { text: reminderText.replace(/^to\s+/i, "").trim().slice(0, 200), dueAtUtc };
}

export async function createUserReminder({ db, user, text, dueAtUtc, now, requestId = null }) {
  const marker = requestId || `REMREQ-${crypto.randomUUID()}`;
  const existing = await db.prepare(
    `SELECT id, text, remind_at_utc, request_id
       FROM reminders
      WHERE request_id = ?1 AND user_id = ?2`
  ).bind(marker, user.id).first();
  if (existing) {
    return {
      id: existing.id,
      text: existing.text,
      dueAtUtc: existing.remind_at_utc,
      requestId: existing.request_id,
      duplicate: true
    };
  }
  const normalizedText = String(text || "").trim();
  if (!normalizedText || normalizedText.length > 200) throw new TypeError("Reminder text is required and limited to 200 characters.");
  if (!dueAtUtc || Number.isNaN(Date.parse(dueAtUtc))) throw new TypeError("Reminder time is required.");
  if (Date.parse(dueAtUtc) <= Date.parse(now)) throw new RangeError("Reminder time must be in the future.");
  const pending = await db.prepare(
    "SELECT COUNT(*) AS count FROM reminders WHERE user_id = ?1 AND status IN ('pending','sending','snoozed')"
  ).bind(user.id).first();
  if (Number(pending.count) >= 100) throw new RangeError("The 100 pending reminder limit was reached.");
  const id = `REM-${crypto.randomUUID()}`;
  const inserted = await db.prepare(
    `INSERT INTO reminders (
       id, user_id, text, remind_at_utc, status, created_at, ping_count, snooze_count, request_id
     ) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, 0, 0, ?6)
     ON CONFLICT(request_id) DO NOTHING`
  ).bind(id, user.id, normalizedText, dueAtUtc, now, marker).run();
  const saved = await db.prepare(
    `SELECT id, text, remind_at_utc, request_id
       FROM reminders
      WHERE request_id = ?1 AND user_id = ?2`
  ).bind(marker, user.id).first();
  if (!saved) throw new Error("Could not retrieve the saved reminder.");
  return {
    id: saved.id,
    text: saved.text,
    dueAtUtc: saved.remind_at_utc,
    requestId: saved.request_id,
    duplicate: Boolean(inserted.meta && inserted.meta.changes === 0)
  };
}

export async function listPendingUserReminders(db, userId, limit = 8) {
  return db.prepare(
    `SELECT id, text, remind_at_utc, status, ping_count, snooze_count
       FROM reminders
      WHERE user_id = ?1 AND status IN ('pending','sending','snoozed','missed','uncertain')
      ORDER BY
        CASE WHEN status = 'missed' THEN 1
             WHEN status = 'uncertain' THEN 2 ELSE 0 END,
        remind_at_utc
      LIMIT ?2`
  ).bind(userId, Math.min(100, limit)).all();
}

export async function processUserReminders({ db, telegram, now, authorizedTelegramUserId, enabled = false }) {
  if (!enabled) return { sent: 0, snoozed: 0, missed: 0, uncertain: 0 };
  const target = await findTarget(db, authorizedTelegramUserId);
  if (!target) return { sent: 0, snoozed: 0, missed: 0, uncertain: 0 };
  const leaseUntil = new Date(now.getTime() + 2 * 60_000).toISOString();
  const due = await db.prepare(
    `SELECT id
       FROM reminders
      WHERE status = 'pending' AND remind_at_utc <= ?1
      ORDER BY remind_at_utc LIMIT 20`
  ).bind(now.toISOString()).all();
  let sent = 0;
  let missed = 0;
  let uncertain = 0;
  for (const row of due.results) {
    const claimed = await db.prepare(
      `UPDATE reminders
          SET status = 'sending'
        WHERE id = ?1 AND status = 'pending'
        RETURNING id, text, remind_at_utc, ping_count`
    ).bind(row.id).first();
    if (!claimed) continue;
    try {
      const message = await telegram.sendAssistantResponse(target.chatId, {
        category: "Reminder",
        title: "",
        sections: [{ heading: "", lines: [`⏰ <b>${claimed.text}</b>`] }],
        actions: [[
          { label: "✅ Got it", action: `reminder_done|${claimed.id}` },
          { label: "⏰ +15 min", action: `reminder_snooze|${claimed.id}|15` }
        ], [
          { label: "⏰ +1 hour", action: `reminder_snooze|${claimed.id}|60` },
          { label: "📝 Make it a task", action: `reminder_task|${claimed.id}` }
        ]]
      });
      await db.prepare(
        `UPDATE reminders SET status='sent', sent_at=?1, ping_count=ping_count+1
          WHERE id=?2 AND status='sending'`
      ).bind(now.toISOString(), claimed.id).run();
      await insertChannelMessage(db, {
        channel: "telegram",
        conversationId: target.chatId,
        externalMessageId: String(message.message_id),
        userId: target.userId,
        direction: "outgoing",
        type: "message",
        category: "Reminder",
        deliveryStatus: "Sent",
        createdAt: now.toISOString()
      });
      sent++;
    } catch (error) {
      await db.prepare(
        `UPDATE reminders SET status='uncertain'
          WHERE id=?1 AND status='sending'`
      ).bind(claimed.id).run();
      await logSystemEvent(db, {
        occurredAt: now.toISOString(),
        severity: "ERROR",
        component: "User reminders",
        eventType: "Reminder delivery uncertain",
        description: "Telegram could not confirm reminder delivery.",
        relatedRecordId: claimed.id,
        errorMessage: error && error.message ? String(error.message).slice(0, 300) : "Telegram delivery failed"
      });
      uncertain++;
    }
  }
  const sentOld = await db.prepare(
    `SELECT id, text, sent_at, ping_count
       FROM reminders
      WHERE status='sent' AND sent_at <= ?1`
  ).bind(new Date(now.getTime() - 10 * 60_000).toISOString()).all();
  for (const reminder of sentOld.results) {
    if (Number(reminder.ping_count) < 2) {
      try {
        await telegram.sendAssistantResponse(target.chatId, {
          category: "Reminder",
          title: "",
          sections: [{ heading: "", lines: [`⏰ Still on this one: ${reminder.text}`] }],
          actions: [[
            { label: "✅ Got it", action: `reminder_done|${reminder.id}` },
            { label: "⏰ +15 min", action: `reminder_snooze|${reminder.id}|15` }
          ]]
        });
        await db.prepare("UPDATE reminders SET ping_count=ping_count+1 WHERE id=?1")
          .bind(reminder.id).run();
      } catch (error) {
        await db.prepare("UPDATE reminders SET status='uncertain' WHERE id=?1")
          .bind(reminder.id).run();
        await logSystemEvent(db, {
          occurredAt: now.toISOString(),
          severity: "ERROR",
          component: "User reminders",
          eventType: "Reminder follow-up delivery uncertain",
          description: "Telegram could not confirm reminder follow-up delivery.",
          relatedRecordId: reminder.id,
          errorMessage: error && error.message ? String(error.message).slice(0, 300) : "Telegram delivery failed"
        });
        uncertain++;
      }
    } else {
      await db.prepare("UPDATE reminders SET status='missed' WHERE id=?1")
        .bind(reminder.id).run();
      missed++;
    }
  }
  return { sent, snoozed: 0, missed, uncertain };
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

function nextCairoDateForTime(time, now) {
  const today = cairoDateKey(now);
  const dueAtUtc = cairoDateTimeToUtc(today, time);
  if (!dueAtUtc) return null;
  if (Date.parse(dueAtUtc) > now.getTime()) return today;
  const tomorrow = shiftDateKey(today, 1);
  return cairoDateTimeToUtc(tomorrow, time) ? tomorrow : null;
}

function cairoDateTimeToUtc(dateKey, time) {
  try {
    return cairoLocalDateTimeToIso(dateKey, time);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}
