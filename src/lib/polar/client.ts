/**
 * v1.17.0 (F4) — Polar AccessLink v3 client for OAuth + data fetching.
 * Docs: https://www.polar.com/accesslink-api/ (re-verify at build).
 *
 * Mirrors the WHOOP client structure (`src/lib/whoop/client.ts`): hand-rolled
 * fetch over `safeFetch` (no SDK), an OAuth handshake, typed collection
 * fetchers, and per-resource field→Measurement mappers (self-documenting; there
 * is no separate reference constant).
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
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";
import { safeFetch } from "@/lib/safe-fetch";
import { reconstructContiguousSleepTimeline } from "@/lib/sleep/reconstruct-timeline";
import { PolarApiError, classifyPolarResponse } from "./response-classifier";

const POLAR_API_BASE = "https://www.polaraccesslink.com";
const POLAR_OAUTH_AUTH_URL = "https://flow.polar.com/oauth2/authorization";
const POLAR_OAUTH_TOKEN_URL = "https://polarremote.com/v2/oauth2/token";

export interface PolarCredentials {
  clientId: string;
  clientSecret: string;
}

/** Resolve the env-configured shared OAuth credentials. This is the fallback
 * the per-user BYO-key resolver (`getPolarClientCredentials`) drops to when a
 * user has not stored their own AccessLink app id/secret. Returns null when
 * unconfigured so the connect route can surface a clean "integration disabled"
 * message. */
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
      upstreamError: typeof json?.error === "string" ? json.error : undefined,
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
  /** Estimated walking/running distance derived from steps, in METRES. */
  distance_from_steps?: number | null;
}

/**
 * One Polar Training Load Pro record (cardio-load collection). `cardio_load` is
 * the session/day cardiovascular load figure — Polar's WHOOP-day-strain
 * analogue. `strain` / `tolerance` / `cardio_load_ratio` describe the
 * acute-vs-chronic balance; only `cardio_load` is mapped today (the others are
 * derived ratios we don't surface yet).
 */
export interface PolarCardioLoad {
  date: string;
  cardio_load?: number | null;
  strain?: number | null;
  tolerance?: number | null;
  cardio_load_ratio?: number | null;
}

/** One Polar SpO2 (Elixir pulse-ox) test result. `blood_oxygen_percentage` is
 * the recorded SpO2 reading in percent (0..100). */
export interface PolarSpo2 {
  date: string;
  blood_oxygen_percentage?: number | null;
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

/** Training Load Pro collection — `cardio_load` strain figures for the recent
 * window. Records live under the `cardio-loads` key. */
export function fetchCardioLoads(
  accessToken: string,
  userId: string,
): Promise<PolarCardioLoad[]> {
  return fetchCollection<PolarCardioLoad>(
    `/v3/users/${encodeURIComponent(userId)}/cardio-load`,
    accessToken,
    "fetchCardioLoads",
    "cardio-loads",
  );
}

/** SpO2 (Elixir pulse-ox) collection — nightly blood-oxygen readings. Records
 * live under the `tests` key. */
export function fetchSpo2(
  accessToken: string,
  userId: string,
): Promise<PolarSpo2[]> {
  return fetchCollection<PolarSpo2>(
    `/v3/users/${encodeURIComponent(userId)}/spo2-tests`,
    accessToken,
    "fetchSpo2",
    "tests",
  );
}

// ─── Field → Measurement mapping ───────────────────────────────

const SEC_TO_MIN = 1 / 60;

function round2(n: number): number {
  return parseFloat(n.toFixed(2));
}

/** A single mapped reading destined for one `Measurement` row. The sync layer
 * stamps `source = POLAR` + `externalId = <resource>:<date>:<fieldTag>` unless
 * the mapper supplies its own full `externalId` (the per-segment sleep rows
 * need an index in the key). */
export interface MappedMeasurement {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  fieldTag: string;
  sleepStage?: "CORE" | "DEEP" | "REM" | "AWAKE" | "IN_BED";
  /**
   * Full externalId for rows the mapper keys itself rather than letting the
   * sync layer build `<resource>:<date>:<fieldTag>`. The reconstructed sleep
   * segments (one row per synthetic span) carry an index so the several rows of
   * one stage stay distinct under `userId_type_source_externalId`. When set the
   * sync layer uses it verbatim.
   */
  externalId?: string;
  /**
   * `true` on per-segment sleep rows whose ORDER is synthesised. When Polar
   * gives only per-stage duration totals (no per-stage onset timestamps), the
   * timeline is reconstructed in a fixed physiological order; the UI labels such
   * a night as an approximate layout and never presents it as measured timing.
   */
  reconstructed?: boolean;
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
 * `measuredAt` is the record's date anchored at noon (the wake
 * morning the night belongs to).
 */
export function mapNightlyRecharge(
  r: PolarNightlyRecharge,
): MappedMeasurement[] {
  const measuredAt = canonicalDailyTimestamp(r.date);
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
  // ANS charge — the HRV-based autonomic-nervous-system component of Nightly
  // Recharge, Polar's primary differentiated recovery signal. It is a deviation
  // around the personal baseline (can be negative), so map it through as-is
  // rather than clamping like the 1–6 recovery band. `0` is a valid reading
  // (baseline), so guard on `number` only, not truthiness.
  if (typeof r.ans_charge === "number") {
    out.push({
      type: "ANS_CHARGE",
      value: round2(r.ans_charge),
      unit: "score",
      measuredAt,
      fieldTag: "ans_charge",
    });
  }
  return out;
}

/**
 * Map one Polar Sleep record into per-stage `SLEEP_DURATION` rows + the
 * `SLEEP_SCORE` percentage.
 *
 * `measuredAt` follows the END-instant convention every other sleep integration
 * uses (WHOOP/Withings/Fitbit) and that the canonical night-grouper
 * (`analytics/sleep-night.ts`) depends on: each stage segment is stamped at its
 * own END instant so the hypnogram has an ordered internal timeline and the
 * wake-day key resolves to the right LOCAL day even for negative-UTC users.
 *
 * Polar's sleep collection carries only per-stage DURATION totals plus the
 * night's `sleep_start_time` / `sleep_end_time` (ISO-8601 with local offset) —
 * no per-stage onset timestamps. So we RECONSTRUCT an ordered, contiguous
 * timeline exactly like WHOOP: lay the asleep stages back-to-back from
 * `sleep_start_time` in a fixed physiological order (CORE → DEEP → REM),
 * emitting one timed row per segment ending at the running cursor, and stamp the
 * `IN_BED` envelope + the score row at `sleep_end_time`. The ORDER is synthetic,
 * so every reconstructed segment is flagged `reconstructed: true` and keyed by
 * an indexed externalId so the several rows of one night stay distinct.
 *
 * If the night carries no usable start/end (older records, missing fields) we
 * fall back to a midnight-UTC anchor and emit untimed stage rows — degraded but
 * never wrong-day for the common UTC-positive case, matching the pre-fix shape.
 */
export function mapSleep(s: PolarSleep): MappedMeasurement[] {
  const out: MappedMeasurement[] = [];

  const startMs = s.sleep_start_time ? Date.parse(s.sleep_start_time) : NaN;
  const endMs = s.sleep_end_time ? Date.parse(s.sleep_end_time) : NaN;
  const haveWindow =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;

  const stages: Array<
    [number | null | undefined, "CORE" | "DEEP" | "REM" | "AWAKE", string]
  > = [
    // AWAKE first — Polar reports the night's total interruption time, but no
    // per-stage onset. Lay it as a leading settling-in/awake block so the asleep
    // stages partition the remaining window and the night reader can surface a
    // real awakeMinutes / efficiency rather than reading the night as fully
    // consolidated. Matches WHOOP's leading-AWAKE ordering.
    [s.total_interruption_duration, "AWAKE", "sleep_awake"],
    [s.light_sleep, "CORE", "sleep_core"],
    [s.deep_sleep, "DEEP", "sleep_deep"],
    [s.rem_sleep, "REM", "sleep_rem"],
  ];

  if (haveWindow) {
    // Reconstructed timeline: lay each stage contiguously from onset, one timed
    // row per segment ending at the running cursor. The order is synthetic
    // (Polar gives no per-stage onset), so the shared builder flags every
    // segment reconstructed; the same algorithm backs WHOOP's `mapSleep`.
    out.push(
      ...reconstructContiguousSleepTimeline({
        startMs,
        stages: stages.map(([sec, stage, fieldTag]) => ({
          durationMs:
            typeof sec === "number" && Number.isFinite(sec) ? sec * 1000 : sec,
          stage,
          fieldTag,
        })),
        // IN_BED — single envelope row over the whole sleep window, stamped at
        // the sleep END so the in-bed reader resolves the span back to
        // [start, end].
        inBed: {
          durationMs: endMs - startMs,
          measuredAt: new Date(endMs),
          fieldTag: "sleep_in_bed",
        },
        // Indexed externalId keeps the several segment rows of one night
        // distinct under userId_type_source_externalId.
        externalIdFor: (fieldTag, index) =>
          `sleep:${s.date}:seg:${fieldTag}:${index}`,
      }),
    );

    if (typeof s.sleep_score === "number") {
      out.push({
        type: "SLEEP_PERFORMANCE",
        value: round2(s.sleep_score),
        unit: "%",
        measuredAt: new Date(endMs),
        fieldTag: "sleep_score",
      });
    }
    return out;
  }

  // Fallback: no usable window. Anchor at noon of the wake date and emit
  // untimed stage rows (the pre-v1.17.1 shape) so a record missing the window
  // fields still contributes a night total.
  const measuredAt = canonicalDailyTimestamp(s.date);
  if (Number.isNaN(measuredAt.getTime())) return [];
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
  const measuredAt = canonicalDailyTimestamp(a.date);
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
  // Distance derived from steps, already in METRES (canonical SI for
  // WALKING_RUNNING_DISTANCE). Fills the POLAR slot the distance ladder already
  // ranks — previously a phantom entry with no producer.
  const distance = a.distance_from_steps;
  if (typeof distance === "number" && distance >= 0) {
    out.push({
      type: "WALKING_RUNNING_DISTANCE",
      value: round2(distance),
      unit: "meters",
      measuredAt,
      fieldTag: "distance",
    });
  }
  return out;
}

/** Map one Polar Training Load Pro record: `cardio_load` → `CARDIO_LOAD`
 * (Polar's device-native cardiovascular-strain figure). `0` is a valid load, so
 * guard on `number` only. */
export function mapCardioLoad(c: PolarCardioLoad): MappedMeasurement[] {
  const measuredAt = canonicalDailyTimestamp(c.date);
  if (Number.isNaN(measuredAt.getTime())) return [];
  if (typeof c.cardio_load !== "number" || c.cardio_load < 0) return [];
  return [
    {
      type: "CARDIO_LOAD",
      value: round2(c.cardio_load),
      unit: "score",
      measuredAt,
      fieldTag: "cardio_load",
    },
  ];
}

/** Map one Polar SpO2 test result: `blood_oxygen_percentage` →
 * `OXYGEN_SATURATION` (percent, 0..100). */
export function mapSpo2(r: PolarSpo2): MappedMeasurement[] {
  const measuredAt = canonicalDailyTimestamp(r.date);
  if (Number.isNaN(measuredAt.getTime())) return [];
  const pct = r.blood_oxygen_percentage;
  if (typeof pct !== "number" || pct <= 0 || pct > 100) return [];
  return [
    {
      type: "OXYGEN_SATURATION",
      value: round2(pct),
      unit: "%",
      measuredAt,
      fieldTag: "spo2",
    },
  ];
}
