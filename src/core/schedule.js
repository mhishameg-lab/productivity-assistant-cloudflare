export const SCHEDULE = Object.freeze({
  morningFallback: "8:00 AM",
  workPrompt: "2:15 PM",
  midShift: "7:00 PM",
  nightWrap: "11:15 PM",
  calendarHeadsUpMinutes: 15,
  weeklyReport: "Friday 6:00 PM",
  monthlyReport: "First of month 6:00 PM",
  systemOk: "Sunday 10:00 AM",
  checkInOutsideShift: "30 minutes",
  checkInShift: "60 minutes",
  shiftWindow: "3:00 PM–11:00 PM"
});

export const TELEGRAM_COMMANDS = Object.freeze([
  { command: "hq", description: "📱 Your HQ: now, next, today" },
  { command: "go", description: "▶️ Start the next move" },
  { command: "drop", description: "📝 Drop a task or reminder" },
  { command: "plan", description: "🗓 Plan your day" },
  { command: "wya", description: "🧭 Where I'm at" },
  { command: "stack", description: "📋 Your task stack" },
  { command: "late", description: "🔴 Overdue tasks" },
  { command: "mail", description: "📥 Unread mail" },
  { command: "remind", description: "⏰ Set a reminder" },
  { command: "brainstorm", description: "🧠 Brainstorm vault" },
  { command: "zzz", description: "😴 Sleep mode & wake-up" },
  { command: "dive", description: "🎧 Focus dive mode" }
]);

export function scheduledJobForCairoTime(time) {
  return ({
    "07:00": "brainstorm_am",
    "08:00": "morning",
    "14:15": "work_briefing",
    "22:00": "brainstorm_pm",
    "23:15": "night_wrap"
  })[time] || null;
}
