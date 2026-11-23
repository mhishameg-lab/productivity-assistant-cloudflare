const SUPPORTED_COMMANDS = new Set([
  "start",
  "today",
  "tomorrow",
  "addtask",
  "focus",
  "tasks",
  "overdue",
  "progress",
  "review",
  "capture",
  "weekly",
  "monthly",
  "habits",
  "accountability",
  "settings",
  "help"
]);

export function resolveIntent(message) {
  if (!message || typeof message !== "object") {
    throw new TypeError("An adapted channel message is required.");
  }

  if (message.action) {
    return {
      type: "user_action",
      identifier: message.action.identifier,
      externalActionId: message.action.externalId
    };
  }

  if (message.message && message.message.command) {
    const { name, arguments: args = "" } = message.message.command;
    if (!SUPPORTED_COMMANDS.has(name)) {
      return { type: "unknown_command", name };
    }
    return {
      type: "command",
      name,
      arguments: args
    };
  }

  if (message.message && message.message.type === "text") {
    return {
      type: "user_message",
      text: message.message.text
    };
  }

  return { type: "unsupported_input" };
}
