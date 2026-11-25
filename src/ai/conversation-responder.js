import { recordAiFailure, reserveAiUsage } from "./usage-ledger.js";
import { BANNED_PHRASES, PERSONA_SYSTEM_PROMPT } from "../core/prompts.js";
import { cairoDateKey, cairoTimeParts, shortDate, timeLabel } from "../core/format.js";
import { getDisplayName } from "../core/voice.js";
import { listPendingTaskPlanningCandidates } from "../db/google-tasks-repository.js";

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_PROMPT_BYTES = 4096;
const MAX_COMPLETION_TOKENS = 120;
const MAX_REPLY_CHARS = 400;
const MAX_REPLY_WORDS = 65;

const EXTRA_BANNED_SUBSTRINGS = Object.freeze([
  "facts:",
  "json",
  "database",
  "sql",
  "tool call",
  "language model",
  "i am an ai",
  "i'm an ai"
]);

/**
 * Assemble grounded, read-only facts about Martino's day from D1 and Calendar.
 * Never throws on optional sources; marks unavailable integrations explicitly.
 */
export async function buildConversationFacts({ db, user, googleCalendar = null, now = new Date() }) {
  const parts = cairoTimeParts(now);
  const date = parts.date;
  const [name, pending, outcomesRows, remindersRows, turnsRows] = await Promise.all([
    getDisplayName(db),
    listPendingTaskPlanningCandidates(db, date, 15).catch(() => []),
    db.prepare(
      "SELECT area, outcome, status FROM daily_outcomes WHERE outcome_date = ?1 ORDER BY rowid ASC LIMIT 5"
    ).bind(date).all().then(r => r.results || []).catch(() => []),
    db.prepare(
      "SELECT text, remind_at_utc FROM reminders WHERE user_id = ?1 AND status IN ('pending', 'sent') ORDER BY remind_at_utc ASC LIMIT 5"
    ).bind(user.id).all().then(r => r.results || []).catch(() => []),
    db.prepare(
      "SELECT role, text FROM chat_turns WHERE user_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 6"
    ).bind(user.id).all().then(r => (r.results || []).reverse()).catch(() => [])
  ]);

  let calendarStatus = googleCalendar ? "ok" : "disabled";
  let calendarEvents = [];
  if (googleCalendar) {
    try {
      const events = await googleCalendar.listEventsForDate(date);
      calendarEvents = (events || []).slice(0, 8).map(ev => ({
        title: String(ev.title || "Busy").slice(0, 80),
        allDay: Boolean(ev.allDay),
        startTime: ev.startTime || null,
        endTime: ev.endTime || null,
        startLabel: ev.allDay ? "All day" : safeTimeLabel(ev.startTime),
        endLabel: ev.allDay ? null : safeTimeLabel(ev.endTime)
      }));
    } catch {
      calendarStatus = "unavailable";
    }
  }

  const overdueTasks = pending.filter(t => t.due_date && t.due_date < date);
  const dueTodayTasks = pending.filter(t => t.due_date === date);

  return {
    name,
    today: {
      date,
      dateLabel: shortDate(date),
      weekday: parts.weekday,
      timeLabel: timeLabel(now),
      timeZone: "Africa/Cairo"
    },
    overdueCount: overdueTasks.length,
    dueTodayCount: dueTodayTasks.length,
    openTaskCount: pending.length,
    pendingTasks: pending.slice(0, 8).map(t => ({
      title: String(t.title || "").slice(0, 100),
      dueDate: t.due_date || null,
      dueLabel: t.due_date ? shortDate(t.due_date) : null,
      overdue: Boolean(t.due_date && t.due_date < date),
      priority: t.priority || "Medium",
      area: t.area || "Other"
    })),
    todayOutcomes: outcomesRows.map(o => ({
      area: o.area,
      outcome: String(o.outcome || "").slice(0, 100),
      status: o.status
    })),
    pendingReminders: remindersRows.map(r => ({
      text: String(r.text || "").slice(0, 80),
      remindAtUtc: r.remind_at_utc,
      timeLabel: safeTimeLabel(r.remind_at_utc)
    })),
    calendarStatus,
    calendarEvents,
    recentTurns: turnsRows
  };
}

/**
 * Call Workers AI once with PERSONA_SYSTEM_PROMPT and grounded FACTS.
 * Returns a validated plain-text reply or null so caller can fall back deterministically.
 */
export async function generateConversationalReply({
  db,
  ai,
  text,
  facts,
  recentTurns = [],
  now = new Date(),
  model = DEFAULT_MODEL,
  dailyNeuronLimit = 5000
}) {
  if (!ai || typeof ai.run !== "function") return null;
  const normalizedText = String(text || "").trim();
  if (!normalizedText || new TextEncoder().encode(normalizedText).byteLength > 1024) {
    return null;
  }
  if (!db || !now || Number.isNaN(Date.parse(now))) {
    throw new TypeError("Conversational AI responder requires D1 and a valid timestamp.");
  }

  const compactFacts = {
    name: facts.name,
    now: `${facts.today.weekday}, ${facts.today.dateLabel}, ${facts.today.timeLabel} (${facts.today.timeZone})`,
    overdueCount: facts.overdueCount,
    dueTodayCount: facts.dueTodayCount,
    openTaskCount: facts.openTaskCount,
    topTasks: (facts.pendingTasks || []).slice(0, 6).map(t => ({
      title: t.title,
      due: t.dueLabel,
      overdue: t.overdue,
      priority: t.priority
    })),
    todayOutcomes: (facts.todayOutcomes || []).slice(0, 3),
    reminders: (facts.pendingReminders || []).slice(0, 3).map(r => ({
      text: r.text,
      at: r.timeLabel
    })),
    calendarStatus: facts.calendarStatus,
    calendarEvents: (facts.calendarEvents || []).slice(0, 6).map(e => ({
      title: e.title,
      time: e.allDay ? "All day" : (e.startLabel && e.endLabel ? `${e.startLabel} - ${e.endLabel}` : e.startLabel)
    }))
  };

  const turns = Array.isArray(recentTurns) ? recentTurns.slice(-3) : [];
  const turnsBlock = turns.length
    ? `\nRecent chat:\n${turns.map(t => `${t.role}: ${String(t.text || "").slice(0, 180)}`).join("\n")}`
    : "";

  const prompt = [
    PERSONA_SYSTEM_PROMPT,
    `FACTS: ${JSON.stringify(compactFacts)}`,
    turnsBlock,
    `${facts.name || "Martino"}: ${normalizedText}`,
    "Reply:"
  ].filter(Boolean).join("\n");

  const promptBytes = new TextEncoder().encode(prompt).byteLength;
  if (promptBytes > MAX_PROMPT_BYTES) return null;

  const reservation = await reserveAiUsage({
    db,
    model,
    inputBytes: promptBytes,
    completionTokens: MAX_COMPLETION_TOKENS,
    dailyNeuronLimit,
    now
  });
  if (!reservation) return null;

  try {
    const result = await ai.run(model, {
      prompt,
      max_tokens: MAX_COMPLETION_TOKENS,
      temperature: 0.6
    });
    return validateConversationReply(result);
  } catch {
    await recordAiFailure(db, reservation.usageDate, now);
    return null;
  }
}

/**
 * Validate and sanitize Workers AI conversational output against length, banned phrases, and emoji limits.
 */
export function validateConversationReply(result) {
  let raw = result && result.response !== undefined ? result.response : result;
  if (typeof raw !== "string") return null;

  let text = raw
    .trim()
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^["“]|["”]$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || text.length > MAX_REPLY_CHARS) return null;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > MAX_REPLY_WORDS) return null;

  const lower = text.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase.toLowerCase())) return null;
  }
  for (const extra of EXTRA_BANNED_SUBSTRINGS) {
    if (lower.includes(extra)) return null;
  }

  // Enforce at most 1 non-status emoji.
  let seenEmoji = false;
  text = text.replace(/\p{Extended_Pictographic}/gu, ch => {
    if (/[🔴🟡🟢⚪☑☐]/u.test(ch)) return ch;
    if (!seenEmoji) {
      seenEmoji = true;
      return ch;
    }
    return "";
  }).replace(/\s+/g, " ").trim();

  return text || null;
}

function safeTimeLabel(iso) {
  if (!iso) return null;
  try {
    return timeLabel(iso);
  } catch {
    return null;
  }
}
