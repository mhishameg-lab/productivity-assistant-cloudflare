import { createGoogleAccessTokenProvider } from "./google-oauth.js";

const GOOGLE_GMAIL_API = "https://gmail.googleapis.com/gmail/v1";

export function createGoogleGmailClient(env, fetchImpl = fetch, clock = () => Date.now()) {
  const accessToken = createGoogleAccessTokenProvider(env, fetchImpl, clock);

  return {
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
    }
  };
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
