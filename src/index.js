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
import { createGoogleCalendarClient } from "./integrations/google-calendar.js";
import { createGoogleTasksClient } from "./integrations/google-tasks.js";
import { handleScheduledEvent } from "./scheduled.js";

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
      const result = await handleAssistantMessage({
        db: env.DB,
        user,
        message,
        googleTasks,
        googleCalendar,
        now
      });

      let deliveredMessage = null;
      if (result) {
        deliveredMessage = await telegram.sendAssistantResponse(
          message.conversation.externalId,
          result
        );
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
          "<b>I couldn't confirm that action.</b>\n\nCheck Google Tasks and this chat before repeating it. Your existing production bot has not been changed."
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

async function logFailure(db, relatedRecordId, description, error, env) {
  const rawMessage = error && error.message ? String(error.message) : "";
  const errorMessage = redactSecrets(rawMessage, env).slice(0, 500);
  const event = {
    occurredAt: new Date().toISOString(),
    severity: "ERROR",
    component: "Telegram webhook",
    eventType: "Processing failure",
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
