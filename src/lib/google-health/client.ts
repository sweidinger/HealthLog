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
import { zonedWallClockToUtc } from "@/lib/tz/wall-clock";
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
// pins both forms so a fetcher can never encode the wrong one. Every launch
// data type is read through `dataPoints.list`.

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
 * time anchor. Every launch data type reads through `dataPoints.list`.
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
   *   - `interval` → an INTERVAL data type (steps / distance / active energy /
   *     floors, sleep, exercise). The cumulative daily totals key on the CIVIL
   *     day: `{type}.interval.civil_start_time` (anchored at UTC-midday) with
   *     `{type}.interval.start_time` (the physical instant) as the fallback —
   *     NOT a `sample_time` (which 400s/empties for interval types and stalls
   *     the incremental filter) and NOT a bare `date`.
   */
  timeField: "sample" | "date" | "interval";
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
  // Skin temperature (`daily-sleep-temperature-derivations`) is intentionally
  // OMITTED: Google surfaces a nightly signed DEVIATION from baseline, not an
  // absolute reading — a future enhancement needing a signed-delta model, not an
  // absolute WRIST_TEMPERATURE row.
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

interface DataPointQuery {
  /** Lower-bound incremental cursor; omitted on a full backfill. */
  start?: Date;
  /** Page size (defaults to `GOOGLE_HEALTH_PAGE_SIZE`). */
  pageSize?: number;
  /** Hard ceiling on pages walked (defence against a runaway cursor). */
  maxPages?: number;
}

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
 * Walk every `DataPoint` for one data type since the incremental cursor via
 * `dataPoints.list` with `nextPageToken` pagination. The data-type id is
 * kebab-cased in the path; the `filter` predicate is built from the snake_case
 * form against the type's time anchor.
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
 * Resolve a `DataPoint`'s measurement timestamp.
 *   - `sample`   → `sample_time.physical_time` (a spot instant; offset-less
 *     strings resolve against `tz`).
 *   - `interval` → the cumulative daily total keys on the CIVIL day:
 *     `interval.civil_start_time` anchored at UTC-midday (so a tz shift can't
 *     roll the day and the day-key aligns with the Apple/Fitbit `stats:` civil
 *     convention), falling back to `interval.start_time` (the physical instant)
 *     only when civil is absent. `start_time` alone off-by-ones the day for
 *     positive-UTC-offset users.
 *   - `date`     → `date` (a civil string or `{year,month,day}` object).
 * Falls back to `fallback` only when nothing parses, so a row is never dropped
 * for a missing anchor.
 */
function resolveMeasuredAt(
  point: GoogleHealthDataPoint,
  dataType: GoogleHealthDataType,
  fallback: Date,
  tz?: string,
): Date {
  if (dataType.timeField === "sample") {
    const t = readPath(point, `${dataType.filter}.sample_time.physical_time`);
    if (typeof t === "string") {
      const d = parseLocalInstant(t, tz);
      if (d) return d;
    }
  } else if (dataType.timeField === "interval") {
    // Civil day first — the day the total belongs to, tz-invariant at UTC-midday.
    const civil = readPath(
      point,
      `${dataType.filter}.interval.civil_start_time`,
    );
    const civilDate = parseCivilStart(civil);
    if (civilDate) return civilDate;
    // Fall back to the physical instant only when civil is absent.
    const t = readPath(point, `${dataType.filter}.interval.start_time`);
    if (typeof t === "string") {
      const d = parseLocalInstant(t, tz);
      if (d) return d;
    }
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
  tz?: string,
): string {
  const at = resolveMeasuredAt(point, dataType, new Date(0), tz);
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
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  // VO2 max is strictly positive; the running totals admit a legitimate zero.
  let value = spec.latestWins
    ? firstNumber(point, spec.valuePaths)
    : firstNonNegativeNumber(point, spec.valuePaths);
  if (value === null) return [];
  if (spec.factor) value = value * spec.factor;
  const dayKey = externalAnchor(point, dataType, tz); // civil YYYY-MM-DD
  return [
    {
      type: spec.type,
      value: round2(value),
      unit: spec.unit,
      measuredAt: resolveMeasuredAt(point, dataType, new Date(), tz),
      // `stats:<type-tag>:<YYYY-MM-DD>` — the sync layer reads `cumulativeDaily`
      // to assemble the externalId, matching the Apple-Health daily-total shape.
      fieldTag: `${spec.fieldTag}:${dayKey}`,
      cumulativeDaily: true,
    },
  ];
}

export function mapSteps(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.steps;
  return mapDailyCumulative(
    point,
    dt,
    {
      type: "ACTIVITY_STEPS",
      unit: "steps",
      fieldTag: "steps",
      valuePaths: [
        ...valuePaths(dt.filter, "count"),
        ...valuePaths(dt.filter, "steps"),
      ],
    },
    tz,
  );
}

export function mapDistance(
  point: GoogleHealthDataPoint,
  tz?: string,
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
        measuredAt: resolveMeasuredAt(point, dt, new Date(), tz),
        fieldTag: `distance:${externalAnchor(point, dt, tz)}`,
        cumulativeDaily: true,
      },
    ];
  }
  return mapDailyCumulative(
    point,
    dt,
    {
      type: "WALKING_RUNNING_DISTANCE",
      unit: "m",
      fieldTag: "distance",
      valuePaths: valuePaths(dt.filter, "kilometers"),
      factor: 1000,
    },
    tz,
  );
}

export function mapActiveEnergy(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.activeEnergy;
  // ACTIVE energy only — NOT total-calories (which folds in BMR). The candidate
  // paths target the active-portion field explicitly.
  return mapDailyCumulative(
    point,
    dt,
    {
      type: "ACTIVE_ENERGY_BURNED",
      unit: "kcal",
      fieldTag: "active_energy",
      valuePaths: [
        ...valuePaths(dt.filter, "active_kilocalories"),
        ...valuePaths(dt.filter, "kilocalories"),
        ...valuePaths(dt.filter, "calories"),
      ],
    },
    tz,
  );
}

export function mapFloors(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.floors;
  return mapDailyCumulative(
    point,
    dt,
    {
      type: "FLIGHTS_CLIMBED",
      unit: "flights",
      fieldTag: "floors",
      valuePaths: [
        ...valuePaths(dt.filter, "count"),
        ...valuePaths(dt.filter, "floors"),
      ],
    },
    tz,
  );
}

export function mapVo2Max(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedMeasurement[] {
  const dt = GOOGLE_HEALTH_DATA_TYPES.vo2Max;
  return mapDailyCumulative(
    point,
    dt,
    {
      type: "VO2_MAX",
      unit: "mL/(kg·min)",
      fieldTag: "vo2_max",
      valuePaths: [
        ...valuePaths(dt.filter, "milliliters_per_kilogram_per_minute"),
        ...valuePaths(dt.filter, "value"),
      ],
      latestWins: true, // strictly positive, one daily reading; not a running sum
    },
    tz,
  );
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
function sleepSessionAnchor(point: GoogleHealthDataPoint, tz?: string): string {
  const end =
    readPath(point, "sleep.interval.end_time") ??
    readPath(point, "interval.end_time") ??
    readPath(point, "sleep.endTime") ??
    readPath(point, "sleep.end_time") ??
    readPath(point, "endTime") ??
    readPath(point, "end_time");
  if (typeof end === "string") {
    const d = parseLocalInstant(end, tz);
    if (d) return d.toISOString();
  }
  const start =
    readPath(point, "sleep.interval.start_time") ??
    readPath(point, "interval.start_time") ??
    readPath(point, "sleep.startTime") ??
    readPath(point, "sleep.start_time") ??
    readPath(point, "startTime");
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
 * workout). The externalId anchors on the session id when present, else on the
 * start instant, so a re-fetch overwrites the same `Workout` row in place.
 * Energy is the active session energy in kcal; HR fields are optional.
 *
 * Session start/end can arrive OFFSET-LESS (local wall clock); `tz` anchors them
 * to the correct UTC instant rather than the process zone.
 */
export function mapWorkout(
  point: GoogleHealthDataPoint,
  tz?: string,
): GoogleHealthMappedWorkout | null {
  const f = GOOGLE_HEALTH_DATA_TYPES.exercise.filter;
  const startedAt = readInstant(
    point,
    [
      `${f}.interval.start_time`,
      `${f}.startTime`,
      `${f}.start_time`,
      `${f}.sample_time.physical_time`,
      "interval.start_time",
      "startTime",
      "start_time",
    ],
    tz,
  );
  const endedAt = readInstant(
    point,
    [
      `${f}.interval.end_time`,
      `${f}.endTime`,
      `${f}.end_time`,
      "interval.end_time",
      "endTime",
      "end_time",
    ],
    tz,
  );
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
