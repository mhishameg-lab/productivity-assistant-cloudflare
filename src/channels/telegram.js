const TELEGRAM_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

export function isAuthorizedTelegramWebhook(request, secret) {
  return Boolean(secret) && request.headers.get(TELEGRAM_SECRET_HEADER) === secret;
}

export function adaptTelegramUpdate(update, receivedAt = new Date().toISOString()) {
  if (!update || !Number.isSafeInteger(Number(update.update_id))) {
    throw new TypeError("Telegram update_id is missing or invalid.");
  }

  const message = update.message;
  const callback = update.callback_query;
  const source = message || (callback && callback.message);
  const user = (message && message.from) || (callback && callback.from);
  if (!source || !source.chat || !user || user.id == null) {
    throw new TypeError("Telegram update does not contain a supported message or callback.");
  }

  const text = message && typeof message.text === "string" ? message.text : "";
  const commandMatch = text.match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);

  return {
    id: `${update.update_id}`,
    channel: "telegram",
    user: {
      externalId: `${user.id}`
    },
    conversation: {
      externalId: `${source.chat.id}`
    },
    receivedAt,
    message: {
      externalId: `${(message || source).message_id || ""}`,
      type: callback ? "callback" : message && message.text ? "text" : "unsupported",
      text: text,
      command: commandMatch
        ? {
            name: commandMatch[1].toLowerCase(),
            arguments: (commandMatch[2] || "").trim()
          }
        : null
    },
    action: callback
      ? {
          externalId: `${callback.id}`,
          identifier: typeof callback.data === "string" ? callback.data : ""
        }
      : null
  };
}
