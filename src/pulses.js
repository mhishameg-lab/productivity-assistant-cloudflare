import { cairoDateKey, cairoTimeParts, timeLabel } from "./core/format.js";
import { say, getDisplayName } from "./core/voice.js";
import { insertChannelMessage, logSystemEvent } from "./db/channel-repository.js";

export async function processWorkPulses({
  db,
  telegram,
  now,
  authorizedTelegramUserId,
  googleCalendar = null,
  enabled = false
}) {
  if (!enabled) return { sent: 0, skipped: 0, ignored: 0 };
  const date = cairoDateKey(now);
  const muted = await db.prepare(
    "SELECT setting_value FROM settings WHERE setting_key = 'pulse_muted_until'"
  ).first();
  if (muted && muted.setting_value > now.toISOString()) {
    return { sent: 0, skipped: 1, ignored: 0 };
  }
  const target = await findTelegramTarget(db, authorizedTelegramUserId);
  if (!target) return { sent: 0, skipped: 1, ignored: 0 };
  const idleSetting = await db.prepare(
    "SELECT setting_value FROM settings WHERE setting_key = 'pulse_idle_minutes'"
  ).first();
  const idleMinutes = idleSetting ? Number(idleSetting.setting_value) : 150;
  const lastIncoming = await db.prepare(
    `SELECT created_at FROM channel_messages
      WHERE channel='telegram' AND user_id=?1 AND direction='incoming'
      ORDER BY created_at DESC LIMIT 1`
  ).bind(target.userId).first();
  if (lastIncoming && now.getTime() - Date.parse(lastIncoming.created_at) < idleMinutes * 60_000) {
    return { sent: 0, skipped: 1, ignored: 0 };
  }
  const minuteOfDay = cairoMinute(now);
  if (minuteOfDay >= 18 * 60 + 30 && minuteOfDay < 18 * 60 + 35) {
    const weekday = cairoTimeParts(now).weekday;
    if (weekday !== "Sat" && weekday !== "Sun") {
      const existingCare = await db.prepare(
        "SELECT 1 FROM work_pulses WHERE user_id=?1 AND cairo_date=?2 AND slot='care'"
      ).bind(target.userId, date).first();
      if (!existingCare) {
        const name = await getDisplayName(db);
        await telegram.sendAssistantResponse(target.chatId, {
          category: "Care note",
          title: "",
          sections: [{ heading: "", lines: [say("care_break", { name, now })] }],
          actions: [[{ label: "Got it", action: "home" }]]
        });
        await recordPulse(db, target.userId, date, "care", "sent", null);
      }
      return { sent: 1, skipped: 0, ignored: 0 };
    }
  }

  const nudgeResult = await processPulseNudges({ db, telegram, target, now });
  if (nudgeResult.handled) return nudgeResult;

  const weekday = cairoTimeParts(now).weekday;
  const isWeekend = weekday === "Sat" || weekday === "Sun";
  if (isWeekend) return { sent: 0, skipped: 1, ignored: nudgeResult.ignored };

  let allowed = minuteOfDay >= 9 * 60 && minuteOfDay < 14 * 60;
  let slot = "morning";
  if (!allowed && minuteOfDay >= 15 * 60 && minuteOfDay <= 23 * 60) {
    allowed = true;
    slot = minuteOfDay >= 18 * 60 + 55 && minuteOfDay <= 19 * 60 + 5
      ? "midshift"
      : "shift";
  }
  if (!allowed) return { sent: 0, skipped: 1, ignored: nudgeResult.ignored };

  const existing = await db.prepare(
    "SELECT 1 FROM work_pulses WHERE user_id = ?1 AND cairo_date = ?2 AND slot = ?3"
  ).bind(target.userId, date, slot).first();
  if (existing) return { sent: 0, skipped: 1, ignored: nudgeResult.ignored };

  const count = await db.prepare(
    "SELECT COUNT(*) AS count FROM work_pulses WHERE user_id = ?1 AND cairo_date = ?2 AND slot != 'care' AND status IN ('sent','answered')"
  ).bind(target.userId, date).first();
  if (Number(count.count) >= 3) return { sent: 0, skipped: 1, ignored: nudgeResult.ignored };

  const recent = await db.prepare(
    "SELECT sent_at FROM work_pulses WHERE user_id = ?1 AND cairo_date = ?2 AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 1"
  ).bind(target.userId, date).first();
  if (recent && now.getTime() - Date.parse(recent.sent_at) < 60 * 60 * 1000) {
    return { sent: 0, skipped: 1, ignored: nudgeResult.ignored };
  }

  if (googleCalendar) {
    try {
      const events = await googleCalendar.listEventsForDate(date);
      if (events.some(event => !event.allDay && eventIsNow(event, now))) {
        await recordPulse(db, target.userId, date, slot, "skipped", "Calendar event happening now");
        return { sent: 0, skipped: 1, ignored: nudgeResult.ignored };
      }
    } catch (error) {
      await recordPulse(db, target.userId, date, slot, "skipped", "Calendar read failed");
      await logSystemEvent(db, {
        occurredAt: now.toISOString(),
        severity: "WARN",
        component: "Work pulses",
        eventType: "Pulse skipped",
        description: "Pulse skipped because Calendar availability could not be verified.",
        errorMessage: error && error.message ? String(error.message).slice(0, 300) : "Calendar read failed"
      });
      return { sent: 0, skipped: 1, ignored: nudgeResult.ignored };
    }
  }

  const outcomes = await db.prepare(
    `SELECT area, outcome, google_task_id, status
       FROM daily_outcomes
      WHERE outcome_date = ?1 AND status NOT IN ('Completed','Dropped')`
  ).bind(date).all();
  const open = outcomes.results.find(row => row.area === "DEEP") ||
    outcomes.results.find(row => row.area === "WORK") ||
    outcomes.results[0];
  if (!open) return { sent: 0, skipped: 1, ignored: nudgeResult.ignored };

  const name = await getDisplayName(db);
  let text = say(open.status === "In progress" ? "pulse_started" : "pulse_not_started", {
    name,
    task: open.outcome,
    now
  });
  if (slot === "midshift") {
    const targetNote = await db.prepare(
      `SELECT answer FROM review_notes
        WHERE review_type='Work briefing' AND review_date=?1 AND question='SDR target'
        ORDER BY created_at DESC LIMIT 1`
    ).bind(date).first();
    if (targetNote && targetNote.answer) {
      text = `Mid-shift check: your SDR target was “${targetNote.answer}”. How's it going?`;
    }
  }
  const kind = open.status === "In progress" ? "started" : "not_started";
  const actions = kind === "started"
    ? [[
        { label: "Still working", action: `pulse|still|${open.area}` },
        { label: "Done", action: `pulse|done|${open.area}` }
      ], [
        { label: "Blocked", action: `pulse|blocked|${open.area}` },
        { label: "Switch", action: `pulse|switch|${open.area}` }
      ]]
    : [[
        { label: "Too big", action: `pulse|reason|too_big|${open.area}` },
        { label: "Pulled away", action: `pulse|reason|pulled_away|${open.area}` }
      ], [
        { label: "Low energy", action: `pulse|reason|low_energy|${open.area}` },
        { label: "Forgot", action: `pulse|reason|forgot|${open.area}` }
      ], [
        { label: "Not important now", action: `pulse|reason|not_important|${open.area}` }
      ]];

  let sent;
  try {
    sent = await telegram.sendAssistantResponse(target.chatId, {
      category: "Work pulse",
      title: "",
      sections: [{ heading: "", lines: [text] }],
      actions
    });
  } catch (error) {
    await recordPulse(db, target.userId, date, slot, "skipped", "Telegram delivery failed");
    throw error;
  }
  await db.prepare(
    `INSERT INTO work_pulses (
       id, user_id, cairo_date, slot, scheduled_at, sent_at, task_ref, kind, status
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'sent')`
  ).bind(
    `PULSE-${crypto.randomUUID()}`,
    target.userId,
    date,
    slot,
    now.toISOString(),
    now.toISOString(),
    open.google_task_id || open.area,
    kind
  ).run();
  await insertChannelMessage(db, {
    channel: "telegram",
    conversationId: target.chatId,
    externalMessageId: String(sent.message_id),
    userId: target.userId,
    direction: "outgoing",
    type: "message",
    category: "Work pulse",
    deliveryStatus: "Sent",
    createdAt: now.toISOString()
  });
  return { sent: 1, skipped: 0, ignored: nudgeResult.ignored };
}

async function processPulseNudges({ db, telegram, target, now }) {
  const sent = await db.prepare(
    `SELECT id, task_ref, sent_at, nudge_count
       FROM work_pulses
      WHERE user_id = ?1 AND status = 'sent'
      ORDER BY sent_at DESC LIMIT 5`
  ).bind(target.userId).all();
  let handled = false;
  let ignored = 0;
  for (const pulse of sent.results) {
    const sentAt = Date.parse(pulse.sent_at);
    const elapsed = now.getTime() - sentAt;
    if (pulse.nudge_count === 0 && elapsed >= 15 * 60 * 1000 && elapsed < 30 * 60 * 1000) {
      await telegram.sendAssistantResponse(target.chatId, {
        category: "Work pulse nudge",
        title: "",
        sections: [{ heading: "", lines: [`Quick check: is “${pulse.task_ref}” still moving?`] }],
        actions: [[{ label: "Still working", action: `pulse|still|${pulse.task_ref}` }]]
      });
      await db.prepare("UPDATE work_pulses SET nudge_count = 1 WHERE id = ?1").bind(pulse.id).run();
      handled = true;
    } else if (pulse.nudge_count >= 1 && elapsed >= 30 * 60 * 1000) {
      await db.prepare("UPDATE work_pulses SET status = 'ignored' WHERE id = ?1").bind(pulse.id).run();
      ignored++;
    }
  }
  return { handled, ignored };
}

async function recordPulse(db, userId, date, slot, status, skipReason) {
  await db.prepare(
    `INSERT INTO work_pulses (
       id, user_id, cairo_date, slot, scheduled_at, kind, status, skip_reason
     ) VALUES (?1, ?2, ?3, ?4, ?5, 'not_started', ?6, ?7)
     ON CONFLICT(user_id, cairo_date, slot) DO NOTHING`
  ).bind(`PULSE-${crypto.randomUUID()}`, userId, date, slot, new Date().toISOString(), status, skipReason).run();
}

async function findTelegramTarget(db, authorizedTelegramUserId) {
  if (!authorizedTelegramUserId) return null;
  const user = await db.prepare(
    "SELECT id FROM users WHERE channel = 'telegram' AND external_user_id = ?1"
  ).bind(String(authorizedTelegramUserId)).first();
  if (!user) return null;
  const message = await db.prepare(
    `SELECT external_chat_id FROM channel_messages
      WHERE channel='telegram' AND user_id=?1 AND direction='incoming'
      ORDER BY created_at DESC LIMIT 1`
  ).bind(user.id).first();
  return message ? { userId: user.id, chatId: message.external_chat_id } : null;
}

function cairoMinute(date) {
  const values = cairoTimeParts(date);
  return Number(values.hour) * 60 + Number(values.minute);
}

function eventIsNow(event, now) {
  if (!event.startTime || !event.endTime) return false;
  const start = Date.parse(event.startTime);
  const end = Date.parse(event.endTime);
  return Number.isFinite(start) && Number.isFinite(end) && start <= now.getTime() && end >= now.getTime();
}
