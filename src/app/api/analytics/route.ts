import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { computeBpInTargetWindows } from "@/lib/analytics/bp-in-target";
import { calculateCompliance } from "@/lib/analytics/compliance";
import {
  computeHealthScore,
  defaultWeightTargetFromHeight,
  type HealthScoreInput,
  type HealthScoreResult,
} from "@/lib/analytics/health-score";
import {
  correlateBpCompliance,
  correlateMoodPulse,
  correlateWeightWeekday,
  type CorrelationResult,
} from "@/lib/insights/correlations";
import type { MeasurementType } from "@/generated/prisma/client";
import { measurementTypeEnum } from "@/lib/validations/measurement";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "analytics.get" } });

  // Derived from canonical enum so a new measurement type is auto-summarised
  // by /api/analytics (V3 audit: enum drift cousins).
  const types = [...measurementTypeEnum.options] as MeasurementType[];

  const measurementsByType = await Promise.all(
    types.map((type) =>
      prisma.measurement
        .findMany({
          where: { userId: user.id, type },
          orderBy: { measuredAt: "asc" },
          select: { value: true, measuredAt: true },
        })
        .then((measurements) => ({
          type,
          summary: summarize(
            measurements.map(
              (m): DataPoint => ({
                date: m.measuredAt,
                value: m.value,
              }),
            ),
          ),
        })),
    ),
  );

  const results: Record<string, ReturnType<typeof summarize>> = {};
  for (const { type, summary } of measurementsByType) {
    results[type] = summary;
  }

  // BMI calculation
  let bmi: number | null = null;
  if (user.heightCm && results.WEIGHT?.latest) {
    const heightM = user.heightCm / 100;
    bmi = Math.round((results.WEIGHT.latest / (heightM * heightM)) * 10) / 10;
  }

  // BP in-target percentage (auto-calculated from date of birth)
  let bpInTargetPct: number | null = null;
  let bpInTargetPct7d: number | null = null;
  let bpInTargetPct30d: number | null = null;
  const bpTargets = getBpTargets(user.dateOfBirth);
  if (bpTargets) {
    const now = new Date();
    // v1.4.19 A1 — fetch ALL paired BP rows, not just the trailing 30
    // days. Up to v1.4.18 we filtered to the last 30 days at the DB
    // level and the headline (`bpInTargetPct`) was routed through
    // `windows.last30Days?.pct` — making the headline a literal copy
    // of the `30T` sub-value. For Marc's data (572 paired readings,
    // recent 30d = 50 %, all-time ≈ 11 %) the tile pinned 50/50/50
    // and looked algorithmically broken. The windowed helper now also
    // returns an independent `allTime` aggregate, which we surface as
    // the headline so the three numbers can diverge naturally.
    const [sysData, diaData] = await Promise.all([
      prisma.measurement.findMany({
        where: { userId: user.id, type: "BLOOD_PRESSURE_SYS" },
        select: { measuredAt: true, value: true },
      }),
      prisma.measurement.findMany({
        where: { userId: user.id, type: "BLOOD_PRESSURE_DIA" },
        select: { measuredAt: true, value: true },
      }),
    ]);

    const windows = computeBpInTargetWindows(sysData, diaData, bpTargets, now);
    bpInTargetPct = windows.allTime?.pct ?? null;
    bpInTargetPct7d = windows.last7Days?.pct ?? null;
    bpInTargetPct30d = windows.last30Days?.pct ?? null;
  }

  // Per-context glucose summaries (canonical mg/dL).
  const glucoseRows = await prisma.measurement.findMany({
    where: { userId: user.id, type: "BLOOD_GLUCOSE" },
    orderBy: { measuredAt: "asc" },
    select: { value: true, measuredAt: true, glucoseContext: true },
  });
  const glucoseByContext: Record<string, ReturnType<typeof summarize>> = {};
  if (glucoseRows.length > 0) {
    const contexts = ["FASTING", "POSTPRANDIAL", "RANDOM", "BEDTIME"] as const;
    for (const ctx of contexts) {
      const ctxRows = glucoseRows.filter((r) => r.glucoseContext === ctx);
      if (ctxRows.length === 0) continue;
      glucoseByContext[ctx] = summarize(
        ctxRows.map((r): DataPoint => ({ date: r.measuredAt, value: r.value })),
      );
    }
  }

  // v1.4.20 phase B3 — three pre-defined correlation hypotheses.
  // All three run on the trailing 30 days so a sparse account doesn't
  // burn the n >= 14 gate on a stale window. Each runner gates on
  // n >= 14 + p < 0.05; below the bar the result.status === "insufficient"
  // and the UI paints an EmptyState.
  const correlations = await computeCorrelationHypotheses(user.id);

  // v1.4.20 phase B5 — Personal Health Score. Server-deterministic
  // composite of BP-in-target % + weight-trend alignment + mood
  // stability + medication compliance. The "vs last week" delta
  // re-runs the same compute against a 7-day-shifted snapshot.
  const healthScore = await computeUserHealthScore(user.id, {
    bpInTargetPct,
    heightCm: user.heightCm ?? null,
  });
  if (healthScore) {
    annotate({
      meta: {
        healthScore: {
          score: healthScore.score,
          band: healthScore.band,
          delta: healthScore.delta,
        },
      },
    });
  }

  return apiSuccess({
    summaries: results,
    bmi,
    bpInTargetPct,
    bpInTargetPct7d,
    bpInTargetPct30d,
    glucoseByContext,
    correlations,
    healthScore,
  });
});

/**
 * Build inputs for the three pre-defined hypotheses + run them.
 * Pure-ish — only Prisma reads, no external calls.
 *
 * Window: trailing 30 days. Anything older falls outside the surface
 * because the user-facing "based on N paired readings · last 30 days"
 * source-chip has to remain truthful.
 */
async function computeCorrelationHypotheses(userId: string): Promise<{
  bpCompliance: CorrelationResult;
  moodPulse: CorrelationResult;
  weightWeekday: CorrelationResult;
}> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const since = new Date(Date.now() - 30 * DAY_MS);

  const [sysRows, diaRows, pulseRows, weightRows, moodRows, intakeRows] =
    await Promise.all([
      prisma.measurement.findMany({
        where: {
          userId,
          type: "BLOOD_PRESSURE_SYS",
          measuredAt: { gte: since },
        },
        select: { value: true, measuredAt: true },
      }),
      prisma.measurement.findMany({
        where: {
          userId,
          type: "BLOOD_PRESSURE_DIA",
          measuredAt: { gte: since },
        },
        select: { value: true, measuredAt: true },
      }),
      prisma.measurement.findMany({
        where: { userId, type: "PULSE", measuredAt: { gte: since } },
        select: { value: true, measuredAt: true },
      }),
      prisma.measurement.findMany({
        where: { userId, type: "WEIGHT", measuredAt: { gte: since } },
        select: { value: true, measuredAt: true },
      }),
      prisma.moodEntry.findMany({
        where: { userId, moodLoggedAt: { gte: since } },
        select: { score: true, moodLoggedAt: true, date: true },
      }),
      prisma.medicationIntakeEvent.findMany({
        where: { userId, scheduledFor: { gte: since } },
        select: { scheduledFor: true, takenAt: true, skipped: true },
      }),
    ]);

  // ── Hypothesis 1: BP × medication compliance ────────────────
  // Aggregate by Berlin-day key so DST + UTC boundary issues don't split
  // a day's readings. The day's "compliance %" is taken / expected for
  // that calendar day across all medications.
  const dayKey = (d: Date): string => berlinDayKey(d);

  const dailySys = new Map<string, number[]>();
  for (const row of sysRows) {
    const key = dayKey(row.measuredAt);
    const list = dailySys.get(key) ?? [];
    list.push(row.value);
    dailySys.set(key, list);
  }

  const dailyCompliance = new Map<string, { expected: number; taken: number }>();
  for (const event of intakeRows) {
    const key = dayKey(event.scheduledFor);
    const slot = dailyCompliance.get(key) ?? { expected: 0, taken: 0 };
    slot.expected += 1;
    if (event.takenAt && !event.skipped) slot.taken += 1;
    dailyCompliance.set(key, slot);
  }

  const bpCompliancePairs: Array<{
    date: Date;
    systolic: number;
    compliancePct: number;
  }> = [];
  for (const [key, sysValues] of dailySys.entries()) {
    const slot = dailyCompliance.get(key);
    if (!slot || slot.expected === 0) continue;
    const compliancePct = (slot.taken / slot.expected) * 100;
    const meanSys = sysValues.reduce((s, v) => s + v, 0) / sysValues.length;
    bpCompliancePairs.push({
      date: dateFromBerlinKey(key),
      systolic: meanSys,
      compliancePct,
    });
  }
  const bpCompliance = correlateBpCompliance({ daily: bpCompliancePairs });

  // ── Hypothesis 2: Mood × resting pulse ──────────────────────
  // Same-day pairing: take the day's mean mood vs the day's mean pulse.
  // "Resting" is approximated by mean — HealthLog has no separate
  // resting-pulse field, so we accept the noise rather than skip.
  const dailyMood = new Map<string, number[]>();
  for (const row of moodRows) {
    const key = berlinDayKey(row.moodLoggedAt);
    const list = dailyMood.get(key) ?? [];
    list.push(row.score);
    dailyMood.set(key, list);
  }
  const dailyPulse = new Map<string, number[]>();
  for (const row of pulseRows) {
    const key = berlinDayKey(row.measuredAt);
    const list = dailyPulse.get(key) ?? [];
    list.push(row.value);
    dailyPulse.set(key, list);
  }
  const moodPulsePairs: Array<{
    date: Date;
    mood: number;
    restingPulse: number;
  }> = [];
  for (const [key, moodScores] of dailyMood.entries()) {
    const pulseValues = dailyPulse.get(key);
    if (!pulseValues || pulseValues.length === 0) continue;
    const meanMood =
      moodScores.reduce((s, v) => s + v, 0) / moodScores.length;
    const meanPulse =
      pulseValues.reduce((s, v) => s + v, 0) / pulseValues.length;
    moodPulsePairs.push({
      date: dateFromBerlinKey(key),
      mood: meanMood,
      restingPulse: meanPulse,
    });
  }
  const moodPulse = correlateMoodPulse({ daily: moodPulsePairs });

  // ── Hypothesis 3: Weight × weekday ──────────────────────────
  // 0 = Monday … 6 = Sunday. ISO weekday minus 1.
  const weightWeekdayPairs: Array<{ weekday: number; weight: number }> = [];
  for (const row of weightRows) {
    const isoWeekday = berlinIsoWeekday(row.measuredAt); // 1..7, 1=Mon
    weightWeekdayPairs.push({
      weekday: isoWeekday - 1,
      weight: row.value,
    });
  }
  const weightWeekday = correlateWeightWeekday({ daily: weightWeekdayPairs });

  // Annotate so admin observability can attribute coverage to the
  // corresponding wide-event rather than chasing it via DB queries.
  annotate({
    meta: {
      correlations: {
        bpCompliance: bpCompliance.status,
        moodPulse: moodPulse.status,
        weightWeekday: weightWeekday.status,
      },
    },
  });

  return { bpCompliance, moodPulse, weightWeekday };
}

const BERLIN_DATE_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
});

function berlinDayKey(d: Date): string {
  const parts = BERLIN_DATE_PARTS.formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${day}`;
}

function dateFromBerlinKey(key: string): Date {
  // Anchor to UTC midnight — the date is a sortable bucket label rather
  // than a wall-clock timestamp, so DST drift is irrelevant.
  return new Date(`${key}T00:00:00.000Z`);
}

const ISO_WEEKDAY: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function berlinIsoWeekday(d: Date): number {
  const parts = BERLIN_DATE_PARTS.formatToParts(d);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return ISO_WEEKDAY[weekday] ?? 1;
}

/**
 * Build the Health Score input from the user's last-30-day weight,
 * mood, and medication-compliance data, plus the already-computed
 * `bpInTargetPct` headline. Re-runs the same compute against a
 * 7-day-shifted window to populate the "vs last week" delta.
 *
 * Returns null when the score wouldn't carry any signal (every
 * component nullable + no medications). The route surfaces the
 * `null` to the UI so the hero panel hides cleanly.
 */
async function computeUserHealthScore(
  userId: string,
  input: { bpInTargetPct: number | null; heightCm: number | null },
): Promise<HealthScoreResult | null> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date();
  const since30d = new Date(now.getTime() - 30 * DAY_MS);
  // Prior week's snapshot — shift everything 7 days into the past so
  // both windows close at the same wall-clock-of-day boundary.
  const prevSince30d = new Date(now.getTime() - 37 * DAY_MS);
  const prevUntil = new Date(now.getTime() - 7 * DAY_MS);

  const [weightRows, moodRows, medications] = await Promise.all([
    prisma.measurement.findMany({
      where: {
        userId,
        type: "WEIGHT",
        measuredAt: { gte: prevSince30d, lte: now },
      },
      select: { value: true, measuredAt: true },
      orderBy: { measuredAt: "asc" },
    }),
    prisma.moodEntry.findMany({
      where: {
        userId,
        moodLoggedAt: { gte: prevSince30d, lte: now },
      },
      select: { score: true, moodLoggedAt: true },
      orderBy: { moodLoggedAt: "asc" },
    }),
    prisma.medication.findMany({
      where: { userId, active: true },
      select: {
        id: true,
        createdAt: true,
        schedules: {
          select: {
            windowStart: true,
            windowEnd: true,
          },
        },
      },
    }),
  ]);

  // Compliance30 per active medication, then again for the prior-week
  // snapshot. The compliance helper anchors on `Date.now()` internally;
  // for the previous-week snapshot we reuse the same helper but pass a
  // shifted "createdAt" floor so the window mathematically reflects the
  // [-37d, -7d] period — equivalent to running the helper a week ago.
  let medicationCompliance30: number[] = [];
  let medicationCompliance30Previous: number[] = [];
  if (medications.length > 0) {
    const medIds = medications.map((m) => m.id);
    const intakeEvents = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId,
        medicationId: { in: medIds },
        scheduledFor: { gte: prevSince30d, lte: now },
      },
      select: {
        medicationId: true,
        scheduledFor: true,
        takenAt: true,
        skipped: true,
      },
    });
    const eventsByMed = new Map<string, typeof intakeEvents>();
    for (const ev of intakeEvents) {
      const list = eventsByMed.get(ev.medicationId);
      if (list) list.push(ev);
      else eventsByMed.set(ev.medicationId, [ev]);
    }
    medicationCompliance30 = medications.map((med) => {
      const events = eventsByMed.get(med.id) ?? [];
      return calculateCompliance(events, med.schedules, 30, med.createdAt).rate;
    });
    medicationCompliance30Previous = medications.map((med) => {
      const events = (eventsByMed.get(med.id) ?? []).filter(
        (e) => e.scheduledFor <= prevUntil,
      );
      // Compute compliance against the prior-week-aligned window by
      // remapping the helper's "now": shift each event's scheduledFor
      // and takenAt forward by 7 days so the helper's internal `now`
      // anchor still captures the same logical 30 days.
      const shifted = events.map((e) => ({
        scheduledFor: new Date(e.scheduledFor.getTime() + 7 * DAY_MS),
        takenAt: e.takenAt
          ? new Date(e.takenAt.getTime() + 7 * DAY_MS)
          : null,
        skipped: e.skipped,
      }));
      return calculateCompliance(shifted, med.schedules, 30, med.createdAt)
        .rate;
    });
  }

  const fallbackTarget = defaultWeightTargetFromHeight(input.heightCm);

  const weightSeriesLast30d = weightRows
    .filter((r) => r.measuredAt >= since30d)
    .map((r) => ({ date: r.measuredAt.toISOString(), kg: r.value }));
  const weightSeriesPrev30d = weightRows
    .filter((r) => r.measuredAt >= prevSince30d && r.measuredAt <= prevUntil)
    .map((r) => ({ date: r.measuredAt.toISOString(), kg: r.value }));

  const moodSeriesLast30d = moodRows
    .filter((r) => r.moodLoggedAt >= since30d)
    .map((r) => ({
      date: r.moodLoggedAt.toISOString(),
      score: r.score,
    }));
  const moodSeriesPrev30d = moodRows
    .filter(
      (r) => r.moodLoggedAt >= prevSince30d && r.moodLoggedAt <= prevUntil,
    )
    .map((r) => ({
      date: r.moodLoggedAt.toISOString(),
      score: r.score,
    }));

  // Skip any input shape where literally nothing is computable — the
  // hero panel hides instead of painting a misleading "0".
  if (
    input.bpInTargetPct === null &&
    weightSeriesLast30d.length === 0 &&
    moodSeriesLast30d.length === 0 &&
    medicationCompliance30.length === 0
  ) {
    // Tag-only annotation so admin observability can see the empty path.
    annotate({
      meta: {
        healthScore: { score: null, reason: "no_components_available" },
      },
    });
    return null;
  }

  const current: HealthScoreInput = {
    bpInTargetRate: input.bpInTargetPct,
    weightSeriesLast30d,
    weightTargetKg: fallbackTarget,
    moodEntriesLast30d: moodSeriesLast30d,
    medicationCompliance30,
  };
  // The all-time `bpInTargetPct` is a slow-moving aggregate and would
  // need a full historical re-pair to "rewind" by a week. We pass the
  // same value to the previous snapshot so the delta primarily
  // reflects week-over-week changes in the weight / mood / compliance
  // pillars — the components that actually move on a weekly cadence.
  const previous: HealthScoreInput = {
    bpInTargetRate: input.bpInTargetPct,
    weightSeriesLast30d: weightSeriesPrev30d,
    weightTargetKg: fallbackTarget,
    moodEntriesLast30d: moodSeriesPrev30d,
    medicationCompliance30: medicationCompliance30Previous,
  };

  return computeHealthScore(current, previous);
}
