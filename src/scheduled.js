import {
  insertChannelMessage,
  logSystemEvent,
  logSyncEvent,
  setConversationState
} from "./db/channel-repository.js";
import { listDailyGoalFocus } from "./db/goal-repository.js";
import { listPendingTaskPlanningCandidates, syncGoogleTaskMirrors } from "./db/google-tasks-repository.js";
import { createTelegramApi } from "./channels/telegram-api.js";
import { createGoogleCalendarClient } from "./integrations/google-calendar.js";
import { createGoogleGmailClient } from "./integrations/google-gmail.js";
import { createGoogleTasksClient } from "./integrations/google-tasks.js";
import { processScheduledReports } from "./reports.js";
import { processHighPriorityEscalations } from "./escalations.js";
import {
  processCalendarAppointmentReminders,
  processOverdueTaskReminders
} from "./reminders.js";
import { buildDailyTaskPlan, formatDailyTaskPlan } from "./core/daily-planner.js";
import { prioritizeReviewRecommendations } from "./ai/review-analyzer.js";
import { areaLabel, cairoTimeParts as formatCairoTimeParts, longDate, timeLabel, weekdayDay } from "./core/format.js";
import { getDisplayName, say } from "./core/voice.js";
import { processWorkPulses } from "./pulses.js";

const MAX_FOLLOWUPS_PER_RUN = 5;
const MAX_FOLLOWUP_AGE_MS = 30 * 60 * 1000;
const CLAIM_LEASE_MS = 2 * 60 * 1000;

export async function processDueFocusSessions({ db, telegram, now }) {
  const nowIso = now.toISOString();
  const oldestValidDueAt = new Date(now.getTime() - MAX_FOLLOWUP_AGE_MS).toISOString();

  await db.prepare(
    `UPDATE focus_sessions
        SET followup_status = 'Expired', claim_until = NULL
      WHERE due_at < ?1
        AND (followup_status = 'Scheduled'
             OR (followup_status = 'Sending' AND claim_until < ?2))`
  ).bind(oldestValidDueAt, nowIso).run();

  const due = await db.prepare(
    `SELECT id
       FROM focus_sessions
      WHERE (followup_status = 'Scheduled'
             OR (followup_status = 'Sending' AND claim_until < ?1))
        AND due_at <= ?2
        AND due_at >= ?3
      ORDER BY due_at
      LIMIT ?4`
  ).bind(nowIso, nowIso, oldestValidDueAt, MAX_FOLLOWUPS_PER_RUN).all();

  let sent = 0;
  for (const row of due.results) {
    const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString();
    const session = await db.prepare(
      `UPDATE focus_sessions
          SET followup_status = 'Sending',
              claim_until = ?1,
              attempt_count = attempt_count + 1
        WHERE id = ?2
          AND (followup_status = 'Scheduled'
               OR (followup_status = 'Sending' AND claim_until < ?3))
        RETURNING id, user_id, chat_id, outcome_date, area, next_action,
                  duration_minutes, due_at, attempt_count`
    ).bind(leaseUntil, row.id, nowIso).first();
    if (!session) continue;

    try {
      const sentMessage = await telegram.sendAssistantResponse(session.chat_id, {
        category: "Focus follow-up",
        title: `${session.area} focus block is up`,
        sections: [{
          heading: session.next_action,
          lines: ["Choose the honest next step."]
        }],
        actions: [[
          { label: "Done", action: `focus|${session.id}|Done` },
          { label: "Partly done", action: `focus|${session.id}|Partial` }
        ], [
          { label: "Blocked", action: `focus|${session.id}|Blocked` },
          { label: "Reschedule", action: `focus|${session.id}|Reschedule` }
        ]]
      });

      await db.prepare(
        `UPDATE focus_sessions
            SET followup_status = 'Sent', claim_until = NULL
          WHERE id = ?1 AND followup_status = 'Sending'`
      ).bind(session.id).run();
      await insertChannelMessage(db, {
        channel: "telegram",
        conversationId: session.chat_id,
        externalMessageId: String(sentMessage.message_id),
        userId: session.user_id,
        direction: "outgoing",
        type: "message",
        category: "Focus follow-up",
        deliveryStatus: "Sent",
        createdAt: nowIso
      });
      await logSystemEvent(db, {
        occurredAt: nowIso,
        severity: "INFO",
        component: "Focus scheduler",
        eventType: "Follow-up sent",
        description: "Focus block follow-up delivered.",
        relatedRecordId: session.id
      });
      sent++;
    } catch (error) {
      await db.prepare(
        `UPDATE focus_sessions
            SET followup_status = 'Failed', claim_until = NULL
          WHERE id = ?1 AND followup_status = 'Sending'`
      ).bind(session.id).run();
      await logSystemEvent(db, {
        occurredAt: now.toISOString(),
        severity: "ERROR",
        component: "Focus scheduler",
        eventType: "Follow-up delivery failed",
        description: "Focus block follow-up could not be delivered.",
        relatedRecordId: session.id,
        errorMessage: error && error.message ? String(error.message).slice(0, 500) : "Unknown error"
      });
    }
  }
  return { sent, considered: due.results.length };
}

export async function handleScheduledEvent(controller, env, ctx) {
  if (env.TELEGRAM_WEBHOOK_CUTOVER_ENABLED === "true") {
    return performTelegramWebhookCutover(env, new Date(Number(controller.scheduledTime)));
  }
  if (env.SCHEDULED_JOBS_ENABLED !== "true" ||
      env.ASSISTANT_ENABLED !== "true" ||
      !["staging", "production"].includes(env.DEPLOYMENT_STAGE)) {
    return { skipped: true, reason: "Scheduled jobs are disabled." };
  }
  if (!env.DB) throw new Error("D1 database binding is not configured for scheduled jobs.");
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram Bot API secret is not configured for scheduled jobs.");
  const now = new Date(Number(controller.scheduledTime));
  if (Number.isNaN(now.getTime())) throw new TypeError("Scheduled event time is invalid.");
  const telegram = createTelegramApi(env.TELEGRAM_BOT_TOKEN);
  const googleCalendar = env.GOOGLE_CALENDAR_ENABLED === "true"
    ? createGoogleCalendarClient(env)
    : null;
  const googleTasks = hasGoogleTasksConfig(env)
    ? createGoogleTasksClient(env)
    : null;
  const gmail = env.GOOGLE_GMAIL_ENABLED === "true"
    ? createGoogleGmailClient(env)
    : null;
  const aiEnabled =
    env.AI_ENABLED === "true" &&
    env.AI_FREE_PLAN_CONFIRMED === "true" &&
    Boolean(env.AI);
  const aiReviewRecommendations = aiEnabled
    ? ({ report, metrics }) => prioritizeReviewRecommendations({
        db: env.DB,
        ai: env.AI,
        report,
        metrics,
        now,
        model: env.AI_MODEL || undefined,
        dailyNeuronLimit: env.AI_DAILY_NEURON_LIMIT || 5000
      })
    : null;
  const focus = await processDueFocusSessions({
    db: env.DB,
    telegram,
    now
  });
  const pulses = await processWorkPulses({
    db: env.DB,
    telegram,
    now,
    authorizedTelegramUserId: env.AUTHORIZED_TELEGRAM_USER_ID,
    googleCalendar,
    enabled: env.WORK_PULSES_ENABLED === "true"
  });
  const rhythm = await processScheduledRhythm({
    db: env.DB,
    telegram,
    now,
    authorizedTelegramUserId: env.AUTHORIZED_TELEGRAM_USER_ID,
    googleTasks,
    googleCalendar
  });
  const reports = await processScheduledReports({
    db: env.DB,
    googleTasks,
    gmail,
    recipient: env.PRODUCTIVITY_EMAIL_RECIPIENT,
    aiReviewRecommendations,
    htmlEmailsEnabled: env.HTML_EMAILS_ENABLED === "true",
    displayName: "Mohamed",
    now
  });
  const escalations = await processHighPriorityEscalations({
    db: env.DB,
    googleTasks,
    gmail,
    recipient: env.PRODUCTIVITY_EMAIL_RECIPIENT,
    htmlEmailsEnabled: env.HTML_EMAILS_ENABLED === "true",
    now,
    enabled: env.EMAIL_ESCALATIONS_ENABLED === "true"
  });
  const calendarReminders = await processCalendarAppointmentReminders({
    db: env.DB,
    telegram,
    googleCalendar,
    authorizedTelegramUserId: env.AUTHORIZED_TELEGRAM_USER_ID,
    now,
    enabled: env.CALENDAR_REMINDERS_ENABLED === "true"
  });
  await processOverdueTaskReminders({
    db: env.DB,
    telegram,
    googleTasks,
    authorizedTelegramUserId: env.AUTHORIZED_TELEGRAM_USER_ID,
    now,
    enabled: false
  });
  return { focus, pulses, rhythm, reports, escalations, calendarReminders };
}

async function performTelegramWebhookCutover(env, now) {
  if (env.DEPLOYMENT_STAGE !== "production" || env.ASSISTANT_ENABLED !== "true") {
    throw new Error("Telegram webhook cutover requires an enabled production deployment.");
  }
  if (!env.DB) throw new Error("D1 database binding is not configured for Telegram webhook cutover.");
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_WEBHOOK_URL) {
    throw new Error("Telegram webhook cutover configuration is incomplete.");
  }
  if (Number.isNaN(now.getTime())) throw new TypeError("Scheduled event time is invalid.");

  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const jobKey = "telegram-webhook-cutover:production";
  const jobId = `JOB-${crypto.randomUUID()}`;
  const claim = await env.DB.prepare(
    `INSERT INTO scheduled_job_runs (id, job_key, started_at, status)
     VALUES (?1, ?2, ?3, 'Processing')
     ON CONFLICT(job_key) DO UPDATE SET
       id = excluded.id,
       started_at = excluded.started_at,
       completed_at = NULL,
       status = 'Processing',
       error_details = NULL
     WHERE scheduled_job_runs.status = 'Failed'
        OR (scheduled_job_runs.status = 'Processing'
            AND scheduled_job_runs.started_at < ?4)
     RETURNING id`
  ).bind(jobId, jobKey, nowIso, staleBefore).first();
  if (!claim) return { skipped: true, reason: "Webhook cutover already completed or is in progress." };

  try {
    const telegram = createTelegramApi(env.TELEGRAM_BOT_TOKEN);
    await telegram.call("setWebhook", {
      url: env.TELEGRAM_WEBHOOK_URL,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false
    });
    await telegram.setMyCommands([
      { command: "hq", description: "📱 Your HQ: now, next, today" },
      { command: "go", description: "▶️ Start the next move" },
      { command: "drop", description: "📝 Drop a task" },
      { command: "wya", description: "🧭 Where I'm at" },
      { command: "plan", description: "🗓 Plan your day" },
      { command: "zzz", description: "😴 Sleep mode and wake-up" },
      { command: "dive", description: "🎧 Leave me alone for a few hours" },
      { command: "remind", description: "⏰ Remind me about something" },
      { command: "stack", description: "📋 Your task stack" },
      { command: "late", description: "🔴 What's overdue" },
      { command: "mail", description: "📥 Unread mail" },
      { command: "pipeline", description: "🔧 How this bot works" }
    ]);
    if (env.MINI_APP_ENABLED === "true" && env.PUBLIC_BASE_URL) {
      await telegram.setChatMenuButton({
        menu_button: {
          type: "web_app",
          text: "HQ",
          web_app: { url: `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/app/home` }
        }
      });
    }
    const info = await telegram.call("getWebhookInfo", {});
    if (info.url !== env.TELEGRAM_WEBHOOK_URL) {
      throw new Error("Telegram did not report the configured production webhook URL.");
    }

    await env.DB.prepare(
      `UPDATE scheduled_job_runs
          SET completed_at = ?1, status = 'Completed'
        WHERE id = ?2 AND status = 'Processing'`
    ).bind(nowIso, jobId).run();
    const deliveryStatus = {
      pendingUpdateCount: Number(info.pending_update_count || 0),
      lastErrorDate: Number.isFinite(Number(info.last_error_date))
        ? new Date(Number(info.last_error_date) * 1000).toISOString()
        : null,
      lastErrorMessage: info.last_error_message
        ? String(info.last_error_message).slice(0, 500)
        : null
    };
    await logSystemEvent(env.DB, {
      occurredAt: nowIso,
      severity: deliveryStatus.lastErrorMessage ? "WARNING" : "INFO",
      component: "Telegram webhook cutover",
      eventType: "Webhook configured",
      description: JSON.stringify({
        message: "Telegram webhook now points to the production Worker.",
        ...deliveryStatus
      })
    });
    return { completed: true };
  } catch (error) {
    await env.DB.prepare(
      `UPDATE scheduled_job_runs
          SET completed_at = ?1, status = 'Failed', error_details = ?2
        WHERE id = ?3 AND status = 'Processing'`
    ).bind(
      nowIso,
      error && error.message ? String(error.message).slice(0, 500) : "Unknown error",
      jobId
    ).run();
    throw error;
  }
}

function hasGoogleTasksConfig(env) {
  return Boolean(
    env.GOOGLE_OAUTH_CLIENT_ID &&
    env.GOOGLE_OAUTH_CLIENT_SECRET &&
    env.GOOGLE_OAUTH_REFRESH_TOKEN &&
    env.GOOGLE_TASK_LIST_ID
  );
}

export async function processScheduledRhythm({
  db,
  telegram,
  now,
  authorizedTelegramUserId,
  googleTasks = null,
  googleCalendar = null
}) {
  const parts = cairoDateTimeParts(now);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}`;
  const dueJob = {
    "07:30": "morning",
    "14:15": "work_briefing",
    "23:00": "shutdown",
    "23:20": "next_day_planning",
    "23:40": "planning_1",
    "00:00": "planning_1",
    "00:20": "planning_2",
    "00:45": "planning_3"
  }[time];
  if (!dueJob) return { sent: 0, skipped: 0 };
  const weekdayName = formatCairoTimeParts(now).weekday;
  const weekday = weekdayName === "Sat" ? 6 : weekdayName === "Sun" ? 0 : null;
  if ((weekday === 6 || weekday === 0) &&
      (dueJob === "work_briefing" || dueJob === "shutdown")) {
    return { sent: 0, skipped: 1 };
  }

  if (dueJob.startsWith("planning_")) {
    const review = await db.prepare(
      "SELECT planning_completed FROM daily_reviews WHERE review_date = ?1"
    ).bind(date).first();
    if (review && Number(review.planning_completed) === 1) {
      return { sent: 0, skipped: 1 };
    }
  }

  const target = await findTelegramTarget(db, authorizedTelegramUserId);
  if (!target) {
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: "WARN",
      component: "Scheduler",
      eventType: "No Telegram destination",
      description: `Skipped ${dueJob}; no authorized private-chat destination is recorded.`
    });
    return { sent: 0, skipped: 1 };
  }

  const jobKey = `rhythm:${dueJob}:${date}`;
  const jobId = `JOB-${crypto.randomUUID()}`;
  const claimed = await db.prepare(
    `INSERT INTO scheduled_job_runs (id, job_key, started_at, status)
     VALUES (?1, ?2, ?3, 'Processing')
     ON CONFLICT(job_key) DO NOTHING
     RETURNING id`
  ).bind(jobId, jobKey, now.toISOString()).first();
  if (!claimed) return { sent: 0, skipped: 1 };

  try {
    const message = await buildRhythmMessage({
      db,
      target,
      dueJob,
      date,
      now,
      googleTasks,
      googleCalendar
    });
    const delivered = await telegram.sendAssistantResponse(target.chatId, message);
    if (dueJob === "morning") {
      try {
        await telegram.pinChatMessage(target.chatId, delivered.message_id);
        await db.prepare(
          `INSERT INTO today_cards (
             user_id, cairo_date, telegram_chat_id, telegram_message_id, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(user_id) DO UPDATE SET
             cairo_date = excluded.cairo_date,
             telegram_chat_id = excluded.telegram_chat_id,
             telegram_message_id = excluded.telegram_message_id,
             updated_at = excluded.updated_at`
        ).bind(target.userId, date, target.chatId, String(delivered.message_id), now.toISOString()).run();
      } catch (error) {
        await logSystemEvent(db, {
          occurredAt: now.toISOString(),
          severity: "WARN",
          component: "Today card",
          eventType: "Card pin failed",
          description: "Morning card was sent but could not be pinned.",
          errorMessage: error && error.message ? String(error.message).slice(0, 300) : "Pin failed"
        });
      }
    }
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
    await db.prepare(
      `UPDATE scheduled_job_runs
          SET completed_at = ?1, status = 'Completed'
        WHERE id = ?2 AND status = 'Processing'`
    ).bind(now.toISOString(), jobId).run();
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: "INFO",
      component: "Scheduler",
      eventType: "Rhythm prompt sent",
      description: `Sent ${dueJob} prompt.`,
      relatedRecordId: jobId
    });
    return { sent: 1, skipped: 0 };
  } catch (error) {
    await db.prepare(
      `UPDATE scheduled_job_runs
          SET completed_at = ?1, status = 'Failed', error_details = ?2
        WHERE id = ?3 AND status = 'Processing'`
    ).bind(
      now.toISOString(),
      error && error.message ? String(error.message).slice(0, 500) : "Unknown error",
      jobId
    ).run();
    await logSystemEvent(db, {
      occurredAt: now.toISOString(),
      severity: "ERROR",
      component: "Scheduler",
      eventType: "Rhythm prompt failed",
      description: `Could not send ${dueJob} prompt.`,
      relatedRecordId: jobId,
      errorMessage: error && error.message ? String(error.message).slice(0, 500) : "Unknown error"
    });
    throw error;
  }
}

async function findTelegramTarget(db, authorizedTelegramUserId) {
  if (!authorizedTelegramUserId) return null;
  const user = await db.prepare(
    `SELECT id
       FROM users
      WHERE channel = 'telegram' AND external_user_id = ?1`
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
  if (!message || !message.external_chat_id) return null;
  return { userId: user.id, chatId: message.external_chat_id };
}

async function buildRhythmMessage({ db, target, dueJob, date, now, googleTasks, googleCalendar }) {
  if (dueJob === "morning") {
    const outcomes = await getOutcomesForDate(db, date);
    const name = await getDisplayName(db);
    const goalFocus = await listDailyGoalFocus(db, target.userId, date);
    let taskPlan = null;
    let taskFailureMessage = googleTasks
      ? "Task status could not be refreshed, so task priorities are omitted from this briefing."
      : "Google Tasks is not configured, so task priorities are omitted from this briefing.";
    if (googleTasks) {
      let tasks = null;
      try {
        tasks = await googleTasks.listAll();
        await syncGoogleTaskMirrors(db, tasks, now.toISOString());
        await logSyncEvent(db, {
          source: "Google Tasks",
          operation: "Synchronize tasks for morning briefing",
          occurredAt: now.toISOString(),
          result: "Success",
          relatedRecordId: `${tasks.length} task(s)`
        });
      } catch (error) {
        await logSyncEvent(db, {
          source: "Google Tasks",
          operation: "Synchronize tasks for morning briefing",
          occurredAt: now.toISOString(),
          result: "Failed",
          errorDetails: error && error.name ? String(error.name) : "Error"
        });
      }
      if (tasks) {
        try {
          const candidates = await listPendingTaskPlanningCandidates(db, date);
          taskPlan = buildDailyTaskPlan(candidates, date);
        } catch (error) {
          taskFailureMessage = "Task priorities could not be built, so they are omitted from this briefing.";
          await logSystemEvent(db, {
            occurredAt: now.toISOString(),
            severity: "ERROR",
            component: "Daily Planner",
            eventType: "Morning task plan failed",
            description: "Could not build task priorities for the morning briefing.",
            errorMessage: error && error.name ? String(error.name) : "Error"
          });
        }
      }
    }
    let calendarEvents = null;
    let calendarErrorDetails = null;
    if (googleCalendar) {
      try {
        calendarEvents = await googleCalendar.listEventsForDate(date);
      } catch (error) {
        calendarErrorDetails = formatCalendarErrorDetails(error);
        await logSystemEvent(db, {
          occurredAt: now.toISOString(),
          severity: "WARN",
          component: "Google Calendar",
          eventType: "Calendar read failed",
          description: "Could not retrieve events for the morning briefing.",
          errorMessage: calendarErrorDetails
        });
      }
    }
    return {
      category: "Morning briefing",
      title: `Good morning, ${name}.`,
      sections: [
        ...(outcomes.length
          ? [{ heading: "Your three outcomes", lines: outcomes }]
          : [{ heading: "", lines: [say("plan_unset", { now })] }]),
        ...(taskPlan
          ? formatDailyTaskPlan(taskPlan, date)
          : [{
              heading: "Google Tasks",
              lines: [taskFailureMessage]
            }]),
        {
          heading: "Goal-aligned next actions",
          lines: goalFocus.length
            ? goalFocus.map(goal => formatGoalFocus(goal, date))
            : ["No objectives defined yet. Use /goal when ready."]
        },
        {
          heading: "Calendar",
          lines: calendarEvents
            ? calendarEvents.length
              ? calendarEvents.map(formatCalendarEvent)
              : ["No appointments today."]
            : calendarErrorDetails
              ? [
                  `Calendar unavailable (${calendarErrorDetails}).`,
                  "Your task plan is still available; verify Calendar access separately."
                ]
              : ["Calendar integration is disabled until OAuth access is authorized."]
        },
        { heading: "", lines: ["What do you want to move forward now?"] }
      ],
      actions: [
        [
          { label: "Start DEEP", action: "start_outcome|DEEP" },
          { label: "Start WORK", action: "start_outcome|WORK" }
        ],
        [{ label: "Start LIFE", action: "start_outcome|LIFE" }],
        [
          { label: "Add something", action: "add_task" },
          { label: "Show full plan", action: "plan_my_day" }
        ],
        [{ label: "Review goals", action: "goals_show" }]
      ]
    };
  }

  if (dueJob === "work_briefing") {
    const runId = crypto.randomUUID();
    await setConversationState(db, target.userId, {
      type: "work_briefing_target",
      date,
      runId
    }, now.toISOString());
    return {
      category: "Work briefing",
      title: `${timeLabel(new Date(now))} work pre-shift`,
      sections: [{ heading: "", lines: [say("preshift_1", { name: await getDisplayName(db), now })] }],
      inputMode: "force_reply",
      inputPlaceholder: "One concrete target"
    };
  }

  if (dueJob === "shutdown") {
    return {
      category: "Daily shutdown",
      title: `${timeLabel(now)} shutdown`,
      sections: [{ heading: "", lines: [say("shutdown", { name: await getDisplayName(db), now })] }],
      actions: [
        [{ label: "Add an open loop", action: "add_task" }],
        [{ label: "No open loops now", action: "shutdown_done" }]
      ]
    };
  }

  if (dueJob === "next_day_planning") {
    const tomorrow = shiftDateKey(date, 1);
    await setConversationState(db, target.userId, {
      type: "next_day_done",
      date: tomorrow,
      reviewDate: date,
      runId: crypto.randomUUID()
    }, now.toISOString(), 7200);
    return {
      category: "Next-day planning",
      title: "Plan tomorrow",
      sections: [{ heading: "", lines: [say("plan_tomorrow_prompt", { now })] }],
      inputMode: "force_reply",
      inputPlaceholder: "One useful win"
    };
  }

  return {
    category: "Daily planning",
    title: "Planning confirmation",
    sections: [{
      heading: "",
      lines: [
        "Your planning confirmation is the final checkpoint.",
        `Confirm today’s plan for ${date}, or review it first.`
      ]
    }],
    actions: [
      [{ label: "Confirm today's plan", action: `plan_confirm_date|${date}` }],
      [{ label: "Review today's plan", action: "plan_my_day" }]
    ]
  };
}

function formatGoalFocus(goal, date) {
  const levels = {
    life_vision: "Life vision",
    annual: "Annual objective",
    quarterly: "Quarterly objective",
    monthly: "Monthly milestone",
    weekly: "Weekly outcome"
  };
  const progress = goal.progress_fraction == null
    ? ""
    : ` · measured ${Math.round(goal.progress_fraction * 100)}%`;
  const deadline = goal.deadline
    ? ` · deadline ${goal.deadline}${goal.deadline < date ? " (passed)" : ""}`
    : "";
  return `${levels[goal.level] || goal.level}: ${goal.title}${progress}${deadline}\nNext: ${goal.next_action}`;
}

function formatCalendarEvent(event) {
  if (event.allDay) return `All day · ${event.title}`;
  return `${event.start}–${event.end} · ${event.title}`;
}

function formatCalendarErrorDetails(error) {
  const reason = error && error.googleApiReason ? ` ${error.googleApiReason}` : "";
  const status = error && error.status ? ` (HTTP ${Number(error.status)})` : "";
  return `Google Calendar${reason}${status}`;
}

async function getOutcomesForDate(db, date) {
  const result = await db.prepare(
    `SELECT area, outcome, status
       FROM daily_outcomes
      WHERE outcome_date = ?1
      ORDER BY updated_at DESC, rowid DESC`
  ).bind(date).all();
  const latest = new Map();
  for (const row of result.results) {
    if (!latest.has(row.area)) latest.set(row.area, row);
  }
  return ["DEEP", "WORK", "LIFE"].map((area, index) => {
    const outcome = latest.get(area);
    if (!outcome) return null;
    const status = outcome.status !== "Planned" ? ` (${outcome.status})` : "";
    return `${index + 1}. ${areaLabel(area)} — ${outcome.outcome}${status}`;
  }).filter(Boolean);
}

function cairoDateTimeParts(date) {
  return formatCairoTimeParts(date);
}

function shiftDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function recordFocusSession(db, {
  id,
  userId,
  chatId,
  date,
  area,
  googleTaskId,
  nextAction,
  durationMinutes,
  startedAt,
  dueAt
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) ||
      !["DEEP", "WORK", "LIFE"].includes(area) ||
      ![25, 50].includes(durationMinutes) ||
      !nextAction || !userId || !chatId) {
    throw new TypeError("Focus session data is invalid.");
  }
  await db.prepare(
    `INSERT INTO focus_sessions (
       id, user_id, chat_id, outcome_date, area, google_task_id, next_action,
       duration_minutes, started_at, due_at, followup_status
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'Scheduled')`
  ).bind(
    id,
    userId,
    String(chatId),
    date,
    area,
    googleTaskId || null,
    nextAction,
    durationMinutes,
    startedAt,
    dueAt
  ).run();
}

export async function getFocusSession(db, id) {
  return db.prepare(
    `SELECT id, user_id, chat_id, outcome_date, area, google_task_id,
            next_action, duration_minutes, started_at, due_at, followup_status,
            response_status, response_details, responded_at
       FROM focus_sessions
      WHERE id = ?1`
  ).bind(id).first();
}

export async function claimFocusSessionResponse(db, id, now, expectedStatus = null) {
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString();
  return db.prepare(
    `UPDATE focus_sessions
        SET response_status = 'Processing',
            claim_until = ?1,
            processing_from_status = COALESCE(?4, '')
      WHERE id = ?2
        AND followup_status = 'Sent'
        AND ((?4 IS NULL AND
              (response_status IS NULL
               OR (response_status = 'Processing'
                   AND processing_from_status = ''
                   AND claim_until < ?3)))
             OR (?4 IS NOT NULL AND
                 (response_status = ?4
                  OR (response_status = 'Processing'
                      AND processing_from_status = ?4
                      AND claim_until < ?3))))
      RETURNING id`
  ).bind(leaseUntil, id, now.toISOString(), expectedStatus).first();
}

export async function releaseFocusSessionResponse(db, id) {
  await db.prepare(
    `UPDATE focus_sessions
        SET response_status = CASE
                WHEN processing_from_status = '' THEN NULL
                ELSE processing_from_status
            END,
            claim_until = NULL,
            processing_from_status = NULL
      WHERE id = ?1 AND response_status = 'Processing'`
  ).bind(id).run();
}

export async function finalizeFocusSessionResponse(db, id, status, details, now) {
  const result = await db.prepare(
    `UPDATE focus_sessions
        SET response_status = ?1,
            response_details = ?2,
            responded_at = ?3,
            claim_until = NULL,
            processing_from_status = NULL
      WHERE id = ?4 AND response_status = 'Processing'`
  ).bind(status, details || "", now.toISOString(), id).run();
  if (!result.meta || result.meta.changes !== 1) {
    throw new Error("Could not finalize the focus session response.");
  }
}
