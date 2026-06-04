/**
 * Fitbit / Google Health API client — OAuth half (v1.12.0).
 * Docs: https://developers.google.com/health (re-verify at build — the Google
 * Health API is young; v4, post-Fitbit-Web-API).
 *
 * Mirrors the WHOOP client structure (`src/lib/whoop/client.ts`): hand-rolled
 * fetch over `safeFetch` (no SDK), an OAuth handshake (`getAuthorizationUrl` /
 * `exchangeCode` / `refreshAccessToken`), and a single profile fetch for the
 * connection's external user id. The data-fetch half (paginated `dataPoints`
 * walker + per-type mappers + `FITBIT_FIELD_MAP`) lands in a later wave.
 *
 * KEY DELTA vs WHOOP — Google does NOT rotate refresh tokens. WHOOP invalidates
 * the prior refresh token on every refresh; Google's refresh tokens are stable
 * (long-lived in production, 7-day expiry only in Testing mode). So
 * `refreshAccessToken` may return a token response WITHOUT a `refresh_token`,
 * and the sync layer keeps the stored one in that case (see `getValidToken` in
 * `sync.ts`).
 *
 * Confidential web-server client: HealthLog holds the client secret
 * server-side, so PKCE is omitted (matches WHOOP). Client credentials are sent
 * to the token endpoint via HTTP Basic auth (RFC 6749 §2.3.1), the way Google's
 * token endpoint accepts a confidential client.
 */
import { getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import { FitbitApiError, classifyFitbitResponse } from "./response-classifier";

export const FITBIT_API_BASE = "https://health.googleapis.com/v4";
const GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface FitbitCredentials {
  clientId: string;
  clientSecret: string;
}

function getRedirectUri(): string {
  return (
    process.env.FITBIT_REDIRECT_URI ??
    `${process.env.NEXT_PUBLIC_APP_URL}/api/fitbit/callback`
  );
}

/**
 * OAuth scopes HealthLog requests (space-separated on the wire). The four
 * launch Restricted read bundles cover every v1.12.0 metric; ECG / nutrition /
 * location / IRN are deliberately omitted to keep the Restricted-scope CASA
 * review surface minimal. Every scope is Restricted → the operator's OAuth
 * client needs Google brand verification + an annual CASA assessment before it
 * leaves Testing mode.
 */
export const FITBIT_OAUTH_SCOPE = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  "https://www.googleapis.com/auth/googlehealth.profile.readonly",
].join(" ");

/**
 * Generate the Google OAuth authorization URL (a browser redirect, not a
 * fetch). `state` is the opaque CSRF nonce minted by `oauth-state.ts`.
 *
 * `access_type=offline` + `prompt=consent` are Google's requirement to receive
 * a refresh token (the equivalent of WHOOP's `offline` scope); `prompt=consent`
 * forces the consent screen so a re-connect always returns a fresh refresh
 * token even if the user previously granted.
 */
export function getAuthorizationUrl(
  state: string,
  creds: FitbitCredentials,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: getRedirectUri(),
    scope: FITBIT_OAUTH_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${GOOGLE_OAUTH_AUTH_URL}?${params}`;
}

export interface FitbitTokenResponse {
  access_token: string;
  /**
   * Present on the initial code exchange and whenever Google issues a new
   * refresh token; ABSENT on a routine refresh because Google does not rotate.
   * The sync layer keeps the stored token when this is missing.
   */
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

/** Basic-auth header carrying the confidential client credentials. */
function basicAuthHeader(creds: FitbitCredentials): string {
  const raw = `${creds.clientId}:${creds.clientSecret}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

async function postToken(
  params: URLSearchParams,
  creds: FitbitCredentials,
  verb: string,
): Promise<FitbitTokenResponse> {
  const start = performance.now();
  const res = await safeFetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(creds),
    },
    body: params.toString(),
  });

  const json = await res.json().catch(() => null);
  const verdict = classifyFitbitResponse(res.status);
  getEvent()?.addExternalCall({
    service: "fitbit",
    method: verb,
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new FitbitApiError({
      verb,
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
      upstreamError: typeof json?.error === "string" ? json.error : undefined,
    });
  }
  return json as FitbitTokenResponse;
}

/** Exchange an authorization code for the initial token pair. */
export async function exchangeCode(
  code: string,
  creds: FitbitCredentials,
): Promise<FitbitTokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: creds.clientId,
      redirect_uri: getRedirectUri(),
    }),
    creds,
    "exchangeCode",
  );
}

/**
 * Refresh an expired access token. Google does NOT rotate refresh tokens — the
 * response carries a fresh `access_token` + `expires_in` but usually omits
 * `refresh_token`. The caller persists the new access token + expiry and keeps
 * the stored refresh token unless a new one is returned. The original scope is
 * preserved by Google, so no `scope` param is re-sent.
 */
export async function refreshAccessToken(
  refreshToken: string,
  creds: FitbitCredentials,
): Promise<FitbitTokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: creds.clientId,
    }),
    creds,
    "refreshAccessToken",
  );
}

/**
 * The Google Health profile carries the external user id used as the
 * connection's `fitbitUserId`. Mirrors WHOOP's `fetchProfile` (a single GET,
 * not a paginated collection).
 */
export interface FitbitProfile {
  /**
   * External user identifier. Google returns `me`-relative profile data; the
   * stable id is surfaced under `name` (a `users/{id}` resource name) or `id`
   * depending on the API surface — both are captured here and resolved at the
   * call site. Re-verify the exact field against a live account at the data-sync
   * wave.
   */
  name?: string;
  id?: string;
}

export async function fetchProfile(
  accessToken: string,
): Promise<FitbitProfile> {
  const start = performance.now();
  const res = await safeFetch(`${FITBIT_API_BASE}/users/me/profile`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json().catch(() => null)) as FitbitProfile | null;
  const verdict = classifyFitbitResponse(res.status);
  getEvent()?.addExternalCall({
    service: "fitbit",
    method: "fetchProfile",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new FitbitApiError({
      verb: "fetchProfile",
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
    });
  }
  return (json ?? {}) as FitbitProfile;
}

/**
 * Resolve the stable external user id from a Google Health profile. The
 * `users/{id}` resource name is the canonical anchor; fall back to a bare `id`
 * or "me" so the connection always persists a non-empty `fitbitUserId`.
 */
export function resolveFitbitUserId(profile: FitbitProfile): string {
  if (profile.name) {
    const tail = profile.name.split("/").pop();
    if (tail) return tail;
  }
  if (profile.id) return profile.id;
  return "me";
}
