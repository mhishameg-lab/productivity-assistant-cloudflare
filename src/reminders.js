import {
  insertChannelMessage,
  logSystemEvent,
  logSyncEvent
} from "./db/channel-repository.js";
import {
  listOverdueTaskMirrors,
  syncGoogleTaskMirrors
} from "./db/google-tasks-repository.js";
import { cairoTimeParts } from "./core/format.js";

const MAX_REMINDER_TASKS = 5;
const REMINDER_COOLDOWN_HOURS = 23;
const CALENDAR_REMINDER_LEAD_MINUTES = 15;
const CALENDAR_REMINDER_WINDOW_MINUTES = 5;
const MAX_CALENDAR_REMINDERS_PER_RUN = 5;

export async function processOverdueTaskReminders({
  db,
  telegram,
  googleTasks,
  authorizedTelegramUserId,
  now,
  enabled = false
}) {
  if (!enabled) return { sent: 0, skipped: 0, failed: 0 };
  const local = cairoParts(now);
  if (local.hour !== "08" || local.minute !== "00") {
    return { sent: 0, skipped: 0, failed: 0 };
  }
  if (!telegram || !googleTasks || !authorizedTelegramUserId) {
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: "ERROR",
      component: "Task reminders",
      eventType: "Reminder integrations unavailable",
      description: "Overdue-task reminders require Telegram, Google Tasks, and the authorized user."
    });
    return { sent: 0, skipped: 0, failed: 1 };
  }

  const date = `${local.year}-${local.month}-${local.day}`;
  const target = await findTelegramTarget(db, authorizedTelegramUserId);
  if (!target) {
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: "WARN",
      component: "Task reminders",
      eventType: "No Telegram destination",
      description: "Skipped overdue-task reminders because no private-chat destination is recorded."
    });
    return { sent: 0, skipped: 1, failed: 0 };
  }

  const jobKey = `task-overdue-reminders:${date}`;
  const jobId = `JOB-${crypto.randomUUID()}`;
  const claim = await db.prepare(
    `INSERT INTO scheduled_job_runs (id, job_key, started_at, status)
     VALUES (?1, ?2, ?3, 'Processing')
     ON CONFLICT(job_key) DO NOTHING
     RETURNING id`
  ).bind(jobId, jobKey, now.toISOString()).first();
  if (!claim) return { sent: 0, skipped: 1, failed: 0 };

  let taskRefreshFailed = false;
  try {
    let syncedTasks;
    try {
      syncedTasks = await googleTasks.listAll();
      await syncGoogleTaskMirrors(db, syncedTasks, now.toISOString());
      await logSyncEvent(db, {
        source: "Google Tasks",
        operation: "Synchronize tasks for overdue reminders",
        occurredAt: now.toISOString(),
        result: "Success",
        relatedRecordId: `${syncedTasks.length} task(s)`
      });
    } catch (error) {
      taskRefreshFailed = true;
      await logSyncEvent(db, {
        source: "Google Tasks",
        operation: "Synchronize tasks for overdue reminders",
        occurredAt: now.toISOString(),
        result: "Failed",
        errorDetails: error && error.name ? String(error.name) : "Error"
      });
      throw error;
    }

    const cooldownCutoff = new Date(
      now.getTime() - REMINDER_COOLDOWN_HOURS * 60 * 60 * 1000
    ).toISOString();
    const count = await db.prepare(
      `SELECT COUNT(*) AS count
         FROM tasks
        WHERE status = 'Pending' AND due_date IS NOT NULL AND due_date < ?1
          AND (last_reminder_at IS NULL OR last_reminder_at <= ?2)`
    ).bind(date, cooldownCutoff).first();
    const eligible = await listOverdueTaskMirrors(db, date, 100, cooldownCutoff);

    if (!eligible.length) {
      await finishReminderJob(db, jobId, now, "Completed");
      await logSystemEvent(db, {
        occurredAt: now.toISOString(),
        severity: "INFO",
        component: "Task reminders",
        eventType: "No eligible overdue tasks",
        description: "No overdue Google Tasks are eligible for a reminder."
      });
      return { sent: 0, skipped: 1, failed: 0 };
    }

    const selected = eligible.slice(0, MAX_REMINDER_TASKS);
    const reminders = await Promise.all(selected.map(async task => {
      const previous = await db.prepare(
        "SELECT COUNT(*) AS count FROM reminder_history WHERE related_record_id = ?1 AND category = 'Overdue task'"
      ).bind(task.id).first();
      return {
        id: `REM-${crypto.randomUUID()}`,
        task,
        reminderNumber: Number(previous && previous.count || 0) + 1
      };
    }));
    const lines = reminders.map(({ task }) =>
      `${task.title} · overdue since ${task.due_date}${task.priority === "High" ? " · high priority" : ""}`
    );
    if (Number(count && count.count || 0) > selected.length) {
      lines.push(`Showing ${selected.length} of ${count.count} eligible overdue tasks. Use /overdue to review more.`);
    }
    const message = {
      category: "Overdue task reminder",
      title: "A quick check on overdue tasks",
      sections: [{
        heading: "Google Tasks still lists these as pending",
        lines: [...lines, "Choose Done only after completing a task, or Later to defer this reminder for today."]
      }],
      actions: reminders.map(({ id, task }) => ([
        {
          label: `Done · ${task.title.slice(0, 20)}`,
          action: `task_complete|${task.google_task_id}`
        },
        {
          label: `Later · ${task.title.slice(0, 18)}`,
          action: `task_reminder_later|${id}`
        }
      ]))
    };

    const delivered = await telegram.sendAssistantResponse(target.chatId, message);
    await insertChannelMessage(db, {
      channel: "telegram",
      conversationId: target.chatId,
      externalMessageId: String(delivered.message_id),
      userId: target.userId,
      direction: "outgoing",
      type: "message",
      category: message.category,
      deliveryStatus: "Sent",
      createdAt: now.toISOString()
    });
    await db.batch(reminders.flatMap(({ id, task, reminderNumber }) => [
      db.prepare(
        `INSERT INTO reminder_history (
           id, category, related_record_id, scheduled_at, sent_at,
           reminder_number, delivery_status
         ) VALUES (?1, 'Overdue task', ?2, ?3, ?3, ?4, 'Sent')`
      ).bind(id, task.id, now.toISOString(), reminderNumber),
      db.prepare(
        "UPDATE tasks SET last_reminder_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'Pending'"
      ).bind(now.toISOString(), task.id)
    ]));
    await finishReminderJob(db, jobId, now, "Completed");
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: "INFO",
      component: "Task reminders",
      eventType: "Overdue-task reminder sent",
      description: `Sent one reminder covering ${reminders.length} overdue task(s).`,
      relatedRecordId: jobId
    });
    return {
      sent: 1,
      skipped: Math.max(0, Number(count && count.count || 0) - reminders.length),
      failed: 0
    };
  } catch (error) {
    await finishReminderJob(db, jobId, now, "Failed", error && error.name ? String(error.name) : "Error");
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: "ERROR",
      component: "Task reminders",
      eventType: "Reminder cycle failed",
      description: "Could not complete the overdue-task reminder cycle.",
      relatedRecordId: jobId,
      errorMessage: error && error.name ? String(error.name) : "Error"
    });
    if (taskRefreshFailed) {
      try {
        const warning = await telegram.sendAssistantResponse(target.chatId, {
          category: "Task reminder status",
          title: "Overdue tasks were not checked",
          sections: [{
            heading: "",
            lines: ["Google Tasks could not be refreshed, so no task reminders were sent. Please check /tasks later."]
          }],
          actions: [[{ label: "Open tasks", action: "show_tasks" }]]
        });
        await insertChannelMessage(db, {
          channel: "telegram",
          conversationId: target.chatId,
          externalMessageId: String(warning.message_id),
          userId: target.userId,
          direction: "outgoing",
          type: "message",
          category: "Task reminder status",
          deliveryStatus: "Sent",
          createdAt: now.toISOString()
        });
      } catch (warningError) {
        await logSystemEvent(db, {
          occurredAt: now.toISOString(),
          severity: "ERROR",
          component: "Task reminders",
          eventType: "Refresh warning delivery failed",
          description: "Could not deliver the task-refresh warning to Telegram.",
          relatedRecordId: jobId,
          errorMessage: warningError && warningError.name ? String(warningError.name) : "Error"
        });
      }
    }
    return { sent: 0, skipped: 0, failed: 1 };
  }
}

export async function processCalendarAppointmentReminders({
  db,
  telegram,
  googleCalendar,
  authorizedTelegramUserId,
  now,
  enabled = false
}) {
  if (!enabled) return { sent: 0, skipped: 0, failed: 0 };
  if (!telegram || !googleCalendar || !authorizedTelegramUserId) {
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: "ERROR",
      component: "Calendar reminders",
      eventType: "Reminder integrations unavailable",
      description: "Calendar reminders require Telegram, Google Calendar, and the authorized user."
    });
    return { sent: 0, skipped: 0, failed: 1 };
  }

  const local = cairoParts(now);
  const date = `${local.year}-${local.month}-${local.day}`;
  let events;
  try {
    events = await googleCalendar.listEventsForDate(date);
  } catch (error) {
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: "WARN",
      component: "Calendar reminders",
      eventType: "Calendar read failed",
      description: "Could not read events for appointment reminders.",
      errorMessage: formatCalendarErrorDetails(error)
    });
    return { sent: 0, skipped: 0, failed: 1 };
  }

  const nowMs = now.getTime();
  const leadMs = CALENDAR_REMINDER_LEAD_MINUTES * 60 * 1000;
  const windowMs = CALENDAR_REMINDER_WINDOW_MINUTES * 60 * 1000;
  const upcoming = events
    .filter(event => event && event.id && !event.allDay && event.startTime)
    .map(event => ({ event, startMs: Date.parse(event.startTime) }))
    .filter(({ startMs }) => {
      const timeUntil = startMs - nowMs;
      return Number.isFinite(startMs) &&
        timeUntil <= leadMs &&
        timeUntil > leadMs - windowMs;
    })
    .sort((left, right) => left.startMs - right.startMs)
    .slice(0, MAX_CALENDAR_REMINDERS_PER_RUN);
  if (!upcoming.length) return { sent: 0, skipped: 0, failed: 0 };

  const target = await findTelegramTarget(db, authorizedTelegramUserId);
  if (!target) {
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: "WARN",
      component: "Calendar reminders",
      eventType: "No Telegram destination",
      description: "Skipped appointment reminders because no private-chat destination is recorded."
    });
    return { sent: 0, skipped: upcoming.length, failed: 0 };
  }

  const claimed = [];

  for (const { event, startMs } of upcoming) {
    const scheduledAt = new Date(startMs - leadMs).toISOString();
    const reminder = await db.prepare(
      `INSERT INTO reminder_history (
         id, category, related_record_id, scheduled_at, reminder_number,
         delivery_status
       ) VALUES (?1, 'Calendar appointment', ?2, ?3, 1, 'Sending')
       ON CONFLICT(related_record_id, scheduled_at)
         WHERE category = 'Calendar appointment'
           AND related_record_id IS NOT NULL
       DO NOTHING
       RETURNING id`
    ).bind(`CALREM-${crypto.randomUUID()}`, event.id, scheduledAt).first();
    if (reminder) claimed.push({ id: reminder.id, event, startMs });
  }

  if (!claimed.length) {
    return { sent: 0, skipped: upcoming.length ? upcoming.length : 0, failed: 0 };
  }

  const message = {
    category: "Calendar appointment reminder",
    title: claimed.length === 1 ? "Upcoming appointment" : "Upcoming appointments",
    sections: [{
      heading: "Prepare for your upcoming appointment",
      lines: claimed.map(({ event, startMs }) => {
        const minutesUntil = Math.ceil((startMs - nowMs) / 60_000);
        return `${event.start} · ${event.title}\nStarts in about ${minutesUntil} minutes. Take a moment to prepare.`;
      })
    }],
    actions: claimed.map(({ id }) => [
      { label: "Prepared", action: `cal_prepared|${id}` },
      { label: "Dismiss", action: `cal_dismissed|${id}` }
    ])
  };

  let delivered;
  try {
    delivered = await telegram.sendAssistantResponse(target.chatId, message);
  } catch (error) {
    const deliveryStatus = error && error.outcomeUncertain ? "Uncertain" : "Failed";
    await db.batch(claimed.map(({ id }) => db.prepare(
      `UPDATE reminder_history
          SET delivery_status = ?1
        WHERE id = ?2 AND delivery_status = 'Sending'`
    ).bind(deliveryStatus, id)));
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: "ERROR",
      component: "Calendar reminders",
      eventType: "Reminder delivery failed",
      description: "Could not confirm delivery of a Calendar appointment reminder.",
      errorMessage: error && error.name ? String(error.name) : "Error"
    });
    return { sent: 0, skipped: 0, failed: 1 };
  }

  await db.batch(claimed.map(({ id }) => db.prepare(
    `UPDATE reminder_history
        SET sent_at = ?1, delivery_status = 'Sent'
      WHERE id = ?2 AND delivery_status = 'Sending'`
  ).bind(now.toISOString(), id)));
  await insertChannelMessage(db, {
    channel: "telegram",
    conversationId: target.chatId,
    externalMessageId: String(delivered.message_id),
    userId: target.userId,
    direction: "outgoing",
    type: "message",
    category: message.category,
    deliveryStatus: "Sent",
    createdAt: now.toISOString()
  });
  await logSystemEvent(db, {
    occurredAt: now.toISOString(),
    severity: "INFO",
    component: "Calendar reminders",
    eventType: "Appointment reminder sent",
    description: `Sent one reminder for ${claimed.length} upcoming appointment(s).`
  });
  return { sent: 1, skipped: upcoming.length - claimed.length, failed: 0 };
}

async function findTelegramTarget(db, authorizedTelegramUserId) {
  const user = await db.prepare(
    "SELECT id FROM users WHERE channel = 'telegram' AND external_user_id = ?1"
  ).bind(String(authorizedTelegramUserId)).first();
  if (!user) return null;
  const message = await db.prepare(
    `SELECT external_chat_id
       FROM channel_messages
      WHERE channel = 'telegram' AND user_id = ?1
        AND direction = 'incoming' AND external_chat_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1`
  ).bind(user.id).first();
  return message && message.external_chat_id
    ? { userId: user.id, chatId: message.external_chat_id }
    : null;
}

async function finishReminderJob(db, jobId, now, status, errorDetails = "") {
  await db.prepare(
    `UPDATE scheduled_job_runs
        SET completed_at = ?1, status = ?2, error_details = ?3
      WHERE id = ?4 AND status = 'Processing'`
  ).bind(now.toISOString(), status, errorDetails, jobId).run();
}

function cairoParts(date) {
  return cairoTimeParts(date);
}

function formatCalendarErrorDetails(error) {
  const reason = error && error.googleApiReason ? ` ${error.googleApiReason}` : "";
  const status = error && error.status ? ` (HTTP ${Number(error.status)})` : "";
  return `Google Calendar${reason}${status}`;
}
