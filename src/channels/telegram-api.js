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
          const error = new Error(`Telegram API ${method} failed with HTTP ${response.status}.`);
          if (method === "editMessageText" &&
              response.status === 400 &&
              /message is not modified/i.test(String(result.description || ""))) {
            error.code = "MESSAGE_NOT_MODIFIED";
          }
          throw error;
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
    setChatMenuButton(payload) {
      return this.call("setChatMenuButton", payload);
    },

    sendAssistantResponse(chatId, response) {
      const sections = (response.sections || []).map(section => {
        const heading = section.heading
          ? `${escapeTelegramHtml(section.heading)}\n`
          : "";
        const lines = (section.lines || []).map(escapeTelegramHtml).join("\n");
        return `${heading}${lines}`;
      }).filter(Boolean);
      const text = [
        response.title ? escapeTelegramHtml(response.title) : "",
        ...sections
      ].filter(Boolean).join("\n\n");
      const replyMarkup = response.replyKeyboardRows
        ? {
            keyboard: response.replyKeyboardRows.map(row => row.map(text => ({ text }))),
            resize_keyboard: true,
            is_persistent: true
          }
        : response.replyKeyboard
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
          ? `${escapeTelegramHtml(section.heading)}\n`
          : "";
        const lines = (section.lines || []).map(escapeTelegramHtml).join("\n");
        return `${heading}${lines}`;
      }).filter(Boolean);
      const text = [
        response.title ? escapeTelegramHtml(response.title) : "",
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
      return this.editMessageText(chatId, messageId, text || " ", replyMarkup)
        .catch(error => {
          if (error && error.code === "MESSAGE_NOT_MODIFIED") {
            return { message_id: messageId, notModified: true };
          }
          throw error;
        });
    },

    answerCallbackQuery(callbackQueryId, text) {
      return this.call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        ...(text ? { text } : {})
      });
    },

    sendChatAction(chatId, action = "typing") {
      return this.call("sendChatAction", {
        chat_id: chatId,
        action
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
