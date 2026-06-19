/**
 * GET /api/measurements/series?kind=&days=
 *
 * iOS-friendly time-series adapter. Maps the camelCase `kind` to the
 * canonical Prisma `MeasurementType`(s) and returns
 *   { kind, points: [{ id, at, value, secondary }], stats }
 *
 * The `kind=bloodPressure` case pairs systolic + diastolic by
 * `measuredAt` so iOS can render the dual-line chart with one fetch.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  buildPayloadDiagnostic,
  returnAllZodIssues,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import { redactSensitiveFields } from "@/lib/observability/redact-payload";
import type { MeasurementType, SleepStage } from "@/generated/prisma/client";
import { reconstructSleepNights } from "@/lib/analytics/sleep-night";
import { VALUE_RANGES } from "@/lib/validations/measurement";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { convertGlucose, resolveGlucoseUnit } from "@/lib/glucose";

/**
 * v1.11.4 — sleep is read row-per-stage (not from the day rollup), so its
 * window is capped to one year even when the client requests the 3650-day
 * "Alle" range. Matches the slim slice's `withSleepNightTotals` sleep read.
 */
const SLEEP_SERIES_MAX_DAYS = 365;

const kindEnum = z.enum([
  "weight",
  "bloodPressure",
  "pulse",
  "bodyFat",
  "glucose",
  "sleep",
  "steps",
  "totalBodyWater",
  "boneMass",
  "oxygenSaturation",
  // v1.5.5 — the iOS app surfaces these as series-capable, but
  // the route used to reject the trend/detail view request with a
  // 422. The underlying MeasurementType enum already carries each
  // value; this list extends the camelCase wire shape so the route
  // matches the data it can serve.
  "restingHeartRate",
  "heartRateVariability",
  "vo2Max",
]);

const querySchema = z.object({
  kind: kindEnum,
  // v1.5.5 — the 365-day cap rejected the iOS app's "Alle"-range
  // request (days = 3650) with a 422, painting an error banner on
  // every metric tile. Ten years matches the recurrence engine's
  // nextOccurrenceAfter hard cap and the medication course-window
  // upper bound, so the ceiling stays consistent across the surface
  // area that the user can wire to a "show me everything" intent.
  days: z.coerce.number().int().min(1).max(3650).optional().default(30),
});

const KIND_TO_TYPE: Record<z.infer<typeof kindEnum>, MeasurementType> = {
  weight: "WEIGHT",
  bloodPressure: "BLOOD_PRESSURE_SYS",
  pulse: "PULSE",
  bodyFat: "BODY_FAT",
  glucose: "BLOOD_GLUCOSE",
  sleep: "SLEEP_DURATION",
  steps: "ACTIVITY_STEPS",
  totalBodyWater: "TOTAL_BODY_WATER",
  boneMass: "BONE_MASS",
  oxygenSaturation: "OXYGEN_SATURATION",
  restingHeartRate: "RESTING_HEART_RATE",
  heartRateVariability: "HEART_RATE_VARIABILITY",
  vo2Max: "VO2_MAX",
};

/**
 * v1.11.4 — explicit per-kind unit token returned at the top level so
 * the client never has to infer the value's unit. `bloodPressure` reuses
 * the systolic type's unit (mmHg, same for both lines). `sleep` is
 * overridden at request time to `"h"` because the route returns per-night
 * TIME-ASLEEP in hours rather than the canonical per-stage minutes.
 *
 * v1.16.16 — `glucose` is the canonical-stored unit (mg/dL) here; it is
 * overridden at request time to the user's `glucoseUnit` preference and the
 * point values are converted to match, so this wire DTO reads in the SAME
 * unit as the CSV + FHIR exports and the blood-glucose detail page (one
 * number, one engine).
 */
const SERIES_UNIT: Record<z.infer<typeof kindEnum>, string> = {
  weight: "kg",
  bloodPressure: "mmHg",
  pulse: "bpm",
  bodyFat: "%",
  glucose: "mg/dL",
  sleep: "h",
  steps: "steps",
  totalBodyWater: "kg",
  boneMass: "kg",
  oxygenSaturation: "%",
  restingHeartRate: "bpm",
  heartRateVariability: "ms",
  vo2Max: "mL/(kg·min)",
};

interface SeriesPoint {
  id: string;
  at: string;
  value: number;
  secondary: number | null;
  /**
   * v1.11.4 — per-stage minutes for a sleep night point. `null` for
   * every non-sleep kind. Lets a sleep detail view render the night's
   * stage breakdown without a second fetch; the headline `value` stays
   * the night's TIME-ASLEEP total.
   */
  sleepStages?: Partial<Record<SleepStage, number>> | null;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.round(Math.sqrt(variance) * 100) / 100;
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const rawQuery = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = querySchema.safeParse(rawQuery);
  if (!parsed.success) {
    // v1.4.43 W6 — iOS chart loader hot path; multi-issue 422 +
    // audit breadcrumb keyed `measurements.series.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    // v1.4.48 H-iOS-2 — surface the iOS-sent query shape alongside
    // the Zod rejection. Top-level keys + a hard 256-char JSON excerpt
    // only; never the full payload, so token-shaped query params (we
    // do not currently accept any but the truncation keeps that
    // invariant cheap) cannot leak. Shared helper via v1.4.49 so the
    // widget + series routes can't drift on the diagnostic shape; the
    // query map is routed through `redactSensitiveFields` first so any
    // future credential-shaped query string (`token`, `apiKey`,
    // `csrfState`) redacts to `"[redacted]"` before the truncate.
    const payloadDiagnostic = buildPayloadDiagnostic(
      redactSensitiveFields(rawQuery),
    );
    annotate({
      action: { name: "measurements.series.validation-failed" },
      meta: {
        issue_count: issues.length,
        ...payloadDiagnostic,
        zod_issues: issues,
      },
    });
    // v1.4.49 — strip `message` from the audit-ledger row so Zod
    // codes that embed the offending value (`invalid_enum_value` etc.)
    // cannot leak user content through the audit surface.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "measurements.series.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {
        /* swallow — 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { kind, days } = parsed.data;
  const since = new Date(Date.now() - days * 86_400_000);

  // v1.11.4 — explicit unit token so the client never infers the unit
  // from the kind. Sleep is special-cased below (per-night TIME-ASLEEP
  // in HOURS); every other kind carries its canonical stored unit.
  let unit = SERIES_UNIT[kind];

  let points: SeriesPoint[] = [];
  // v1.16.16 — when glucose stats are computed over RAW mg/dL (parity with the
  // detail page + FHIR), the branch fills this so the response below skips the
  // generic over-points path that would double-round mmol/L figures.
  let glucoseStats: {
    mean: number;
    min: number;
    max: number;
    stdDev: number;
    count: number;
  } | null = null;
  if (kind === "sleep") {
    // SLEEP_DURATION is stored one row per STAGE per night (minutes).
    // Collapse the stage rows into ONE point per night carrying the
    // night's TIME ASLEEP (CORE + DEEP + REM, excluding IN_BED + AWAKE),
    // converted to HOURS. The single-stage rows the legacy path returned
    // made the chart show one fragment per stage instead of a nightly
    // trend. The per-night reconstruction clusters stages into sessions
    // (so a midnight-spanning night stays one point) and collapses a
    // dual-source night to one canonical source via the user's `sleep`
    // priority ladder.
    //
    // v1.11.4 — sleep is the one kind read row-per-stage (≈5 rows/night ×
    // source-count) rather than from the day-bucketed rollup, so an
    // unbounded "Alle" (days = 3650) request on a multi-year dual-source
    // account would walk a six-figure row set into JS. Cap the sleep read
    // at SLEEP_SERIES_MAX_DAYS (365 d) — the same one-year bound the slim
    // slice's `withSleepNightTotals` uses — so the window stays small
    // regardless of the requested range. Other kinds read from the rollup
    // tier and keep the full 3650-day range.
    const sleepSince = new Date(
      Date.now() - Math.min(days, SLEEP_SERIES_MAX_DAYS) * 86_400_000,
    );
    const [tz, priorityJson] = await Promise.all([
      resolveUserTimezone(user.id),
      loadUserSourcePriority(user.id),
    ]);
    const rows = await prisma.measurement.findMany({
      where: {
        userId: user.id,
        type: "SLEEP_DURATION",
        measuredAt: { gte: sleepSince },
        deletedAt: null,
      },
      orderBy: { measuredAt: "asc" },
      select: {
        id: true,
        value: true,
        measuredAt: true,
        sleepStage: true,
        source: true,
        // Writer-level collapse: two HealthKit apps behind one source
        // (watch stages vs phone in-bed) must not blend into one night.
        deviceType: true,
      },
    });
    unit = "h";
    points = reconstructSleepNights(rows, tz, priorityJson)
      .filter((n) => n.asleepMinutes > 0)
      .map((n) => {
        const stageHours = Object.fromEntries(
          Object.entries(n.stages).map(([s, m]) => [
            s,
            Math.round((m / 60) * 100) / 100,
          ]),
        ) as Partial<Record<SleepStage, number>>;
        return {
          id: `sleep:${n.night}`,
          at: n.measuredAt.toISOString(),
          value: Math.round((n.asleepMinutes / 60) * 100) / 100,
          secondary: null,
          sleepStages: Object.keys(stageHours).length > 0 ? stageHours : null,
        };
      });
  } else if (kind === "bloodPressure") {
    // Exclude non-physiological rows (systolic < 40 / diastolic < 20) from the
    // series AND the implicit "latest" (the last point). BP is two rows paired
    // client-side, so a corrupt row that slipped in before the input floor was
    // enforced — a seed-era systolic-0, iOS #33 — must never surface as the
    // latest reading. Floors mirror VALUE_RANGES (the input validator's min);
    // this is a read-side selection guard, not a tightening of the write floor.
    const [sys, dia] = await Promise.all([
      prisma.measurement.findMany({
        where: {
          userId: user.id,
          type: "BLOOD_PRESSURE_SYS",
          measuredAt: { gte: since },
          deletedAt: null,
          value: { gte: VALUE_RANGES.BLOOD_PRESSURE_SYS.min },
        },
        orderBy: { measuredAt: "asc" },
        select: { id: true, value: true, measuredAt: true },
      }),
      prisma.measurement.findMany({
        where: {
          userId: user.id,
          type: "BLOOD_PRESSURE_DIA",
          measuredAt: { gte: since },
          deletedAt: null,
          value: { gte: VALUE_RANGES.BLOOD_PRESSURE_DIA.min },
        },
        orderBy: { measuredAt: "asc" },
        select: { id: true, value: true, measuredAt: true },
      }),
    ]);

    // Pair by closest timestamp within ±5 minutes.
    const PAIR_WINDOW_MS = 5 * 60_000;
    points = sys.map((s) => {
      let bestDia: { value: number; dt: number } | null = null;
      for (const d of dia) {
        const dt = Math.abs(d.measuredAt.getTime() - s.measuredAt.getTime());
        if (dt > PAIR_WINDOW_MS) continue;
        if (!bestDia || dt < bestDia.dt) {
          bestDia = { value: d.value, dt };
        }
      }
      return {
        id: s.id,
        at: s.measuredAt.toISOString(),
        value: s.value,
        secondary: bestDia?.value ?? null,
      };
    });
  } else {
    const type = KIND_TO_TYPE[kind];
    const rows = await prisma.measurement.findMany({
      where: {
        userId: user.id,
        type,
        measuredAt: { gte: since },
        deletedAt: null,
      },
      orderBy: { measuredAt: "asc" },
      select: { id: true, value: true, measuredAt: true },
    });
    if (kind === "glucose") {
      // v1.16.16 — glucose is stored canonical mg/dL; convert each point to
      // the user's display unit AT SERIALIZATION so the wire DTO is unit-
      // coherent with the CSV + FHIR exports (one number, one engine). The
      // top-level `unit` token follows. mg/dL-preference users are unchanged
      // (convertGlucose rounds the integer); mmol/L users see 1-decimal
      // values (100 → 5.5) and `unit: "mmol/L"`.
      const profile = await prisma.user.findUnique({
        where: { id: user.id },
        select: { glucoseUnit: true },
      });
      const glucoseUnit = resolveGlucoseUnit(profile?.glucoseUnit ?? null);
      unit = glucoseUnit;
      points = rows.map((r) => ({
        id: r.id,
        at: r.measuredAt.toISOString(),
        value: convertGlucose(r.value, glucoseUnit),
        secondary: null,
      }));
      // v1.16.16 — stat parity. The stat strip's mean/min/max/stdDev must
      // match the detail-page + FHIR convention: aggregate over RAW mg/dL,
      // then convert each resulting figure ONCE. Deriving the stats from the
      // already-converted+rounded points double-rounds the mean and stdDev
      // for mmol/L users, drifting the last decimal off the detail page.
      // Single-reading sets stay identical (100 → 5.5). Hand back stats here
      // so the shared block below leaves a populated `glucoseStats` alone.
      const rawDataPoints: DataPoint[] = rows.map((r) => ({
        date: r.measuredAt,
        value: r.value,
      }));
      if (rawDataPoints.length > 0) {
        const rawSummary = summarize(rawDataPoints);
        const rawValues = rawDataPoints.map((p) => p.value);
        glucoseStats = {
          mean:
            rawSummary.mean === null
              ? 0
              : convertGlucose(rawSummary.mean, glucoseUnit),
          min:
            rawSummary.min === null
              ? 0
              : convertGlucose(rawSummary.min, glucoseUnit),
          max:
            rawSummary.max === null
              ? 0
              : convertGlucose(rawSummary.max, glucoseUnit),
          // Glucose mg/dL↔mmol/L is purely multiplicative (no offset), so a
          // spread converts with the same factor as a level.
          stdDev: convertGlucose(stdDev(rawValues), glucoseUnit),
          count: rawSummary.count,
        };
      }
    } else {
      points = rows.map((r) => ({
        id: r.id,
        at: r.measuredAt.toISOString(),
        value: r.value,
        secondary: null,
      }));
    }
  }

  const dataPoints: DataPoint[] = points.map((p) => ({
    date: new Date(p.at),
    value: p.value,
  }));
  const summary = dataPoints.length > 0 ? summarize(dataPoints) : null;
  const values = dataPoints.map((p) => p.value);

  annotate({
    action: { name: "measurements.series" },
    meta: { kind, days, count: points.length },
  });

  return apiSuccess({
    kind,
    unit,
    points,
    stats:
      glucoseStats ??
      (summary
        ? {
            mean: summary.mean,
            min: summary.min,
            max: summary.max,
            stdDev: stdDev(values),
            count: summary.count,
          }
        : { mean: 0, min: 0, max: 0, stdDev: 0, count: 0 }),
  });
});
