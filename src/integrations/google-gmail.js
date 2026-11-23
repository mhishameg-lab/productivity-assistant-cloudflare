import { createGoogleAccessTokenProvider } from "./google-oauth.js";
import { buildMultipartAlternative } from "../core/email.js";

const GOOGLE_GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const MAX_ANALYSIS_BODY_CHARACTERS = 2500;
const MAX_ANALYSIS_RESPONSE_BYTES = 100_000;

export function createGoogleGmailClient(env, fetchImpl = fetch, clock = () => Date.now()) {
  const accessToken = createGoogleAccessTokenProvider(env, fetchImpl, clock);

  return {
    async listUnreadInboxThreads(limit = 5) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
        throw new RangeError("Gmail inbox limit must be from 1 to 10.");
      }
      const profile = await gmailGet("/users/me/profile");
      if (!profile || typeof profile.emailAddress !== "string" || !profile.emailAddress) {
        throw new Error("Gmail profile did not include the account address.");
      }

      const query = new URLSearchParams({
        maxResults: String(Math.min(10, limit * 2)),
        q: "is:unread"
      });
      const listed = await gmailGet(`/users/me/threads?${query}`);
      const threadIds = Array.from(new Set(
        (listed && Array.isArray(listed.threads) ? listed.threads : [])
          .map(thread => thread && thread.id)
          .filter(id => typeof id === "string" && id)
      )).slice(0, Math.min(10, limit * 2));
      const threads = await Promise.all(threadIds.map(async id => {
        const params = new URLSearchParams({ format: "metadata" });
        for (const header of ["From", "Subject", "Date"]) {
          params.append("metadataHeaders", header);
        }
        return gmailGet(`/users/me/threads/${encodeURIComponent(id)}?${params}`);
      }));

      const ownAddress = profile.emailAddress.toLowerCase();
      const results = [];
      for (const thread of threads) {
        const messages = thread && Array.isArray(thread.messages) ? thread.messages : [];
        const latestUnreadInbound = messages
          .filter(message =>
            message &&
            typeof message.id === "string" &&
            Array.isArray(message.labelIds) &&
            message.labelIds.includes("UNREAD")
          )
          .filter(message => {
            const from = getHeader(message, "From");
            const senderAddress = getEmailAddress(from).toLowerCase();
            return from && (!senderAddress || senderAddress !== ownAddress);
          })
          .sort((left, right) =>
            Number(right.internalDate || 0) - Number(left.internalDate || 0)
          )[0];
        if (!latestUnreadInbound) continue;

        const from = getHeader(latestUnreadInbound, "From");
        const headerDate = getHeader(latestUnreadInbound, "Date");
        const internalTimestamp = Number(latestUnreadInbound.internalDate);
        const fallbackDate = Number.isFinite(internalTimestamp) && internalTimestamp > 0
          ? new Date(internalTimestamp).toISOString()
          : "";
        const receivedAt = headerDate || fallbackDate;
        results.push({
          threadId: thread.id,
          messageId: latestUnreadInbound.id,
          from,
          subject: decodeMimeWords(getHeader(latestUnreadInbound, "Subject") || "(no subject)"),
          receivedAt: Number.isNaN(Date.parse(receivedAt)) ? "" : receivedAt
        });
        if (results.length >= limit) break;
      }
      return results;
    },

    async readMessageText(messageId) {
      if (!isGmailId(messageId)) throw new TypeError("Gmail message ID is invalid.");
      const params = new URLSearchParams({ format: "full", fields: "payload" });
      const message = await gmailGet(
        `/users/me/messages/${encodeURIComponent(messageId)}?${params}`,
        MAX_ANALYSIS_RESPONSE_BYTES
      );
      return extractPlainText(message && message.payload)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_ANALYSIS_BODY_CHARACTERS);
    },

    async getThreadSummary(threadId) {
      if (!isGmailId(threadId)) throw new TypeError("Gmail thread ID is invalid.");
      const params = new URLSearchParams({ format: "metadata" });
      for (const header of ["From", "Subject", "Date"]) {
        params.append("metadataHeaders", header);
      }
      const thread = await gmailGet(
        `/users/me/threads/${encodeURIComponent(threadId)}?${params}`
      );
      const messages = thread && Array.isArray(thread.messages) ? thread.messages : [];
      const latest = messages.reduce((current, message) =>
        !current || Number(message.internalDate || 0) > Number(current.internalDate || 0)
          ? message
          : current,
      null);
      if (!latest) return null;
      const dateHeader = getHeader(latest, "Date");
      const timestamp = Number(latest.internalDate);
      const fallbackDate = Number.isFinite(timestamp) && timestamp > 0
        ? new Date(timestamp).toISOString()
        : "";
      const receivedAt = dateHeader || fallbackDate;
      return {
        threadId,
        from: getHeader(latest, "From"),
        subject: decodeMimeWords(getHeader(latest, "Subject") || "(no subject)"),
        receivedAt: Number.isNaN(Date.parse(receivedAt)) ? "" : receivedAt
      };
    },

    async sendText({ to, subject, body }) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to || ""))) {
        throw new TypeError("Gmail recipient must be a valid email address.");
      }
      if (!subject || /[\r\n]/.test(String(subject)) || String(subject).length > 250) {
        throw new TypeError("Gmail subject is invalid or too long.");
      }
      if (typeof body !== "string" || body.length > 100_000) {
        throw new TypeError("Gmail message body must be text of 100,000 characters or fewer.");
      }

      const raw = encodeMimeMessage({
        to,
        subject,
        body: body.replace(/\r\n?/g, "\n")
      });
      const token = await accessToken();
      let response;
      try {
        response = await fetchImpl(`${GOOGLE_GMAIL_API}/users/me/messages/send`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ raw })
        });
      } catch {
        const error = new Error("Gmail send outcome is unknown after a network failure.");
        error.outcomeUncertain = true;
        throw error;
      }

      if (!response.ok) {
        const error = new Error(`Gmail API send failed with HTTP ${response.status}.`);
        error.status = response.status;
        error.outcomeUncertain = response.status >= 500;
        throw error;
      }
      let result;
      try {
        result = await response.json();
      } catch {
        result = null;
      }
      if (!result || typeof result.id !== "string" || !result.id) {
        const error = new Error("Gmail accepted the request but returned no message identifier.");
        error.outcomeUncertain = true;
        throw error;
      }
      return { id: result.id, threadId: result.threadId || null };
    },

    async sendMultipart({ to, subject, text, html }) {
      const mime = buildMultipartAlternative({ to, subject, text, html });
      const raw = base64UrlEncode(new TextEncoder().encode(mime));
      const token = await accessToken();
      let response;
      try {
        response = await fetchImpl(`${GOOGLE_GMAIL_API}/users/me/messages/send`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ raw })
        });
      } catch {
        const error = new Error("Gmail send outcome is unknown after a network failure.");
        error.outcomeUncertain = true;
        throw error;
      }
      if (!response.ok) {
        const error = new Error(`Gmail API send failed with HTTP ${response.status}.`);
        error.status = response.status;
        error.outcomeUncertain = response.status >= 500;
        throw error;
      }
      const result = await response.json().catch(() => null);
      if (!result || typeof result.id !== "string" || !result.id) {
        const error = new Error("Gmail accepted the request but returned no message identifier.");
        error.outcomeUncertain = true;
        throw error;
      }
      return { id: result.id, threadId: result.threadId || null };
    }
  };

  async function gmailGet(path, maxResponseBytes = null) {
    const token = await accessToken();
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetchImpl(`${GOOGLE_GMAIL_API}${path}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
      } catch {
        if (attempt === 2) throw new Error("Gmail read request failed due to a network error.");
        await delay(250 * (2 ** attempt));
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await delay(250 * (2 ** attempt));
        continue;
      }
      break;
    }
    if (!response || !response.ok) {
      const status = response ? response.status : "unknown";
      const error = new Error(`Gmail API read failed with HTTP ${status}.`);
      if (response) error.status = response.status;
      throw error;
    }
    return maxResponseBytes
      ? readJsonResponseBounded(response, maxResponseBytes)
      : response.json();
  }
}

async function readJsonResponseBounded(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("Gmail message response exceeded the analysis size limit.");
  }
  if (!response.body) {
    throw new Error("Gmail message response did not contain readable content.");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("Gmail message response exceeded the analysis size limit.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Gmail message response was not valid JSON.");
  }
}

function getHeader(message, name) {
  const headers = message.payload && Array.isArray(message.payload.headers)
    ? message.payload.headers
    : [];
  const header = headers.find(item =>
    item && typeof item.name === "string" && item.name.toLowerCase() === name.toLowerCase()
  );
  return header && typeof header.value === "string" ? header.value : "";
}

function isGmailId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function extractPlainText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const chunks = [];
  collectPlainText(payload, chunks);
  return chunks.join("\n");
}

function collectPlainText(part, chunks) {
  if (part.mimeType === "text/plain" && part.body && part.body.data) {
    chunks.push(decodeBase64Url(part.body.data));
  }
  for (const child of Array.isArray(part.parts) ? part.parts : []) {
    collectPlainText(child, chunks);
  }
}

function decodeBase64Url(value) {
  const standard = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - standard.length % 4) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Gmail message text could not be decoded.");
  }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function getEmailAddress(value) {
  const bracketed = String(value || "").match(/<([^<>]+)>/);
  return (bracketed ? bracketed[1] : value).trim();
}

function decodeMimeWords(value) {
  return String(value).replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (encoded, content) => {
    try {
      const binary = atob(content);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      return new TextDecoder("utf-8").decode(bytes);
    } catch {
      return encoded;
    }
  });
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function encodeMimeMessage({ to, subject, body }) {
  const encodedSubject = base64Encode(new TextEncoder().encode(subject))
    .match(/.{1,60}/g)
    .map(part => `=?UTF-8?B?${part}?=`)
    .join("\r\n ");
  const encodedBody = base64Encode(new TextEncoder().encode(body))
    .match(/.{1,76}/g);
  const mime = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody ? encodedBody.join("\r\n") : ""
  ].join("\r\n");
  return base64UrlEncode(new TextEncoder().encode(mime));
}

function base64Encode(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64UrlEncode(bytes) {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
