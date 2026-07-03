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
 * Optional Pixel-Watch clinical scopes (ECG + irregular-rhythm notifications).
 * Kept defined but OFF by default: they widen the Restricted-scope review
 * surface and only apply to Pixel Watch sources, so they are opt-in behind the
 * `GOOGLE_HEALTH_EXPERIMENTAL_SCOPES` env flag until they land cleanly. Both are
 * read-only categories (no `.writeonly` variant exists upstream).
 */
export const GOOGLE_HEALTH_EXPERIMENTAL_SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.ecg.readonly",
  "https://www.googleapis.com/auth/googlehealth.irn.readonly",
] as const;

/**
 * True when the operator has opted into the experimental ECG/IRN scopes via
 * `GOOGLE_HEALTH_EXPERIMENTAL_SCOPES=true`. Read lazily so tests can toggle it
 * per case and so a deploy can flip it without a rebuild.
 */
export function experimentalScopesEnabled(): boolean {
  const raw = process.env.GOOGLE_HEALTH_EXPERIMENTAL_SCOPES;
  return raw === "true" || raw === "1";
}

/**
 * Resolve the scope list HealthLog requests: the four core Restricted bundles,
 * plus the ECG/IRN bundles only when the experimental flag is set.
 */
export function resolveGoogleHealthScopes(): string[] {
  return experimentalScopesEnabled()
    ? [...GOOGLE_HEALTH_CORE_SCOPES, ...GOOGLE_HEALTH_EXPERIMENTAL_SCOPES]
    : [...GOOGLE_HEALTH_CORE_SCOPES];
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
// every data type, read through `GET /v4/users/me/dataTypes/{dataType}/dataPoints`
// with `nextPageToken` pagination. Google's value-field JSON is NOT fully
// published, so the mappers below are intentionally defensive: every value is
// pulled out of a small set of candidate field shapes and guarded by a
// finite-positive check before it becomes a Measurement. Capture the real
// per-type value-field JSON into `mapping.md` against a live test account at
// build and tighten the extractors then.
//
// Casing gotcha: the data-type id is **kebab-case in the path** (`body-fat`)
// and **snake_case in the `filter`** (`body_fat`). `GOOGLE_HEALTH_DATA_TYPES`
// pins both forms so a fetcher can never encode the wrong one.
//
// READ METHOD: most data types support `:list`. Two types —
// `total-calories` and `calories-in-heart-rate-zone` — support ONLY the roll-up
// surface (no `:list`); they carry `readMethod: "dailyRollUp"` and route through
// the single-day roll-up walker instead. Every other type stays on `:list`.

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
 * the incremental `filter=` predicate. `timeField` names the value object's
 * time anchor. `readMethod` selects the read surface (`list` by default;
 * `dailyRollUp` for the two roll-up-only types).
 */
export interface GoogleHealthDataType {
  /** kebab-case segment for the request path. */
  path: string;
  /** snake_case prefix for the `filter` predicate. */
  filter: string;
  /**
   * Which time anchor the filter / measuredAt resolution targets:
   *   - `sample`   → spot reading (`{type}.sample_time.physical_time`).
   *   - `date`     → daily summary keyed on a civil date (`{type}.date`).
   *   - `interval` → an INTERVAL data type (steps / distance / calories /
   *     floors, sleep, exercise), anchored on `{type}.interval.start_time`
   *     (the physical instant) with `{type}.interval.civil_start_time` as the
   *     civil fallback — NOT a `sample_time` (which 400s/empties for interval
   *     types and stalls the incremental filter) and NOT a bare `date`.
   */
  timeField: "sample" | "date" | "interval";
  /**
   * Which read surface to use. Defaults to `list`. `total-calories` and
   * `calories-in-heart-rate-zone` are roll-up-only (no `:list`) and MUST use
   * `dailyRollUp` — the list walker refuses them.
   */
  readMethod?: "list" | "dailyRollUp";
}

/**
 * The launch data types. Each entry pins the kebab-path + snake-filter pair so
 * the two encodings can never drift. Identifiers verified against the 2026
 * Google Health contract (API-RESEARCH §3/§4).
 */
export const GOOGLE_HEALTH_DATA_TYPES = {
  weight: { path: "weight", filter: "weight", timeField: "sample" },
  bodyFat: { path: "body-fat", filter: "body_fat", timeField: "sample" },
  oxygenSaturation: {
    path: "oxygen-saturation",
    filter: "oxygen_saturation",
    timeField: "date",
  },
  heartRateVariability: {
    path: "heart-rate-variability",
    filter: "heart_rate_variability",
    timeField: "date",
  },
  restingHeartRate: {
    path: "daily-resting-heart-rate",
    filter: "daily_resting_heart_rate",
    timeField: "date",
  },
  respiratoryRate: {
    path: "respiratory-rate",
    filter: "respiratory_rate",
    timeField: "date",
  },
  heartRate: { path: "heart-rate", filter: "heart_rate", timeField: "sample" },
  height: { path: "height", filter: "height", timeField: "sample" },
  sleepTemperature: {
    path: "daily-sleep-temperature-derivations",
    filter: "daily_sleep_temperature_derivations",
    timeField: "date",
  },
  // ── Activity bundle — daily cumulative totals ──────────────────
  // Scope: `googlehealth.activity_and_fitness.readonly`. These are INTERVAL
  // data types: Google buckets a daily total into an `interval` (a `start_time`
  // + `end_time`, with `civil_start_time` for the calendar-day grain). The
  // incremental filter targets `interval.start_time` and the externalId carries
  // the `stats:` prefix so a re-fetched day overwrites in place (mirrors the
  // Apple-Health `stats:<HK>:<YYYY-MM-DD>` daily-total overwrite contract).
  steps: { path: "steps", filter: "steps", timeField: "interval" },
  distance: { path: "distance", filter: "distance", timeField: "interval" },
  // Active energy — canonical id `active-energy-burned` (release-notes
  // 2026-05-26); this is the ACTIVE portion only, NOT `total-calories` (which
  // folds in BMR and is roll-up-only, see below).
  activeEnergy: {
    path: "active-energy-burned",
    filter: "active_energy_burned",
    timeField: "interval",
  },
  floors: { path: "floors", filter: "floors", timeField: "interval" },
  // VO2 max is a daily-summary metric (one civil-date reading), not an interval
  // bucket — keep the `date` anchor.
  vo2Max: { path: "vo2-max", filter: "vo2_max", timeField: "date" },
  // ── Roll-up-only types (no `:list`) ───────────────────────────
  // `total-calories` and `calories-in-heart-rate-zone` support ONLY the roll-up
  // surface. Defined here so the read layer routes them through `:dailyRollUp`
  // and never accidentally `:list`s them; not yet wired to a Measurement mapper
  // (active energy already covers the active-calories slot; total-calories folds
  // in BMR and needs a modelling decision before it lands as a metric).
  totalCalories: {
    path: "total-calories",
    filter: "total_calories",
    timeField: "interval",
    readMethod: "dailyRollUp",
  },
  caloriesInHeartRateZone: {
    path: "calories-in-heart-rate-zone",
    filter: "calories_in_heart_rate_zone",
    timeField: "interval",
    readMethod: "dailyRollUp",
  },
  // ── Sleep bundle ───────────────────────────────────────────────
  // Scope: `googlehealth.sleep.readonly`. A sleep session is an INTERVAL data
  // type (a start + end span carrying a per-stage breakdown); the incremental
  // filter must target `interval.start_time`, not a `sample_time` (which 400s
  // for interval types). Mapped to per-stage SLEEP_DURATION rows.
  sleep: { path: "sleep", filter: "sleep", timeField: "interval" },
  // ── Exercise bundle ────────────────────────────────────────────
  // Scope: `googlehealth.activity_and_fitness.readonly`. An exercise session is
  // an INTERVAL data type (a start + end span) → a `Workout` row (NOT a
  // Measurement). The incremental filter targets `interval.start_time`.
  exercise: { path: "exercise", filter: "exercise", timeField: "interval" },
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

/**
 * `dataPoints:dailyRollUp` envelope. The response shape is not fully published;
 * both `dataPoints` and `rollupDataPoints` are tolerated so a live-verified
 * shape doesn't require a code change here. (OPEN — confirm at build.)
 */
interface GoogleHealthDailyRollUpPage {
  dataPoints?: GoogleHealthDataPoint[];
  rollupDataPoints?: GoogleHealthDataPoint[];
  nextPageToken?: string | null;
}

interface DataPointQuery {
  /** Lower-bound incremental cursor; omitted on a full backfill. */
  start?: Date;
  /** Page size (defaults to `GOOGLE_HEALTH_PAGE_SIZE`). */
  pageSize?: number;
  /** Hard ceiling on pages walked (defence against a runaway cursor). */
  maxPages?: number;
  /** Hard ceiling on days walked for a `:dailyRollUp` read. */
  maxDays?: number;
}

/** Default backfill horizon (days) when a roll-up read has no incremental start. */
const DAILY_ROLLUP_BACKFILL_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Build the incremental `filter` field + bound for one data type. Centralised
 * so the predicate and the read-time anchor resolution can never drift.
 *   - `sample`   → spot reading, filter on `{filter}.sample_time.physical_time`.
 *   - `interval` → INTERVAL type, filter on `{filter}.interval.start_time`.
 *   - `date`     → daily civil-date summary, filter on `{filter}.date`.
 */
export function incrementalFilter(
  dataType: GoogleHealthDataType,
  start: Date,
): { field: string; bound: string } {
  switch (dataType.timeField) {
    case "sample":
      return {
        field: `${dataType.filter}.sample_time.physical_time`,
        bound: start.toISOString(),
      };
    case "interval":
      return {
        field: `${dataType.filter}.interval.start_time`,
        bound: start.toISOString(),
      };
    case "date":
      return {
        field: `${dataType.filter}.date`,
        bound: start.toISOString().slice(0, 10),
      };
  }
}

/**
 * Walk every `DataPoint` for one data type since the incremental cursor.
 * Routes by `readMethod`: `list` types walk `dataPoints.list` with
 * `nextPageToken` pagination; the two roll-up-only types walk `:dailyRollUp`
 * one day at a time. The data-type id is kebab-cased in the path; the `filter`
 * predicate is built from the snake_case form against the type's time anchor.
 */
export async function fetchDataPoints(
  dataType: GoogleHealthDataType,
  accessToken: string,
  verb: string,
  query: DataPointQuery = {},
): Promise<GoogleHealthDataPoint[]> {
  if (dataType.readMethod === "dailyRollUp") {
    return fetchDailyRollUp(dataType, accessToken, verb, query);
  }

  const points: GoogleHealthDataPoint[] = [];
  let pageToken: string | null | undefined;
  let pageCount = 0;
  const maxPages = query.maxPages ?? 1000;
  const pageSize = query.pageSize ?? GOOGLE_HEALTH_PAGE_SIZE;

  do {
    const params = new URLSearchParams({ pageSize: String(pageSize) });
    if (query.start) {
      const { field, bound } = incrementalFilter(dataType, query.start);
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

/**
 * Walk `dataPoints:dailyRollUp` one civil day at a time for a roll-up-only data
 * type (`total-calories`, `calories-in-heart-rate-zone`). Those types have no
 * `:list`; the daily-summary endpoint returns one aggregate per day. Bounded by
 * `maxDays` (default 90) and by the incremental `start` when present.
 *
 * The exact request/response shape of `:dailyRollUp` is not fully published
 * (OPEN — confirm at build); this reads defensively and tolerates either a
 * `dataPoints` or a `rollupDataPoints` array so a live-verified shape needs no
 * code change. The per-day `date` filter is the documented single-day selector.
 */
export async function fetchDailyRollUp(
  dataType: GoogleHealthDataType,
  accessToken: string,
  verb: string,
  query: DataPointQuery = {},
): Promise<GoogleHealthDataPoint[]> {
  const points: GoogleHealthDataPoint[] = [];
  const maxDays = query.maxDays ?? DAILY_ROLLUP_BACKFILL_DAYS;
  const now = Date.now();
  const startMs = query.start
    ? query.start.getTime()
    : now - maxDays * MS_PER_DAY;

  let dayCount = 0;
  for (
    let cursor = startMs;
    cursor <= now && dayCount < maxDays;
    cursor += MS_PER_DAY, dayCount += 1
  ) {
    const day = new Date(cursor).toISOString().slice(0, 10);
    const params = new URLSearchParams({
      // The daily-summary selector: the single civil day this roll-up covers.
      filter: `${dataType.filter}.date = "${day}"`,
    });

    const dayStart = performance.now();
    const res = await safeFetch(
      `${GOOGLE_HEALTH_API_BASE}/users/me/dataTypes/${dataType.path}/dataPoints:dailyRollUp?${params}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    const json = (await res
      .json()
      .catch(() => null)) as GoogleHealthDailyRollUpPage | null;
    const verdict = classifyGoogleHealthResponse(res.status);
    getEvent()?.addExternalCall({
      service: "google-health",
      method: `${verb}(day=${dayCount})`,
      duration_ms: Math.round(performance.now() - dayStart),
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

    for (const p of json?.dataPoints ?? json?.rollupDataPoints ?? []) {
      points.push(p);
    }
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

/** Finite + strictly-positive guard. */
function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
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
 * Pull the first finite number out of a list of candidate value paths on a
 * `DataPoint`. The Google value-field JSON is undocumented, so each mapper hands
 * the small set of shapes the field is likely to take (a bare `value`, a typed
 * sub-object, a `{ value: { fpVal } }` wrapper, …); the first finite hit wins.
 */
function firstNumber(
  point: GoogleHealthDataPoint,
  paths: string[],
): number | null {
  for (const path of paths) {
    const v = readPath(point, path);
    if (positive(v)) return v;
    // A value can legitimately be zero for some metrics, but the launch metrics
    // (weight, body-fat, SpO2, HRV, RHR, respiratory rate, HR, height) are all
    // strictly positive — a zero is a garbage/empty reading, so `positive` is
    // the right guard.
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
 * Resolve a `DataPoint`'s measurement timestamp.
 *   - `sample`   → `sample_time.physical_time` (a spot ISO instant).
 *   - `interval` → `interval.start_time` (the bucket's start ISO instant), with
 *     `interval.civil_start_time` (a civil string / `{year,month,day}`) as the
 *     fallback.
 *   - `date`     → `date` (a civil string or `{year,month,day}` object).
 * Falls back to `fallback` only when nothing parses, so a row is never dropped
 * for a missing anchor.
 */
function resolveMeasuredAt(
  point: GoogleHealthDataPoint,
  dataType: GoogleHealthDataType,
  fallback: Date,
): Date {
  if (dataType.timeField === "sample") {
    const t = readPath(point, `${dataType.filter}.sample_time.physical_time`);
    if (typeof t === "string") {
      const d = new Date(t);
      if (!Number.isNaN(d.getTime())) return d;
    }
  } else if (dataType.timeField === "interval") {
    const t = readPath(point, `${dataType.filter}.interval.start_time`);
    if (typeof t === "string") {
      const d = new Date(t);
      if (!Number.isNaN(d.getTime())) return d;
    }
    const civil = readPath(
      point,
      `${dataType.filter}.interval.civil_start_time`,
    );
    if (typeof civil === "string") {
      const d = new Date(civil);
      if (!Number.isNaN(d.getTime())) return d;
    }
    const civilObj = parseCivilDateObject(civil);
    if (civilObj) return civilObj;
  } else {
    const dateVal = readPath(point, `${dataType.filter}.date`);
    if (typeof dateVal === "string") {
      const d = new Date(dateVal);
      if (!Number.isNaN(d.getTime())) return d;
    }
    const civilObj = parseCivilDateObject(dateVal);
    if (civilObj) return civilObj;
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
): string {
  const at = resolveMeasuredAt(point, dataType, new Date(0));
  // The mapper-driven interval types (steps/distance/calories/floors) are daily
  // totals, so they share the civil-day externalId grain with `date` summaries —
  // a re-fetched day overwrites in place. (Sleep/exercise are interval too but
  // mint their own per-session anchors and never reach this helper.)
  if (dataType.timeField === "date" || dataType.timeField === "interval") {
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

/** Candidate value-field shapes a Google `DataPoint` is likely to carry. */
function valuePaths(filterKey: string, leaf: string): string[] {
  return [
    `${filterKey}.${leaf}`,
    `${filterKey}.value.${leaf}`,
    `${filterKey}.value`,
    `value.${leaf}`,
    `value`,
  ];
}

export function mapWeight(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.weight;
  return mapSimple(point, dt, {
    type: "WEIGHT",
    unit: "kg",
    fieldTag: "weight",
    valuePaths: valuePaths(dt.filter, "kilograms"),
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
    valuePaths: valuePaths(dt.filter, "percentage"),
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
    valuePaths: [
      ...valuePaths(dt.filter, "average_percentage"),
      ...valuePaths(dt.filter, "percentage"),
    ],
  });
}

export function mapHeartRateVariability(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.heartRateVariability;
  // Google reports a nightly RMSSD-style HRV. Per the design decision it lands
  // in the SDNN-lineage `HEART_RATE_VARIABILITY` slot (Apple-comparable), NOT
  // WHOOP's `HRV_RMSSD` (reserved for the WHOOP-native estimator). Re-confirm
  // the estimator against a live account and revisit if it warrants `HRV_RMSSD`.
  return mapSimple(point, dt, {
    type: "HEART_RATE_VARIABILITY",
    unit: "ms",
    fieldTag: "hrv",
    valuePaths: [
      ...valuePaths(dt.filter, "rmssd_milliseconds"),
      ...valuePaths(dt.filter, "milliseconds"),
    ],
  });
}

export function mapRestingHeartRate(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.restingHeartRate;
  return mapSimple(point, dt, {
    type: "RESTING_HEART_RATE",
    unit: "bpm",
    fieldTag: "rhr",
    valuePaths: valuePaths(dt.filter, "beats_per_minute"),
  });
}

export function mapRespiratoryRate(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.respiratoryRate;
  return mapSimple(point, dt, {
    type: "RESPIRATORY_RATE",
    unit: "breaths/min",
    fieldTag: "resp_rate",
    valuePaths: [
      ...valuePaths(dt.filter, "breaths_per_minute"),
      ...valuePaths(dt.filter, "average_breaths_per_minute"),
    ],
  });
}

export function mapHeartRate(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.heartRate;
  return mapSimple(point, dt, {
    type: "PULSE",
    unit: "bpm",
    fieldTag: "hr",
    valuePaths: valuePaths(dt.filter, "beats_per_minute"),
  });
}

export function mapSleepTemperature(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.sleepTemperature;
  // Google surfaces a sleeping skin/wrist temperature derivation.
  // `WRIST_TEMPERATURE` is the closest semantic slot (Apple sleeping-wrist-temp).
  // Confirm absolute-vs-baseline at build; the guard rejects a non-positive
  // (baseline-delta) reading.
  return mapSimple(point, dt, {
    type: "WRIST_TEMPERATURE",
    unit: "celsius",
    fieldTag: "wrist_temp",
    valuePaths: [
      ...valuePaths(dt.filter, "nightly_temperature_celsius"),
      ...valuePaths(dt.filter, "celsius"),
    ],
  });
}

/**
 * Extract the profile height (in cm) from a Google `height` data point, or null
 * when nothing parses. Height is a one-time `User.heightCm` profile seed (written
 * only when the user has no height yet) — NOT a Measurement. Returns cm.
 */
export function mapHeightCm(point: GoogleHealthDataPoint): number | null {
  const dt = GOOGLE_HEALTH_DATA_TYPES.height;
  // Google may report height in metres or centimetres; try cm-direct first, then
  // metres × 100. Both pass through the positive guard.
  const cm = firstNumber(point, valuePaths(dt.filter, "centimeters"));
  if (cm !== null) return round2(cm);
  const m = firstNumber(point, valuePaths(dt.filter, "meters"));
  if (m !== null) return round2(m * M_TO_CM);
  return null;
}

/**
 * Field→Measurement mapping table (mirror of `mapping.md`). Documents which
 * Google Health source field becomes which MeasurementType + unit, and pins the
 * kebab-path / snake-filter pair for each. Used as the single-glance reference
 * and by the mapper tests; the mappers above are the executable form.
 */
export const GOOGLE_HEALTH_FIELD_MAP: Record<
  string,
  { type: string; unit: string; path: string; filter: string; note?: string }
> = {
  weight: {
    type: "WEIGHT",
    unit: "kg",
    path: "weight",
    filter: "weight",
    note: "picker ranks a real Withings scale above Google Health",
  },
  bodyFat: {
    type: "BODY_FAT",
    unit: "%",
    path: "body-fat",
    filter: "body_fat",
  },
  oxygenSaturation: {
    type: "OXYGEN_SATURATION",
    unit: "%",
    path: "oxygen-saturation",
    filter: "oxygen_saturation",
  },
  heartRateVariability: {
    type: "HEART_RATE_VARIABILITY",
    unit: "ms",
    path: "heart-rate-variability",
    filter: "heart_rate_variability",
    note: "SDNN slot (Apple-comparable), NOT HRV_RMSSD; confirm estimator at build",
  },
  restingHeartRate: {
    type: "RESTING_HEART_RATE",
    unit: "bpm",
    path: "daily-resting-heart-rate",
    filter: "daily_resting_heart_rate",
  },
  respiratoryRate: {
    type: "RESPIRATORY_RATE",
    unit: "breaths/min",
    path: "respiratory-rate",
    filter: "respiratory_rate",
  },
  heartRate: {
    type: "PULSE",
    unit: "bpm",
    path: "heart-rate",
    filter: "heart_rate",
    note: "intraday spot HR",
  },
  height: {
    type: "User.heightCm",
    unit: "cm",
    path: "height",
    filter: "height",
    note: "profile seed — written to User.heightCm only when null, never as a Measurement",
  },
  sleepTemperature: {
    type: "WRIST_TEMPERATURE",
    unit: "celsius",
    path: "daily-sleep-temperature-derivations",
    filter: "daily_sleep_temperature_derivations",
    note: "overnight wrist-temp; confirm absolute-vs-baseline at build",
  },
  // ── Activity bundle — daily cumulative ──────────────────────────
  steps: {
    type: "ACTIVITY_STEPS",
    unit: "steps",
    path: "steps",
    filter: "steps",
    note: "daily total; stats: externalId overwrites on re-fetch; 0 is a valid rest day",
  },
  distance: {
    type: "WALKING_RUNNING_DISTANCE",
    unit: "m",
    path: "distance",
    filter: "distance",
    note: "daily total metres; stats: externalId overwrites on re-fetch",
  },
  activeEnergy: {
    type: "ACTIVE_ENERGY_BURNED",
    unit: "kcal",
    path: "active-energy-burned",
    filter: "active_energy_burned",
    note: "ACTIVE portion only (NOT total-calories, which folds in BMR); stats: externalId overwrites on re-fetch",
  },
  floors: {
    type: "FLIGHTS_CLIMBED",
    unit: "flights",
    path: "floors",
    filter: "floors",
    note: "daily total floors; stats: externalId overwrites on re-fetch",
  },
  vo2Max: {
    type: "VO2_MAX",
    unit: "mL/(kg·min)",
    path: "vo2-max",
    filter: "vo2_max",
    note: "daily latest-wins; daily-anchor externalId overwrites on re-fetch",
  },
  sleep: {
    type: "SLEEP_DURATION",
    unit: "minutes",
    path: "sleep",
    filter: "sleep",
    note: "per-stage rows (IN_BED/AWAKE/REM/CORE/DEEP); measuredAt = stage END",
  },
  exercise: {
    type: "Workout",
    unit: "—",
    path: "exercise",
    filter: "exercise",
    note: "exercise session → Workout row (NOT a Measurement); cross-source dedup at read time",
  },
};

// ─── Activity mappers: daily cumulative ────────────────────────

/** Finite + non-negative guard — cumulative metrics admit a legitimate 0. */
function nonNegative(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/**
 * Pull the first finite NON-negative number out of a list of candidate value
 * paths. Unlike `firstNumber` (strictly positive), this admits a legitimate
 * zero — a day of rest still records 0 steps / 0 floors / 0 active kcal, and
 * dropping the zero would leave a hole the chart misreads as missing data.
 */
function firstNonNegativeNumber(
  point: GoogleHealthDataPoint,
  paths: string[],
): number | null {
  for (const path of paths) {
    const v = readPath(point, path);
    if (nonNegative(v)) return v;
  }
  return null;
}

/**
 * Map one daily cumulative-activity data point into a single Measurement
 * reading. The externalId is the `stats:`-prefixed daily-total shape so a
 * re-fetched day overwrites in place rather than minting a duplicate — the same
 * overwrite contract the Apple-Health `stats:<HK>:<YYYY-MM-DD>` daily totals
 * use. A zero is preserved (a rest day is real data, not a gap). `latestWins`
 * (VO2 max) carries the same daily anchor; it is daily latest-wins rather than a
 * running sum, but the per-day overwrite key is identical.
 */
function mapDailyCumulative(
  point: GoogleHealthDataPoint,
  dataType: GoogleHealthDataType,
  spec: {
    type: string;
    unit: string;
    fieldTag: string;
    valuePaths: string[];
    factor?: number;
    /** VO2 max is daily latest-wins, not a running total — still one row/day. */
    latestWins?: boolean;
  },
): GoogleHealthMappedMeasurement[] {
  // VO2 max is strictly positive; the running totals admit a legitimate zero.
  let value = spec.latestWins
    ? firstNumber(point, spec.valuePaths)
    : firstNonNegativeNumber(point, spec.valuePaths);
  if (value === null) return [];
  if (spec.factor) value = value * spec.factor;
  const dayKey = externalAnchor(point, dataType); // YYYY-MM-DD for a daily type
  return [
    {
      type: spec.type,
      value: round2(value),
      unit: spec.unit,
      measuredAt: resolveMeasuredAt(point, dataType, new Date()),
      // `stats:<type-tag>:<YYYY-MM-DD>` — the sync layer reads `cumulativeDaily`
      // to assemble the externalId, matching the Apple-Health daily-total shape.
      fieldTag: `${spec.fieldTag}:${dayKey}`,
      cumulativeDaily: true,
    },
  ];
}

export function mapSteps(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.steps;
  return mapDailyCumulative(point, dt, {
    type: "ACTIVITY_STEPS",
    unit: "steps",
    fieldTag: "steps",
    valuePaths: [
      ...valuePaths(dt.filter, "count"),
      ...valuePaths(dt.filter, "steps"),
    ],
  });
}

export function mapDistance(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.distance;
  // Google may report metres or kilometres; prefer the explicit-metres field,
  // else convert km → m. Both pass the non-negative guard.
  const meters = firstNonNegativeNumber(point, valuePaths(dt.filter, "meters"));
  if (meters !== null) {
    return [
      {
        type: "WALKING_RUNNING_DISTANCE",
        value: round2(meters),
        unit: "m",
        measuredAt: resolveMeasuredAt(point, dt, new Date()),
        fieldTag: `distance:${externalAnchor(point, dt)}`,
        cumulativeDaily: true,
      },
    ];
  }
  return mapDailyCumulative(point, dt, {
    type: "WALKING_RUNNING_DISTANCE",
    unit: "m",
    fieldTag: "distance",
    valuePaths: valuePaths(dt.filter, "kilometers"),
    factor: 1000,
  });
}

export function mapActiveEnergy(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.activeEnergy;
  // ACTIVE energy only — NOT total-calories (which folds in BMR). The candidate
  // paths target the active-portion field explicitly.
  return mapDailyCumulative(point, dt, {
    type: "ACTIVE_ENERGY_BURNED",
    unit: "kcal",
    fieldTag: "active_energy",
    valuePaths: [
      ...valuePaths(dt.filter, "active_kilocalories"),
      ...valuePaths(dt.filter, "kilocalories"),
      ...valuePaths(dt.filter, "calories"),
    ],
  });
}

export function mapFloors(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.floors;
  return mapDailyCumulative(point, dt, {
    type: "FLIGHTS_CLIMBED",
    unit: "flights",
    fieldTag: "floors",
    valuePaths: [
      ...valuePaths(dt.filter, "count"),
      ...valuePaths(dt.filter, "floors"),
    ],
  });
}

export function mapVo2Max(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.vo2Max;
  return mapDailyCumulative(point, dt, {
    type: "VO2_MAX",
    unit: "mL/(kg·min)",
    fieldTag: "vo2_max",
    valuePaths: [
      ...valuePaths(dt.filter, "milliliters_per_kilogram_per_minute"),
      ...valuePaths(dt.filter, "value"),
    ],
    latestWins: true, // strictly positive, one daily reading; not a running sum
  });
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
 * Read the per-stage segments off a Google sleep `DataPoint`, tolerating the
 * undocumented JSON shape. Candidate locations: `sleep.segments`,
 * `sleep.stages`, `sleep.levels.data`, or a bare top-level `segments`/`stages`.
 */
function readSleepSegments(
  point: GoogleHealthDataPoint,
): GoogleHealthSleepSegment[] {
  const candidates = [
    readPath(point, "sleep.segments"),
    readPath(point, "sleep.stages"),
    readPath(point, "sleep.levels.data"),
    readPath(point, "segments"),
    readPath(point, "stages"),
    readPath(point, "levels.data"),
  ];
  for (const c of candidates) {
    if (!Array.isArray(c)) continue;
    const out: GoogleHealthSleepSegment[] = [];
    for (const raw of c) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      const stage =
        (typeof o.stage === "string" && o.stage) ||
        (typeof o.level === "string" && o.level) ||
        (typeof o.type === "string" && o.type) ||
        "";
      const startTime =
        (typeof o.startTime === "string" && o.startTime) ||
        (typeof o.start_time === "string" && o.start_time) ||
        (typeof o.dateTime === "string" && o.dateTime) ||
        undefined;
      const endTime =
        (typeof o.endTime === "string" && o.endTime) ||
        (typeof o.end_time === "string" && o.end_time) ||
        undefined;
      if (stage) out.push({ stage, startTime, endTime });
    }
    if (out.length > 0) return out;
  }
  return [];
}

/**
 * The stable session anchor for a sleep `DataPoint`'s externalId. The session
 * end (or start) ISO instant is unique per night, so per-stage rows key as
 * `<session-anchor>:sleep_<stage>` — a re-scored night overwrites in place.
 */
function sleepSessionAnchor(point: GoogleHealthDataPoint): string {
  const end =
    readPath(point, "sleep.interval.end_time") ??
    readPath(point, "interval.end_time") ??
    readPath(point, "sleep.endTime") ??
    readPath(point, "sleep.end_time") ??
    readPath(point, "endTime") ??
    readPath(point, "end_time");
  if (typeof end === "string") {
    const d = new Date(end);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const start =
    readPath(point, "sleep.interval.start_time") ??
    readPath(point, "interval.start_time") ??
    readPath(point, "sleep.startTime") ??
    readPath(point, "sleep.start_time") ??
    readPath(point, "startTime");
  if (typeof start === "string") {
    const d = new Date(start);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
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
 */
export function mapSleepSession(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedMeasurement[] {
  const segments = readSleepSegments(point);
  if (segments.length === 0) return [];

  const anchor = sleepSessionAnchor(point);
  const out: GoogleHealthMappedMeasurement[] = [];
  let segIndex = 0;
  for (const seg of segments) {
    const stage = mapGoogleHealthSleepStage(seg.stage);
    if (!stage) continue;
    const mins = minutesBetween(seg.startTime, seg.endTime);
    if (mins === null || !(mins > 0)) continue;
    const end = new Date(seg.endTime as string);
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
 * Google Health exercise-activity-type → HealthLog `WorkoutSportType`. Unknown
 * types fall through to a generic label; the column is free-text so an unmapped
 * type still persists (just not under a canonical sport bucket).
 */
const GOOGLE_HEALTH_EXERCISE_TYPE_MAP: Record<string, string> = {
  walk: "walking",
  walking: "walking",
  run: "running",
  running: "running",
  treadmill: "running",
  bike: "cycling",
  biking: "cycling",
  cycling: "cycling",
  spinning: "cycling",
  hike: "hiking",
  hiking: "hiking",
  swim: "swimming",
  swimming: "swimming",
  rowing: "rowing",
  elliptical: "elliptical",
  stairclimber: "stairClimber",
  yoga: "yoga",
  pilates: "mindAndBody",
  weights: "strength",
  strength: "strength",
  workout: "strength",
  hiit: "hiit",
  interval_workout: "hiit",
  dance: "dance",
  golf: "golf",
  tennis: "tennis",
  basketball: "basketball",
  soccer: "soccer",
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

/** Read a finite number off a list of candidate paths (any sign), or null. */
function readNumber(
  point: GoogleHealthDataPoint,
  paths: string[],
): number | null {
  for (const path of paths) {
    const v = readPath(point, path);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** Read an ISO/string instant off a list of candidate paths, or null. */
function readInstant(
  point: GoogleHealthDataPoint,
  paths: string[],
): Date | null {
  for (const path of paths) {
    const v = readPath(point, path);
    if (typeof v === "string") {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

/**
 * Map one Google exercise session `DataPoint` into a `Workout` shape. Returns
 * null when there is no usable start/end (a session with no time span is not a
 * workout). The externalId anchors on the session id when present, else on the
 * start instant, so a re-fetch overwrites the same `Workout` row in place.
 * Energy is the active session energy in kcal; HR fields are optional.
 */
export function mapWorkout(
  point: GoogleHealthDataPoint,
): GoogleHealthMappedWorkout | null {
  const f = GOOGLE_HEALTH_DATA_TYPES.exercise.filter;
  const startedAt = readInstant(point, [
    `${f}.interval.start_time`,
    `${f}.startTime`,
    `${f}.start_time`,
    `${f}.sample_time.physical_time`,
    "interval.start_time",
    "startTime",
    "start_time",
  ]);
  const endedAt = readInstant(point, [
    `${f}.interval.end_time`,
    `${f}.endTime`,
    `${f}.end_time`,
    "interval.end_time",
    "endTime",
    "end_time",
  ]);
  if (!startedAt || !endedAt || endedAt <= startedAt) return null;

  const durationSec = Math.round(
    (endedAt.getTime() - startedAt.getTime()) / 1000,
  );

  const sessionId =
    (typeof readPath(point, `${f}.session_id`) === "string" &&
      (readPath(point, `${f}.session_id`) as string)) ||
    (typeof readPath(point, `${f}.id`) === "string" &&
      (readPath(point, `${f}.id`) as string)) ||
    (typeof readPath(point, "name") === "string" &&
      (readPath(point, "name") as string)) ||
    null;
  const externalId = sessionId ?? `exercise:${startedAt.toISOString()}`;

  const sportRaw =
    readPath(point, `${f}.activity_type`) ??
    readPath(point, `${f}.exercise_type`) ??
    readPath(point, `${f}.type`) ??
    readPath(point, "activityType");

  const energyKcal = readNumber(point, [
    `${f}.active_kilocalories`,
    `${f}.calories`,
    `${f}.energy.kilocalories`,
  ]);
  const distanceM = readNumber(point, [
    `${f}.distance.meters`,
    `${f}.distance_meters`,
    `${f}.distance`,
  ]);
  const avgHr = readNumber(point, [
    `${f}.average_heart_rate.beats_per_minute`,
    `${f}.average_heart_rate`,
    `${f}.heart_rate.average`,
  ]);
  const maxHr = readNumber(point, [
    `${f}.maximum_heart_rate.beats_per_minute`,
    `${f}.max_heart_rate`,
    `${f}.heart_rate.maximum`,
  ]);
  const minHr = readNumber(point, [
    `${f}.minimum_heart_rate.beats_per_minute`,
    `${f}.min_heart_rate`,
    `${f}.heart_rate.minimum`,
  ]);

  return {
    externalId,
    sportType: mapGoogleHealthSportType(sportRaw),
    startedAt,
    endedAt,
    durationSec,
    totalEnergyKcal: energyKcal !== null ? Math.round(energyKcal) : null,
    totalDistanceM:
      distanceM !== null && distanceM >= 0 ? round2(distanceM) : null,
    avgHeartRate: avgHr !== null && avgHr > 0 ? Math.round(avgHr) : null,
    maxHeartRate: maxHr !== null && maxHr > 0 ? Math.round(maxHr) : null,
    minHeartRate: minHr !== null && minHr > 0 ? Math.round(minHr) : null,
  };
}
