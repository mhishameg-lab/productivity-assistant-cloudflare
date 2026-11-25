export const CAIRO_TIME_ZONE = "Africa/Cairo";

export function cairoDateKey(date) {
  return formatParts(date).date;
}

export function cairoTimeParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CAIRO_TIME_ZONE,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter(part => part.type !== "literal").map(part => [part.type, part.value])
  );
  return {
    ...values,
    date: `${values.year}-${values.month}-${values.day}`
  };
}

export function shortDate(dateOrKey) {
  const date = toCairoDate(dateOrKey);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

export function longDate(dateOrKey) {
  const date = toCairoDate(dateOrKey);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

export function weekdayDay(dateOrKey) {
  const date = toCairoDate(dateOrKey);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(date);
}

export function timeLabel(value) {
  let parts;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError("Time is invalid.");
    parts = cairoTimeParts(value);
  } else if (/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value))) {
    const [hourStr, minuteStr] = String(value).split(":");
    parts = { hour: hourStr, minute: minuteStr };
  } else {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError("Time is invalid.");
    parts = cairoTimeParts(date);
  }
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new TypeError("Time is invalid.");
  }
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

export function dateTimeLabel(dateOrKey) {
  if (typeof dateOrKey === "string" && /\dT/.test(dateOrKey)) {
    const date = new Date(dateOrKey);
    return `${shortDate(date)} · ${timeLabel(date)}`;
  }
  return `${shortDate(dateOrKey)} · ${timeLabel(dateOrKey)}`;
}

export function timeRange(start, end) {
  return `${timeLabel(start)} – ${timeLabel(end)}`;
}

export function durationLabel(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value < 0) throw new TypeError("Duration is invalid.");
  const rounded = Math.floor(value);
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return hours
    ? remainder ? `${hours} h ${remainder} min` : `${hours} h`
    : `${remainder} min`;
}

export function greetingLine(name = "Martino", now = new Date()) {
  const hour = Number(cairoTimeParts(now).hour);
  const weekday = cairoTimeParts(now).weekday;
  if (hour < 12) {
    const morning = hour < 6
      ? `🌙 Good morning, ${name}`
      : "☀️";
    return morning === "☀️"
      ? `☀️ Good morning, ${name}`
      : morning;
  }
  if (hour < 18) return `🌤 Good afternoon, ${name}`;
  if (hour < 23) return `🌙 Good evening, ${name}`;
  return `🌙 Hey ${name}`;
}

export function relativeLabel(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value < 0) throw new TypeError("Relative minutes are invalid.");
  return `in about ${Math.round(value)} minutes`;
}

export function parseTimeInput(input) {
  const text = String(input || "").trim();
  const twelveHour = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (twelveHour) {
    let hour = Number(twelveHour[1]);
    const minute = twelveHour[2] ? Number(twelveHour[2]) : 0;
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (/pm/i.test(twelveHour[3]) && hour !== 12) hour += 12;
    if (/am/i.test(twelveHour[3]) && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  const twentyFour = text.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (twentyFour) return `${twentyFour[1]}:${twentyFour[2]}`;
  return null;
}

export function parseDateInput(input, now = new Date()) {
  const text = String(input || "").trim();
  const today = cairoDateKey(now);
  if (/^today$/i.test(text)) return today;
  if (/^tomorrow$/i.test(text)) return shiftDateKey(today, 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) && isRealDateKey(text)) return text;

  const slash = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    const year = slash[3] ? Number(slash[3]) : nextOccurrenceYear(month, day, today);
    const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (!isRealDateKey(key)) return null;
    if (!slash[3] && key < today) return null;
    return key;
  }

  const named = text.match(/^([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?$/);
  if (named) {
    const monthNames = [
      ["january", "jan"], ["february", "feb"], ["march", "mar"], ["april", "apr"],
      ["may", "may"], ["june", "jun"], ["july", "jul"], ["august", "aug"],
      ["september", "sep"], ["october", "oct"], ["november", "nov"], ["december", "dec"]
    ];
    const monthIndex = monthNames.findIndex(names =>
      names.includes(named[1].toLowerCase())
    );
    if (monthIndex < 0) return null;
    const day = Number(named[2]);
    const year = named[3] ? Number(named[3]) : nextOccurrenceYear(monthIndex + 1, day, today);
    const key = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (!isRealDateKey(key)) return null;
    if (!named[3] && key < today) return null;
    return key;
  }
  return null;
}

export function parseCairoDateTime(input, now = new Date()) {
  const text = String(input || "").trim();
  const first = text.match(/^(.+?)\s+(\d{1,2}(?::\d{2})?\s*(?:AM|PM)|[01]\d:[0-5]\d|2[0-3]:[0-5]\d)$/i);
  if (!first) return null;
  const dateKey = parseDateInput(first[1], now);
  const time = parseTimeInput(first[2]);
  return dateKey && time ? { dateKey, time } : null;
}

export function areaLabel(area) {
  return ({
    DEEP: "🌱 Growth",
    WORK: "💼 Work",
    LIFE: "🏠 Life",
    Admin: "📎 Errands",
    Other: "⋯ Other"
  })[area] || "⋯ Other";
}

export function stripStoredAreaWords(text) {
  return String(text || "")
    .replace(/\bDEEP\b/g, "Growth")
    .replace(/\bWORK\b/g, "Work")
    .replace(/\bLIFE\b/g, "Life");
}

export function shiftDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatParts(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) throw new TypeError("Date is invalid.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CAIRO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const values = Object.fromEntries(
    parts.filter(part => part.type !== "literal").map(part => [part.type, part.value])
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    year: values.year,
    month: values.month,
    day: values.day
  };
}

function toCairoDate(value) {
  if (value instanceof Date) return new Date(`${formatParts(value).date}T12:00:00.000Z`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return new Date(`${value}T12:00:00.000Z`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Date is invalid.");
  return new Date(`${formatParts(date).date}T12:00:00.000Z`);
}

function isRealDateKey(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const date = new Date(`${key}T12:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === key;
}

function nextOccurrenceYear(month, day, today) {
  const currentYear = Number(today.slice(0, 4));
  for (let year = currentYear; year <= currentYear + 1; year++) {
    const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (isRealDateKey(key) && key >= today) return year;
  }
  return currentYear;
}
