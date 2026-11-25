import { recordAiFailure, reserveAiUsage } from "./usage-ledger.js";
import { buildCaptureParserSystemPrompt } from "../core/prompts.js";
import { cairoDateKey, cairoTimeParts, shiftDateKey } from "../core/format.js";
import { normalizeArea, resolveWeekdayDate } from "../core/capture-router.js";
import { cairoLocalDateTimeToIso } from "../integrations/google-calendar.js";

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_PROMPT_BYTES = 4096;
const MAX_COMPLETION_TOKENS = 200;

const ALLOWED_INTENTS = new Set([
  "task",
  "reminder",
  "schedule",
  "done",
  "reschedule",
  "question",
  "chat",
  "unknown"
]);

const ALLOWED_PRIORITIES = new Set(["High", "Medium", "Low"]);

const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            intent: { type: "string", enum: [...ALLOWED_INTENTS] },
            title: { type: ["string", "null"], maxLength: 120 },
            description: { type: ["string", "null"], maxLength: 300 },
            due_date: { type: ["string", "null"] },
            time: { type: ["string", "null"] },
            duration_min: { type: ["integer", "null"], enum: [25, 50, null] },
            priority: { type: ["string", "null"], enum: ["High", "Medium", "Low", null] },
            area: { type: ["string", "null"], enum: ["DEEP", "WORK", "LIFE", "Admin", "Other", null] },
            target_hint: { type: ["string", "null"], maxLength: 120 },
            confidence: { type: "number", minimum: 0, maximum: 1 }
          },
          required: [
            "intent",
            "title",
            "description",
            "due_date",
            "time",
            "duration_min",
            "priority",
            "area",
            "target_hint",
            "confidence"
          ],
          additionalProperties: false
        }
      }
    },
    required: ["items"],
    additionalProperties: false
  }
};

export async function parseWithWorkersAi({
  db,
  ai,
  text,
  recentTurns = [],
  now,
  model = DEFAULT_MODEL,
  dailyNeuronLimit = 5000
}) {
  if (!ai || typeof ai.run !== "function") return null;
  const normalizedText = String(text || "").trim();
  if (!normalizedText || new TextEncoder().encode(normalizedText).byteLength > 1024) {
    return null;
  }
  if (!db || !now || Number.isNaN(Date.parse(now))) {
    throw new TypeError("AI capture parser requires D1 and a valid timestamp.");
  }

  const parts = cairoTimeParts(now);
  const date = parts.date;
  const systemPrompt = buildCaptureParserSystemPrompt({
    weekday: parts.weekday,
    date,
    time: `${parts.hour}:${parts.minute}`,
    tomorrow: shiftDateKey(date, 1),
    nextFriday: resolveWeekdayDate("friday", now)
  });

  const turnsBlock = Array.isArray(recentTurns) && recentTurns.length
    ? `\nRecent turns:\n${recentTurns.slice(-3).map(t => `${t.role}: ${String(t.text || "").slice(0, 200)}`).join("\n")}`
    : "";
  const prompt = `${systemPrompt}${turnsBlock}\nMessage: ${JSON.stringify(normalizedText)}`;
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
      response_format: RESPONSE_FORMAT,
      max_tokens: MAX_COMPLETION_TOKENS,
      temperature: 0.1
    });
    return validateCaptureResponse(result, now);
  } catch (error) {
    await recordAiFailure(db, reservation.usageDate, now);
    return null;
  }
}

export function validateCaptureResponse(result, now = new Date()) {
  let raw = result && result.response !== undefined ? result.response : result;
  if (typeof raw === "string") {
    const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    try {
      raw = JSON.parse(stripped);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items) ||
      raw.items.length < 1 || raw.items.length > 5) {
    return null;
  }

  const today = cairoDateKey(now);
  const validated = [];
  for (const item of raw.items) {
    if (!item || typeof item !== "object" || !ALLOWED_INTENTS.has(item.intent)) {
      return null;
    }
    const confidence = Number(item.confidence);
    if (!Number.isFinite(confidence)) return null;
    const clampedConfidence = Math.min(1, Math.max(0, confidence));

    const title = typeof item.title === "string"
      ? item.title.trim().slice(0, 120) || null
      : null;
    const description = typeof item.description === "string"
      ? item.description.trim().slice(0, 300) || null
      : null;
    const dueDate = validateDateKey(item.due_date);
    if (item.due_date != null && !dueDate) return null;
    const time = validateTime24(item.time);
    if (item.time != null && !time) return null;
    const durationMin = item.duration_min === 25 || item.duration_min === 50
      ? item.duration_min
      : null;
    const priority = ALLOWED_PRIORITIES.has(item.priority) ? item.priority : null;
    const area = item.area == null ? null : normalizeArea(item.area);
    const targetHint = typeof item.target_hint === "string"
      ? item.target_hint.trim().slice(0, 120) || null
      : null;

    let pastTime = false;
    let invalidLocalTime = false;
    if (dueDate && dueDate < today) {
      pastTime = true;
    } else if (dueDate && time) {
      try {
        const iso = cairoLocalDateTimeToIso(dueDate, time);
        if (Date.parse(iso) <= now.getTime()) pastTime = true;
      } catch {
        invalidLocalTime = true;
      }
    }

    validated.push({
      intent: item.intent,
      title,
      description,
      due_date: dueDate,
      time,
      duration_min: durationMin,
      priority,
      area,
      target_hint: targetHint,
      confidence: clampedConfidence,
      exactUtcIso: null,
      pastTime,
      invalidLocalTime
    });
  }

  return { source: "ai", items: validated };
}

function validateDateKey(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const parsed = new Date(`${s}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== s) return null;
  return s;
}

function validateTime24(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(s)) return null;
  return s;
}
