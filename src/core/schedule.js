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

export function scheduledJobForCairoTime(time) {
  return ({
    "08:00": "morning",
    "14:15": "work_briefing",
    "23:15": "night_wrap"
  })[time] || null;
}
