export function createTelegramApi(token, fetchImpl = fetch) {
  if (!token) throw new Error("Telegram Bot API token is not configured.");
  const baseUrl = `https://api.telegram.org/bot${token}`;

  return {
    async call(method, payload) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetchImpl(`${baseUrl}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (response.status === 429 && attempt === 0 && result.parameters &&
            Number.isInteger(result.parameters.retry_after) &&
            result.parameters.retry_after >= 0 && result.parameters.retry_after <= 3) {
          await delay(result.parameters.retry_after * 1000);
          continue;
        }
        if (!response.ok) {
          throw new Error(`Telegram API ${method} failed with HTTP ${response.status}.`);
        }
        if (!result.ok) throw new Error(`Telegram API ${method} returned an unsuccessful result.`);
        return result.result;
      }
      throw new Error(`Telegram API ${method} retry limit was reached.`);
    },

    sendMessage(chatId, text, replyMarkup) {
      return this.call("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      });
    },

    editMessageText(chatId, messageId, text, replyMarkup) {
      return this.call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      });
    },

    pinChatMessage(chatId, messageId) {
      return this.call("pinChatMessage", {
        chat_id: chatId,
        message_id: messageId,
        disable_notification: true
      });
    },

    unpinChatMessage(chatId, messageId) {
      return this.call("unpinChatMessage", {
        chat_id: chatId,
        ...(messageId ? { message_id: messageId } : {})
      });
    },

    setMyCommands(commands) {
      return this.call("setMyCommands", { commands });
    },

    sendAssistantResponse(chatId, response) {
      const sections = (response.sections || []).map(section => {
        const heading = section.heading
          ? `<b>${escapeTelegramHtml(section.heading)}</b>\n`
          : "";
        const lines = (section.lines || []).map(escapeTelegramHtml).join("\n");
        return `${heading}${lines}`;
      }).filter(Boolean);
      const text = [
        response.title ? `<b>${escapeTelegramHtml(response.title)}</b>` : "",
        ...sections
      ].filter(Boolean).join("\n\n");
      const replyMarkup = response.replyKeyboard
        ? {
            keyboard: [response.replyKeyboard.map(text => ({ text }))],
            resize_keyboard: true,
            is_persistent: true
          }
        : response.actions && response.actions.length
        ? {
            inline_keyboard: response.actions.map(row => row.map(action => ({
              text: action.label,
              callback_data: action.action
            })))
          }
        : response.inputMode === "force_reply"
          ? {
              force_reply: true,
              selective: true,
              input_field_placeholder: response.inputPlaceholder || "Type one short answer"
            }
          : null;
      return this.sendMessage(chatId, text || " ", replyMarkup);
    },

    editAssistantResponse(chatId, messageId, response) {
      const sections = (response.sections || []).map(section => {
        const heading = section.heading
          ? `<b>${escapeTelegramHtml(section.heading)}</b>\n`
          : "";
        const lines = (section.lines || []).map(escapeTelegramHtml).join("\n");
        return `${heading}${lines}`;
      }).filter(Boolean);
      const text = [
        response.title ? `<b>${escapeTelegramHtml(response.title)}</b>` : "",
        ...sections
      ].filter(Boolean).join("\n\n");
      const replyMarkup = response.actions && response.actions.length
        ? {
            inline_keyboard: response.actions.map(row => row.map(action => ({
              text: action.label,
              callback_data: action.action
            })))
          }
        : response.inputMode === "force_reply"
          ? {
              force_reply: true,
              selective: true,
              input_field_placeholder: response.inputPlaceholder || "Type one short answer"
            }
          : null;
      return this.editMessageText(chatId, messageId, text || " ", replyMarkup);
    },

    answerCallbackQuery(callbackQueryId, text) {
      return this.call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {})
      });
    }
  };
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function escapeTelegramHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
