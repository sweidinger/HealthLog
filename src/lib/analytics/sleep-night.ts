/**
 * v1.11.4 — per-night sleep aggregation (iOS #1, HIGH).
 *
 * `SLEEP_DURATION` is stored in MINUTES, one row per sleep STAGE per
 * night (IN_BED / AWAKE / ASLEEP / REM / CORE / DEEP) since v1.4.23. The
 * value is NOT cumulative — a single stage row carries only that stage's
 * minutes. Every "last night's sleep" surface therefore has to SUM the
 * stage rows belonging to one night before it shows a headline number;
 * reading the single most-recent row gives one stage, not the night.
 *
 * This helper is the one shared place that turns the raw per-stage rows
 * into per-night totals. The headline "time asleep" is light(CORE) +
 * deep + REM (+ legacy bare `ASLEEP`); IN_BED and AWAKE are excluded
 * from the asleep total, matching the AASM convention already encoded in
 * `sleep-score.ts`'s `ASLEEP_STAGES`. Bare rows with no `sleepStage`
 * (legacy / manual) count as that night's asleep total.
 *
 * Night grouping
 * --------------
 * A "night" is keyed by the wake-day calendar date in the USER's
 * timezone (`userDayKey`). Apple Health / WHOOP write each stage with
 * `measuredAt` at the stage's start instant; all the stages of one
 * sleep session fall on the same wall-clock calendar day, so the tz day
 * key collapses them into one bucket. (This matches the existing
 * `computeSleepStageBreakdown` convention in the analytics route.)
 *
 * Unit
 * ----
 * Totals are returned in MINUTES — the canonical `SLEEP_DURATION` unit
 * (`getUnitForType` → "minutes") — so the existing web consumers that
 * already treat the summary as minutes (e.g. the insights overview's
 * `formatHoursMinutes`) keep working unchanged; they now average per-
 * night totals instead of per-stage rows, which is strictly more
 * correct. Callers that want hours convert at the edge (`/ 60`).
 */
import type { SleepStage } from "@/generated/prisma/client";
import { userDayKey } from "@/lib/tz/resolver";
import { summarize, type DataSummary } from "@/lib/analytics/trends";

/** Stages that count toward "time asleep" (excludes IN_BED + AWAKE). */
const ASLEEP_STAGES: ReadonlySet<SleepStage> = new Set<SleepStage>([
  "ASLEEP",
  "REM",
  "CORE",
  "DEEP",
]);

export interface SleepStageRow {
  value: number;
  measuredAt: Date;
  sleepStage: SleepStage | null;
}

/** One reconstructed night: the asleep total + the per-stage breakdown. */
export interface SleepNight {
  /** Wake-day key (YYYY-MM-DD) in the user's timezone. */
  night: string;
  /** Latest stage instant in the night — the night's representative timestamp. */
  measuredAt: Date;
  /** Time asleep in minutes = CORE + DEEP + REM (+ legacy bare ASLEEP). */
  asleepMinutes: number;
  /** In-bed minutes when an IN_BED row exists, else null. */
  inBedMinutes: number | null;
  /** Awake-in-bed minutes when an AWAKE row exists, else null. */
  awakeMinutes: number | null;
  /** Per-stage minutes for the night (only stages the device reported). */
  stages: Partial<Record<SleepStage, number>>;
}

/**
 * Group raw per-stage rows into per-night totals (tz-aware wake-day key).
 * Pure — the caller does the bounded DB read. Nights are returned sorted
 * ascending by key so the last element is the most recent night.
 */
export function reconstructSleepNights(
  rows: SleepStageRow[],
  tz: string,
): SleepNight[] {
  const byNight = new Map<string, SleepStageRow[]>();
  for (const row of rows) {
    const key = userDayKey(row.measuredAt, tz);
    const list = byNight.get(key) ?? [];
    list.push(row);
    byNight.set(key, list);
  }

  const nights: SleepNight[] = [];
  for (const [night, nightRows] of byNight) {
    let asleep = 0;
    let inBed = 0;
    let awake = 0;
    let sawInBed = false;
    let sawAwake = false;
    let latest = nightRows[0].measuredAt;
    const stages: Partial<Record<SleepStage, number>> = {};
    for (const r of nightRows) {
      const minutes = Number.isFinite(r.value) ? r.value : 0;
      if (r.measuredAt.getTime() > latest.getTime()) latest = r.measuredAt;
      const stage = r.sleepStage;
      if (stage) {
        stages[stage] = (stages[stage] ?? 0) + minutes;
      }
      if (stage === "IN_BED") {
        inBed += minutes;
        sawInBed = true;
      } else if (stage === "AWAKE") {
        awake += minutes;
        sawAwake = true;
      } else if (stage && ASLEEP_STAGES.has(stage)) {
        asleep += minutes;
      } else if (stage == null) {
        // Bare SLEEP_DURATION row (no stage) — the night's total asleep.
        asleep += minutes;
      }
    }
    nights.push({
      night,
      measuredAt: latest,
      asleepMinutes: asleep,
      inBedMinutes: sawInBed ? inBed : null,
      awakeMinutes: sawAwake ? awake : null,
      stages,
    });
  }
  return nights.sort((a, b) => (a.night < b.night ? -1 : 1));
}

export interface SleepNightSummary {
  /**
   * A `DataSummary` whose every value is a per-night TIME-ASLEEP total
   * (minutes). Drop-in replacement for the per-stage `summaries.
   * SLEEP_DURATION` the slim slice produced. Null when no night has any
   * asleep minutes in the supplied rows.
   */
  summary: DataSummary;
  /** The most recent night (for the dashboard/series headline), or null. */
  latestNight: SleepNight | null;
}

/**
 * Reconstruct nights from raw rows and summarise the per-night asleep
 * totals. Nights with zero asleep minutes are dropped (an IN_BED-only or
 * AWAKE-only fragment is not a scorable night). The returned `summary`
 * uses one DataPoint per night so `summarize()`'s windowed avg7 / avg30
 * become "average nightly sleep over the trailing N days".
 */
export function summarizeSleepNights(
  rows: SleepStageRow[],
  tz: string,
): SleepNightSummary {
  const nights = reconstructSleepNights(rows, tz).filter(
    (n) => n.asleepMinutes > 0,
  );
  const dataPoints = nights.map((n) => ({
    date: n.measuredAt,
    value: n.asleepMinutes,
  }));
  return {
    summary: summarize(dataPoints),
    latestNight: nights.length > 0 ? nights[nights.length - 1] : null,
  };
}
