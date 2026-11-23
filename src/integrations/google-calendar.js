import { createGoogleAccessTokenProvider } from "./google-oauth.js";
import { cairoDateKey as formattedCairoDateKey, cairoTimeParts, dateTimeLabel, timeLabel } from "../core/format.js";

const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const CAIRO_TIME_ZONE = "Africa/Cairo";
const SAFE_CALENDAR_ERROR_REASONS = new Set([
  "accessNotConfigured",
  "calendarUsageLimitsExceeded",
  "forbidden",
  "insufficientPermissions",
  "notFound",
  "quotaExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded"
]);

export function cairoDateStart(dateKey) {
  if (!isValidDateKey(dateKey)) {
    throw new TypeError("Calendar date must be a real YYYY-MM-DD date.");
  }
  return cairoMidnight(dateKey);
}

export function createGoogleCalendarClient(env, fetchImpl = fetch, clock = () => Date.now()) {
  const accessToken = createGoogleAccessTokenProvider(env, fetchImpl, clock);
  const calendarId = env.GOOGLE_CALENDAR_ID || "primary";

  async function request(path, options = {}) {
    const token = await accessToken();
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetchImpl(`${GOOGLE_CALENDAR_API}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.headers || {})
        }
      });
      if (response.status < 500 && response.status !== 429) break;
      if (attempt < 2) await delay(250 * (2 ** attempt));
    }
    if (!response.ok) {
      let googleApiReason = null;
      try {
        const errorBody = await response.json();
        const reasons = [
          ...(errorBody && errorBody.error && Array.isArray(errorBody.error.errors)
            ? errorBody.error.errors.map(item => item && item.reason)
            : []),
          errorBody && errorBody.error && errorBody.error.status,
          errorBody && errorBody.error && errorBody.error.reason
        ];
        googleApiReason = reasons.find(reason =>
          typeof reason === "string" && SAFE_CALENDAR_ERROR_REASONS.has(reason)
        ) || null;
      } catch {
        googleApiReason = null;
      }
      const suffix = googleApiReason ? ` (${googleApiReason})` : "";
      const error = new Error(
        `Google Calendar API request failed with HTTP ${response.status}${suffix}.`
      );
      error.status = response.status;
      error.integration = "Google Calendar";
      if (googleApiReason) error.googleApiReason = googleApiReason;
      throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async function getEvent(eventId) {
    return request(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
    );
  }

  return {
    async listEventsForDate(dateKey) {
      if (!isValidDateKey(dateKey)) {
        throw new TypeError("Calendar date must be a real YYYY-MM-DD date.");
      }

      const query = new URLSearchParams({
        timeMin: cairoMidnight(dateKey).toISOString(),
        timeMax: cairoMidnight(shiftDateKey(dateKey, 1)).toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "2500",
        fields: "items(id,summary,start,end,status),nextPageToken"
      });
      const events = [];
      let pageToken = "";
      do {
        if (pageToken) query.set("pageToken", pageToken);
        const page = await request(
          `/calendars/${encodeURIComponent(calendarId)}/events?${query}`
        );
        for (const event of page.items || []) {
          if (event.status === "cancelled") continue;
          const allDay = Boolean(event.start && event.start.date);
          events.push({
            id: event.id,
            title: event.summary || "(No title)",
            startTime: allDay ? event.start.date : event.start.dateTime,
            endTime: allDay ? event.end.date : event.end.dateTime,
            allDay,
            start: allDay ? "All day" : formatCairoTime(event.start.dateTime),
            end: allDay ? "" : formatCairoTime(event.end.dateTime)
          });
        }
        pageToken = page.nextPageToken || "";
      } while (pageToken);
      return events;
    },

    async createTaskBlock({
      idempotencyKey,
      title,
      date,
      startTime,
      durationMinutes,
      description = "",
      notBefore
    }) {
      if (![25, 50].includes(Number(durationMinutes))) {
        throw new TypeError("Calendar focus block duration must be 25 or 50 minutes.");
      }
      const start = cairoLocalDateTimeToIso(date, startTime);
      if (!notBefore || Number.isNaN(Date.parse(notBefore)) || Date.parse(start) <= Date.parse(notBefore)) {
        throw new TypeError("Calendar focus block must start in the future.");
      }
      const end = new Date(Date.parse(start) + Number(durationMinutes) * 60_000).toISOString();
      return this.createEvent({
        idempotencyKey,
        title,
        start,
        end,
        description
      });
    },

    async createEvent({ idempotencyKey, title, start, end, description = "" }) {
      const normalizedTitle = String(title || "").trim();
      if (!idempotencyKey || String(idempotencyKey).length > 200) {
        throw new TypeError("Calendar event idempotency key is required and must be 200 characters or fewer.");
      }
      if (!normalizedTitle || normalizedTitle.length > 500) {
        throw new TypeError("Calendar event title is required and must be 500 characters or fewer.");
      }
      if (!isOffsetDateTime(start) || !isOffsetDateTime(end) || Date.parse(end) <= Date.parse(start)) {
        throw new TypeError("Calendar event requires valid offset date-times with end after start.");
      }
      if (String(description).length > 8000) {
        throw new TypeError("Calendar event description must be 8,000 characters or fewer.");
      }

      const eventId = await eventIdForKey(idempotencyKey);
      const payload = {
        id: eventId,
        summary: normalizedTitle,
        description: String(description),
        start: { dateTime: start, timeZone: CAIRO_TIME_ZONE },
        end: { dateTime: end, timeZone: CAIRO_TIME_ZONE }
      };
      try {
        return await request(
          `/calendars/${encodeURIComponent(calendarId)}/events`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          }
        );
      } catch (error) {
        if (error.status !== 409) throw error;
        const existing = await getEvent(eventId);
        if (!sameEvent(existing, payload)) {
          throw new Error("Calendar idempotency key already belongs to a different event.");
        }
        return existing;
      }
    }
  };
}

function sameEvent(existing, requested) {
  return existing &&
    existing.summary === requested.summary &&
    Date.parse(existing.start && existing.start.dateTime) === Date.parse(requested.start.dateTime) &&
    Date.parse(existing.end && existing.end.dateTime) === Date.parse(requested.end.dateTime);
}

async function eventIdForKey(key) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(key))
  );
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return `a${hex}`;
}

function isOffsetDateTime(value) {
  const match = String(value).match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|([+-])(\d{2}):(\d{2}))$/
  );
  if (!match || !isValidDateKey(match[1])) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] || 0);
  const offsetHour = Number(match[6] || 0);
  const offsetMinute = Number(match[7] || 0);
  return hour < 24 && minute < 60 && second < 60 &&
    offsetHour <= 14 && offsetMinute < 60 &&
    (offsetHour < 14 || offsetMinute === 0) &&
    !Number.isNaN(Date.parse(value));
}

function isValidDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function shiftDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function cairoMidnight(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const wallTime = Date.UTC(year, month - 1, day);
  let low = wallTime - 36 * 60 * 60 * 1000;
  let high = wallTime + 36 * 60 * 60 * 1000;
  for (let attempt = 0; attempt < 48; attempt++) {
    const midpoint = Math.floor((low + high) / 2);
    if (formatCairoDateKey(new Date(midpoint)) >= dateKey) high = midpoint;
    else low = midpoint + 1;
  }
  return new Date(high);
}

function formatCairoDateKey(date) {
  return formattedCairoDateKey(date);
}

export function cairoLocalDateTimeToIso(dateKey, time) {
  if (!isValidDateKey(dateKey) || !/^\d{2}:\d{2}$/.test(String(time))) {
    throw new TypeError("Calendar start must use a real YYYY-MM-DD date and HH:mm Cairo time.");
  }
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (hour > 23 || minute > 59) {
    throw new TypeError("Calendar start time is invalid.");
  }

  const wallTime = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set(
    [-12, 0, 12].map(hours => cairoOffsetMinutes(wallTime + hours * 60 * 60 * 1000))
  );
  const candidates = Array.from(offsets, offset => wallTime - offset * 60_000)
    .filter(timestamp => formatCairoDateTime(timestamp) === `${dateKey} ${time}`)
    .sort((left, right) => left - right);
  if (!candidates.length) {
    throw new TypeError("That Cairo local time does not exist because of a timezone transition.");
  }
  return new Date(candidates[0]).toISOString();
}

function cairoOffsetMinutes(timestamp) {
  const parts = cairoDateTimeParts(timestamp);
  const localTime = Date.UTC(
    parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second
  );
  return (localTime - timestamp) / 60_000;
}

function cairoDateTimeParts(timestamp) {
  const values = cairoTimeParts(new Date(timestamp));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: 0
  };
}

function formatCairoDateTime(timestamp) {
  const parts = cairoDateTimeParts(timestamp);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function formatCairoTime(value) {
  return timeLabel(new Date(value));
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
