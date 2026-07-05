/**
 * Google Health API client — OAuth + data-point reads (v1.27.0).
 * Docs: https://developers.google.com/health (health.googleapis.com/v4, the
 * successor to the Fitbit Web API, unifying Fitbit + Pixel Watch + Fitbit Air).
 *
 * Hand-rolled fetch over `safeFetch` (no SDK): the OAuth handshake
 * (`getAuthorizationUrl` / `exchangeCode` / `refreshAccessToken`), a single
 * profile fetch for the connection's external user id, and the paginated
 * `dataPoints.list` walker + per-type mappers.
 *
 * KEY OAUTH SEMANTICS (verified 2026 contract):
 *   - Access-token TTL = 1 h (contrast the classic Fitbit Web API's 8 h).
 *   - Refresh tokens do NOT rotate — a routine refresh returns a fresh
 *     `access_token` WITHOUT a `refresh_token`; the sync layer keeps the stored
 *     one (see `getValidToken` in `sync.ts`). Refresh tokens are time-based:
 *     they expire after 6 months of disuse, or — in a consent screen still in
 *     "Testing" publishing mode — after 7 DAYS, at which point the user must
 *     re-consent. A revoked / expired refresh token surfaces `invalid_grant`
 *     (or a 401) on the token endpoint; `postToken` lifts that onto the
 *     `reauth_required` class so the connection prompts a reconnect rather than
 *     a generic hard error.
 *   - PKCE (S256): the authorize request carries a `code_challenge`; the
 *     callback presents the matching `code_verifier` on exchange. Google's
 *     web-server (confidential) client also sends the client secret via HTTP
 *     Basic auth (RFC 6749 §2.3.1) — Basic + PKCE together.
 *   - `access_type=offline` + `prompt=consent` are required to reliably receive
 *     a refresh token (and force one on every re-consent).
 */
import { createHash, randomBytes } from "node:crypto";
import { getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import { wallClockInTz, zonedWallClockToUtc } from "@/lib/tz/wall-clock";
import {
  GoogleHealthApiError,
  classifyGoogleHealthResponse,
  type GoogleHealthClassification,
} from "./response-classifier";

export const GOOGLE_HEALTH_API_BASE = "https://health.googleapis.com/v4";
const GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleHealthCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Resolve the OAuth `redirect_uri`, then assert it against an allowlist
 * (defence-in-depth).
 *
 * The value is operator-controlled config (`GOOGLE_HEALTH_REDIRECT_URI`, else
 * derived from `NEXT_PUBLIC_APP_URL`), not user input, so Google's
 * registered-redirect check is the real backstop. But a misconfigured or
 * `Host`-coerced `NEXT_PUBLIC_APP_URL` (a mis-deployed reverse proxy reflecting
 * a forwarded Host) would otherwise send the authorization code's landing URL
 * off-origin. Pin the target here so a malformed origin fails fast at the
 * handshake rather than silently redirecting elsewhere:
 *   - must be an absolute, parseable URL,
 *   - must be https (the one exception is a localhost/loopback dev host, which
 *     Google itself permits over http),
 *   - must land on the fixed `/api/google-health/callback` path,
 *   - when derived from `NEXT_PUBLIC_APP_URL`, must stay same-origin with it.
 */
function getRedirectUri(): string {
  const explicit = process.env.GOOGLE_HEALTH_REDIRECT_URI;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const raw =
    explicit ?? (appUrl ? `${appUrl}/api/google-health/callback` : undefined);

  if (!raw) {
    throw new Error(
      "Google Health redirect_uri is not configured — set GOOGLE_HEALTH_REDIRECT_URI or NEXT_PUBLIC_APP_URL",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `Google Health redirect_uri is not an absolute URL: ${raw}`,
    );
  }

  const isLoopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1";
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopback)
  ) {
    throw new Error(
      `Google Health redirect_uri must be https (or http on localhost): ${parsed.origin}`,
    );
  }

  if (parsed.pathname !== "/api/google-health/callback") {
    throw new Error(
      `Google Health redirect_uri must target /api/google-health/callback, got ${parsed.pathname}`,
    );
  }

  // When an explicit GOOGLE_HEALTH_REDIRECT_URI is set alongside
  // NEXT_PUBLIC_APP_URL, require them to share an origin so the pinned value
  // can't drift to an unexpected host relative to the app's own base URL.
  if (explicit && appUrl) {
    let appOrigin: string;
    try {
      appOrigin = new URL(appUrl).origin;
    } catch {
      throw new Error(`NEXT_PUBLIC_APP_URL is not an absolute URL: ${appUrl}`);
    }
    if (parsed.origin !== appOrigin) {
      throw new Error(
        `Google Health redirect_uri origin ${parsed.origin} does not match NEXT_PUBLIC_APP_URL origin ${appOrigin}`,
      );
    }
  }

  return parsed.toString();
}

/**
 * The four core Restricted read scopes HealthLog requests for v1. Every scope
 * is Restricted → the operator's OAuth client needs Google verification + an
 * annual CASA assessment before it leaves "Testing" publishing mode (staying in
 * Testing with ≤100 test users avoids CASA at the cost of a 7-day refresh-token
 * expiry).
 */
export const GOOGLE_HEALTH_CORE_SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  "https://www.googleapis.com/auth/googlehealth.profile.readonly",
] as const;

/**
 * Resolve the scope list HealthLog requests: the four core Restricted bundles.
 * ECG/IRN are a future enhancement — add those two Restricted read scopes only
 * together with an ECG/IRN reader, never before (Google penalizes requesting a
 * Restricted scope the app never consumes).
 */
export function resolveGoogleHealthScopes(): string[] {
  return [...GOOGLE_HEALTH_CORE_SCOPES];
}

/** The space-separated scope string sent on the authorize request. */
export function getGoogleHealthScopeString(): string {
  return resolveGoogleHealthScopes().join(" ");
}

// ─── PKCE ──────────────────────────────────────────────────────
//
// Google's authorization-code flow accepts S256 PKCE. The verifier is a
// high-entropy random string; the challenge is BASE64URL(SHA256(verifier)). The
// verifier is stashed on the OAuth-state row at connect and presented on the
// token exchange at callback — never in the cookie or the URL.

export interface GoogleHealthPkcePair {
  verifier: string;
  challenge: string;
}

/**
 * Mint a PKCE verifier + S256 challenge. 64 random bytes → 86 base64url chars,
 * comfortably inside the RFC 7636 43–128 char verifier range and well past the
 * 256-bit entropy floor.
 */
export function generatePkcePair(): GoogleHealthPkcePair {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Build the Google authorization URL (a browser redirect, not a fetch). `state`
 * is the opaque CSRF nonce minted by `oauth-state.ts`; `codeChallenge` is the
 * S256 PKCE challenge whose verifier the callback presents on token exchange.
 *
 * `access_type=offline` + `prompt=consent` are Google's requirement to receive
 * a refresh token; `prompt=consent` forces the consent screen so a re-connect
 * always returns a fresh refresh token even if the user previously granted.
 */
export function getAuthorizationUrl(
  state: string,
  creds: GoogleHealthCredentials,
  codeChallenge: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: getRedirectUri(),
    scope: getGoogleHealthScopeString(),
    access_type: "offline",
    prompt: "consent",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return `${GOOGLE_OAUTH_AUTH_URL}?${params}`;
}

export interface GoogleHealthTokenResponse {
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
function basicAuthHeader(creds: GoogleHealthCredentials): string {
  const raw = `${creds.clientId}:${creds.clientSecret}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

async function postToken(
  params: URLSearchParams,
  creds: GoogleHealthCredentials,
  verb: string,
): Promise<GoogleHealthTokenResponse> {
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
  const verdict = classifyGoogleHealthResponse(res.status);
  const upstreamError =
    typeof json?.error === "string" ? (json.error as string) : undefined;

  // Google signals a revoked / expired refresh token — the user disconnected
  // the app upstream, OR the 7-day "Testing"-mode refresh window lapsed — via
  // `invalid_grant` on the token endpoint (sometimes a 400, sometimes a 401). A
  // bare status classification buckets a 400 as `persistent` (never prompts a
  // reconnect); lift an `invalid_grant` onto `reauth_required` so the connection
  // surfaces the reconnect CTA. A 401 already classifies as `reauth_required`.
  const classification: GoogleHealthClassification =
    upstreamError === "invalid_grant"
      ? "reauth_required"
      : verdict.classification;

  getEvent()?.addExternalCall({
    service: "google-health",
    method: verb,
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (classification !== "success") {
    throw new GoogleHealthApiError({
      verb,
      classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
      upstreamError,
    });
  }
  return json as GoogleHealthTokenResponse;
}

/**
 * Exchange an authorization code for the initial token pair, presenting the
 * PKCE verifier. `redirect_uri` must exactly match the one sent to the
 * authorize endpoint.
 */
export async function exchangeCode(
  code: string,
  codeVerifier: string,
  creds: GoogleHealthCredentials,
): Promise<GoogleHealthTokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: creds.clientId,
      redirect_uri: getRedirectUri(),
      code_verifier: codeVerifier,
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
 * preserved by Google, so no `scope` param is re-sent. A revoked / expired
 * refresh token throws a `GoogleHealthApiError` classified `reauth_required`.
 */
export async function refreshAccessToken(
  refreshToken: string,
  creds: GoogleHealthCredentials,
): Promise<GoogleHealthTokenResponse> {
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
 * connection's `externalUserId`. A single GET, not a paginated collection.
 */
export interface GoogleHealthProfile {
  /**
   * External user identifier. Google returns `me`-relative profile data; the
   * stable id is surfaced under `name` (a `users/{id}` resource name) or `id`
   * depending on the API surface — both are captured here and resolved at the
   * call site. Re-verify the exact field against a live account at build.
   */
  name?: string;
  id?: string;
}

export async function fetchProfile(
  accessToken: string,
): Promise<GoogleHealthProfile> {
  const start = performance.now();
  const res = await safeFetch(`${GOOGLE_HEALTH_API_BASE}/users/me/profile`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res
    .json()
    .catch(() => null)) as GoogleHealthProfile | null;
  const verdict = classifyGoogleHealthResponse(res.status);
  getEvent()?.addExternalCall({
    service: "google-health",
    method: "fetchProfile",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new GoogleHealthApiError({
      verb: "fetchProfile",
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
    });
  }
  return (json ?? {}) as GoogleHealthProfile;
}

/**
 * Resolve the stable external user id from a Google Health profile. The
 * `users/{id}` resource name is the canonical anchor; fall back to a bare `id`
 * or "me" so the connection always persists a non-empty `externalUserId`.
 */
export function resolveGoogleHealthUserId(
  profile: GoogleHealthProfile,
): string {
  if (profile.name) {
    const tail = profile.name.split("/").pop();
    if (tail) return tail;
  }
  if (profile.id) return profile.id;
  return "me";
}

// ─── Data-point reads (Google Health `dataPoints.list` / `:dailyRollUp`) ──────
//
// The Google Health API exposes one uniform `DataPoint` resource shape across
// every data type. Spot / daily-summary / session types are read through
// `GET /v4/users/me/dataTypes/{dataType}/dataPoints` with `nextPageToken`
// pagination; the cumulative activity types (steps / distance / active energy /
// floors) are read through `POST …/dataPoints:dailyRollUp` — their `list`
// surface returns minute-grain observation buckets (or, for floors, does not
// exist at all), so the daily totals MUST come from the rollup.
//
// Casing gotcha (three encodings per type, all pinned in
// `GOOGLE_HEALTH_DATA_TYPES` so a fetcher can never mix them up):
//   - request path:      kebab-case  (`body-fat`)
//   - `filter` predicate: snake_case (`body_fat.sample_time.physical_time`)
//   - response payload:   camelCase — the `DataPoint` value is a union keyed by
//     the camelCase type name (`bodyFat`, `dailyRestingHeartRate`, …) with
//     camelCase nested objects (`sampleTime.physicalTime`,
//     `interval.startTime`, `civilStartTime.date`).
//
// proto3 int64 fields arrive as JSON **strings** (`"12345"`) — every numeric
// extractor coerces numeric strings before the finite check.

/**
 * Page-size ceiling for `dataPoints.list`. The daily/intraday reads default to
 * 1440 (one-per-minute) and cap at 10 000; sleep/exercise cap at 25. The launch
 * metrics use the daily/spot reads, so the default page size is the larger.
 */
export const GOOGLE_HEALTH_PAGE_SIZE = 1000;
/** Sleep/exercise read cap — matches the Google Health 25-cap for those types. */
export const GOOGLE_HEALTH_ACTIVITY_PAGE_SIZE = 25;

/**
 * One data type's on-the-wire encodings. `path` is the kebab-case segment
 * spliced into the request URL; `filter` is the snake_case prefix used to build
 * the incremental `filter=` predicate; `key` is the camelCase union key the
 * response payload nests the value object under. `timeField` names the read
 * method + time anchor.
 */
export interface GoogleHealthDataType {
  /** kebab-case segment for the request path. */
  path: string;
  /** snake_case prefix for the `filter` predicate. */
  filter: string;
  /** camelCase union key in the response `DataPoint` payload. */
  key: string;
  /**
   * Which read method + time anchor the type uses:
   *   - `sample`     → spot reading via list; filter
   *     `{filter}.sample_time.physical_time`, read `{key}.sampleTime.physicalTime`.
   *   - `date`       → daily summary via list; filter `{filter}.date`
   *     (`YYYY-MM-DD`), read `{key}.date` (a `{year,month,day}` object).
   *   - `sessionEnd` → sleep sessions via list; sleep filters ONLY on
   *     `{filter}.interval.end_time` (any other field 400s); anchor
   *     `{key}.interval.endTime`.
   *   - `civilStart` → exercise sessions via list; session types filter ONLY on
   *     `{filter}.interval.civil_start_time` with an offset-less civil bound;
   *     times read from `{key}.interval.startTime/endTime` (RFC-3339).
   *   - `rollup`     → cumulative daily totals via `POST :dailyRollUp`
   *     (`windowSizeDays: 1`); never listed. Day key `civilStartTime.date`.
   */
  timeField: "sample" | "date" | "sessionEnd" | "civilStart" | "rollup";
}

/**
 * The launch data types. Each entry pins the kebab-path + snake-filter +
 * camelCase-payload triple so the three encodings can never drift. Identifiers
 * reconciled against the official v4 reference (data-types index + per-type
 * schema pages).
 */
export const GOOGLE_HEALTH_DATA_TYPES = {
  weight: {
    path: "weight",
    filter: "weight",
    key: "weight",
    timeField: "sample",
  },
  bodyFat: {
    path: "body-fat",
    filter: "body_fat",
    key: "bodyFat",
    timeField: "sample",
  },
  // Daily-grain SpO2 lives on `daily-oxygen-saturation` (`averagePercentage`);
  // the bare `oxygen-saturation` type is per-SAMPLE and does not accept a
  // `.date` filter (400).
  oxygenSaturation: {
    path: "daily-oxygen-saturation",
    filter: "daily_oxygen_saturation",
    key: "dailyOxygenSaturation",
    timeField: "date",
  },
  // Nightly HRV summary lives on `daily-heart-rate-variability`; the bare
  // `heart-rate-variability` type is per-sample (RMSSD + SDNN fields) and does
  // not accept a `.date` filter.
  heartRateVariability: {
    path: "daily-heart-rate-variability",
    filter: "daily_heart_rate_variability",
    key: "dailyHeartRateVariability",
    timeField: "date",
  },
  restingHeartRate: {
    path: "daily-resting-heart-rate",
    filter: "daily_resting_heart_rate",
    key: "dailyRestingHeartRate",
    timeField: "date",
  },
  // `respiratory-rate` does not exist in the catalogue; the daily summary is
  // `daily-respiratory-rate` (`dailyRespiratoryRateBpm`).
  respiratoryRate: {
    path: "daily-respiratory-rate",
    filter: "daily_respiratory_rate",
    key: "dailyRespiratoryRate",
    timeField: "date",
  },
  heartRate: {
    path: "heart-rate",
    filter: "heart_rate",
    key: "heartRate",
    timeField: "sample",
  },
  height: {
    path: "height",
    filter: "height",
    key: "height",
    timeField: "sample",
  },
  // Skin temperature (`daily-sleep-temperature-derivations`) is intentionally
  // OMITTED: Google surfaces a nightly signed DEVIATION from baseline, not an
  // absolute reading — a future enhancement needing a signed-delta model, not an
  // absolute WRIST_TEMPERATURE row.
  // ── Activity bundle — daily cumulative totals ──────────────────
  // Scope: `googlehealth.activity_and_fitness.readonly`. Read through
  // `POST :dailyRollUp` with `windowSizeDays: 1`: the `list` surface returns
  // minute-grain observation buckets, NOT daily totals (and floors has no list
  // method at all). The externalId carries the `stats:` prefix so a re-fetched
  // day overwrites in place (mirrors the Apple-Health
  // `stats:<HK>:<YYYY-MM-DD>` daily-total overwrite contract).
  steps: { path: "steps", filter: "steps", key: "steps", timeField: "rollup" },
  distance: {
    path: "distance",
    filter: "distance",
    key: "distance",
    timeField: "rollup",
  },
  // Active energy — canonical id `active-energy-burned`; this is the ACTIVE
  // portion only, NOT `total-calories` (which folds in BMR).
  activeEnergy: {
    path: "active-energy-burned",
    filter: "active_energy_burned",
    key: "activeEnergyBurned",
    timeField: "rollup",
  },
  floors: {
    path: "floors",
    filter: "floors",
    key: "floors",
    timeField: "rollup",
  },
  // The daily VO2-max reading lives on `daily-vo2-max` (`vo2Max`); the bare
  // `vo2-max` type is per-sample and does not accept a `.date` filter.
  vo2Max: {
    path: "daily-vo2-max",
    filter: "daily_vo2_max",
    key: "dailyVo2Max",
    timeField: "date",
  },
  // ── Sleep bundle ───────────────────────────────────────────────
  // Scope: `googlehealth.sleep.readonly`. Sleep sessions filter ONLY on
  // `sleep.interval.end_time` / `.civil_end_time` — a start-time filter 400s.
  // Mapped to per-stage SLEEP_DURATION rows.
  sleep: {
    path: "sleep",
    filter: "sleep",
    key: "sleep",
    timeField: "sessionEnd",
  },
  // ── Exercise bundle ────────────────────────────────────────────
  // Scope: `googlehealth.activity_and_fitness.readonly`. Session types
  // (excluding sleep/ECG) filter ONLY on `interval.civil_start_time` with an
  // offset-less civil bound → a `Workout` row (NOT a Measurement).
  exercise: {
    path: "exercise",
    filter: "exercise",
    key: "exercise",
    timeField: "civilStart",
  },
} as const satisfies Record<string, GoogleHealthDataType>;

/** Google Health `DataPoint` — value object is type-keyed + carries a time anchor. */
export interface GoogleHealthDataPoint {
  [key: string]: unknown;
}

/** `dataPoints.list` envelope: `{ dataPoints, nextPageToken }`. */
interface GoogleHealthDataPointPage {
  dataPoints?: GoogleHealthDataPoint[];
  nextPageToken?: string | null;
}

interface DataPointQuery {
  /** Lower-bound incremental cursor; omitted on a full backfill. */
  start?: Date;
  /** Page size (defaults to `GOOGLE_HEALTH_PAGE_SIZE`). */
  pageSize?: number;
  /** Hard ceiling on pages walked (defence against a runaway cursor). */
  maxPages?: number;
  /**
   * The user's IANA zone — needed only by the `civilStart` filter (the
   * offset-less civil bound must be the watermark's wall clock in the USER'S
   * zone). Omitted → the bound forms in UTC.
   */
  tz?: string;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Format a UTC instant as the offset-less civil wall clock an observer in `tz`
 * reads at that moment (`YYYY-MM-DDTHH:MM:SS`, no `Z`, no offset) — the bound
 * format the session `civil_start_time` filter expects. Without `tz` the bound
 * forms in UTC.
 */
export function formatCivilBound(instant: Date, tz?: string): string {
  if (!tz) return instant.toISOString().slice(0, 19);
  const p = wallClockInTz(instant, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

/**
 * Build the incremental `filter` field + bound for one list-read data type.
 * Centralised so the predicate and the read-time anchor resolution can never
 * drift. The legal filter fields are per-shape (anything else 400s):
 *   - `sample`     → `{filter}.sample_time.physical_time` (RFC-3339).
 *   - `date`       → `{filter}.date` (`YYYY-MM-DD`).
 *   - `sessionEnd` → sleep only: `{filter}.interval.end_time` (RFC-3339) — the
 *     ONLY filterable time field on sleep; watermark semantics improve too (a
 *     night is fetched when it ENDS after the cursor).
 *   - `civilStart` → exercise: `{filter}.interval.civil_start_time` with an
 *     offset-less civil bound in the user's zone.
 * `rollup` types never build a list filter — they read via `:dailyRollUp`.
 */
export function incrementalFilter(
  dataType: GoogleHealthDataType,
  start: Date,
  tz?: string,
): { field: string; bound: string } {
  switch (dataType.timeField) {
    case "sample":
      return {
        field: `${dataType.filter}.sample_time.physical_time`,
        bound: start.toISOString(),
      };
    case "sessionEnd":
      return {
        field: `${dataType.filter}.interval.end_time`,
        bound: start.toISOString(),
      };
    case "civilStart":
      return {
        field: `${dataType.filter}.interval.civil_start_time`,
        bound: formatCivilBound(start, tz),
      };
    case "date":
      return {
        field: `${dataType.filter}.date`,
        bound: start.toISOString().slice(0, 10),
      };
    case "rollup":
      throw new Error(
        `Google Health data type ${dataType.path} reads via :dailyRollUp, not dataPoints.list`,
      );
  }
}

/**
 * Walk every `DataPoint` for one data type since the incremental cursor via
 * `dataPoints.list` with `nextPageToken` pagination. The data-type id is
 * kebab-cased in the path; the `filter` predicate is built from the snake_case
 * form against the type's time anchor. `rollup` types refuse — they read via
 * `fetchDailyRollUp`.
 */
export async function fetchDataPoints(
  dataType: GoogleHealthDataType,
  accessToken: string,
  verb: string,
  query: DataPointQuery = {},
): Promise<GoogleHealthDataPoint[]> {
  const points: GoogleHealthDataPoint[] = [];
  let pageToken: string | null | undefined;
  let pageCount = 0;
  const maxPages = query.maxPages ?? 1000;
  const pageSize = query.pageSize ?? GOOGLE_HEALTH_PAGE_SIZE;

  do {
    const params = new URLSearchParams({ pageSize: String(pageSize) });
    if (query.start) {
      const { field, bound } = incrementalFilter(
        dataType,
        query.start,
        query.tz,
      );
      params.set("filter", `${field} >= "${bound}"`);
    }
    if (pageToken) params.set("pageToken", pageToken);

    const pageStart = performance.now();
    const res = await safeFetch(
      `${GOOGLE_HEALTH_API_BASE}/users/me/dataTypes/${dataType.path}/dataPoints?${params}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    const json = (await res
      .json()
      .catch(() => null)) as GoogleHealthDataPointPage | null;
    const verdict = classifyGoogleHealthResponse(res.status);
    getEvent()?.addExternalCall({
      service: "google-health",
      method: `${verb}(page=${pageCount})`,
      duration_ms: Math.round(performance.now() - pageStart),
      status: res.status,
      error: verdict.classification === "success" ? undefined : verdict.reason,
    });
    if (verdict.classification !== "success") {
      throw new GoogleHealthApiError({
        verb,
        classification: verdict.classification,
        httpStatus: verdict.httpStatus,
        reason: verdict.reason,
      });
    }

    for (const p of json?.dataPoints ?? []) points.push(p);
    pageToken = json?.nextPageToken ?? null;
    pageCount += 1;
  } while (pageToken && pageCount < maxPages);

  return points;
}

// ─── Daily roll-up reads (`POST …/dataPoints:dailyRollUp`) ─────────────────

/** Max civil days one dailyRollUp request range may span (per the v4 docs). */
export const GOOGLE_HEALTH_ROLLUP_RANGE_DAYS = 90;

/**
 * Full-sync horizon for the rollup types, in civil days. The rollup read needs
 * an explicit range (unlike the unbounded list walk), so the backfill is
 * pinned: 5 years ≈ 21 chunks per type — bounded, and deeper than any
 * wearable-history horizon the dashboard reads.
 */
export const GOOGLE_HEALTH_ROLLUP_BACKFILL_DAYS = 5 * 365;

/** A civil calendar date (1-based month), the dailyRollUp range unit. */
export interface GoogleHealthCivilDate {
  year: number;
  month: number;
  day: number;
}

/** The civil date an observer in `tz` reads at `instant` (UTC without `tz`). */
export function civilDateInTz(
  instant: Date,
  tz?: string,
): GoogleHealthCivilDate {
  if (!tz) {
    return {
      year: instant.getUTCFullYear(),
      month: instant.getUTCMonth() + 1,
      day: instant.getUTCDate(),
    };
  }
  const p = wallClockInTz(instant, tz);
  return { year: p.year, month: p.month, day: p.day };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function civilToUtcMs(d: GoogleHealthCivilDate): number {
  return Date.UTC(d.year, d.month - 1, d.day);
}

function utcMsToCivil(ms: number): GoogleHealthCivilDate {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/**
 * Split a closed-open civil range into ≤`maxDays` closed-open chunks — the
 * dailyRollUp request range caps at 90 days, so a multi-year backfill walks the
 * range in slices. Returns an empty list when `start >= end`.
 */
export function chunkCivilRange(
  start: GoogleHealthCivilDate,
  endExclusive: GoogleHealthCivilDate,
  maxDays: number = GOOGLE_HEALTH_ROLLUP_RANGE_DAYS,
): Array<{ start: GoogleHealthCivilDate; end: GoogleHealthCivilDate }> {
  const s = civilToUtcMs(start);
  const e = civilToUtcMs(endExclusive);
  const out: Array<{
    start: GoogleHealthCivilDate;
    end: GoogleHealthCivilDate;
  }> = [];
  for (let cur = s; cur < e; cur += maxDays * DAY_MS) {
    const chunkEnd = Math.min(cur + maxDays * DAY_MS, e);
    out.push({ start: utcMsToCivil(cur), end: utcMsToCivil(chunkEnd) });
  }
  return out;
}

/**
 * One dailyRollUp aggregate window: `civilStartTime`/`civilEndTime` are
 * CivilDateTime objects (`{date:{year,month,day}, time:{…}}`), the value is a
 * union keyed by the camelCase type name carrying the `*Sum` rollup fields
 * (`steps.countSum`, `distance.millimetersSum`, `activeEnergyBurned.kcalSum`,
 * `floors.countSum` — int64 sums arrive as JSON strings).
 */
export interface GoogleHealthRollupPoint {
  [key: string]: unknown;
}

/** `dataPoints:dailyRollUp` envelope. */
interface GoogleHealthRollupPage {
  rollupDataPoints?: GoogleHealthRollupPoint[];
  nextPageToken?: string | null;
}

interface RollupQuery {
  /** Lower-bound incremental cursor; a full backfill walks the pinned horizon. */
  start?: Date;
  /** The user's IANA zone — the civil range is user-local. */
  tz?: string;
}

/**
 * Read one cumulative data type's daily totals via `POST …/dataPoints:dailyRollUp`
 * with `windowSizeDays: 1`. The civil range is closed-open and user-local,
 * chunked at ≤90 days per request; without an incremental `start` the walk
 * covers the pinned backfill horizon. A `nextPageToken` is honoured defensively
 * (the response is documented without one, but the request accepts page
 * tokens).
 */
export async function fetchDailyRollUp(
  dataType: GoogleHealthDataType,
  accessToken: string,
  verb: string,
  query: RollupQuery = {},
): Promise<GoogleHealthRollupPoint[]> {
  const now = new Date();
  const from =
    query.start ??
    new Date(now.getTime() - GOOGLE_HEALTH_ROLLUP_BACKFILL_DAYS * DAY_MS);
  // End exclusive at tomorrow (user-local) so today's running total is covered.
  const startCivil = civilDateInTz(from, query.tz);
  const endCivil = civilDateInTz(new Date(now.getTime() + DAY_MS), query.tz);

  const points: GoogleHealthRollupPoint[] = [];
  let chunkIndex = 0;
  for (const chunk of chunkCivilRange(startCivil, endCivil)) {
    let pageToken: string | null | undefined;
    let pageCount = 0;
    do {
      const body: Record<string, unknown> = {
        range: {
          start: { date: chunk.start },
          end: { date: chunk.end },
        },
        windowSizeDays: 1,
        pageSize: 100,
      };
      if (pageToken) body.pageToken = pageToken;

      const reqStart = performance.now();
      const res = await safeFetch(
        `${GOOGLE_HEALTH_API_BASE}/users/me/dataTypes/${dataType.path}/dataPoints:dailyRollUp`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      const json = (await res
        .json()
        .catch(() => null)) as GoogleHealthRollupPage | null;
      const verdict = classifyGoogleHealthResponse(res.status);
      getEvent()?.addExternalCall({
        service: "google-health",
        method: `${verb}(chunk=${chunkIndex},page=${pageCount})`,
        duration_ms: Math.round(performance.now() - reqStart),
        status: res.status,
        error:
          verdict.classification === "success" ? undefined : verdict.reason,
      });
      if (verdict.classification !== "success") {
        throw new GoogleHealthApiError({
          verb,
          classification: verdict.classification,
          httpStatus: verdict.httpStatus,
          reason: verdict.reason,
        });
      }

      for (const p of json?.rollupDataPoints ?? []) points.push(p);
      pageToken = json?.nextPageToken ?? null;
      pageCount += 1;
    } while (pageToken && pageCount < 100);
    chunkIndex += 1;
  }

  return points;
}

// ─── Field → Measurement mapping ───────────────────────────────
// The single source of truth is `mapping.md` — keep both in sync when adding
// entries.

/** Metres → centimetres (Google `height` → `User.heightCm`). */
const M_TO_CM = 100;

function round2(n: number): number {
  return parseFloat(n.toFixed(2));
}

/**
 * Coerce a raw payload value to a finite number, or null. proto3 int64 fields
 * arrive as JSON strings (`"12345"`); `Number()` handles both int and decimal
 * strings, guarded by a finite check (empty / whitespace strings coerce to 0
 * via `Number("")` — reject them explicitly).
 */
function coerceNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * A single mapped reading destined for one `Measurement` row. The `source`
 * (`GOOGLE_HEALTH`) and `externalId` (`<anchor>:<fieldTag>`) are stamped by the
 * sync layer; the mapper emits only type/value/unit/measuredAt + the field-tag
 * that disambiguates the externalId.
 */
export interface GoogleHealthMappedMeasurement {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  /** Disambiguator appended to the per-point anchor to form the externalId. */
  fieldTag: string;
  /** Per-stage sleep rows carry the SleepStage; everything else omits it. */
  sleepStage?: GoogleHealthSleepStage;
  /**
   * `true` when the externalId carries the `stats:` daily-total prefix (the
   * cumulative activity metrics). The sync layer stamps the externalId; this
   * flag lets it pick the right shape (`stats:<type-tag>:<YYYY-MM-DD>` vs the
   * `<anchor>:<fieldTag>` spot shape) without re-deriving the grain.
   */
  cumulativeDaily?: boolean;
}

/** HealthLog `SleepStage` values a Google sleep stage maps onto. */
export type GoogleHealthSleepStage =
  "IN_BED" | "AWAKE" | "ASLEEP" | "REM" | "CORE" | "DEEP";

/**
 * Pull the first finite STRICTLY-POSITIVE number out of a list of candidate
 * value paths on a `DataPoint`, coercing int64 JSON strings. The launch metrics
 * (weight, body-fat, SpO2, HRV, RHR, respiratory rate, HR, height, VO2 max) are
 * all strictly positive — a zero is a garbage/empty reading and is dropped.
 */
function firstNumber(
  point: GoogleHealthDataPoint,
  paths: string[],
): number | null {
  for (const path of paths) {
    const n = coerceNumber(readPath(point, path));
    if (n !== null && n > 0) return n;
  }
  return null;
}

/** Resolve a dotted path against a nested object; undefined on any miss. */
function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Parse a `{year,month,day}` civil-date object into a UTC-midday Date, or null. */
function parseCivilDateObject(val: unknown): Date | null {
  if (!val || typeof val !== "object") return null;
  const o = val as Record<string, unknown>;
  if (
    typeof o.year === "number" &&
    typeof o.month === "number" &&
    typeof o.day === "number"
  ) {
    // Google civil dates are 1-based months; anchor at UTC midday so a timezone
    // shift can't roll the civil day across a boundary.
    return new Date(Date.UTC(o.year, o.month - 1, o.day, 12));
  }
  return null;
}

/**
 * Parse a Google civil START anchor — the calendar day a cumulative daily total
 * belongs to — into a UTC-midday Date, or null. Accepts a `{year,month,day}`
 * object OR a civil string (`YYYY-MM-DD`, optionally carrying a time suffix like
 * `2026-06-02T00:00:00`); only the Y-M-D is kept, anchored at UTC midday so a
 * timezone shift can't roll the civil day. Mirrors the Fitbit `parseCivilDate`
 * UTC-midday convention.
 */
function parseCivilStart(val: unknown): Date | null {
  if (typeof val === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(val.trim());
    if (!m) return null;
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  }
  return parseCivilDateObject(val);
}

/**
 * Matches an offset-less local ISO wall-clock string (`2026-06-02T03:02:30` /
 * `...T03:02:30.000`). No trailing `Z`, no `±hh:mm` — those denote an absolute
 * instant and are honoured verbatim.
 */
const OFFSET_LESS_LOCAL_ISO =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

/**
 * Parse a Google timestamp into a UTC instant. Sleep segments + exercise
 * sessions can emit LOCAL wall-clock strings WITHOUT an offset — the night /
 * session belongs to the user's local clock, so an offset-less string is
 * resolved against the USER'S timezone, not the process zone (a bare
 * `new Date(iso)` parses an offset-less string in the host zone, which shifts a
 * non-UTC user by their offset and can flip a near-midnight wake-day). When `tz`
 * is omitted the host-local fallback preserves the prior behaviour. Strings that
 * DO carry an offset/`Z` are absolute and parsed as-is. Mirrors the Fitbit
 * `parseLocalInstant`. Returns null on a miss.
 */
function parseLocalInstant(iso: string, tz?: string): Date | null {
  const m = OFFSET_LESS_LOCAL_ISO.exec(iso.trim());
  if (m) {
    return zonedWallClockToUtc(
      {
        year: Number(m[1]),
        month: Number(m[2]),
        day: Number(m[3]),
        hour: Number(m[4]),
        minute: Number(m[5]),
        second: m[6] ? Number(m[6]) : 0,
      },
      tz,
    );
  }
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve a `DataPoint`'s measurement timestamp. The read paths are camelCase —
 * the response payload nests the value union under the camelCase type name with
 * camelCase time objects (the snake_case forms exist only inside the request
 * `filter` parameter).
 *   - `sample` → `{key}.sampleTime.physicalTime` (a spot instant; offset-less
 *     strings resolve against `tz`).
 *   - `date`   → `{key}.date` (a `{year,month,day}` object, or a civil string) —
 *     anchored at UTC-midday so a tz shift can't roll the civil day.
 * Falls back to `fallback` only when nothing parses, so a row is never dropped
 * for a missing anchor. (Sleep / exercise sessions and the rollup types anchor
 * through their own helpers, never here.)
 */
function resolveMeasuredAt(
  point: GoogleHealthDataPoint,
  dataType: GoogleHealthDataType,
  fallback: Date,
  tz?: string,
): Date {
  if (dataType.timeField === "sample") {
    const t = readPath(point, `${dataType.key}.sampleTime.physicalTime`);
    if (typeof t === "string") {
      const d = parseLocalInstant(t, tz);
      if (d) return d;
    }
  } else if (dataType.timeField === "date") {
    const dateVal = readPath(point, `${dataType.key}.date`);
    const civil = parseCivilStart(dateVal);
    if (civil) return civil;
  }
  return fallback;
}

/**
 * Stable anchor for a `DataPoint`'s externalId. A spot reading anchors on its
 * sample time; a daily summary on its civil date. Combined with a type-specific
 * field-tag this makes the upsert key idempotent across re-fetches.
 */
function externalAnchor(
  point: GoogleHealthDataPoint,
  dataType: GoogleHealthDataType,
  tz?: string,
): string {
  const at = resolveMeasuredAt(point, dataType, new Date(0), tz);
  // Daily summaries share the civil-day externalId grain so a re-fetched day
  // overwrites in place. (Sleep/exercise sessions and the rollup daily totals
  // mint their own anchors and never reach this helper.)
  if (dataType.timeField === "date") {
    return at.toISOString().slice(0, 10);
  }
  return at.toISOString();
}

/**
 * Map one data point of a simple single-value metric into a Measurement
 * reading. `valuePaths` lists the candidate value shapes; the first
 * finite-positive hit wins. Returns an empty array when no value parses.
 */
function mapSimple(
  point: GoogleHealthDataPoint,
  dataType: GoogleHealthDataType,
  spec: {
    type: string;
    unit: string;
    fieldTag: string;
    valuePaths: string[];
    factor?: number;
  },
): GoogleHealthMappedMeasurement[] {
  let value = firstNumber(point, spec.valuePaths);
  if (value === null) return [];
  if (spec.factor) value = value * spec.factor;
  return [
    {
      type: spec.type,
      value: round2(value),
      unit: spec.unit,
      measuredAt: resolveMeasuredAt(point, dataType, new Date()),
      fieldTag: `${externalAnchor(point, dataType)}:${spec.fieldTag}`,
    },
  ];
}

export function mapWeight(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.weight;
  // Documented field is `weightGrams` (grams) → kg.
  return mapSimple(point, dt, {
    type: "WEIGHT",
    unit: "kg",
    fieldTag: "weight",
    valuePaths: [`${dt.key}.weightGrams`],
    factor: 0.001,
  });
}

export function mapBodyFat(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.bodyFat;
  return mapSimple(point, dt, {
    type: "BODY_FAT",
    unit: "%",
    fieldTag: "body_fat",
    valuePaths: [`${dt.key}.percentage`],
  });
}

export function mapOxygenSaturation(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.oxygenSaturation;
  return mapSimple(point, dt, {
    type: "OXYGEN_SATURATION",
    unit: "%",
    fieldTag: "spo2",
    valuePaths: [`${dt.key}.averagePercentage`],
  });
}

export function mapHeartRateVariability(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.heartRateVariability;
  // The daily field is an unlabelled "average HRV ms". Per the design decision
  // it lands in the SDNN-lineage `HEART_RATE_VARIABILITY` slot
  // (Apple-comparable), NOT WHOOP's `HRV_RMSSD` (reserved for the WHOOP-native
  // estimator). The per-sample type carries explicit RMSSD + SDNN fields —
  // re-confirm the estimator against live data and revisit if warranted.
  return mapSimple(point, dt, {
    type: "HEART_RATE_VARIABILITY",
    unit: "ms",
    fieldTag: "hrv",
    valuePaths: [`${dt.key}.averageHeartRateVariabilityMilliseconds`],
  });
}

export function mapRestingHeartRate(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.restingHeartRate;
  // `beatsPerMinute` is an int64 JSON string — coerced by the extractor.
  return mapSimple(point, dt, {
    type: "RESTING_HEART_RATE",
    unit: "bpm",
    fieldTag: "rhr",
    valuePaths: [`${dt.key}.beatsPerMinute`],
  });
}

export function mapRespiratoryRate(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.respiratoryRate;
  // `dailyRespiratoryRateBpm` is an int64 JSON string.
  return mapSimple(point, dt, {
    type: "RESPIRATORY_RATE",
    unit: "breaths/min",
    fieldTag: "resp_rate",
    valuePaths: [`${dt.key}.dailyRespiratoryRateBpm`],
  });
}

export function mapHeartRate(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.heartRate;
  // `beatsPerMinute` is an int64 JSON string.
  return mapSimple(point, dt, {
    type: "PULSE",
    unit: "bpm",
    fieldTag: "hr",
    valuePaths: [`${dt.key}.beatsPerMinute`],
  });
}

/** One extracted `height` sample: centimetres + the sample instant (if any). */
export interface GoogleHealthHeightSample {
  cm: number;
  sampledAt: Date | null;
}

/**
 * Extract the profile height from a Google `height` data point, or null when
 * nothing parses. Height is a one-time `User.heightCm` profile seed (written
 * only when the user has no height yet) — NOT a Measurement. The documented
 * field is `heightMeters` (metres) → cm. `sampledAt` lets the caller pick the
 * LATEST sample explicitly — list responses are ordered DESCENDING, so
 * "last row wins" would pick the OLDEST.
 */
export function mapHeight(
  point: GoogleHealthDataPoint,
): GoogleHealthHeightSample | null {
  const dt = GOOGLE_HEALTH_DATA_TYPES.height;
  const m = firstNumber(point, [`${dt.key}.heightMeters`]);
  if (m === null) return null;
  const t = readPath(point, `${dt.key}.sampleTime.physicalTime`);
  const sampledAt = typeof t === "string" ? parseLocalInstant(t) : null;
  return { cm: round2(m * M_TO_CM), sampledAt };
}

// ─── Activity mappers: daily roll-up totals ────────────────────

/**
 * Pull the first finite NON-negative number out of a list of candidate value
 * paths, coercing int64 JSON strings. Unlike `firstNumber` (strictly positive),
 * this admits a legitimate zero — a day of rest still records 0 steps /
 * 0 floors / 0 active kcal, and dropping the zero would leave a hole the chart
 * misreads as missing data.
 */
function firstNonNegativeNumber(
  point: GoogleHealthDataPoint,
  paths: string[],
): number | null {
  for (const path of paths) {
    const n = coerceNumber(readPath(point, path));
    if (n !== null && n >= 0) return n;
  }
  return null;
}

/**
 * Map one `dailyRollUp` aggregate window (`windowSizeDays: 1`) into a single
 * daily-total Measurement reading. The day key comes from the window's
 * `civilStartTime.date` (a `{year,month,day}` object), anchored at UTC-midday
 * per the shared civil-day convention; a window with no parseable civil day is
 * dropped (it cannot be keyed). The externalId is the `stats:`-prefixed
 * daily-total shape so a re-fetched day overwrites in place — the same
 * overwrite contract the Apple-Health `stats:<HK>:<YYYY-MM-DD>` daily totals
 * use. A zero is preserved (a rest day is real data, not a gap).
 */
function mapDailyRollup(
  point: GoogleHealthRollupPoint,
  spec: {
    type: string;
    unit: string;
    fieldTag: string;
    valuePaths: string[];
    factor?: number;
  },
): GoogleHealthMappedMeasurement[] {
  const day =
    parseCivilDateObject(readPath(point, "civilStartTime.date")) ??
    parseCivilStart(readPath(point, "civilStartTime"));
  if (!day) return [];
  let value = firstNonNegativeNumber(point, spec.valuePaths);
  if (value === null) return [];
  if (spec.factor) value = value * spec.factor;
  const dayKey = day.toISOString().slice(0, 10);
  return [
    {
      type: spec.type,
      value: round2(value),
      unit: spec.unit,
      measuredAt: day,
      // `stats:<type-tag>:<YYYY-MM-DD>` — the sync layer reads `cumulativeDaily`
      // to assemble the externalId, matching the Apple-Health daily-total shape.
      fieldTag: `${spec.fieldTag}:${dayKey}`,
      cumulativeDaily: true,
    },
  ];
}

export function mapSteps(
  point: GoogleHealthRollupPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.steps;
  // `countSum` is an int64 JSON string.
  return mapDailyRollup(point, {
    type: "ACTIVITY_STEPS",
    unit: "steps",
    fieldTag: "steps",
    valuePaths: [`${dt.key}.countSum`],
  });
}

export function mapDistance(
  point: GoogleHealthRollupPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.distance;
  // `millimetersSum` is an int64 JSON string → metres.
  return mapDailyRollup(point, {
    type: "WALKING_RUNNING_DISTANCE",
    unit: "m",
    fieldTag: "distance",
    valuePaths: [`${dt.key}.millimetersSum`],
    factor: 0.001,
  });
}

export function mapActiveEnergy(
  point: GoogleHealthRollupPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.activeEnergy;
  // ACTIVE energy only — NOT total-calories (which folds in BMR).
  return mapDailyRollup(point, {
    type: "ACTIVE_ENERGY_BURNED",
    unit: "kcal",
    fieldTag: "active_energy",
    valuePaths: [`${dt.key}.kcalSum`],
  });
}

export function mapFloors(
  point: GoogleHealthRollupPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.floors;
  // `countSum` is an int64 JSON string.
  return mapDailyRollup(point, {
    type: "FLIGHTS_CLIMBED",
    unit: "flights",
    fieldTag: "floors",
    valuePaths: [`${dt.key}.countSum`],
  });
}

/**
 * Map one `daily-vo2-max` summary into a VO2_MAX reading. A daily latest-wins
 * metric (one civil-date reading, strictly positive — not a running sum), read
 * via list with a `.date` filter; it keeps the `stats:`-style per-day overwrite
 * key so a re-rolled day replaces in place.
 */
export function mapVo2Max(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.vo2Max;
  const value = firstNumber(point, [`${dt.key}.vo2Max`]);
  if (value === null) return [];
  const measuredAt = resolveMeasuredAt(point, dt, new Date());
  return [
    {
      type: "VO2_MAX",
      value: round2(value),
      unit: "mL/(kg·min)",
      measuredAt,
      fieldTag: `vo2_max:${externalAnchor(point, dt)}`,
      cumulativeDaily: true,
    },
  ];
}

// ── Sleep ──────────────────────────────────────────────────────
//
// A Google Health sleep session carries a list of per-stage segments, each with
// a stage label + a start + end. HealthLog stores one SLEEP_DURATION row per
// stage segment with `measuredAt = stage END` (so the night-total + hypnogram
// readers consume the same enum WHOOP / Apple write). The stage labels are
// harmonised onto the shared `SleepStage` enum.

/** Google Health sleep stage label → HealthLog `SleepStage`. */
const GOOGLE_HEALTH_SLEEP_STAGE_MAP: Record<string, GoogleHealthSleepStage> = {
  // Canonical Google Health stage names (snake / lower variants accepted).
  in_bed: "IN_BED",
  inbed: "IN_BED",
  awake: "AWAKE",
  wake: "AWAKE",
  light: "CORE", // "light" ↔ Apple "core" (same shallow-NREM band)
  core: "CORE",
  rem: "REM",
  deep: "DEEP",
  // The classic (non-stages) sleep log uses asleep/restless/wake.
  asleep: "ASLEEP",
  restless: "AWAKE",
} as const;

/**
 * Normalise a raw Google sleep-stage label to a `SleepStage`, or null for an
 * unknown label (skipped rather than mis-bucketed).
 */
export function mapGoogleHealthSleepStage(
  raw: unknown,
): GoogleHealthSleepStage | null {
  if (typeof raw !== "string") return null;
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return (
    GOOGLE_HEALTH_SLEEP_STAGE_MAP[key] ??
    GOOGLE_HEALTH_SLEEP_STAGE_MAP[key.replace(/_/g, "")] ??
    null
  );
}

/** One sleep-stage segment pulled defensively off a Google sleep session. */
interface GoogleHealthSleepSegment {
  stage: string;
  startTime?: string;
  endTime?: string;
}

/** Minutes between two ISO instants, or null if either is unparseable. */
function minutesBetween(startIso?: string, endIso?: string): number | null {
  if (!startIso || !endIso) return null;
  const s = new Date(startIso).getTime();
  const e = new Date(endIso).getTime();
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return null;
  return (e - s) / 60_000;
}

/**
 * Read the per-stage segments off a Google sleep `DataPoint`. Documented shape:
 * `sleep.stages` is an array of
 * `{ startTime, startUtcOffset, endTime, endUtcOffset, type }` where `type` is
 * the `SLEEP_STAGE_TYPE` enum (`AWAKE | LIGHT | DEEP | REM | ASLEEP | RESTLESS
 * | SLEEP_STAGE_TYPE_UNSPECIFIED`) and the times are RFC-3339 Timestamps.
 */
function readSleepSegments(
  point: GoogleHealthDataPoint,
): GoogleHealthSleepSegment[] {
  const stages = readPath(point, "sleep.stages");
  if (!Array.isArray(stages)) return [];
  const out: GoogleHealthSleepSegment[] = [];
  for (const raw of stages) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const stage = typeof o.type === "string" ? o.type : "";
    const startTime = typeof o.startTime === "string" ? o.startTime : undefined;
    const endTime = typeof o.endTime === "string" ? o.endTime : undefined;
    if (stage) out.push({ stage, startTime, endTime });
  }
  return out;
}

/**
 * The stable session anchor for a sleep `DataPoint`'s externalId. The session
 * end (or start) ISO instant is unique per night, so per-stage rows key as
 * `<session-anchor>:sleep_<stage>` — a re-scored night overwrites in place.
 * Paths are camelCase (`sleep.interval.endTime`) — the response payload never
 * uses snake_case.
 */
function sleepSessionAnchor(point: GoogleHealthDataPoint, tz?: string): string {
  const end = readPath(point, "sleep.interval.endTime");
  if (typeof end === "string") {
    const d = parseLocalInstant(end, tz);
    if (d) return d.toISOString();
  }
  const start = readPath(point, "sleep.interval.startTime");
  if (typeof start === "string") {
    const d = parseLocalInstant(start, tz);
    if (d) return d.toISOString();
  }
  return new Date(0).toISOString();
}

/**
 * Map one Google sleep session into per-SEGMENT `SLEEP_DURATION` rows. The
 * Google sleep payload carries a real per-stage segment series (each with its
 * own start/end), so one row is emitted PER SEGMENT — `measuredAt = that
 * segment's END` — rather than collapsing a stage's segments onto a single
 * lastEnd instant. The timeline is MEASURED (real onsets), so these rows are NOT
 * flagged reconstructed — unlike WHOOP, which has no onsets.
 *
 * Each segment carries a stage-scoped, INDEXED fieldTag so the several segments
 * of one stage stay distinct under the `(userId, type, source, externalId)`
 * dedup key. Unknown stage labels are skipped; a session with no parseable
 * segment yields nothing.
 *
 * Segment timestamps can arrive OFFSET-LESS (local wall clock); `tz` (the user's
 * stored zone) anchors them to the correct UTC instant rather than the process
 * zone — without it a non-UTC user's near-midnight segment END would shift by
 * their offset. Timestamps carrying an explicit offset/`Z` are honoured as-is.
 */
export function mapSleepSession(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const segments = readSleepSegments(point);
  if (segments.length === 0) return [];

  const anchor = sleepSessionAnchor(point, tz);
  const out: GoogleHealthMappedMeasurement[] = [];
  let segIndex = 0;
  for (const seg of segments) {
    const stage = mapGoogleHealthSleepStage(seg.stage);
    if (!stage) continue;
    const mins = minutesBetween(seg.startTime, seg.endTime);
    if (mins === null || !(mins > 0)) continue;
    const end = parseLocalInstant(seg.endTime as string, tz);
    if (!end) continue;
    out.push({
      type: "SLEEP_DURATION",
      value: round2(mins),
      unit: "minutes",
      measuredAt: end,
      fieldTag: `${anchor}:sleep_${stage.toLowerCase()}:${segIndex}`,
      sleepStage: stage,
    });
    segIndex += 1;
  }
  return out;
}

// ── Workouts (exercise sessions) ───────────────────────────────

/**
 * Google Health `Exercise.exerciseType` → HealthLog `WorkoutSportType`. The
 * enum arrives UPPERCASE (`RUNNING`, `STRENGTH_TRAINING`, …); the resolver
 * lowercases + underscores before the lookup, so the keys here are the
 * normalised forms. Unknown types fall through to a generic label; the column
 * is free-text so an unmapped type still persists (just not under a canonical
 * sport bucket).
 */
const GOOGLE_HEALTH_EXERCISE_TYPE_MAP: Record<string, string> = {
  walk: "walking",
  walking: "walking",
  run: "running",
  running: "running",
  treadmill: "running",
  treadmill_running: "running",
  bike: "cycling",
  biking: "cycling",
  cycling: "cycling",
  spinning: "cycling",
  mountain_biking: "cycling",
  hike: "hiking",
  hiking: "hiking",
  swim: "swimming",
  swimming: "swimming",
  rowing: "rowing",
  elliptical: "elliptical",
  stairclimber: "stairClimber",
  stair_climbing: "stairClimber",
  yoga: "yoga",
  pilates: "mindAndBody",
  weights: "strength",
  strength: "strength",
  strength_training: "strength",
  weightlifting: "strength",
  workout: "strength",
  hiit: "hiit",
  high_intensity_interval_training: "hiit",
  interval_workout: "hiit",
  interval_training: "hiit",
  dance: "dance",
  dancing: "dance",
  golf: "golf",
  tennis: "tennis",
  basketball: "basketball",
  soccer: "soccer",
  football: "soccer",
  bootcamp: "crossTraining",
  circuit_training: "crossTraining",
  sport: "mixedCardio",
} as const;

/** Resolve a Google exercise activity type to a canonical sport label. */
export function mapGoogleHealthSportType(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") return "other";
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return (
    GOOGLE_HEALTH_EXERCISE_TYPE_MAP[key] ??
    GOOGLE_HEALTH_EXERCISE_TYPE_MAP[key.replace(/_/g, "")] ??
    "other"
  );
}

/** One mapped Google exercise session destined for a `Workout` row. */
export interface GoogleHealthMappedWorkout {
  externalId: string;
  sportType: string;
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
  totalEnergyKcal: number | null;
  totalDistanceM: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  minHeartRate: number | null;
}

/**
 * Read a finite number off a list of candidate paths (any sign), coercing int64
 * JSON strings, or null.
 */
function readNumber(
  point: GoogleHealthDataPoint,
  paths: string[],
): number | null {
  for (const path of paths) {
    const n = coerceNumber(readPath(point, path));
    if (n !== null) return n;
  }
  return null;
}

/**
 * Read an instant off a list of candidate paths, or null. Offset-less strings
 * resolve against `tz` (the user's stored zone) rather than the process zone;
 * strings carrying an explicit offset/`Z` are honoured as-is.
 */
function readInstant(
  point: GoogleHealthDataPoint,
  paths: string[],
  tz?: string,
): Date | null {
  for (const path of paths) {
    const v = readPath(point, path);
    if (typeof v === "string") {
      const d = parseLocalInstant(v, tz);
      if (d) return d;
    }
  }
  return null;
}

/**
 * Map one Google exercise session `DataPoint` into a `Workout` shape. Returns
 * null when there is no usable start/end (a session with no time span is not a
 * workout).
 *
 * Documented payload: `exercise.interval.startTime/endTime` (RFC-3339),
 * `exercise.exerciseType` (UPPERCASE enum), and
 * `exercise.metricsSummary.{caloriesKcal, distanceMillimeters,
 * averageHeartRateBeatsPerMinute (int64 string), …}`. There is no session-id
 * field — the DataPoint's top-level `name` (a resource name) is the stable id;
 * the start instant is the fallback. metricsSummary carries no max/min HR →
 * null.
 *
 * Session start/end can arrive OFFSET-LESS (local wall clock); `tz` anchors
 * them to the correct UTC instant rather than the process zone.
 */
export function mapWorkout(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedWorkout | null {
  const k = GOOGLE_HEALTH_DATA_TYPES.exercise.key;
  const startedAt = readInstant(point, [`${k}.interval.startTime`], tz);
  const endedAt = readInstant(point, [`${k}.interval.endTime`], tz);
  if (!startedAt || !endedAt || endedAt <= startedAt) return null;

  const durationSec = Math.round(
    (endedAt.getTime() - startedAt.getTime()) / 1000,
  );

  const name = readPath(point, "name");
  const externalId =
    typeof name === "string" && name !== ""
      ? name
      : `exercise:${startedAt.toISOString()}`;

  const sportRaw = readPath(point, `${k}.exerciseType`);

  const energyKcal = readNumber(point, [`${k}.metricsSummary.caloriesKcal`]);
  const distanceMm = readNumber(point, [
    `${k}.metricsSummary.distanceMillimeters`,
  ]);
  const avgHr = readNumber(point, [
    `${k}.metricsSummary.averageHeartRateBeatsPerMinute`,
  ]);

  return {
    externalId,
    sportType: mapGoogleHealthSportType(sportRaw),
    startedAt,
    endedAt,
    durationSec,
    totalEnergyKcal: energyKcal !== null ? Math.round(energyKcal) : null,
    totalDistanceM:
      distanceMm !== null && distanceMm >= 0 ? round2(distanceMm / 1000) : null,
    avgHeartRate: avgHr !== null && avgHr > 0 ? Math.round(avgHr) : null,
    // metricsSummary carries no maximum/minimum heart rate.
    maxHeartRate: null,
    minHeartRate: null,
  };
}
