/**
 * Illness correlation engine — the READ layer (v1.18.1, Workstream B / P3).
 *
 * Resolves the per-vital per-day mean series the pure `computeIllnessCorrelation`
 * engine needs, then runs the engine. Two windows per vital, and the seam
 * between them is the BASELINE-CONTAMINATION GUARD:
 *
 *   baselineDays : [onset − lookback − BASELINE_WINDOW_DAYS, onset − lookback)
 *   episodeDays  : [onset − lookback, end]
 *
 * The baseline window ENDS strictly before the pre-onset lookback, so no day
 * inside (or just before) the episode can poison the baseline the episode is
 * measured against. This is the single most important reliability property of
 * the engine — a baseline that includes the illness days would shrink every
 * deviation toward zero and silently under-report the very anomaly we exist to
 * surface.
 *
 * Reads are DAY-native (the spread invariant forbids composing a band from a
 * coarser tier's `sd`): the rollup DAY tier when covered, a bounded per-type
 * live-SQL fallback on a coverage miss. EVERY per-day key is the USER'S local
 * day (`dayKeyForUserTz`), never a raw UTC slice — the onset/feltBetter markers
 * are already keyed in the user's tz, so the vital series must match or a
 * non-UTC user gets an off-by-one (a 03:00Z reading is local D−1 but UTC D).
 * Rollup DAY buckets are minted at the UTC midnight of the user-tz day, so
 * keying their `bucketStart` through `dayKeyForUserTz` is exact.
 */
import pLimit from "p-limit";
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { readBestGranularityRollups } from "@/lib/rollups/measurement-read-wmy";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import { dayKeyForUserTz } from "@/lib/measurements/consolidation-tz";
import { resolveUserTimezone } from "@/lib/measurements/consolidation-base";
import type { Derived } from "@/lib/insights/derived/types";
import {
  BASELINE_WINDOW_DAYS,
  ILLNESS_SCAN_TYPES,
  PRE_ONSET_LOOKBACK_DAYS,
  computeIllnessCorrelation,
  type DayLogFeverPoint,
  type IllnessCorrelationValue,
  type VitalSeries,
} from "./correlation";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Bound the per-vital fan-out so a single episode's scan can't pin the
 * shared Prisma pool. Mirrors the W-POOL `p-limit(4)` discipline the
 * analytics summaries slice applies.
 */
const VITAL_SCAN_CONCURRENCY = 4;

/** The episode shape the read layer needs (a subset of the Prisma row). */
export interface EpisodeForCorrelation {
  id: string;
  onsetAt: Date;
  resolvedAt: Date | null;
  lifecycle: string;
}

/** A windowed per-day read: mean + max per local day, with provenance. */
interface WindowRead {
  points: { day: string; mean: number; max: number }[];
  source: "DAY" | "live" | "none";
}

/**
 * Resolve the per-vital series for one episode (contamination-guarded
 * baseline window) and run the pure engine. Returns the same gated
 * `Derived<T>` the engine returns — `insufficient` flows straight through.
 */
export async function computeEpisodeCorrelation(
  userId: string,
  episode: EpisodeForCorrelation,
  timezone: string | null,
  now: Date = new Date(),
): Promise<Derived<IllnessCorrelationValue>> {
  const tz = resolveUserTimezone(timezone);
  const onset = episode.onsetAt;
  const end = episode.resolvedAt ?? now;

  // Window seams (UTC instants; the day keys are read in the user's tz).
  const preOnsetStart = new Date(
    onset.getTime() - PRE_ONSET_LOOKBACK_DAYS * MS_PER_DAY,
  );
  const baselineEnd = preOnsetStart; // baseline ends where the lookback starts
  const baselineStart = new Date(
    baselineEnd.getTime() - BASELINE_WINDOW_DAYS * MS_PER_DAY,
  );

  const onsetDay = dayKeyForUserTz(onset, tz);
  const feltBetterDay = episode.resolvedAt
    ? dayKeyForUserTz(episode.resolvedAt, tz)
    : null;

  // One coverage probe shared across every vital read (pool-contention
  // mitigation — the same pattern the derived route uses).
  const coverage = await probeRollupCoverage(userId);

  // Attempt every scan type under a bounded concurrency cap. The two
  // windows per type (baseline + episode) are independent reads, so they
  // run paired rather than serially (halving the per-type round-trips).
  // The day-log fever read shares the same fan-out budget.
  const limit = pLimit(VITAL_SCAN_CONCURRENCY);
  const [perType, dayLogFever] = await Promise.all([
    Promise.all(
      ILLNESS_SCAN_TYPES.map((type) =>
        limit(async () => {
          const [baseline, episodeWin] = await Promise.all([
            readWindowMeans(
              userId,
              type,
              baselineStart,
              baselineEnd,
              coverage,
              tz,
              now,
            ),
            readWindowMeans(
              userId,
              type,
              preOnsetStart,
              end,
              coverage,
              tz,
              now,
            ),
          ]);
          return { type, baseline, episodeWin };
        }),
      ),
    ),
    limit(() => readDayLogFever(episode.id, preOnsetStart, end, tz)),
  ]);

  const series: VitalSeries[] = [];
  let anyLive = false;
  let anyDay = false;
  for (const { type, baseline, episodeWin } of perType) {
    if (baseline.points.length === 0 && episodeWin.points.length === 0)
      continue;
    if (baseline.source === "live" || episodeWin.source === "live")
      anyLive = true;
    if (baseline.source === "DAY" || episodeWin.source === "DAY") anyDay = true;
    series.push({
      type,
      baselineDays: baseline.points.map((p) => ({ day: p.day, mean: p.mean })),
      episodeDays: episodeWin.points.map((p) => ({ day: p.day, mean: p.mean })),
      // Per-day max over the episode window — the fever red-flag prefers it so
      // an evening spike averaged toward normal in the daily mean is not masked.
      episodeDayMax: episodeWin.points.map((p) => ({
        day: p.day,
        mean: p.max,
      })),
    });
  }

  const source: "DAY" | "live" | "none" = anyDay
    ? "DAY"
    : anyLive
      ? "live"
      : "none";

  return computeIllnessCorrelation({
    episodeId: episode.id,
    window: { onsetDay, feltBetterDay, lifecycle: episode.lifecycle },
    series,
    dayLogFever,
    source,
    now,
  });
}

/**
 * Per-day mean + max for `(userId, type)` over an explicit [from, to) window,
 * keyed by the USER'S local day. The DAY rollup serves the trailing
 * (`to ≈ now`) case; otherwise a bounded raw read groups per local day. The
 * tz-keying is what keeps the contamination-guard seam and the onset/felt-
 * better markers in the same calendar for a non-UTC user.
 */
async function readWindowMeans(
  userId: string,
  type: MeasurementType,
  from: Date,
  to: Date,
  coverage: Awaited<ReturnType<typeof probeRollupCoverage>>,
  tz: string,
  now: Date,
): Promise<WindowRead> {
  const toIsNow = Math.abs(to.getTime() - now.getTime()) < MS_PER_DAY;

  if (toIsNow && coverage.get(type) === true) {
    const windowDays = Math.max(
      1,
      Math.ceil((to.getTime() - from.getTime()) / MS_PER_DAY),
    );
    const resolved = await readBestGranularityRollups(userId, type, windowDays);
    if (
      resolved &&
      resolved.granularity === "DAY" &&
      resolved.rows.length > 0
    ) {
      const fromKey = dayKeyForUserTz(from, tz);
      // DAY buckets are minted at the UTC midnight of the user-tz day, so
      // keying `bucketStart` through the user tz is exact.
      const points = resolved.rows
        .map((row) => ({
          day: dayKeyForUserTz(row.bucketStart, tz),
          mean: row.mean,
          max: row.maxValue ?? row.mean,
        }))
        .filter((p) => p.day >= fromKey)
        .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
      if (points.length > 0) return { points, source: "DAY" };
    }
    // Coverage said "has buckets" but the window resolved coarser / empty →
    // fall through to the live read so the series stays DAY-native.
  }

  // Bounded raw fallback — group per the USER'S local day (never a UTC slice).
  // A trailing window (`to ≈ now`) reads open-ended (gte only) so it stays a
  // "trailing" read; a bounded window pins `lt` so it can never reach past its
  // seam (the contamination guard for the baseline window).
  const measuredAt = toIsNow ? { gte: from } : { gte: from, lt: to };
  const rows = await prisma.measurement.findMany({
    where: { userId, type, deletedAt: null, measuredAt },
    orderBy: { measuredAt: "asc" },
    select: { value: true, measuredAt: true },
  });
  if (rows.length === 0) return { points: [], source: "none" };
  const byDay = new Map<string, { sum: number; count: number; max: number }>();
  for (const row of rows) {
    const day = dayKeyForUserTz(row.measuredAt, tz);
    const acc = byDay.get(day) ?? { sum: 0, count: 0, max: -Infinity };
    acc.sum += row.value;
    acc.count += 1;
    acc.max = Math.max(acc.max, row.value);
    byDay.set(day, acc);
  }
  const points = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, acc]) => ({ day, mean: acc.sum / acc.count, max: acc.max }));
  return { points, source: "live" };
}

/**
 * Read the illness day-log `feverC` series over [from, to) as per-day MAX
 * fever points (keyed by the stored `date`, which is already the user-tz day
 * string the day-log was logged under). Drops null fevers.
 */
async function readDayLogFever(
  episodeId: string,
  from: Date,
  to: Date,
  tz: string,
): Promise<DayLogFeverPoint[]> {
  const fromKey = dayKeyForUserTz(from, tz);
  const toKey = dayKeyForUserTz(to, tz);
  const rows = await prisma.illnessDayLog.findMany({
    where: {
      episodeId,
      deletedAt: null,
      feverC: { not: null },
      date: { gte: fromKey, lte: toKey },
    },
    select: { date: true, feverC: true },
  });
  const byDay = new Map<string, number>();
  for (const row of rows) {
    if (row.feverC == null) continue;
    byDay.set(row.date, Math.max(byDay.get(row.date) ?? -Infinity, row.feverC));
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, feverC]) => ({ day, feverC }));
}
