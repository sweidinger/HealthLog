/**
 * v1.17.0 (F4) — Oura Cloud API v2 client for OAuth + data fetching.
 * Docs: https://cloud.ouraring.com/v2/docs (re-verify at build).
 *
 * Mirrors the WHOOP / Polar client structure: hand-rolled fetch over
 * `safeFetch` (no SDK), an OAuth handshake (`getAuthorizationUrl` /
 * `exchangeCode` / `refreshAccessToken`), typed v2 collection fetchers with
 * `next_token` pagination, and a single source-of-truth field→Measurement
 * mapping.
 *
 * Oura specifics: standard authorization-code OAuth WITH refresh tokens (the
 * sync layer refreshes on 401, persisting BOTH rotated tokens). The token
 * endpoint takes client_id/secret in the body. Collections are read by
 * `start_date` / `end_date` (YYYY-MM-DD) and page via `next_token`.
 */
import { getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import { OuraApiError, classifyOuraResponse } from "./response-classifier";

const OURA_API_BASE = "https://api.ouraring.com";
const OURA_OAUTH_AUTH_URL = "https://cloud.ouraring.com/oauth/authorize";
const OURA_OAUTH_TOKEN_URL = "https://api.ouraring.com/oauth/token";

export interface OuraCredentials {
  clientId: string;
  clientSecret: string;
}

/** Env-configured shared OAuth credentials (F4 = full OAuth from env). */
export function getOuraCredentials(): OuraCredentials | null {
  const clientId = process.env.OURA_CLIENT_ID;
  const clientSecret = process.env.OURA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function getOuraRedirectUri(): string {
  return (
    process.env.OURA_REDIRECT_URI ||
    `${process.env.NEXT_PUBLIC_APP_URL}/api/oura/callback`
  );
}

/** `daily` covers sleep / readiness / activity; `personal` is profile info. */
export const OURA_OAUTH_SCOPE = "daily personal" as const;

export function getAuthorizationUrl(
  state: string,
  creds: OuraCredentials,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: getOuraRedirectUri(),
    scope: OURA_OAUTH_SCOPE,
    state,
  });
  return `${OURA_OAUTH_AUTH_URL}?${params}`;
}

export interface OuraTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

async function postToken(
  params: URLSearchParams,
  verb: string,
): Promise<OuraTokenResponse> {
  const start = performance.now();
  const res = await safeFetch(OURA_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params.toString(),
  });
  const json = await res.json().catch(() => null);
  const verdict = classifyOuraResponse(res.status);
  getEvent()?.addExternalCall({
    service: "oura",
    method: verb,
    duration_ms: Math.round(performance.now() - start),
    status: res.status,
    error: verdict.classification === "success" ? undefined : verdict.reason,
  });
  if (verdict.classification !== "success") {
    throw new OuraApiError({
      verb,
      classification: verdict.classification,
      httpStatus: verdict.httpStatus,
      reason: verdict.reason,
      upstreamError:
        typeof json?.error === "string" ? json.error : undefined,
    });
  }
  return json as OuraTokenResponse;
}

export async function exchangeCode(
  code: string,
  creds: OuraCredentials,
): Promise<OuraTokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: getOuraRedirectUri(),
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
    "exchangeCode",
  );
}

export async function refreshAccessToken(
  refreshToken: string,
  creds: OuraCredentials,
): Promise<OuraTokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
    "refreshAccessToken",
  );
}

// ─── Collection reads (v2) ─────────────────────────────────────

/** v2 paginated envelope: `{ data, next_token }`. */
export interface OuraCollection<T> {
  data: T[];
  next_token?: string | null;
}

export interface OuraSleep {
  id: string;
  day: string;
  bedtime_end?: string;
  total_sleep_duration?: number | null;
  time_in_bed?: number | null;
  efficiency?: number | null;
  rem_sleep_duration?: number | null;
  deep_sleep_duration?: number | null;
  light_sleep_duration?: number | null;
  awake_time?: number | null;
  average_heart_rate?: number | null;
  lowest_heart_rate?: number | null;
  average_hrv?: number | null;
  average_breath?: number | null;
}

export interface OuraReadiness {
  id: string;
  day: string;
  timestamp?: string;
  score?: number | null;
}

export interface OuraDailyActivity {
  id: string;
  day: string;
  timestamp?: string;
  steps?: number | null;
  active_calories?: number | null;
  total_calories?: number | null;
}

interface DateRangeQuery {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  maxPages?: number;
}

async function fetchCollection<T>(
  path: string,
  accessToken: string,
  verb: string,
  query: DateRangeQuery,
): Promise<T[]> {
  const records: T[] = [];
  let nextToken: string | null | undefined;
  let pageCount = 0;
  const maxPages = query.maxPages ?? 100;

  do {
    const params = new URLSearchParams({
      start_date: query.startDate,
      end_date: query.endDate,
    });
    if (nextToken) params.set("next_token", nextToken);

    const pageStart = performance.now();
    const res = await safeFetch(`${OURA_API_BASE}${path}?${params}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    const json = (await res.json().catch(() => null)) as
      | OuraCollection<T>
      | null;
    const verdict = classifyOuraResponse(res.status);
    getEvent()?.addExternalCall({
      service: "oura",
      method: `${verb}(page=${pageCount})`,
      duration_ms: Math.round(performance.now() - pageStart),
      status: res.status,
      error:
        verdict.classification === "success" ? undefined : verdict.reason,
    });
    if (verdict.classification !== "success") {
      throw new OuraApiError({
        verb,
        classification: verdict.classification,
        httpStatus: verdict.httpStatus,
        reason: verdict.reason,
      });
    }
    for (const r of json?.data ?? []) records.push(r);
    nextToken = json?.next_token ?? null;
    pageCount += 1;
  } while (nextToken && pageCount < maxPages);

  return records;
}

export function fetchSleep(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraSleep[]> {
  return fetchCollection<OuraSleep>(
    "/v2/usercollection/sleep",
    accessToken,
    "fetchSleep",
    query,
  );
}

export function fetchReadiness(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraReadiness[]> {
  return fetchCollection<OuraReadiness>(
    "/v2/usercollection/daily_readiness",
    accessToken,
    "fetchReadiness",
    query,
  );
}

export function fetchDailyActivity(
  accessToken: string,
  query: DateRangeQuery,
): Promise<OuraDailyActivity[]> {
  return fetchCollection<OuraDailyActivity>(
    "/v2/usercollection/daily_activity",
    accessToken,
    "fetchDailyActivity",
    query,
  );
}

// ─── Field → Measurement mapping ───────────────────────────────

const SEC_TO_MIN = 1 / 60;

function round2(n: number): number {
  return parseFloat(n.toFixed(2));
}

export interface MappedMeasurement {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  fieldTag: string;
  sleepStage?: "CORE" | "DEEP" | "REM" | "AWAKE";
}

function dayAnchor(day: string, bedtimeEnd?: string): Date | null {
  // Prefer the precise wake instant when present; else anchor the day at UTC
  // midnight. The recovery resolver reads the local day key off this stamp.
  const candidate = bedtimeEnd ?? `${day}T00:00:00.000Z`;
  const d = new Date(candidate);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Map one Oura readiness record: `score` → `RECOVERY_SCORE` (source OURA,
 * feeding the recovery ladder below WHOOP). */
export function mapReadiness(r: OuraReadiness): MappedMeasurement[] {
  if (typeof r.score !== "number") return [];
  const measuredAt = dayAnchor(r.day, r.timestamp);
  if (!measuredAt) return [];
  return [
    {
      type: "RECOVERY_SCORE",
      value: round2(r.score),
      unit: "score",
      measuredAt,
      fieldTag: "recovery",
    },
  ];
}

/** Map one Oura sleep record: per-stage durations (s→min), efficiency, HRV,
 * RHR (lowest_heart_rate), respiratory rate. */
export function mapSleep(s: OuraSleep): MappedMeasurement[] {
  const measuredAt = dayAnchor(s.day, s.bedtime_end);
  if (!measuredAt) return [];
  const out: MappedMeasurement[] = [];

  const stages: Array<[number | null | undefined, MappedMeasurement["sleepStage"], string]> = [
    [s.light_sleep_duration, "CORE", "sleep_core"],
    [s.deep_sleep_duration, "DEEP", "sleep_deep"],
    [s.rem_sleep_duration, "REM", "sleep_rem"],
    [s.awake_time, "AWAKE", "sleep_awake"],
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
  if (typeof s.efficiency === "number") {
    out.push({
      type: "SLEEP_EFFICIENCY",
      value: round2(s.efficiency),
      unit: "%",
      measuredAt,
      fieldTag: "sleep_eff",
    });
  }
  if (typeof s.average_hrv === "number" && s.average_hrv > 0) {
    out.push({
      type: "HRV_RMSSD",
      value: round2(s.average_hrv),
      unit: "ms",
      measuredAt,
      fieldTag: "hrv_rmssd",
    });
  }
  if (typeof s.lowest_heart_rate === "number" && s.lowest_heart_rate > 0) {
    out.push({
      type: "RESTING_HEART_RATE",
      value: Math.round(s.lowest_heart_rate),
      unit: "bpm",
      measuredAt,
      fieldTag: "rhr",
    });
  }
  if (typeof s.average_breath === "number" && s.average_breath > 0) {
    out.push({
      type: "RESPIRATORY_RATE",
      value: round2(s.average_breath),
      unit: "breaths/min",
      measuredAt,
      fieldTag: "resp_rate",
    });
  }
  return out;
}

/** Map one Oura daily-activity record: steps + active energy. */
export function mapDailyActivity(a: OuraDailyActivity): MappedMeasurement[] {
  const measuredAt = dayAnchor(a.day, a.timestamp);
  if (!measuredAt) return [];
  const out: MappedMeasurement[] = [];
  if (typeof a.steps === "number" && a.steps >= 0) {
    out.push({
      type: "ACTIVITY_STEPS",
      value: Math.round(a.steps),
      unit: "steps",
      measuredAt,
      fieldTag: "steps",
    });
  }
  if (typeof a.active_calories === "number" && a.active_calories >= 0) {
    out.push({
      type: "ACTIVE_ENERGY_BURNED",
      value: round2(a.active_calories),
      unit: "kcal",
      measuredAt,
      fieldTag: "active_energy",
    });
  }
  return out;
}

