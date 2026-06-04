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

// ─── Data-point reads (Google Health `dataPoints.list`) ────────
//
// The Google Health API exposes one uniform `DataPoint` resource shape across
// every data type, read through `GET /v4/users/me/dataTypes/{dataType}/dataPoints`
// with `nextPageToken` pagination. This mirrors the WHOOP `fetchCollection`
// page-walk (`whoop/client.ts:270`), but Google's value-field JSON is NOT fully
// published yet — so the mappers below are intentionally defensive: every value
// is pulled out of a small set of candidate field shapes and guarded by a
// finite-positive check before it becomes a Measurement. Capture the real
// per-type value-field JSON into `src/lib/fitbit/mapping.md` against a live test
// account at build and tighten the extractors then.
//
// Casing gotcha (design §A.1): the data-type id is **kebab-case in the path**
// (`body-fat`) and **snake_case in the `filter`** (`body_fat`). `FITBIT_DATA_TYPES`
// pins both forms so a fetcher can never encode the wrong one.

/**
 * Page-size ceiling for `dataPoints.list`. The daily/intraday reads default to
 * 1440 (one-per-minute) and cap at 10 000; sleep/exercise cap at 25 (same as
 * WHOOP's `WHOOP_PAGE_LIMIT`). The launch metrics use the daily/spot reads, so
 * the default page size is the larger value.
 */
export const FITBIT_PAGE_SIZE = 1000;
/** Sleep/exercise read cap — matches the Google Health 25-cap for those types. */
export const FITBIT_ACTIVITY_PAGE_SIZE = 25;

/**
 * One data type's two on-the-wire encodings. `path` is the kebab-case segment
 * spliced into the request URL; `filter` is the snake_case prefix used to build
 * the incremental `filter=` predicate. The `timeField` names the value object's
 * time anchor (a sample time for spot readings, a date for daily summaries) so
 * the incremental filter targets the right field.
 */
export interface FitbitDataType {
  /** kebab-case segment for the request path. */
  path: string;
  /** snake_case prefix for the `filter` predicate. */
  filter: string;
  /**
   * Which time anchor the filter / measuredAt resolution targets:
   *   - `sample` → spot reading (`{type}.sample_time.physical_time`).
   *   - `date`   → daily summary (`{type}.date`).
   */
  timeField: "sample" | "date";
}

/**
 * The launch (W3 metrics) data types. Each entry pins the kebab-path + snake-filter
 * pair so the two encodings can never drift. Activity/sleep/workout types land in
 * W5; only the health-metrics bundle is read here.
 */
export const FITBIT_DATA_TYPES = {
  weight: { path: "weight", filter: "weight", timeField: "sample" },
  bodyFat: { path: "body-fat", filter: "body_fat", timeField: "sample" },
  oxygenSaturation: {
    path: "daily-oxygen-saturation",
    filter: "daily_oxygen_saturation",
    timeField: "date",
  },
  heartRateVariability: {
    path: "daily-heart-rate-variability",
    filter: "daily_heart_rate_variability",
    timeField: "date",
  },
  restingHeartRate: {
    path: "daily-resting-heart-rate",
    filter: "daily_resting_heart_rate",
    timeField: "date",
  },
  respiratoryRate: {
    path: "daily-respiratory-rate",
    filter: "daily_respiratory_rate",
    timeField: "date",
  },
  heartRate: { path: "heart-rate", filter: "heart_rate", timeField: "sample" },
  height: { path: "height", filter: "height", timeField: "sample" },
  sleepTemperature: {
    path: "daily-sleep-temperature-derivations",
    filter: "daily_sleep_temperature_derivations",
    timeField: "date",
  },
  // ── Activity bundle (W5) — daily cumulative totals ─────────────
  // Scope: `googlehealth.activity_and_fitness.readonly`. Each is a per-day
  // summary (`timeField: "date"`); the externalId carries the `stats:` prefix
  // so a re-fetched day overwrites in place (mirrors the Apple-Health
  // `stats:<HK>:<YYYY-MM-DD>` daily-total overwrite contract).
  steps: { path: "steps", filter: "steps", timeField: "date" },
  distance: { path: "distance", filter: "distance", timeField: "date" },
  activeCalories: {
    path: "active-calories",
    filter: "active_calories",
    timeField: "date",
  },
  floors: { path: "floors", filter: "floors", timeField: "date" },
  vo2Max: { path: "vo2-max", filter: "vo2_max", timeField: "date" },
  // ── Sleep bundle (W5) ──────────────────────────────────────────
  // Scope: `googlehealth.sleep.readonly`. A sleep session carries a start +
  // end + a per-stage breakdown; mapped to per-stage SLEEP_DURATION rows.
  sleep: { path: "sleep", filter: "sleep", timeField: "sample" },
  // ── Exercise bundle (W5) ───────────────────────────────────────
  // Scope: `googlehealth.activity_and_fitness.readonly`. An exercise session
  // → a `Workout` row (NOT a Measurement).
  exercise: { path: "exercise", filter: "exercise", timeField: "sample" },
} as const satisfies Record<string, FitbitDataType>;

export type FitbitDataTypeKey = keyof typeof FITBIT_DATA_TYPES;

/** Google Health `DataPoint` — value object is type-keyed + carries a time anchor. */
export interface FitbitDataPoint {
  [key: string]: unknown;
}

/** `dataPoints.list` envelope: `{ dataPoints, nextPageToken }`. */
interface FitbitDataPointPage {
  dataPoints?: FitbitDataPoint[];
  nextPageToken?: string | null;
}

interface DataPointQuery {
  /** Lower-bound incremental cursor; omitted on a full backfill. */
  start?: Date;
  /** Page size (defaults to `FITBIT_PAGE_SIZE`). */
  pageSize?: number;
  /** Hard ceiling on pages walked (defence against a runaway cursor). */
  maxPages?: number;
}

/**
 * Walk every `DataPoint` for one data type since the incremental cursor.
 * Mirrors the WHOOP `fetchCollection` page-loop: `nextPageToken` pagination, a
 * 1000-page `maxPages` ceiling, and per-page `addExternalCall` telemetry. The
 * data-type id is kebab-cased in the path; the `filter` predicate is built from
 * the snake_case form against the type's time anchor.
 */
export async function fetchDataPoints(
  dataType: FitbitDataType,
  accessToken: string,
  verb: string,
  query: DataPointQuery = {},
): Promise<FitbitDataPoint[]> {
  const points: FitbitDataPoint[] = [];
  let pageToken: string | null | undefined;
  let pageCount = 0;
  const maxPages = query.maxPages ?? 1000;
  const pageSize = query.pageSize ?? FITBIT_PAGE_SIZE;

  do {
    const params = new URLSearchParams({ pageSize: String(pageSize) });
    if (query.start) {
      // snake_case filter prefix; sample readings filter on the sample time,
      // daily summaries on the civil date.
      const field =
        dataType.timeField === "sample"
          ? `${dataType.filter}.sample_time.physical_time`
          : `${dataType.filter}.date`;
      const bound =
        dataType.timeField === "sample"
          ? query.start.toISOString()
          : query.start.toISOString().slice(0, 10);
      params.set("filter", `${field} >= "${bound}"`);
    }
    if (pageToken) params.set("pageToken", pageToken);

    const pageStart = performance.now();
    const res = await safeFetch(
      `${FITBIT_API_BASE}/users/me/dataTypes/${dataType.path}/dataPoints?${params}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    const json = (await res.json().catch(() => null)) as FitbitDataPointPage | null;
    const verdict = classifyFitbitResponse(res.status);
    getEvent()?.addExternalCall({
      service: "fitbit",
      method: `${verb}(page=${pageCount})`,
      duration_ms: Math.round(performance.now() - pageStart),
      status: res.status,
      error: verdict.classification === "success" ? undefined : verdict.reason,
    });
    if (verdict.classification !== "success") {
      throw new FitbitApiError({
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
// The single source of truth is `src/lib/fitbit/mapping.md` — keep both in
// sync when adding entries.

/** Metres → centimetres (Fitbit `height` → `User.heightCm`). */
const M_TO_CM = 100;

function round2(n: number): number {
  return parseFloat(n.toFixed(2));
}

/** Finite + strictly-positive guard — the WHOOP `positive()` discipline. */
function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * A single mapped Fitbit reading destined for one `Measurement` row. The
 * `source` (`FITBIT`) and `externalId` (`<anchor>:<fieldTag>`) are stamped by the
 * sync layer; the mapper emits only type/value/unit/measuredAt + the field-tag
 * that disambiguates the externalId. Mirrors WHOOP's `MappedMeasurement`.
 */
export interface FitbitMappedMeasurement {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  /** Disambiguator appended to the per-point anchor to form the externalId. */
  fieldTag: string;
  /** Per-stage sleep rows carry the SleepStage; everything else omits it. */
  sleepStage?: FitbitSleepStage;
  /**
   * `true` when the externalId carries the `stats:` daily-total prefix (the
   * cumulative activity metrics). The sync layer stamps the externalId; this
   * flag lets it pick the right shape (`stats:<type-tag>:<YYYY-MM-DD>` vs the
   * `<anchor>:<fieldTag>` spot shape) without re-deriving the grain.
   */
  cumulativeDaily?: boolean;
}

/** HealthLog `SleepStage` values a Fitbit sleep stage maps onto. */
export type FitbitSleepStage =
  | "IN_BED"
  | "AWAKE"
  | "ASLEEP"
  | "REM"
  | "CORE"
  | "DEEP";

/**
 * Pull the first finite number out of a list of candidate value paths on a
 * `DataPoint`. The Google value-field JSON is undocumented, so each mapper hands
 * the small set of shapes the field is likely to take (a bare `value`, a typed
 * sub-object, a `{ value: { fpVal } }` wrapper, …); the first finite hit wins.
 */
function firstNumber(
  point: FitbitDataPoint,
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

/**
 * Resolve a `DataPoint`'s measurement timestamp. Sample readings carry a
 * `sample_time.physical_time`; daily summaries carry a `date` (a civil date or a
 * `{year,month,day}` object). Falls back to the fetch time only when nothing
 * parses, so a row is never dropped for a missing anchor.
 */
function resolveMeasuredAt(
  point: FitbitDataPoint,
  dataType: FitbitDataType,
  fallback: Date,
): Date {
  if (dataType.timeField === "sample") {
    const t = readPath(point, `${dataType.filter}.sample_time.physical_time`);
    if (typeof t === "string") {
      const d = new Date(t);
      if (!Number.isNaN(d.getTime())) return d;
    }
  } else {
    const dateVal = readPath(point, `${dataType.filter}.date`);
    if (typeof dateVal === "string") {
      const d = new Date(dateVal);
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (dateVal && typeof dateVal === "object") {
      const o = dateVal as Record<string, unknown>;
      if (
        typeof o.year === "number" &&
        typeof o.month === "number" &&
        typeof o.day === "number"
      ) {
        // Google civil dates are 1-based months; anchor at UTC midday so a
        // timezone shift can't roll the civil day across a boundary.
        return new Date(Date.UTC(o.year, o.month - 1, o.day, 12));
      }
    }
  }
  return fallback;
}

/**
 * Stable anchor for a `DataPoint`'s externalId. A spot reading anchors on its
 * sample time; a daily summary on its civil date. Combined with a type-specific
 * field-tag this makes the upsert key idempotent across re-fetches (a re-sync of
 * the same window overwrites in place rather than minting a duplicate).
 */
function externalAnchor(point: FitbitDataPoint, dataType: FitbitDataType): string {
  const at = resolveMeasuredAt(point, dataType, new Date(0));
  if (dataType.timeField === "date") return at.toISOString().slice(0, 10);
  return at.toISOString();
}

/**
 * Map one data point of a simple single-value metric into a Measurement reading.
 * `valuePaths` lists the candidate value shapes; the first finite-positive hit
 * wins. Returns an empty array when no value parses (an empty/garbage point).
 */
function mapSimple(
  point: FitbitDataPoint,
  dataType: FitbitDataType,
  spec: { type: string; unit: string; fieldTag: string; valuePaths: string[]; factor?: number },
): FitbitMappedMeasurement[] {
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

export function mapWeight(point: FitbitDataPoint): FitbitMappedMeasurement[] {
  const dt = FITBIT_DATA_TYPES.weight;
  return mapSimple(point, dt, {
    type: "WEIGHT",
    unit: "kg",
    fieldTag: "weight",
    valuePaths: valuePaths(dt.filter, "kilograms"),
  });
}

export function mapBodyFat(point: FitbitDataPoint): FitbitMappedMeasurement[] {
  const dt = FITBIT_DATA_TYPES.bodyFat;
  return mapSimple(point, dt, {
    type: "BODY_FAT",
    unit: "%",
    fieldTag: "body_fat",
    valuePaths: valuePaths(dt.filter, "percentage"),
  });
}

export function mapOxygenSaturation(
  point: FitbitDataPoint,
): FitbitMappedMeasurement[] {
  const dt = FITBIT_DATA_TYPES.oxygenSaturation;
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
  point: FitbitDataPoint,
): FitbitMappedMeasurement[] {
  const dt = FITBIT_DATA_TYPES.heartRateVariability;
  // Fitbit reports a nightly RMSSD-style HRV. Per the design decision it lands
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
  point: FitbitDataPoint,
): FitbitMappedMeasurement[] {
  const dt = FITBIT_DATA_TYPES.restingHeartRate;
  return mapSimple(point, dt, {
    type: "RESTING_HEART_RATE",
    unit: "bpm",
    fieldTag: "rhr",
    valuePaths: valuePaths(dt.filter, "beats_per_minute"),
  });
}

export function mapRespiratoryRate(
  point: FitbitDataPoint,
): FitbitMappedMeasurement[] {
  const dt = FITBIT_DATA_TYPES.respiratoryRate;
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

export function mapHeartRate(point: FitbitDataPoint): FitbitMappedMeasurement[] {
  const dt = FITBIT_DATA_TYPES.heartRate;
  return mapSimple(point, dt, {
    type: "PULSE",
    unit: "bpm",
    fieldTag: "hr",
    valuePaths: valuePaths(dt.filter, "beats_per_minute"),
  });
}

export function mapSleepTemperature(
  point: FitbitDataPoint,
): FitbitMappedMeasurement[] {
  const dt = FITBIT_DATA_TYPES.sleepTemperature;
  // Google surfaces a sleeping skin/wrist temperature derivation. `WRIST_TEMPERATURE`
  // is the closest semantic slot (Apple sleeping-wrist-temp). Confirm absolute-vs-
  // baseline at build; the guard rejects a non-positive (baseline-delta) reading.
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
 * Extract the profile height (in cm) from a Fitbit `height` data point, or null
 * when nothing parses. Height is a one-time `User.heightCm` profile seed (written
 * only when the user has no height yet) — NOT a Measurement, mirroring WHOOP's
 * `mapBody` height handling. Returns cm.
 */
export function mapHeightCm(point: FitbitDataPoint): number | null {
  const dt = FITBIT_DATA_TYPES.height;
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
 * Fitbit/Google-Health source field becomes which MeasurementType + unit, and
 * pins the kebab-path / snake-filter pair for each. Used as the single-glance
 * reference and by the mapper tests; the mappers above are the executable form.
 */
export const FITBIT_FIELD_MAP: Record<
  string,
  { type: string; unit: string; path: string; filter: string; note?: string }
> = {
  weight: {
    type: "WEIGHT",
    unit: "kg",
    path: "weight",
    filter: "weight",
    note: "picker ranks a real Withings scale above Fitbit",
  },
  bodyFat: { type: "BODY_FAT", unit: "%", path: "body-fat", filter: "body_fat" },
  oxygenSaturation: {
    type: "OXYGEN_SATURATION",
    unit: "%",
    path: "daily-oxygen-saturation",
    filter: "daily_oxygen_saturation",
  },
  heartRateVariability: {
    type: "HEART_RATE_VARIABILITY",
    unit: "ms",
    path: "daily-heart-rate-variability",
    filter: "daily_heart_rate_variability",
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
    path: "daily-respiratory-rate",
    filter: "daily_respiratory_rate",
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
  // ── Activity bundle (W5) — daily cumulative ─────────────────────
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
  activeCalories: {
    type: "ACTIVE_ENERGY_BURNED",
    unit: "kcal",
    path: "active-calories",
    filter: "active_calories",
    note: "ACTIVE portion only (NOT total caloriesOut); stats: externalId overwrites on re-fetch",
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

// ─── W5 mappers: activity (cumulative), sleep stages, workouts ──

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
  point: FitbitDataPoint,
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
  point: FitbitDataPoint,
  dataType: FitbitDataType,
  spec: {
    type: string;
    unit: string;
    fieldTag: string;
    valuePaths: string[];
    factor?: number;
    /** VO2 max is daily latest-wins, not a running total — still one row/day. */
    latestWins?: boolean;
  },
): FitbitMappedMeasurement[] {
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

export function mapSteps(point: FitbitDataPoint): FitbitMappedMeasurement[] {
  const dt = FITBIT_DATA_TYPES.steps;
  return mapDailyCumulative(point, dt, {
    type: "ACTIVITY_STEPS",
    unit: "steps",
    fieldTag: "steps",
    valuePaths: [...valuePaths(dt.filter, "count"), ...valuePaths(dt.filter, "steps")],
  });
}

export function mapDistance(point: FitbitDataPoint): FitbitMappedMeasurement[] {
  const dt = FITBIT_DATA_TYPES.distance;
  // Google may report metres or kilometres; prefer the explicit-metres field,
  // else convert km → m. Both pass the non-negative guard.
  const meters = firstNonNegativeNumber(
    point,
    valuePaths(dt.filter, "meters"),
  );
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

export function mapActiveCalories(
  point: FitbitDataPoint,
): FitbitMappedMeasurement[] {
  const dt = FITBIT_DATA_TYPES.activeCalories;
  // ACTIVE energy only — NOT total caloriesOut (which folds in BMR). The
  // candidate paths target the active-portion field explicitly.
  return mapDailyCumulative(point, dt, {
    type: "ACTIVE_ENERGY_BURNED",
    unit: "kcal",
    fieldTag: "active_calories",
    valuePaths: [
      ...valuePaths(dt.filter, "active_kilocalories"),
      ...valuePaths(dt.filter, "kilocalories"),
      ...valuePaths(dt.filter, "calories"),
    ],
  });
}

export function mapFloors(point: FitbitDataPoint): FitbitMappedMeasurement[] {
  const dt = FITBIT_DATA_TYPES.floors;
  return mapDailyCumulative(point, dt, {
    type: "FLIGHTS_CLIMBED",
    unit: "flights",
    fieldTag: "floors",
    valuePaths: [...valuePaths(dt.filter, "count"), ...valuePaths(dt.filter, "floors")],
  });
}

export function mapVo2Max(point: FitbitDataPoint): FitbitMappedMeasurement[] {
  const dt = FITBIT_DATA_TYPES.vo2Max;
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
// A Google Health sleep session carries a list of per-stage segments, each
// with a stage label + a start + end. HealthLog stores one SLEEP_DURATION row
// per stage with `measuredAt = stage END` (so the night-total + hypnogram
// readers consume the same enum WHOOP / Apple write). The stage labels are
// harmonised onto the shared `SleepStage` enum.

/** Google Health sleep stage label → HealthLog `SleepStage`. */
const FITBIT_SLEEP_STAGE_MAP: Record<string, FitbitSleepStage> = {
  // Canonical Google Health stage names (snake / lower variants accepted).
  in_bed: "IN_BED",
  inbed: "IN_BED",
  awake: "AWAKE",
  wake: "AWAKE",
  light: "CORE", // Fitbit "light" ↔ Apple "core" (same shallow-NREM band)
  core: "CORE",
  rem: "REM",
  deep: "DEEP",
  // Fitbit's classic (non-stages) sleep log uses asleep/restless/wake.
  asleep: "ASLEEP",
  restless: "AWAKE",
} as const;

/**
 * Normalise a raw Google sleep-stage label to a `SleepStage`, or null for an
 * unknown label (skipped rather than mis-bucketed).
 */
export function mapFitbitSleepStage(raw: unknown): FitbitSleepStage | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return FITBIT_SLEEP_STAGE_MAP[key] ?? FITBIT_SLEEP_STAGE_MAP[key.replace(/_/g, "")] ?? null;
}

/** One sleep-stage segment pulled defensively off a Google sleep session. */
interface FitbitSleepSegment {
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
function readSleepSegments(point: FitbitDataPoint): FitbitSleepSegment[] {
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
    const out: FitbitSleepSegment[] = [];
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
function sleepSessionAnchor(point: FitbitDataPoint): string {
  const end =
    readPath(point, "sleep.endTime") ??
    readPath(point, "sleep.end_time") ??
    readPath(point, "endTime") ??
    readPath(point, "end_time");
  if (typeof end === "string") {
    const d = new Date(end);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const start =
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
 * Map one Google sleep session into per-stage `SLEEP_DURATION` rows. Each
 * stage's segments are summed into one row carrying the stage's `SleepStage`,
 * `measuredAt = the latest segment END for that stage`, and a stage-scoped
 * fieldTag so the (up to six) stage rows for one night stay distinct under the
 * dedup key. Unknown stage labels are skipped; a session with no parseable
 * segment yields nothing.
 */
export function mapSleepSession(
  point: FitbitDataPoint,
): FitbitMappedMeasurement[] {
  const segments = readSleepSegments(point);
  if (segments.length === 0) return [];

  // Accumulate per-stage minutes + track the latest end instant for each stage.
  const perStage = new Map<
    FitbitSleepStage,
    { minutes: number; lastEnd: Date }
  >();
  for (const seg of segments) {
    const stage = mapFitbitSleepStage(seg.stage);
    if (!stage) continue;
    const mins = minutesBetween(seg.startTime, seg.endTime);
    if (mins === null) continue;
    const end = new Date(seg.endTime as string);
    const prev = perStage.get(stage);
    if (prev) {
      prev.minutes += mins;
      if (end > prev.lastEnd) prev.lastEnd = end;
    } else {
      perStage.set(stage, { minutes: mins, lastEnd: end });
    }
  }

  const anchor = sleepSessionAnchor(point);
  const out: FitbitMappedMeasurement[] = [];
  for (const [stage, agg] of perStage) {
    if (!(agg.minutes > 0)) continue;
    out.push({
      type: "SLEEP_DURATION",
      value: round2(agg.minutes),
      unit: "minutes",
      measuredAt: agg.lastEnd,
      fieldTag: `${anchor}:sleep_${stage.toLowerCase()}`,
      sleepStage: stage,
    });
  }
  return out;
}

// ── Workouts (exercise sessions) ───────────────────────────────

/**
 * Google Health exercise-activity-type → HealthLog `WorkoutSportType`. Unknown
 * types fall through to a generic label; the column is free-text so an unmapped
 * type still persists (just not under a canonical sport bucket).
 */
const FITBIT_EXERCISE_TYPE_MAP: Record<string, string> = {
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
export function mapFitbitSportType(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") return "other";
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (
    FITBIT_EXERCISE_TYPE_MAP[key] ??
    FITBIT_EXERCISE_TYPE_MAP[key.replace(/_/g, "")] ??
    "other"
  );
}

/** One mapped Fitbit exercise session destined for a `Workout` row. */
export interface FitbitMappedWorkout {
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
function readNumber(point: FitbitDataPoint, paths: string[]): number | null {
  for (const path of paths) {
    const v = readPath(point, path);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** Read an ISO/string instant off a list of candidate paths, or null. */
function readInstant(point: FitbitDataPoint, paths: string[]): Date | null {
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
export function mapWorkout(point: FitbitDataPoint): FitbitMappedWorkout | null {
  const f = FITBIT_DATA_TYPES.exercise.filter;
  const startedAt = readInstant(point, [
    `${f}.startTime`,
    `${f}.start_time`,
    `${f}.sample_time.physical_time`,
    "startTime",
    "start_time",
  ]);
  const endedAt = readInstant(point, [
    `${f}.endTime`,
    `${f}.end_time`,
    "endTime",
    "end_time",
  ]);
  if (!startedAt || !endedAt || endedAt <= startedAt) return null;

  const durationSec = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);

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
    sportType: mapFitbitSportType(sportRaw),
    startedAt,
    endedAt,
    durationSec,
    totalEnergyKcal: energyKcal !== null ? Math.round(energyKcal) : null,
    totalDistanceM: distanceM !== null && distanceM >= 0 ? round2(distanceM) : null,
    avgHeartRate: avgHr !== null && avgHr > 0 ? Math.round(avgHr) : null,
    maxHeartRate: maxHr !== null && maxHr > 0 ? Math.round(maxHr) : null,
    minHeartRate: minHr !== null && minHr > 0 ? Math.round(minHr) : null,
  };
}
