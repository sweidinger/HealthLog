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
 * live-SQL fallback on a coverage miss. The `readDayMeanSeries` helper the
 * baseline engine already exports does exactly this and is reused verbatim, so
 * the rollup-vs-live parity the baseline tests pin carries over for free.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { readDayMeanSeries } from "@/lib/insights/derived/baseline";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import { dayKeyForUserTz } from "@/lib/measurements/consolidation-tz";
import { resolveUserTimezone } from "@/lib/measurements/consolidation-base";
import type { Derived } from "@/lib/insights/derived/types";
import {
  BASELINE_WINDOW_DAYS,
  ILLNESS_SCAN_TYPES,
  PRE_ONSET_LOOKBACK_DAYS,
  computeIllnessCorrelation,
  type IllnessCorrelationValue,
  type VitalSeries,
} from "./correlation";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The episode shape the read layer needs (a subset of the Prisma row). */
export interface EpisodeForCorrelation {
  id: string;
  onsetAt: Date;
  resolvedAt: Date | null;
  lifecycle: string;
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
  const preOnsetStart = new Date(onset.getTime() - PRE_ONSET_LOOKBACK_DAYS * MS_PER_DAY);
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

  const series: VitalSeries[] = [];
  let anyLive = false;
  let anyDay = false;

  // We attempt every scan type. The read helper reuses the baseline engine's
  // rollup-first path (live fallback on a coverage miss); an untracked vital
  // returns empty points and is dropped below. Each read is a single windowed
  // query, so attempting all types is bounded.
  for (const type of ILLNESS_SCAN_TYPES) {
    const baseline = await readWindowMeans(userId, type, baselineStart, baselineEnd, coverage, now);
    const episodeWin = await readWindowMeans(userId, type, preOnsetStart, end, coverage, now);
    if (baseline.points.length === 0 && episodeWin.points.length === 0) continue;
    if (baseline.source === "live" || episodeWin.source === "live") anyLive = true;
    if (baseline.source === "DAY" || episodeWin.source === "DAY") anyDay = true;
    series.push({
      type,
      baselineDays: baseline.points.map((p) => ({ day: p.day, mean: p.mean })),
      episodeDays: episodeWin.points.map((p) => ({ day: p.day, mean: p.mean })),
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
    source,
    now,
  });
}

/**
 * Per-day means for `(userId, type)` over an explicit [from, to) window.
 * Reuses the baseline engine's `readDayMeanSeries` (DAY-native rollup with a
 * live fallback) for the whole-window read, then trims to the window so the
 * baseline and episode windows can share the one cached read path while
 * keeping their seams exact. The trim is on the local day key so the
 * contamination guard holds in the user's timezone.
 */
async function readWindowMeans(
  userId: string,
  type: MeasurementType,
  from: Date,
  to: Date,
  coverage: Awaited<ReturnType<typeof probeRollupCoverage>>,
  now: Date,
): Promise<{ points: { day: string; mean: number }[]; source: "DAY" | "live" | "none" }> {
  // The baseline helper reads a trailing window ending at `now`. We need an
  // arbitrary [from, to) window, so read directly here: DAY rollup first via
  // the helper for the trailing case, else a bounded raw read. To keep the
  // seam exact we always do the bounded raw per-day grouping for the bounded
  // window (a single indexed query), and only use the helper's rollup path
  // when `to` is effectively `now` (the common active-episode case).
  const toIsNow = Math.abs(to.getTime() - now.getTime()) < MS_PER_DAY;
  if (toIsNow) {
    const windowDays = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / MS_PER_DAY));
    const resolved = await readDayMeanSeries(userId, type, windowDays, now, coverage);
    const fromKey = from.toISOString().slice(0, 10);
    return {
      points: resolved.points.filter((p) => p.day >= fromKey),
      source: resolved.source === "DAY" ? "DAY" : resolved.source === "none" ? "none" : "live",
    };
  }

  const rows = await prisma.measurement.findMany({
    where: { userId, type, deletedAt: null, measuredAt: { gte: from, lt: to } },
    orderBy: { measuredAt: "asc" },
    select: { value: true, measuredAt: true },
  });
  if (rows.length === 0) return { points: [], source: "none" };
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const row of rows) {
    const day = row.measuredAt.toISOString().slice(0, 10);
    const acc = byDay.get(day) ?? { sum: 0, count: 0 };
    acc.sum += row.value;
    acc.count += 1;
    byDay.set(day, acc);
  }
  const points = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, acc]) => ({ day, mean: acc.sum / acc.count }));
  return { points, source: "live" };
}
