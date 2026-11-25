import {
  cairoDateKey,
  cairoTimeParts,
  parseDateInput,
  parseTimeInput,
  shiftDateKey
} from "./format.js";
import { cairoLocalDateTimeToIso } from "../integrations/google-calendar.js";
import { parseDiveDuration } from "../companion.js";

export const DEFAULT_AREA_KEYWORD_MAP = Object.freeze({
  WORK: ["sdr", "gtmx", "upflex", "outreach", "call"],
  DEEP: ["python", "hvac", "revit", "study", "learn", "course"],
  LIFE: ["gym", "health", "bills", "bill", "pay", "passport"]
});

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_REGEX = "\\b(?:next\\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\\b";
const CHAT_PATTERNS = [
  /^(?:hi|hey|yo|sup|hello|hiya|heya|morning|good morning|good afternoon|good evening|thanks|thank you|thx|ty|ok|okay|bet|cool|nice|lol|haha)\b[!.]*$/i,
  /^(?:i'?m|im|feeling|i feel)\s+(?:tired|exhausted|drained|stressed|overwhelmed|stuck|burnt out|burned out|sleepy|done for today)\b/i
];
const QUESTION_PATTERNS = [
  /\?\s*$/,
  /^(?:what|what's|whats|when|where|who|which|how|am i|do i|did i|are there|is there|can i|should i|have i|will i)\b/i
];

export async function loadAreaKeywordMap(db) {
  if (!db) return DEFAULT_AREA_KEYWORD_MAP;
  try {
    const row = await db.prepare(
      "SELECT setting_value FROM settings WHERE setting_key = 'area_keyword_map'"
    ).first();
    if (!row || !row.setting_value) return DEFAULT_AREA_KEYWORD_MAP;
    const parsed = JSON.parse(row.setting_value);
    if (!parsed || typeof parsed !== "object") return DEFAULT_AREA_KEYWORD_MAP;
    const cleaned = {};
    for (const area of ["WORK", "DEEP", "LIFE", "Admin", "Other"]) {
      if (Array.isArray(parsed[area])) {
        cleaned[area] = parsed[area].map(v => String(v).trim().toLowerCase()).filter(Boolean);
      }
    }
    return Object.keys(cleaned).length ? cleaned : DEFAULT_AREA_KEYWORD_MAP;
  } catch {
    return DEFAULT_AREA_KEYWORD_MAP;
  }
}

export function guessArea(text, keywordMap = DEFAULT_AREA_KEYWORD_MAP) {
  const lower = String(text || "").toLowerCase();
  for (const area of ["WORK", "DEEP", "LIFE", "Admin"]) {
    const keywords = keywordMap[area] || [];
    for (const kw of keywords) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\b`, "i").test(lower)) {
        return area;
      }
    }
  }
  return "Other";
}

export function guessPriority(text) {
  if (/\b(?:urgent|asap|important|critical|high\s+priority|p1)\b/i.test(String(text || ""))) {
    return "High";
  }
  if (/\b(?:low\s+priority|whenever|someday|p3)\b/i.test(String(text || ""))) {
    return "Low";
  }
  return "Medium";
}

export function normalizeArea(area) {
  const raw = String(area || "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper === "DEEP" || upper === "GROWTH") return "DEEP";
  if (upper === "WORK") return "WORK";
  if (upper === "LIFE") return "LIFE";
  if (raw.toLowerCase() === "admin" || raw.toLowerCase() === "errands") return "Admin";
  if (raw.toLowerCase() === "other") return "Other";
  return null;
}

export function cleanTaskHint(hint) {
  return String(hint || "")
    .replace(/\b(?:the|my|a|an|task|todo|one|please)\b/gi, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchPendingTasks(tasks, targetHint) {
  const cleaned = cleanTaskHint(targetHint).toLowerCase();
  if (!cleaned) return [];
  const tokens = cleaned.split(" ").filter(Boolean);
  const scored = [];
  for (const task of tasks) {
    if (!task || task.status !== "Pending") continue;
    const titleLower = String(task.title || "").toLowerCase();
    if (!titleLower) continue;
    if (titleLower === cleaned) {
      scored.push({ task, score: 100 });
      continue;
    }
    if (titleLower.includes(cleaned)) {
      scored.push({ task, score: 80 + cleaned.length / Math.max(1, titleLower.length) });
      continue;
    }
    const matchedTokens = tokens.filter(token => titleLower.includes(token));
    if (matchedTokens.length === tokens.length && tokens.length > 0) {
      scored.push({ task, score: 60 + matchedTokens.length });
    } else if (tokens.length > 1 && matchedTokens.length >= Math.ceil(tokens.length / 2)) {
      scored.push({ task, score: 30 + matchedTokens.length });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map(item => item.task);
}

export function parseFastPathCapture(rawText, now = new Date(), keywordMap = DEFAULT_AREA_KEYWORD_MAP) {
  const text = String(rawText || "").trim();
  if (!text) return null;

  // 1. Multi-line list (2..5 non-empty lines)
  const lines = text.split(/\r?\n/).map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean);
  if (lines.length >= 2 && lines.length <= 5 && !/\?$/.test(text)) {
    const items = [];
    let allResolved = true;
    for (const line of lines) {
      if (line.length > 120 || /\?$/.test(line)) {
        allResolved = false;
        break;
      }
      const sub = parseSingleFastPath(line, now, keywordMap, { allowBareTask: true });
      if (!sub || sub.intent === "question" || sub.intent === "chat" || sub.intent === "unknown") {
        allResolved = false;
        break;
      }
      items.push(sub);
    }
    if (allResolved && items.length >= 2) {
      return { source: "fast_path", items };
    }
  }

  const single = parseSingleFastPath(text, now, keywordMap, { allowBareTask: false });
  if (!single) return null;
  return { source: "fast_path", items: [single] };
}

function parseSingleFastPath(text, now, keywordMap, { allowBareTask = false } = {}) {
  const trimmed = text.trim();

  // Sleep triggers (EN + AR)
  if (/^(?:going to sleep|good\s*night|sleep(?:\s+mode)?|نايم)\b/i.test(trimmed)) {
    const timeMatch = trimmed.match(/\b(?:wake(?:\s+me)?\s+(?:at|up\s+at)|at|till|until)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i) ||
      trimmed.match(/\b(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm))\b/i);
    const wakeTime = timeMatch ? parseFlexibleTime(timeMatch[1], now, { preferSleep: true }) : null;
    return makeItem({
      intent: "sleep",
      title: "Sleep mode",
      time: wakeTime,
      confidence: 0.98
    });
  }

  // Dive triggers (EN + AR)
  if (/^(?:leave me(?:\s+alone)?|heads down|سيبني)/iu.test(trimmed)) {
    const minutes = parseDiveDuration(trimmed);
    return makeItem({
      intent: "dive",
      title: "Dive mode",
      duration_min: minutes,
      confidence: 0.98
    });
  }

  // Done triggers
  const doneMatch = trimmed.match(/^(?:done\s+with|finished(?:\s+with)?|completed|mark\s+done|i\s+finished)\s+(.+)$/i) ||
    trimmed.match(/^mark\s+(.+?)\s+(?:as\s+)?(?:done|complete|completed)$/i);
  if (doneMatch) {
    const hint = cleanTaskHint(doneMatch[1]);
    if (hint) {
      return makeItem({
        intent: "done",
        target_hint: hint,
        title: hint,
        confidence: 0.95
      });
    }
  }

  // Reschedule triggers
  const reschedMatch = trimmed.match(/^(?:move|reschedule|push|postpone)\s+(.+?)\s+(?:to|for|until)\s+(.+)$/i);
  if (reschedMatch) {
    const dateInfo = extractDateAndTime(reschedMatch[2], now);
    if (dateInfo.dueDate) {
      return makeItem({
        intent: "reschedule",
        target_hint: cleanTaskHint(reschedMatch[1]) || reschedMatch[1].trim(),
        due_date: dateInfo.dueDate,
        time: dateInfo.time,
        confidence: 0.93
      });
    }
  }

  // Reminder triggers
  if (/^remind(?:\s+me)?\b/i.test(trimmed)) {
    return parseReminderFastPath(trimmed, now, keywordMap);
  }

  // Explicit Schedule triggers ("schedule ...", "block ...", "put ... on my calendar")
  if (/^(?:schedule|block)\b/i.test(trimmed) || /\bon\s+(?:my\s+)?calendar\b/i.test(trimmed)) {
    const parsed = parseScheduleFastPath(trimmed, now, keywordMap);
    if (parsed) return parsed;
  }

  // Schedule inferred from duration + time ("study python revision tomorrow 3pm 50 min")
  const hasDuration = /\b(?:25|50)\s*(?:min|mins|minutes?)\b/i.test(trimmed);
  const extracted = extractDateAndTime(trimmed, now);
  if (hasDuration && extracted.time) {
    const parsed = parseScheduleFastPath(trimmed, now, keywordMap);
    if (parsed) return parsed;
  }

  // Question vs Chat (before bare task)
  if (QUESTION_PATTERNS.some(p => p.test(trimmed))) {
    return makeItem({
      intent: "question",
      title: trimmed.slice(0, 120),
      confidence: 0.92
    });
  }
  if (CHAT_PATTERNS.some(p => p.test(trimmed))) {
    return makeItem({
      intent: "chat",
      title: trimmed.slice(0, 120),
      confidence: 0.92
    });
  }

  // Explicit task prefix ("add ...", "task ...", "todo ...", "i need to ...", "need to ...")
  const explicitTask = trimmed.match(/^(?:add(?:\s+a)?(?:\s+task)?|task|todo|to-do|i\s+need\s+to|need\s+to|i\s+have\s+to|have\s+to)\s+(.+)$/i);
  if (explicitTask) {
    return buildTaskItem(explicitTask[1], trimmed, now, keywordMap);
  }

  // Implicit task with clear date or time phrase ("call Ahmed tomorrow", "finish the Upflex brief by Friday, high priority")
  if (extracted.dueDate || extracted.time) {
    // If it also has an explicit time AND a work/study verb without "due"/"by", wait:
    // "call Ahmed tomorrow" -> dueDate, no time -> task!
    // "call Ahmed tomorrow 5pm" -> task or reminder? Task with time? Let's treat due phrase without "schedule"/"block"/"min" as task unless time-only!
    return buildTaskItem(trimmed, trimmed, now, keywordMap);
  }

  if (allowBareTask) {
    return buildTaskItem(trimmed, trimmed, now, keywordMap);
  }

  return null;
}

function parseReminderFastPath(trimmed, now, keywordMap) {
  let rest = trimmed.replace(/^remind(?:\s+me)?\s*/i, "").trim();
  if (!rest) {
    return makeItem({
      intent: "reminder",
      title: null,
      due_date: null,
      time: null,
      confidence: 0.95
    });
  }

  // Relative: "in 30 min to stretch" or "to stretch in 30 min"
  const relFront = rest.match(/^in\s+(\d+(?:\.\d+)?)\s+(minutes?|mins?|min|hours?|hrs?|hr)\s+(?:to\s+)?(.+)$/i);
  if (relFront) {
    const mins = Math.round(Number(relFront[1]) * (/hour|hr/i.test(relFront[2]) ? 60 : 1));
    const due = new Date(now.getTime() + mins * 60_000);
    const parts = cairoTimeParts(due);
    return makeItem({
      intent: "reminder",
      title: capitalizeFirst(relFront[3].trim()),
      due_date: parts.date,
      time: `${parts.hour}:${parts.minute}`,
      exactUtcIso: due.toISOString(),
      confidence: 0.96
    });
  }
  const relBack = rest.match(/^(?:to\s+)?(.+?)\s+in\s+(\d+(?:\.\d+)?)\s+(minutes?|mins?|min|hours?|hrs?|hr)$/i);
  if (relBack) {
    const mins = Math.round(Number(relBack[2]) * (/hour|hr/i.test(relBack[3]) ? 60 : 1));
    const due = new Date(now.getTime() + mins * 60_000);
    const parts = cairoTimeParts(due);
    return makeItem({
      intent: "reminder",
      title: capitalizeFirst(relBack[1].trim()),
      due_date: parts.date,
      time: `${parts.hour}:${parts.minute}`,
      exactUtcIso: due.toISOString(),
      confidence: 0.96
    });
  }

  rest = rest.replace(/^to\s+/i, "").trim();
  const extracted = extractDateAndTime(rest, now);
  const title = cleanTrailingConnectors(extracted.cleanedText);
  return makeItem({
    intent: "reminder",
    title: title ? capitalizeFirst(title) : null,
    due_date: extracted.dueDate || (extracted.time ? nextCairoDateForTime(extracted.time, now) : null),
    time: extracted.time,
    pastTime: extracted.pastTime,
    invalidLocalTime: extracted.invalidLocalTime,
    area: guessArea(title || rest, keywordMap),
    confidence: 0.95
  });
}

function parseScheduleFastPath(trimmed, now, keywordMap) {
  let rest = trimmed
    .replace(/^(?:schedule|block(?:\s+out)?|put)\s+/i, "")
    .replace(/\bon\s+(?:my\s+)?calendar\b/gi, "")
    .trim();
  let duration = 50;
  const durMatch = rest.match(/\b(\d{1,3})\s*(?:minutes?|mins?|min)\b/i);
  if (durMatch) {
    const n = Number(durMatch[1]);
    duration = n <= 35 ? 25 : 50;
    rest = `${rest.slice(0, durMatch.index)} ${rest.slice(durMatch.index + durMatch[0].length)}`.trim();
  }
  const extracted = extractDateAndTime(rest, now);
  const title = cleanTrailingConnectors(extracted.cleanedText.replace(/^(?:for|to)\s+/i, "").replace(/\s+(?:for|to)$/i, ""));
  if (!extracted.time) return null;
  const dateKey = extracted.dueDate || nextCairoDateForTime(extracted.time, now);
  return makeItem({
    intent: "schedule",
    title: title ? capitalizeFirst(title) : "Focus block",
    due_date: dateKey,
    time: extracted.time,
    duration_min: duration,
    area: guessArea(title || trimmed, keywordMap),
    priority: guessPriority(trimmed),
    pastTime: extracted.pastTime,
    invalidLocalTime: extracted.invalidLocalTime,
    confidence: 0.94
  });
}

function buildTaskItem(rawBody, fullText, now, keywordMap) {
  const priority = guessPriority(fullText);
  let body = rawBody
    .replace(/,?\s*\b(?:high|medium|low)\s+priority\b/gi, "")
    .replace(/,?\s*\b(?:urgent|asap)\b/gi, "")
    .trim();
  const extracted = extractDateAndTime(body, now);
  const title = cleanTrailingConnectors(extracted.cleanedText);
  if (!title) return null;
  return makeItem({
    intent: "task",
    title: capitalizeFirst(title),
    due_date: extracted.dueDate,
    time: extracted.time,
    priority,
    area: guessArea(title, keywordMap),
    pastTime: extracted.pastTime,
    confidence: 0.92
  });
}

export function extractDateAndTime(text, now = new Date()) {
  let working = ` ${String(text || "").trim()} `;
  let dueDate = null;
  let time = null;
  let explicitPastDate = false;
  let invalidLocalTime = false;

  // 1. Date phrases
  const datePatterns = [
    { re: /\b(yesterday)\b/i, fn: () => { explicitPastDate = true; return shiftDateKey(cairoDateKey(now), -1); } },
    { re: /\b(today|tonight)\b/i, fn: () => cairoDateKey(now) },
    { re: /\b(tomorrow|tmrw|tmr)\b/i, fn: () => shiftDateKey(cairoDateKey(now), 1) },
    { re: new RegExp(WEEKDAY_REGEX, "i"), fn: m => resolveWeekdayDate(m[0], now) },
    { re: /\b(?:by|on)?\s*(\d{4}-\d{2}-\d{2})\b/i, fn: m => parseDateInput(m[1], now) },
    { re: /\b(?:by|on)?\s*(\d{1,2}\/\d{1,2}(?:\/\d{4})?)\b/i, fn: m => parseDateInput(m[1], now) },
    { re: /\b(?:by|on)?\s*((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?)\b/i, fn: m => parseDateInput(m[1], now) },
    { re: /\bin\s+(\d+)\s+days?\b/i, fn: m => shiftDateKey(cairoDateKey(now), Number(m[1])) }
  ];

  for (const { re, fn } of datePatterns) {
    const match = working.match(re);
    if (match) {
      const resolved = fn(match);
      if (resolved) {
        dueDate = resolved;
        working = working.replace(match[0], " ");
        break;
      }
    }
  }

  // Strip dangling "by " / "on " before date if left behind
  working = working.replace(/\s+(?:by|on)\s+/gi, " ").replace(/\s+/g, " ");

  // 2. Time phrases
  const timeMatch =
    working.match(/\b(?:at\s+)?(\d{1,2}:\d{2}\s*(?:am|pm))\b/i) ||
    working.match(/\b(?:at\s+)?(\d{1,2}\s*(?:am|pm))\b/i) ||
    working.match(/\b(?:at\s+)([01]?\d|2[0-3]):([0-5]\d)\b/i) ||
    working.match(/\bat\s+(\d{1,2})\b/i);

  if (timeMatch) {
    const token = timeMatch[1] && timeMatch[2]
      ? `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}`
      : timeMatch[1];
    time = parseFlexibleTime(token, now, { preferSleep: false });
    if (time) {
      working = working.replace(timeMatch[0], " ");
    }
  }

  let pastTime = false;
  const today = cairoDateKey(now);
  if (dueDate && dueDate < today) {
    pastTime = true;
  } else if (dueDate && time) {
    try {
      const iso = cairoLocalDateTimeToIso(dueDate, time);
      if (Date.parse(iso) <= now.getTime()) pastTime = true;
    } catch {
      invalidLocalTime = true;
    }
  } else if (explicitPastDate) {
    pastTime = true;
  }

  return {
    dueDate,
    time,
    pastTime,
    invalidLocalTime,
    cleanedText: working.replace(/\s+/g, " ").trim()
  };
}

export function parseFlexibleTime(token, now = new Date(), { preferSleep = false } = {}) {
  const cleaned = String(token || "").trim();
  const strict = parseTimeInput(cleaned);
  if (strict) return strict;

  const bare = cleaned.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!bare) return null;
  const hour = Number(bare[1]);
  const minute = bare[2] ? Number(bare[2]) : 0;
  if (hour < 0 || hour > 23 || minute > 59) return null;
  if (hour === 0 || hour > 12) {
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  const mm = String(minute).padStart(2, "0");
  if (preferSleep) {
    if (hour >= 4 && hour <= 11) return `${String(hour).padStart(2, "0")}:${mm}`;
    if (hour === 12) return `12:${mm}`;
    return `${String(hour + 12).padStart(2, "0")}:${mm}`;
  }

  // Normal day context: for 1..7 without am/pm, prefer PM (13:00..19:00); for 8..11 prefer AM if still upcoming today else PM
  const am = `${String(hour === 12 ? 0 : hour).padStart(2, "0")}:${mm}`;
  const pm = `${String(hour === 12 ? 12 : hour + 12).padStart(2, "0")}:${mm}`;
  const today = cairoDateKey(now);
  if (hour >= 1 && hour <= 7) {
    return pm;
  }
  try {
    const amMs = Date.parse(cairoLocalDateTimeToIso(today, am));
    if (amMs > now.getTime()) return am;
    const pmMs = Date.parse(cairoLocalDateTimeToIso(today, pm));
    if (pmMs > now.getTime()) return pm;
  } catch {}
  return hour === 12 ? `12:${mm}` : am;
}

export function resolveWeekdayDate(phrase, now = new Date()) {
  const lower = String(phrase || "").toLowerCase();
  const isNext = /\bnext\b/.test(lower);
  const short = lower.replace(/\bnext\b/, "").trim().slice(0, 3);
  const targetDay = WEEKDAYS.indexOf(short);
  if (targetDay < 0) return null;
  const today = cairoDateKey(now);
  const currentDay = new Date(`${today}T12:00:00.000Z`).getUTCDay();
  let delta = (targetDay - currentDay + 7) % 7;
  if (delta === 0 || (isNext && delta <= 7)) {
    delta = delta === 0 ? 7 : delta;
  }
  return shiftDateKey(today, delta);
}

export function nextCairoDateForTime(time, now = new Date()) {
  const today = cairoDateKey(now);
  try {
    const todayIso = cairoLocalDateTimeToIso(today, time);
    if (Date.parse(todayIso) > now.getTime()) return today;
  } catch {
    return null;
  }
  const tomorrow = shiftDateKey(today, 1);
  try {
    cairoLocalDateTimeToIso(tomorrow, time);
    return tomorrow;
  } catch {
    return null;
  }
}

function cleanTrailingConnectors(text) {
  return String(text || "")
    .replace(/\b(?:by|at|on|for|to)\s*$/i, "")
    .replace(/^(?:by|at|on|for)\s+/i, "")
    .replace(/[,.\s]+$/g, "")
    .replace(/^[,.\s]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function capitalizeFirst(value) {
  const s = String(value || "").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

function makeItem(fields) {
  return {
    intent: fields.intent,
    title: fields.title || null,
    description: fields.description || null,
    due_date: fields.due_date || null,
    time: fields.time || null,
    duration_min: fields.duration_min ?? null,
    priority: fields.priority || null,
    area: fields.area || null,
    target_hint: fields.target_hint || null,
    confidence: fields.confidence ?? 0.9,
    exactUtcIso: fields.exactUtcIso || null,
    pastTime: Boolean(fields.pastTime),
    invalidLocalTime: Boolean(fields.invalidLocalTime)
  };
}
