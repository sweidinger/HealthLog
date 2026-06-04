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
import { resolveUserTimezone } from "@/lib/tz/resolver";

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
    const payloadDiagnostic = buildPayloadDiagnostic(redactSensitiveFields(rawQuery));
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
  if (kind === "sleep") {
    // SLEEP_DURATION is stored one row per STAGE per night (minutes).
    // Collapse the stage rows into ONE point per night carrying the
    // night's TIME ASLEEP (CORE + DEEP + REM, excluding IN_BED + AWAKE),
    // converted to HOURS. The single-stage rows the legacy path returned
    // made the chart show one fragment per stage instead of a nightly
    // trend.
    const tz = await resolveUserTimezone(user.id);
    const rows = await prisma.measurement.findMany({
      where: {
        userId: user.id,
        type: "SLEEP_DURATION",
        measuredAt: { gte: since },
        deletedAt: null,
      },
      orderBy: { measuredAt: "asc" },
      select: { id: true, value: true, measuredAt: true, sleepStage: true },
    });
    unit = "h";
    points = reconstructSleepNights(rows, tz)
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
          sleepStages:
            Object.keys(stageHours).length > 0 ? stageHours : null,
        };
      });
  } else if (kind === "bloodPressure") {
    const [sys, dia] = await Promise.all([
      prisma.measurement.findMany({
        where: {
          userId: user.id,
          type: "BLOOD_PRESSURE_SYS",
          measuredAt: { gte: since },
          deletedAt: null,
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
    points = rows.map((r) => ({
      id: r.id,
      at: r.measuredAt.toISOString(),
      value: r.value,
      secondary: null,
    }));
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
    stats: summary
      ? {
          mean: summary.mean,
          min: summary.min,
          max: summary.max,
          stdDev: stdDev(values),
          count: summary.count,
        }
      : { mean: 0, min: 0, max: 0, stdDev: 0, count: 0 },
  });
});
