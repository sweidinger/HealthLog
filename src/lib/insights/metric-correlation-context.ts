/**
 * v1.12.1 (D3) — feed FDR-surviving cross-metric correlations into the
 * per-metric assessment card.
 *
 * The discovery engine (`correlation-discovery.ts`) already computes, with
 * a real Pearson + exact p-value + Benjamini-Hochberg FDR control, which
 * behaviour×outcome pairs are statistically defensible. Until now that
 * intelligence only reached the period narrative; the per-metric cards —
 * where many users actually live — never saw it, so every card read in
 * isolation ("your resting HR is X") instead of relationally ("your
 * resting HR rose the same week your sleep dropped").
 *
 * This module runs the SAME full-matrix discovery the
 * `/api/insights/correlations` route runs (so a card never surfaces a pair
 * the correlations page wouldn't), then filters to the surviving pairs that
 * INVOLVE the current metric's discovery channel. The result is the
 * engine's own conservative, descriptive, never-causal `interpretation`
 * strings — passed verbatim into the prompt as grounded context.
 *
 * Read-only consumption. No new statistics are computed here; the only
 * change vs the route is the filter to one metric and a shorter window cap.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import {
  discoverCorrelations,
  discoveryMeasurementTypes,
  DISCOVERY_BEHAVIOURS,
  DISCOVERY_OUTCOMES,
  type DailySeriesPoint,
  type NamedSeries,
} from "@/lib/insights/correlation-discovery";
import type { RelevantCorrelation } from "@/lib/insights/assessment-context";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Trailing window for the discovery scan — mirrors the route. */
const WINDOW_DAYS = 180;

/**
 * The discovery-channel key a `MeasurementType` participates as, or null
 * when the metric is not part of the curated discovery matrix. The channel
 * key equals the measurement type for every participating metric
 * (`TIME_IN_DAYLIGHT`, `BLOOD_GLUCOSE`, `ACTIVITY_STEPS`, `SLEEP_DURATION`,
 * `HEART_RATE_VARIABILITY`, `RESTING_HEART_RATE`).
 */
function channelKeyForType(type: MeasurementType): string | null {
  const key = type as string;
  if (
    (DISCOVERY_BEHAVIOURS as readonly string[]).includes(key) ||
    (DISCOVERY_OUTCOMES as readonly string[]).includes(key)
  ) {
    return key;
  }
  return null;
}

/** Day key (YYYY-MM-DD) for an instant in the user's display timezone. */
function tzDayKey(at: Date, tz: string): string {
  const { year, month, day } = wallClockInTz(at, tz);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Collapse rows to per-day means keyed in the user's tz. */
function toDailyMeans(
  rows: Array<{ value: number; at: Date }>,
  tz: string,
): DailySeriesPoint[] {
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const r of rows) {
    if (!Number.isFinite(r.value)) continue;
    const day = tzDayKey(r.at, tz);
    const acc = byDay.get(day) ?? { sum: 0, count: 0 };
    acc.sum += r.value;
    acc.count += 1;
    byDay.set(day, acc);
  }
  return [...byDay.entries()]
    .map(([day, acc]) => ({ day, value: acc.sum / acc.count }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

/**
 * Fetch the FDR-surviving correlations that involve `measurementType`.
 *
 * Returns an empty array when the metric is not a discovery channel, when
 * there is too little paired data, or when no pair survives the FDR control
 * — the relations prompt block then simply drops out. Best-effort: any
 * read/compute failure resolves to `[]` so a correlation hiccup can never
 * block the assessment generation it only decorates.
 */
export async function getRelevantCorrelationsForMetric(
  userId: string,
  measurementType: MeasurementType,
): Promise<RelevantCorrelation[]> {
  const channel = channelKeyForType(measurementType);
  if (!channel) return [];

  try {
    const profile = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const tz = profile?.timezone ?? "Europe/Berlin";
    const since = new Date(Date.now() - WINDOW_DAYS * MS_PER_DAY);

    // Non-measurement channels (MOOD, and v1.21.0 MEDICATION_COMPLIANCE /
    // SYMPTOM_SEVERITY) are backed by other models — `discoveryMeasurementTypes`
    // strips them from the measurement `type IN (...)` query (a non-enum string
    // would error the cast). This per-metric-card surface does not populate the
    // compliance / symptom channels (they degrade to absent here); the
    // canonical `/api/insights/correlations` route builds them.
    const behaviourTypes = discoveryMeasurementTypes(
      DISCOVERY_BEHAVIOURS,
    ) as MeasurementType[];
    const outcomeTypes = discoveryMeasurementTypes(
      DISCOVERY_OUTCOMES,
    ) as MeasurementType[];

    const [measurements, moodEntries] = await Promise.all([
      prisma.measurement.findMany({
        where: {
          userId,
          deletedAt: null,
          measuredAt: { gte: since },
          type: { in: [...behaviourTypes, ...outcomeTypes] },
        },
        orderBy: { measuredAt: "asc" },
        take: 20000,
        select: { type: true, value: true, measuredAt: true },
      }),
      prisma.moodEntry.findMany({
        where: { userId, deletedAt: null, moodLoggedAt: { gte: since } },
        orderBy: { moodLoggedAt: "asc" },
        take: 5000,
        select: { score: true, moodLoggedAt: true },
      }),
    ]);

    const byType = new Map<string, Array<{ value: number; at: Date }>>();
    for (const m of measurements) {
      const list = byType.get(m.type) ?? [];
      list.push({ value: m.value, at: m.measuredAt });
      byType.set(m.type, list);
    }
    const moodDaily = toDailyMeans(
      moodEntries.map((e) => ({ value: e.score, at: e.moodLoggedAt })),
      tz,
    );

    const series: NamedSeries[] = [];
    for (const key of DISCOVERY_BEHAVIOURS) {
      const points =
        key === "MOOD" ? moodDaily : toDailyMeans(byType.get(key) ?? [], tz);
      series.push({ key, role: "behaviour", points });
    }
    for (const key of DISCOVERY_OUTCOMES) {
      const points =
        key === "MOOD" ? moodDaily : toDailyMeans(byType.get(key) ?? [], tz);
      series.push({ key, role: "outcome", points });
    }

    const result = discoverCorrelations(series);
    return result.discovered
      .filter((d) => d.behaviour === channel || d.outcome === channel)
      .map((d) => ({ interpretation: d.interpretation, n: d.n, r: d.r }));
  } catch {
    return [];
  }
}
