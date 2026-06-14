/**
 * v1.17.0 (F4) — Polar AccessLink v3 client for OAuth + data fetching.
 * Docs: https://www.polar.com/accesslink-api/ (re-verify at build).
 *
 * Mirrors the WHOOP client structure (`src/lib/whoop/client.ts`): hand-rolled
 * fetch over `safeFetch` (no SDK), an OAuth handshake, typed collection
 * fetchers, and a single source-of-truth field→Measurement mapping
 * (`POLAR_FIELD_MAP`).
 *
 * Polar specifics that differ from WHOOP:
 *   - The token endpoint uses HTTP Basic auth (`base64(client_id:client_secret)`)
 *     rather than client_id/secret in the body.
 *   - Polar access tokens DO NOT expire and there is NO refresh token. The
 *     `User.polarRefreshTokenEncrypted` column stays null; `getValidToken`
 *     never refreshes. A revoked grant surfaces as a 401 on the next data read.
 *   - The token response carries `x_user_id` — Polar's numeric member id — which
 *     every data path needs (`/v3/users/{userId}/...`). It is persisted as
 *     `User.polarUserIdEncrypted` at connect time.
 *   - The client must register the user once (`POST /v3/users`) before data
 *     reads work; a 409 from registration means "already registered" and is
 *     treated as success.
 */
import { getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import { PolarApiError, classifyPolarResponse } from "./response-classifier";

const POLAR_API_BASE = "https://www.polaraccesslink.com";
const POLAR_OAUTH_AUTH_URL = "https://flow.polar.com/oauth2/authorization";
const POLAR_OAUTH_TOKEN_URL = "https://polarremote.com/v2/oauth2/token";

export interface PolarCredentials {
  clientId: string;
  clientSecret: string;
}

/** Resolve the env-configured shared OAuth credentials (F4 = full OAuth from
 * env, not per-user BYO keys). Returns null when unconfigured so the connect
 * route can surface a clean "integration disabled" message. */
export function getPolarCredentials(): PolarCredentials | null {
  const clientId = process.env.POLAR_CLIENT_ID;
  const clientSecret = process.env.POLAR_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function getPolarRedirectUri(): string {
  // `||`, not `??`: the compose whitelist materialises an unset var as an empty
  // string, which must still fall through to the derived URI.
  return (
    process.env.POLAR_REDIRECT_URI ||
    `${process.env.NEXT_PUBLIC_APP_URL}/api/polar/callback`
  );
}

/**
 * Polar OAuth scope. `accesslink.read_all` grants every read collection so the
 * user consents once. Space-separated on the wire.
 */
export const POLAR_OAUTH_SCOPE = "accesslink.read_all" as const;

/** Build the browser-redirect authorization URL. `state` is the signed nonce. */
export function getAuthorizationUrl(
  state: string,
  creds: PolarCredentials,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: getPolarRedirectUri(),
    scope: POLAR_OAUTH_SCOPE,
    state,
  });
  return `${POLAR_OAUTH_AUTH_URL}?${params}`;
}

export interface PolarTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  x_user_id: number;
}

function basicAuthHeader(creds: PolarCredentials): string {
  const raw = `${creds.clientId}:${creds.clientSecret}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

/** Exchange an authorization code for the access token + `x_user_id`. */
export async function exchangeCode(
  code: string,
  creds: PolarCredentials,
): Promise<PolarTokenResponse> {
  const start = performance.now();
  const res = await safeFetch(POLAR_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(creds),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: getPolarRedirectUri(),
    }).toString(),
  });
  const json = await res.json().catch(() => null);
  const verdict = classifyPolarResponse(res.status);
  getEvent()?.addExternalCall({
    service: "polar",
    method: "exchangeCode",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new PolarApiError({
      verb: "exchangeCode",
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
      upstreamError:
        typeof json?.error === "string" ? json.error : undefined,
    });
  }
  return json as PolarTokenResponse;
}

/**
 * Register the user with the Polar app (`POST /v3/users`). Required once before
 * any data read works. A 409 means the member is already registered for this
 * app — treated as success. Other non-2xx throw a classified error.
 */
export async function registerUser(
  accessToken: string,
  memberId: string,
): Promise<void> {
  const start = performance.now();
  const res = await safeFetch(`${POLAR_API_BASE}/v3/users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ "member-id": memberId }),
  });
  const verdict = classifyPolarResponse(res.status);
  getEvent()?.addExternalCall({
    service: "polar",
    method: "registerUser",
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error:
      res.status === 409 || verdict.classification === "success"
        ? undefined
        : verdict.reason,
  });
  // 409 Conflict — member already registered for this app. Idempotent success.
  if (res.status === 409) return;
  if (verdict.classification !== "success") {
    throw new PolarApiError({
      verb: "registerUser",
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
    });
  }
}

// ─── Collection reads ──────────────────────────────────────────

/** One Polar Nightly Recharge record. */
export interface PolarNightlyRecharge {
  date: string;
  nightly_recharge_status?: number | null;
  ans_charge?: number | null;
  ans_charge_status?: number | null;
  heart_rate_avg?: number | null;
  hrv_avg?: number | null;
  breathing_rate_avg?: number | null;
}

/** One Polar Sleep record. Durations are seconds. */
export interface PolarSleep {
  date: string;
  sleep_start_time?: string;
  sleep_end_time?: string;
  light_sleep?: number | null;
  deep_sleep?: number | null;
  rem_sleep?: number | null;
  total_interruption_duration?: number | null;
  sleep_charge?: number | null;
  sleep_score?: number | null;
  heart_rate_samples?: Record<string, number>;
}

/** One Polar daily-activity summary. */
export interface PolarActivity {
  date: string;
  "active-calories"?: number | null;
  "active-steps"?: number | null;
  calories?: number | null;
}

interface CollectionResult<T> {
  records: T[];
}

async function fetchCollection<T>(
  path: string,
  accessToken: string,
  verb: string,
  recordsKey: string,
): Promise<T[]> {
  const start = performance.now();
  const res = await safeFetch(`${POLAR_API_BASE}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const verdict = classifyPolarResponse(res.status);
  getEvent()?.addExternalCall({
    service: "polar",
    method: verb,
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new PolarApiError({
      verb,
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
    });
  }
  // 204 No Content — a window with no records. Polar returns an empty body.
  if (res.status === 204) return [];
  const json = (await res.json().catch(() => null)) as
    | CollectionResult<T>
    | Record<string, T[]>
    | null;
  if (!json) return [];
  const list = (json as Record<string, unknown>)[recordsKey];
  return Array.isArray(list) ? (list as T[]) : [];
}

export function fetchNightlyRecharges(
  accessToken: string,
  userId: string,
): Promise<PolarNightlyRecharge[]> {
  return fetchCollection<PolarNightlyRecharge>(
    `/v3/users/${encodeURIComponent(userId)}/nightly-recharge`,
    accessToken,
    "fetchNightlyRecharges",
    "recharges",
  );
}

export function fetchSleeps(
  accessToken: string,
  userId: string,
): Promise<PolarSleep[]> {
  return fetchCollection<PolarSleep>(
    `/v3/users/${encodeURIComponent(userId)}/sleep`,
    accessToken,
    "fetchSleeps",
    "nights",
  );
}

export function fetchActivities(
  accessToken: string,
  userId: string,
): Promise<PolarActivity[]> {
  return fetchCollection<PolarActivity>(
    `/v3/users/${encodeURIComponent(userId)}/activity-transactions`,
    accessToken,
    "fetchActivities",
    "activity-log",
  );
}

// ─── Field → Measurement mapping ───────────────────────────────

const SEC_TO_MIN = 1 / 60;

function round2(n: number): number {
  return parseFloat(n.toFixed(2));
}

/** A single mapped reading destined for one `Measurement` row. The sync layer
 * stamps `source = POLAR` + `externalId = <date>:<fieldTag>`. */
export interface MappedMeasurement {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  fieldTag: string;
  sleepStage?: "CORE" | "DEEP" | "REM";
}

/** A `nightly_recharge_status` is Polar's 1–6 recovery band; map it to a
 * 0–100 RECOVERY_SCORE so it feeds the canonical recovery ladder below WHOOP.
 * The status is the most stable recovery signal Polar exposes; we linearly
 * rescale 1–6 → 0–100 (1 = worst, 6 = best). */
function rechargeStatusToScore(status: number): number {
  const clamped = Math.max(1, Math.min(6, status));
  return round2(((clamped - 1) / 5) * 100);
}

/**
 * Map one Polar Nightly Recharge record. The recovery band → `RECOVERY_SCORE`
 * (source POLAR, distinct from the COMPUTED proxy); HRV → `HRV_RMSSD`; the
 * nightly average HR → `RESTING_HEART_RATE`; breathing rate → `RESPIRATORY_RATE`.
 * `measuredAt` is the record's date at local midnight UTC anchor (the wake
 * morning the night belongs to).
 */
export function mapNightlyRecharge(r: PolarNightlyRecharge): MappedMeasurement[] {
  const measuredAt = new Date(`${r.date}T00:00:00.000Z`);
  if (Number.isNaN(measuredAt.getTime())) return [];
  const out: MappedMeasurement[] = [];

  if (typeof r.nightly_recharge_status === "number") {
    out.push({
      type: "RECOVERY_SCORE",
      value: rechargeStatusToScore(r.nightly_recharge_status),
      unit: "score",
      measuredAt,
      fieldTag: "recovery",
    });
  }
  if (typeof r.hrv_avg === "number" && r.hrv_avg > 0) {
    out.push({
      type: "HRV_RMSSD",
      value: round2(r.hrv_avg),
      unit: "ms",
      measuredAt,
      fieldTag: "hrv_rmssd",
    });
  }
  if (typeof r.heart_rate_avg === "number" && r.heart_rate_avg > 0) {
    out.push({
      type: "RESTING_HEART_RATE",
      value: Math.round(r.heart_rate_avg),
      unit: "bpm",
      measuredAt,
      fieldTag: "rhr",
    });
  }
  if (typeof r.breathing_rate_avg === "number" && r.breathing_rate_avg > 0) {
    out.push({
      type: "RESPIRATORY_RATE",
      value: round2(r.breathing_rate_avg),
      unit: "breaths/min",
      measuredAt,
      fieldTag: "resp_rate",
    });
  }
  return out;
}

/** Map one Polar Sleep record: per-stage `SLEEP_DURATION` (s→min) + the
 * `SLEEP_SCORE` percentage where present. */
export function mapSleep(s: PolarSleep): MappedMeasurement[] {
  const measuredAt = new Date(`${s.date}T00:00:00.000Z`);
  if (Number.isNaN(measuredAt.getTime())) return [];
  const out: MappedMeasurement[] = [];

  const stages: Array<[number | null | undefined, MappedMeasurement["sleepStage"], string]> = [
    [s.light_sleep, "CORE", "sleep_core"],
    [s.deep_sleep, "DEEP", "sleep_deep"],
    [s.rem_sleep, "REM", "sleep_rem"],
  ];
  for (const [sec, stage, fieldTag] of stages) {
    if (typeof sec === "number" && sec >= 0) {
      out.push({
        type: "SLEEP_DURATION",
        value: round2(sec * SEC_TO_MIN),
        unit: "minutes",
        measuredAt,
        fieldTag,
        sleepStage: stage,
      });
    }
  }
  if (typeof s.sleep_score === "number") {
    out.push({
      type: "SLEEP_PERFORMANCE",
      value: round2(s.sleep_score),
      unit: "%",
      measuredAt,
      fieldTag: "sleep_score",
    });
  }
  return out;
}

/** Map one Polar daily-activity record: `ACTIVITY_STEPS` +
 * `ACTIVE_ENERGY_BURNED` where Polar reports them. Steps live under
 * `active-steps`; the ACTIVE energy portion under `active-calories` (NOT the
 * total `calories`, which includes BMR — matching the Fitbit active-only
 * convention). */
export function mapActivity(a: PolarActivity): MappedMeasurement[] {
  const measuredAt = new Date(`${a.date}T00:00:00.000Z`);
  if (Number.isNaN(measuredAt.getTime())) return [];
  const out: MappedMeasurement[] = [];
  const steps = a["active-steps"];
  if (typeof steps === "number" && steps >= 0) {
    out.push({
      type: "ACTIVITY_STEPS",
      value: Math.round(steps),
      unit: "steps",
      measuredAt,
      fieldTag: "steps",
    });
  }
  const activeCalories = a["active-calories"];
  if (typeof activeCalories === "number" && activeCalories >= 0) {
    out.push({
      type: "ACTIVE_ENERGY_BURNED",
      value: round2(activeCalories),
      unit: "kcal",
      measuredAt,
      fieldTag: "active_energy",
    });
  }
  return out;
}

/** Field→Measurement reference table (mirror of the mappers above). */
export const POLAR_FIELD_MAP: Record<
  string,
  { type: string; unit: string; note?: string }
> = {
  "nightly_recharge.nightly_recharge_status": {
    type: "RECOVERY_SCORE",
    unit: "score",
    note: "1-6 band rescaled to 0-100; feeds recovery ladder below WHOOP",
  },
  "nightly_recharge.hrv_avg": { type: "HRV_RMSSD", unit: "ms" },
  "nightly_recharge.heart_rate_avg": {
    type: "RESTING_HEART_RATE",
    unit: "bpm",
  },
  "nightly_recharge.breathing_rate_avg": {
    type: "RESPIRATORY_RATE",
    unit: "breaths/min",
  },
  "sleep.{light,deep,rem}_sleep": {
    type: "SLEEP_DURATION",
    unit: "minutes",
    note: "s->min, one row per stage (light->CORE, deep->DEEP, rem->REM)",
  },
  "sleep.sleep_score": { type: "SLEEP_PERFORMANCE", unit: "%" },
  "activity.active-steps": { type: "ACTIVITY_STEPS", unit: "steps" },
  "activity.active-calories": {
    type: "ACTIVE_ENERGY_BURNED",
    unit: "kcal",
    note: "active portion only (NOT total calories incl. BMR)",
  },
};
