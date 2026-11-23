import { escapeTelegramHtml as escapeHtml } from "../channels/telegram-api.js";

export function encodeRfc2047(subject) {
  const utf8 = new TextEncoder().encode(String(subject || ""));
  if ([...utf8].every(byte => byte >= 32 && byte <= 126)) return String(subject);
  let binary = "";
  for (const byte of utf8) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

export function buildMultipartAlternative({ to, subject, text, html, from = null }) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to || ""))) {
    throw new TypeError("Gmail recipient must be valid.");
  }
  if (!subject || /[\r\n]/.test(String(subject)) || String(subject).length > 250) {
    throw new TypeError("Gmail subject is invalid.");
  }
  const textPart = String(text || "").replace(/\r\n?/g, "\n");
  const htmlPart = String(html || "");
  if (textPart.length > 100_000 || htmlPart.length > 90_000) {
    throw new RangeError("Email content exceeds the fixed size limit.");
  }
  const boundary = `=_part_${crypto.randomUUID().replace(/-/g, "")}`;
  const encodedSubject = encodeRfc2047(subject);
  const lines = [
    `From: ${from || "Personal Productivity Assistant"}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary=\"${boundary}\"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64(textPart),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64(htmlPart),
    `--${boundary}--`,
    ""
  ];
  return lines.join("\r\n");
}

export function escapeEmailHtml(value) {
  return escapeHtml(value);
}

export function encodeBase64(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/.{76}(?=.)/g, "$&\r\n");
}
