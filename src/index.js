import { adaptTelegramUpdate, isAuthorizedTelegramWebhook } from "./channels/telegram.js";
import { createTelegramApi } from "./channels/telegram-api.js";
import { handleAssistantMessage } from "./core/assistant.js";
import {
  claimChannelUpdate,
  finishChannelUpdate,
  getOrCreateChannelUser,
  insertChannelAction,
  insertChannelMessage,
  logSystemEvent
} from "./db/channel-repository.js";
import {
  cairoLocalDateTimeToIso,
  createGoogleCalendarClient
} from "./integrations/google-calendar.js";
import { createGoogleGmailClient } from "./integrations/google-gmail.js";
import { createGoogleTasksClient } from "./integrations/google-tasks.js";
import { classifyNaturalLanguageIntent } from "./ai/intent-classifier.js";
import { parseWithWorkersAi } from "./ai/capture-parser.js";
import { generateConversationalReply } from "./ai/conversation-responder.js";
import { generateCreativeFocusTip, prioritizeDailyTasks } from "./ai/daily-prioritizer.js";
import { analyzeEmailFollowUps } from "./ai/email-followups.js";
import { handleScheduledEvent } from "./scheduled.js";
import {
  addTaskPageHtml,
  miniAppResponse,
  planPageHtml,
  homePageHtml,
  restPageHtml,
  settingsPageHtml,
  validateTelegramInitData
} from "./core/miniapp.js";
import { cairoDateKey, shiftDateKey, shortDate } from "./core/format.js";
import { getDisplayName } from "./core/voice.js";
import { upsertGoogleTaskMirror } from "./db/google-tasks-repository.js";
import { createCapturedTask, createPlannedOutcomeTask } from "./core/assistant.js";
import { createUserReminder } from "./user-reminders.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

export default {
  async scheduled(controller, env, ctx) {
    try {
      return await handleScheduledEvent(controller, env, ctx);
    } catch (error) {
      if (env.DB) {
        await logSystemEvent(env.DB, {
          occurredAt: new Date(Number(controller.scheduledTime)).toISOString(),
          severity: "ERROR",
          component: "Scheduler",
          eventType: "Scheduled run failed",
          description: "Scheduled workflow failed.",
          errorMessage: error && error.message ? String(error.message).slice(0, 500) : "Unknown error"
        });
      }
      throw error;
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      const productionTrafficEnabled =
        env.DEPLOYMENT_STAGE === "production" && env.ASSISTANT_ENABLED === "true";
      return jsonResponse({
        status: env.DEPLOYMENT_STAGE || "staging",
        assistantEnabled: env.ASSISTANT_ENABLED === "true",
        productionTrafficEnabled,
        databaseConfigured: Boolean(env.DB)
      });
    }

    if (url.pathname.startsWith("/app/")) {
      if (env.MINI_APP_ENABLED !== "true") {
        return jsonResponse({ error: "Mini App is disabled." }, 404);
      }
      if (!env.DB) return jsonResponse({ error: "D1 database binding is not configured." }, 503);
      if (request.method === "GET" && [
        "/app/home",
        "/app/add",
        "/app/plan",
        "/app/rest",
        "/app/settings"
      ].includes(url.pathname)) {
        const name = await getDisplayName(env.DB);
        const page = url.pathname === "/app/home"
          ? homePageHtml(name)
          : url.pathname === "/app/rest"
            ? restPageHtml(name)
            : url.pathname === "/app/settings"
              ? settingsPageHtml(name)
              : url.pathname === "/app/plan"
                ? planPageHtml(name)
                : addTaskPageHtml(name);
        return miniAppResponse(page);
      }
      if (url.pathname === "/app/api/bootstrap" && request.method === "GET") {
        const authorized = await authorizeMiniAppRequest(request, env);
        if (!authorized) return jsonResponse({ error: "Unauthorized" }, 401);
        const date = cairoDateKey(new Date());
        const [settings, outcomes, tasks] = await Promise.all([
          env.DB.prepare("SELECT setting_key, setting_value FROM settings").all(),
          env.DB.prepare("SELECT area, outcome, status FROM daily_outcomes WHERE outcome_date = ?1").bind(date).all(),
          env.DB.prepare("SELECT id, title, area, status FROM tasks WHERE status = 'Pending' ORDER BY due_date IS NULL, due_date, title LIMIT 50").all()
        ]);
        return jsonResponse({
          date,
          dateLabel: shortDate(date),
          settings: Object.fromEntries(settings.results.map(row => [row.setting_key, row.setting_value])),
          outcomes: outcomes.results,
          noPlan: outcomes.results.length === 0,
          tasks: tasks.results
        });
      }
      if (url.pathname === "/app/api/plan" && request.method === "POST") {
        const authorized = await authorizeMiniAppRequest(request, env);
        if (!authorized) return jsonResponse({ error: "Unauthorized" }, 401);
        return saveMiniAppPlan(request, env);
      }
      if (url.pathname === "/app/api/task" && request.method === "POST") {
        const authorized = await authorizeMiniAppRequest(request, env);
        if (!authorized) return jsonResponse({ error: "Unauthorized" }, 401);
        return saveMiniAppTask(request, env);
      }
      if (url.pathname === "/app/api/reminder" && request.method === "POST") {
        const authorized = await authorizeMiniAppRequest(request, env);
        if (!authorized) return jsonResponse({ error: "Unauthorized" }, 401);
        return saveMiniAppReminder(request, env);
      }
      if (url.pathname === "/app/api/complete" && request.method === "POST") {
        const authorized = await authorizeMiniAppRequest(request, env);
        if (!authorized) return jsonResponse({ error: "Unauthorized" }, 401);
        return saveMiniAppCompletion(request, env);
      }
      return jsonResponse({ error: "Not found" }, 404);
    }

    if (url.pathname !== "/webhooks/telegram" || request.method !== "POST") {
      return jsonResponse({ error: "Not found" }, 404);
    }

    if (env.DEPLOYMENT_STAGE !== "production" || env.ASSISTANT_ENABLED !== "true") {
      return jsonResponse({ error: "Assistant processing is disabled for this deployment." }, 503);
    }
    if (!env.DB) return jsonResponse({ error: "D1 database binding is not configured." }, 503);
    if (!env.TELEGRAM_BOT_TOKEN) {
      return jsonResponse({ error: "Telegram Bot API secret is not configured." }, 503);
    }
    if (!isAuthorizedTelegramWebhook(request, env.TELEGRAM_WEBHOOK_SECRET)) {
      return jsonResponse({ error: "Unauthorized" }, 403);
    }

    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > MAX_REQUEST_BYTES) {
      return jsonResponse({ error: "Request too large" }, 413);
    }

    let update;
    try {
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
        return jsonResponse({ error: "Request too large" }, 413);
      }
      update = JSON.parse(body);
    } catch {
      return jsonResponse({ error: "Invalid JSON" }, 400);
    }

    let message;
    try {
      message = adaptTelegramUpdate(update);
    } catch (error) {
      if (error instanceof TypeError) {
        return jsonResponse({ error: error.message }, 400);
      }
      throw error;
    }

    const telegram = createTelegramApi(env.TELEGRAM_BOT_TOKEN);
    const authorized = env.AUTHORIZED_TELEGRAM_USER_ID &&
      String(env.AUTHORIZED_TELEGRAM_USER_ID) === message.user.externalId;
    if (!authorized) {
      if (message.action) {
        await telegram.answerCallbackQuery(message.action.externalId, "This bot is private.");
      }
      return jsonResponse({ ok: true });
    }

    const now = new Date();
    let user;
    let claim;
    try {
      user = await getOrCreateChannelUser(
        env.DB,
        message.channel,
        message.user.externalId,
        now.toISOString()
      );
      claim = await claimChannelUpdate(env.DB, message, user.id, now.toISOString());
    } catch (error) {
      console.error(JSON.stringify({
        event: "telegram_update_claim_failed",
        updateId: message.id,
        errorType: error && error.name || "Error"
      }));
      return jsonResponse({ error: "Could not claim update for processing." }, 500);
    }
    if (!claim.claimed) return jsonResponse({ ok: true, duplicate: true });

    try {
      if (message.action) {
        try {
          await telegram.answerCallbackQuery(message.action.externalId, "Processing…");
        } catch (error) {
          await logFailure(env.DB, message.id, "Callback acknowledgement failed", error, env);
        }
      }
      await insertChannelMessage(env.DB, {
        channel: message.channel,
        conversationId: message.conversation.externalId,
        externalMessageId: message.message.externalId,
        userId: user.id,
        direction: "incoming",
        type: message.message.type,
        content: message.message.text,
        callbackInformation: message.action ? message.action.identifier : null,
        createdAt: message.receivedAt
      });

      const googleTasks = hasGoogleTasksConfig(env)
        ? createGoogleTasksClient(env)
        : null;
      const googleGmail = env.GOOGLE_GMAIL_READ_ENABLED === "true"
        ? createGoogleGmailClient(env)
        : null;
      const calendarClient = env.GOOGLE_CALENDAR_ENABLED === "true"
        ? createGoogleCalendarClient(env)
        : null;
      const googleCalendar = calendarClient
        ? {
            listEventsForDate: date => calendarClient.listEventsForDate(date),
            ...(env.GOOGLE_CALENDAR_WRITES_ENABLED === "true"
              ? { createTaskBlock: options => calendarClient.createTaskBlock(options) }
              : {})
          }
        : null;
      const aiEnabled =
        env.AI_ENABLED === "true" &&
        env.AI_FREE_PLAN_CONFIRMED === "true" &&
        Boolean(env.AI);
      const captureParser = aiEnabled
        ? ({ text, recentTurns, now: parseNow }) => parseWithWorkersAi({
            db: env.DB,
            ai: env.AI,
            text,
            recentTurns,
            now: parseNow || now,
            model: env.AI_MODEL || undefined,
            dailyNeuronLimit: env.AI_DAILY_NEURON_LIMIT || 5000
          })
        : null;
      const conversationResponder = aiEnabled
        ? ({ text, facts, recentTurns, now: replyNow }) => generateConversationalReply({
            db: env.DB,
            ai: env.AI,
            text,
            facts,
            recentTurns,
            now: replyNow || now,
            model: env.AI_MODEL || undefined,
            dailyNeuronLimit: env.AI_DAILY_NEURON_LIMIT || 5000
          })
        : null;
      const onBeforeAiCall = () =>
        telegram.sendChatAction(message.conversation.externalId, "typing").catch(() => {});
      const naturalLanguageClassifier = aiEnabled
        ? text => classifyNaturalLanguageIntent({
              db: env.DB,
              ai: env.AI,
              text,
              now,
              model: env.AI_MODEL || undefined,
              dailyNeuronLimit: env.AI_DAILY_NEURON_LIMIT || 5000
            })
        : null;
      const aiDailyPlanner = aiEnabled
        ? ({ date, tasks, goals }) => prioritizeDailyTasks({
            db: env.DB,
            ai: env.AI,
            date,
            tasks,
            goals,
            now,
            model: env.AI_MODEL || undefined,
            dailyNeuronLimit: env.AI_DAILY_NEURON_LIMIT || 5000
          })
        : null;
      const aiFocusTip = aiEnabled
        ? ({ tasks, goals }) => generateCreativeFocusTip({
            db: env.DB,
            ai: env.AI,
            tasks,
            goals,
            now,
            model: env.AI_MODEL || undefined,
            dailyNeuronLimit: env.AI_DAILY_NEURON_LIMIT || 5000
          })
        : null;
      const emailFollowUpAnalyzer =
        aiEnabled &&
        googleGmail &&
        env.GMAIL_AI_ANALYSIS_ENABLED === "true"
          ? threads => analyzeEmailFollowUps({
              db: env.DB,
              ai: env.AI,
              threads,
              now,
              model: env.AI_MODEL || undefined,
              dailyNeuronLimit: env.AI_DAILY_NEURON_LIMIT || 5000
            })
          : null;
      const result = await handleAssistantMessage({
        db: env.DB,
        user,
        message,
        googleTasks,
        googleCalendar,
        googleGmail,
        naturalLanguageClassifier,
        captureParser,
        conversationResponder,
        onBeforeAiCall,
        aiDailyPlanner,
        aiFocusTip,
        emailFollowUpAnalyzer,
        userRemindersEnabled: env.USER_REMINDERS_ENABLED === "true",
        companionEnabled: env.COMPANION_ENABLED === "true",
        workPulsesEnabled: env.WORK_PULSES_ENABLED === "true",
        now
      });

      let deliveredMessage = null;
      if (result) {
        if (message.action && message.message.externalId) {
          try {
            deliveredMessage = await telegram.editAssistantResponse(
              message.conversation.externalId,
              Number(message.message.externalId),
              result
            );
          } catch (error) {
            await logFailure(
              env.DB,
              message.id,
              "Telegram message edit failed; sent a new message",
              error,
              env,
              { severity: "WARN", eventType: "Message edit fallback" }
            );
            deliveredMessage = await telegram.sendAssistantResponse(
              message.conversation.externalId,
              result
            );
          }
        } else {
          deliveredMessage = await telegram.sendAssistantResponse(
            message.conversation.externalId,
            result
          );
        }
      }
      if (message.action) {
        await insertChannelAction(env.DB, {
          channel: message.channel,
          userId: user.id,
          externalActionId: message.action.externalId,
          identifier: message.action.identifier,
          actionName: message.action.identifier.split("|")[0],
          result: result ? "Processed" : "Ignored",
          createdAt: now.toISOString()
        });
      }
      if (deliveredMessage) {
        await insertChannelMessage(env.DB, {
          channel: message.channel,
          conversationId: message.conversation.externalId,
          externalMessageId: String(deliveredMessage.message_id),
          userId: user.id,
          direction: "outgoing",
          type: "message",
          category: result.category,
          deliveryStatus: "Sent",
          createdAt: now.toISOString()
        });
      }
      await finishChannelUpdate(env.DB, message, "processed", new Date().toISOString());
      return jsonResponse({ ok: true });
    } catch (error) {
      await logFailure(env.DB, message.id, "Telegram update processing failed", error, env);
      try {
        const notice = await telegram.sendMessage(
          message.conversation.externalId,
          formatFailureNotice(error)
        );
        await insertChannelMessage(env.DB, {
          channel: message.channel,
          conversationId: message.conversation.externalId,
          externalMessageId: String(notice.message_id),
          userId: user.id,
          direction: "outgoing",
          type: "message",
          category: "Action needs attention",
          deliveryStatus: "Sent",
          createdAt: new Date().toISOString()
        });
        await finishChannelUpdate(
          env.DB,
          message,
          "processed_with_error",
          new Date().toISOString()
        );
        return jsonResponse({ ok: true, needsAttention: true });
      } catch (noticeError) {
        try {
          await finishChannelUpdate(env.DB, message, "failed", new Date().toISOString());
        } catch (finalizeError) {
          await logFailure(env.DB, message.id, "Update finalization failed", finalizeError, env);
        }
        await logFailure(env.DB, message.id, "Failure notice delivery failed", noticeError, env);
        return jsonResponse({ error: "Update processing failed." }, 500);
      }
    }
  }
};

function formatFailureNotice(error) {
  if (error && error.oauthErrorCode === "invalid_grant") {
    return "<b>Google authorization needs attention.</b>\n\nGoogle rejected the saved refresh grant. Reauthorize Google and update the existing OAuth refresh token directly in Cloudflare. Never send credentials in this chat. No task status was changed.";
  }
  if (error && error.oauthErrorCode === "invalid_client") {
    return "<b>Google authorization needs attention.</b>\n\nGoogle rejected the OAuth client credentials. Correct the existing client credentials directly in Cloudflare. Never send credentials in this chat. No task status was changed.";
  }
  if (error && error.oauthRefreshFailure) {
    const status = Number.isInteger(Number(error.status)) ? ` (HTTP ${Number(error.status)})` : "";
    return `<b>Google authorization needs attention.</b>\n\nGoogle could not refresh the saved OAuth credentials${status}. Review the existing Google OAuth values directly in Cloudflare. Never send credentials in this chat. No Google API operation was performed.`;
  }
  if (error && error.integration === "Google Calendar" && Number(error.status) === 403) {
    return "<b>Google Calendar access was denied.</b>\n\nCheck the Calendar API and the Calendar access granted to the configured Google account. Task management remains available; check Calendar before retrying any event action.";
  }
  return "<b>I couldn't complete that request.</b>\n\nCheck the connected service and verify whether the requested change took effect before retrying.";
}

async function authorizeMiniAppRequest(request, env) {
  const initData = request.headers.get("X-Telegram-Init-Data");
  if (!initData || !env.TELEGRAM_BOT_TOKEN) return null;
  return validateTelegramInitData(initData, env.TELEGRAM_BOT_TOKEN, env.AUTHORIZED_TELEGRAM_USER_ID);
}

async function saveMiniAppPlan(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON." }, 400);
  }
  if (!body || typeof body.requestId !== "string" || body.requestId.length > 128) {
    return jsonResponse({ error: "A request id is required." }, 400);
  }
  const existing = await env.DB.prepare(
    "SELECT google_task_id FROM mini_app_requests WHERE id = ?1"
  ).bind(body.requestId).first();
  if (existing) return jsonResponse({ ok: true, duplicate: true });
  await env.DB.prepare(
    `INSERT INTO mini_app_requests (id, created_at, status)
     VALUES (?1, ?2, 'Processing')`
  ).bind(body.requestId, new Date().toISOString()).run();

  const now = new Date();
  const date = body.mode === "tomorrow"
    ? shiftDateKey(cairoDateKey(now), 1)
    : cairoDateKey(now);
  const areas = [
    ["DEEP", body.growth],
    ["WORK", body.work],
    ["LIFE", body.life]
  ];
  const googleTasks = hasGoogleTasksConfig(env) ? createGoogleTasksClient(env) : null;
  for (const [area, outcome] of areas) {
    if (!outcome || !String(outcome).trim()) continue;
    let googleTaskId = null;
    if (googleTasks) {
      const task = await createPlannedOutcomeTask({
        db: env.DB,
        googleTasks,
        requestId: `${body.requestId}-${area}`,
        title: String(outcome).trim().slice(0, 500),
        area,
        priority: area === "LIFE" ? "Medium" : "High",
        dueDate: date,
        risk: body.risk ? String(body.risk).trim().slice(0, 1000) : "",
        now
      });
      googleTaskId = task.id;
    } else {
      await env.DB.prepare(
        "UPDATE mini_app_requests SET status = 'Needs review', error_details = 'Google Tasks unavailable.' WHERE id = ?1"
      ).bind(body.requestId).run();
      return jsonResponse({ error: "Google Tasks is unavailable." }, 503);
    }
    await env.DB.prepare(
      `INSERT INTO daily_outcomes (
         id, outcome_date, area, outcome, done_test, google_task_id, status, updated_at
       ) VALUES (?1, ?2, ?3, ?4, '', ?5, 'Planned', ?6)
       ON CONFLICT(id) DO NOTHING`
    ).bind(`OUT-${body.requestId}-${area}`, date, area, String(outcome).trim().slice(0, 500), googleTaskId, now.toISOString()).run();
  }
  if (body.risk) {
    await env.DB.prepare(
      `INSERT INTO review_notes (id, review_type, review_date, question, answer, created_at)
       VALUES (?1, 'Daily planning', ?2, 'What could derail this day?', ?3, ?4)`
    ).bind(`RISK-${body.requestId}`, date, String(body.risk).trim().slice(0, 1000), now.toISOString()).run();
  }
  await env.DB.prepare(
    "UPDATE mini_app_requests SET status = 'Completed' WHERE id = ?1"
  ).bind(body.requestId).run();
  return jsonResponse({ ok: true });
}

async function saveMiniAppTask(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON." }, 400);
  }
  if (!body || typeof body.requestId !== "string" || body.requestId.length > 128 ||
      typeof body.title !== "string" || !body.title.trim()) {
    return jsonResponse({ error: "Request id and title are required." }, 400);
  }
  const marker = await env.DB.prepare(
    "SELECT google_task_id FROM mini_app_requests WHERE id = ?1"
  ).bind(body.requestId).first();
  if (marker) return jsonResponse({ ok: true, duplicate: true });
  if (!hasGoogleTasksConfig(env)) {
    return jsonResponse({ error: "Google Tasks is unavailable." }, 503);
  }
  const allowedAreas = new Set(["DEEP", "WORK", "LIFE", "Admin", "Other"]);
  const allowedPriorities = new Set(["High", "Medium", "Low"]);
  const area = allowedAreas.has(body.area) ? body.area : "WORK";
  const priority = allowedPriorities.has(body.priority) ? body.priority : "Medium";
  const today = cairoDateKey(new Date());
  const finalDue = body.due === "today"
    ? today
    : body.due === "tomorrow"
      ? shiftDateKey(today, 1)
      : "";
  await env.DB.prepare(
    `INSERT INTO mini_app_requests (id, created_at, status)
     VALUES (?1, ?2, 'Processing')`
  ).bind(body.requestId, new Date().toISOString()).run();
  const googleTasks = createGoogleTasksClient(env);
  const user = await getOrCreateChannelUser(
    env.DB,
    "telegram",
    String(env.AUTHORIZED_TELEGRAM_USER_ID),
    new Date().toISOString()
  );
  const response = await createCapturedTask({
    db: env.DB,
    user,
    state: {
      requestId: body.requestId,
      title: body.title.trim().slice(0, 500),
      area,
      priority,
      dueDate: finalDue,
      doneTest: String(body.doneTest || "").trim()
    },
    addToTop3: false,
    googleTasks,
    now: new Date(),
    clearConversation: false
  });
  await env.DB.prepare(
    "UPDATE mini_app_requests SET status = 'Completed' WHERE id = ?1"
  ).bind(body.requestId).run();
  return jsonResponse({ ok: true, category: response.category });
}

async function saveMiniAppReminder(request, env) {
  if (env.USER_REMINDERS_ENABLED !== "true") {
    return jsonResponse({ error: "Reminder delivery is paused." }, 503);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON." }, 400);
  }
  if (!body ||
      typeof body.requestId !== "string" ||
      !body.requestId.trim() ||
      body.requestId.length > 128) {
    return jsonResponse({ error: "A valid request id is required." }, 400);
  }
  if (typeof body.text !== "string" || !body.text.trim() || body.text.trim().length > 200) {
    return jsonResponse({ error: "Reminder text is required and must be 200 characters or fewer." }, 400);
  }
      const existingReminder = await env.DB.prepare(
        "SELECT id FROM reminders WHERE request_id = ?1"
      ).bind(body.requestId).first();
      if (existingReminder) return jsonResponse({ ok: true, duplicate: true });
  const now = new Date();
  let dueAtUtc = "";
  if (typeof body.dueAtUtc === "string" && body.dueAtUtc) {
    dueAtUtc = body.dueAtUtc;
  } else if (body.inMinutes !== undefined && body.inMinutes !== null && body.inMinutes !== "") {
    const minutes = Number(body.inMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return jsonResponse({ error: "Choose a positive reminder delay." }, 400);
    }
    dueAtUtc = new Date(now.getTime() + minutes * 60_000).toISOString();
  } else if (body.dueDate && body.dueTime) {
    try {
      dueAtUtc = cairoLocalDateTimeToIso(body.dueDate, body.dueTime);
    } catch (error) {
      if (error instanceof TypeError) {
        return jsonResponse({ error: "Choose a valid Cairo-local date and time." }, 400);
      }
      throw error;
    }
  }
  const dueAt = Date.parse(dueAtUtc);
  if (!dueAtUtc || Number.isNaN(dueAt) || dueAt <= now.getTime()) {
    return jsonResponse({ error: "Choose a future reminder time." }, 400);
  }
  const user = await getOrCreateChannelUser(
    env.DB,
    "telegram",
    String(env.AUTHORIZED_TELEGRAM_USER_ID),
    now.toISOString()
  );
  const reminder = await createUserReminder({
    db: env.DB,
    user,
    text: body.text.trim(),
    dueAtUtc,
    now: now.toISOString(),
    requestId: body.requestId
  });
  await env.DB.prepare(
    `INSERT INTO mini_app_requests (id, created_at, status)
     VALUES (?1, ?2, 'Completed')
     ON CONFLICT(id) DO UPDATE SET status = 'Completed', error_details = ''`
  ).bind(body.requestId, now.toISOString()).run();
  return jsonResponse({ ok: true, duplicate: reminder.duplicate });
}

async function saveMiniAppCompletion(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON." }, 400);
  }
  if (!body || typeof body.requestId !== "string" || !body.googleTaskId ||
      typeof body.googleTaskId !== "string") {
    return jsonResponse({ error: "Request id and Google Task id are required." }, 400);
  }
  const existing = await env.DB.prepare(
    "SELECT google_task_id FROM mini_app_requests WHERE id = ?1"
  ).bind(body.requestId).first();
  if (existing) return jsonResponse({ ok: true, duplicate: true });
  if (!hasGoogleTasksConfig(env)) {
    return jsonResponse({ error: "Google Tasks is unavailable." }, 503);
  }
  await env.DB.prepare(
    `INSERT INTO mini_app_requests (id, google_task_id, created_at, status)
     VALUES (?1, ?2, ?3, 'Processing')`
  ).bind(body.requestId, body.googleTaskId, new Date().toISOString()).run();
  const googleTasks = createGoogleTasksClient(env);
  const completed = await googleTasks.complete(body.googleTaskId);
  await upsertGoogleTaskMirror(env.DB, completed, new Date().toISOString());
  await env.DB.prepare(
    "UPDATE mini_app_requests SET status = 'Completed' WHERE id = ?1"
  ).bind(body.requestId).run();
  return jsonResponse({ ok: true });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders
  });
}

function hasGoogleTasksConfig(env) {
  return Boolean(
    env.GOOGLE_OAUTH_CLIENT_ID &&
    env.GOOGLE_OAUTH_CLIENT_SECRET &&
    env.GOOGLE_OAUTH_REFRESH_TOKEN &&
    env.GOOGLE_TASK_LIST_ID
  );
}

async function logFailure(
  db,
  relatedRecordId,
  description,
  error,
  env,
  { severity = "ERROR", eventType = "Processing failure" } = {}
) {
  const rawMessage = error && error.message ? String(error.message) : "";
  const errorMessage = redactSecrets(rawMessage, env).slice(0, 500);
  const event = {
    occurredAt: new Date().toISOString(),
    severity,
    component: "Telegram webhook",
    eventType,
    description,
    relatedRecordId,
    errorMessage: errorMessage || (error && error.name ? String(error.name) : "Error")
  };
  try {
    await logSystemEvent(db, event);
  } catch (loggingError) {
    console.error(JSON.stringify({
      event: "system_log_write_failed",
      relatedRecordId,
      errorType: loggingError && loggingError.name || "Error"
    }));
  }
}

function redactSecrets(message, env) {
  let result = String(message || "");
  for (const key of [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REFRESH_TOKEN"
  ]) {
    const secret = env && env[key];
    if (secret) result = result.split(String(secret)).join("[REDACTED]");
  }
  return result
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]");
}
