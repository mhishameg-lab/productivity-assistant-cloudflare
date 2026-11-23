const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const accessTokenCache = new Map();

export function createGoogleAccessTokenProvider(env, fetchImpl = fetch, clock = () => Date.now()) {
  const required = [
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REFRESH_TOKEN"
  ];
  const missing = required.filter(key => !env[key]);
  if (missing.length) {
    throw new Error(`Google OAuth is not configured (${missing.join(", ")}).`);
  }

  return async function getAccessToken() {
    const cacheKey = `${env.GOOGLE_OAUTH_CLIENT_ID}:${env.GOOGLE_OAUTH_REFRESH_TOKEN}`;
    const cached = accessTokenCache.get(cacheKey);
    if (cached && cached.expiresAt > clock() + 60_000) return cached.value;

    const body = new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: "refresh_token"
    });
    const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!response.ok) {
      throw new Error(`Google OAuth token refresh failed with HTTP ${response.status}.`);
    }

    const result = await response.json();
    if (!result.access_token || !Number.isFinite(Number(result.expires_in))) {
      throw new Error("Google OAuth token refresh returned an invalid result.");
    }
    accessTokenCache.set(cacheKey, {
      value: result.access_token,
      expiresAt: clock() + Number(result.expires_in) * 1000
    });
    return result.access_token;
  };
}
