import { cairoDateKey, cairoTimeParts } from "./format.js";

export const VOICE_VARIANTS = {
  greeting_morning: [
    "Good morning, {name}. Ready when you are.",
    "Good morning, {name}. Fresh day, clear plan.",
    "Morning, {name}. Let's make today simple."
  ],
  greeting_weekend_morning: ["Happy {weekday}, {name}. Take it easy, but let's use the morning well."],
  plan_unset: ["Your three outcomes for today aren't set yet. It takes about a minute."],
  outcome_suggestion: ["💡 Suggested: {task}"],
  nothing_overdue: ["Nothing overdue. 🎉"],
  tasks_clear: ["Your task list is clear. Want to add something, or take the win?"],
  preshift_1: ["Almost shift time, {name}. What's your SDR target for tonight?"],
  preshift_2: ["Nice. What's your plan for hitting it?"],
  preshift_3: ["One thing you want to learn tonight?"],
  pulse_started: [
    "Hey {name}, how's it going with “{task}”?",
    "Checking in on “{task}”. Still on it?"
  ],
  pulse_not_started: [
    "Hey {name}, “{task}” hasn't moved yet today. No pressure. What got in the way?",
    "{name}, “{task}” is still waiting. What's making it hard to start?"
  ],
  reason_too_big: ["Totally normal. Want to just do the first 25 minutes?"],
  reason_low_energy: ["Okay. Take 5 minutes: water, stretch. Then 25 minutes on “{task}”, or move it to tomorrow."],
  reason_pulled_away: ["Fair, that happens in SDR work. Is “{task}” still today's priority?"],
  reason_forgot: ["No problem. Start it now?"],
  reason_not_important: ["Good to know. Keep it, reschedule it, or drop today's outcome. I won't cancel the task for you."],
  done_one: ["Nice work, {name}. “{task}” is done."],
  done_all_three: ["All three outcomes done today. Really well done, {name}. Rest is part of the plan too."],
  shutdown: ["Shift's done, {name}. Good work tonight. Let's close the loops: capture anything open in Google Tasks, or tell me there's nothing."],
  plan_tomorrow_prompt: ["Ready to plan tomorrow? It takes about a minute."],
  plan_saved: ["Tomorrow's set, {name}. Go rest. You'll start with a clear plan."],
  care_break: ["Quick human check, {name}: have you had water and something to eat? Two minutes away from the screen helps."],
  google_down: ["Google Tasks didn't respond, so I won't show you old info. Try again in a minute."]
};

export function say(situation, context = {}) {
  const variants = VOICE_VARIANTS[situation] || [];
  if (!variants.length) return "";
  const date = cairoDateKey(context.now || new Date());
  const index = stableHash(`${date}:${situation}`) % variants.length;
  return fillTemplate(variants[index], context);
}

export async function getDisplayName(db) {
  if (!db) return "Mohamed";
  const row = await db.prepare(
    "SELECT setting_value FROM settings WHERE setting_key = 'display_name'"
  ).bind().first();
  return row && row.setting_value ? String(row.setting_value) : "Mohamed";
}

export function greetingLine(dbName, now = new Date()) {
  const name = dbName || "Mohamed";
  const hour = Number(cairoTimeParts(now).hour);
  if (hour < 12) return `Good morning, ${name}.`;
  if (hour < 18) return `Good afternoon, ${name}.`;
  if (hour < 23) return `Good evening, ${name}.`;
  return `Hey ${name}.`;
}

function fillTemplate(template, context) {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    context[key] == null ? match : String(context[key])
  );
}

function stableHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
