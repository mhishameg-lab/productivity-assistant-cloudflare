const SUPPORTED_COMMANDS = new Set([
  "start",
  "today",
  "tomorrow",
  "addtask",
  "available",
  "focus",
  "tasks",
  "inbox",
  "goals",
  "goal",
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
  ,"quiet",
  "pulses",
  "vibe",
  "tone"
]);

const DETERMINISTIC_TEXT_ROUTES = [
  { intent: "today", patterns: [/^(?:what should i focus on today|what should i do today|what should i do next|plan my day|show (?:me )?(?:today'?s|my daily) plan)$/] },
  { intent: "tomorrow", patterns: [/^(?:prepare me for tomorrow|plan tomorrow|show (?:me )?tomorrow'?s plan)$/] },
  { intent: "tasks", patterns: [/^(?:show|list|review) (?:me )?(?:my )?(?:open |unfinished |pending )?tasks$/, /^what (?:are )?my unfinished tasks$/] },
  { intent: "overdue", patterns: [/^(?:show|review|list) (?:my )?overdue tasks$/] },
  { intent: "inbox", patterns: [/^(?:show|review) (?:my )?(?:important )?(?:unread )?emails?$/, /^what important emails have i missed$/] },
  { intent: "accountability", patterns: [/^(?:trello|obsidian)(?: check in| check-in)?$/, /^(?:i updated|i reviewed) (?:trello|obsidian)$/] },
  { intent: "goals", patterns: [/^(?:review|show) (?:my )?goals$/, /^what am i neglecting$/] },
  { intent: "weekly", patterns: [/^(?:plan|review) my week$/] },
  { intent: "addtask", patterns: [/^(?:remember this commitment|add a task|capture a task)$/] },
  { intent: "help", patterns: [/^(?:help|what can you do)$/] }
];

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

export function resolveDeterministicTextIntent(text) {
  const normalized = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
  if (!normalized) return null;
  for (const route of DETERMINISTIC_TEXT_ROUTES) {
    if (route.patterns.some(pattern => pattern.test(normalized))) return route.intent;
  }
  return null;
}

export function resolveAvailableTimeRequest(text) {
  const normalized = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[’]/g, "'");
  const match = normalized.match(
    /^(?:i have|i've got|i am|i'm)\s+(\d+(?:\.\d+)?|one|two|three|four|five|six|a couple)\s+(minutes?|mins?|hours?|hrs?)\s+(?:free|available)\b/
  );
  if (!match) return null;

  const amount = match[1] === "a couple"
    ? 2
    : Number.isFinite(Number(match[1]))
      ? Number(match[1])
      : ({
          one: 1,
          two: 2,
          three: 3,
          four: 4,
          five: 5,
          six: 6
        })[match[1]];
  const unit = match[2];
  const minutes = Math.round(amount * (/^(?:hours?|hrs?)$/.test(unit) ? 60 : 1));
  return { minutes };
}
