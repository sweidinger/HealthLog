/**
 * Workouts block for the Coach snapshot (v1.7.0).
 *
 * The Workout model is never dumped row-for-row. The block carries
 * the most recent `WORKOUT_RECENT_CAP` sessions (sport, duration,
 * energy, distance, avg/max HR) plus a per-sport weekly count + total
 * duration/energy rollup for the tail so the prompt stays bounded
 * even for a heavy-training account at a long window.
 *
 * Split out of `snapshot.ts`; the builder passes the rows it already
 * read plus the shared accumulators, so the emitted shape and ordering
 * are unchanged.
 */
import { annotate } from "@/lib/logging/context";
import { tzDayKey, tzWeekday } from "../snapshot-series";
import type {
  CoachProvenance,
  CoachProvenanceMetric,
  CoachScopeSource,
} from "../types";

/**
 * v1.7.0 — the workouts block never dumps every session. It carries
 * the most-recent N sessions verbatim plus a per-sport rollup for the
 * tail, so a heavy-training account at a long window stays bounded.
 */
const WORKOUT_RECENT_CAP = 15;

interface WorkoutsBlockContext {
  workoutRows: Array<{
    sportType: string;
    startedAt: Date;
    durationSec: number;
    totalEnergyKcal: number | null;
    totalDistanceM: number | null;
    avgHeartRate: number | null;
    maxHeartRate: number | null;
  }>;
  userTz: string;
  snapshot: Record<string, unknown>;
  metrics: Set<CoachProvenanceMetric>;
  counts: NonNullable<CoachProvenance["counts"]>;
  registerBlock: (key: string, source: CoachScopeSource) => void;
}

export function buildWorkoutsBlock(ctx: Readonly<WorkoutsBlockContext>): void {
  const { workoutRows, userTz, snapshot, metrics, counts, registerBlock } = ctx;
  // The workout sessions are read in parallel by the builder.
  if (workoutRows.length === 0) {
    annotate({
      action: { name: "coach.cluster.empty_skipped" },
      meta: { cluster: "workouts", source: "workouts" },
    });
  } else {
    const recentList = workoutRows.slice(0, WORKOUT_RECENT_CAP).map((w) => ({
      date: tzDayKey(w.startedAt, userTz),
      weekday: tzWeekday(w.startedAt, userTz),
      sport: w.sportType,
      durationMin: Math.round(w.durationSec / 60),
      energyKcal: w.totalEnergyKcal ?? null,
      distanceM: w.totalDistanceM ?? null,
      avgHr: w.avgHeartRate ?? null,
      maxHr: w.maxHeartRate ?? null,
    }));
    // Per-sport rollup over the whole window.
    const bySport = new Map<
      string,
      { count: number; durationMin: number; energyKcal: number }
    >();
    for (const w of workoutRows) {
      const e = bySport.get(w.sportType) ?? {
        count: 0,
        durationMin: 0,
        energyKcal: 0,
      };
      e.count += 1;
      e.durationMin += Math.round(w.durationSec / 60);
      e.energyKcal += w.totalEnergyKcal ?? 0;
      bySport.set(w.sportType, e);
    }
    const sportRollup = Array.from(bySport.entries())
      .map(([sport, v]) => ({
        sport,
        count: v.count,
        totalDurationMin: v.durationMin,
        totalEnergyKcal: Math.round(v.energyKcal),
      }))
      .sort((a, b) => b.count - a.count);
    snapshot.workouts = {
      recent: recentList,
      perSport: sportRollup,
      totalInWindow: workoutRows.length,
    };
    metrics.add("workouts");
    counts.workouts = workoutRows.length;
    registerBlock("workouts", "workouts");
  }
}
