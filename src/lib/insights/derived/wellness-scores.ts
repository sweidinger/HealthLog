/**
 * v1.10.0 — passthrough read of the persisted nightly wellness scores
 * (`RECOVERY_SCORE` / `STRESS_SCORE` / `STRAIN_SCORE`).
 *
 * These three 0–100 composites are NOT recomputed here. A nightly job
 * (`src/lib/jobs/{recovery,stress,strain}-score.ts`) writes them as
 * `COMPUTED`-source Measurement rows; this engine simply reads the most
 * recent persisted value plus a short trend so the SAME `Derived<T>`
 * contract every other derived metric speaks also carries the scores. No
 * surface ever recomputes — the dashboard, Coach, and doctor report all
 * pattern-match the `Derived<WellnessScoreValue>` this returns.
 *
 * Server-only — reads `@/lib/db`.
 */
import { prisma } from "@/lib/db";
import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import { buildInsufficient, buildOk, nowProvenanceTimestamp } from "./coverage";
import type { BaselineProfile } from "./baseline";
import type { StrainAnchor } from "@/lib/insights/strain-score";
import { resolveCanonicalRecovery } from "./recovery-resolve";
import { SPARKLINE_MAX_POINTS, type Derived } from "./types";

/** A 0–100 wellness score band. Higher is better for recovery; for stress a
 *  higher score is worse, so the band direction flips (see `WELLNESS_DIR`). */
export type WellnessScoreBand = "green" | "yellow" | "red";

export interface WellnessScoreValue {
  /** The latest persisted 0–100 score. */
  score: number;
  band: WellnessScoreBand;
  /** Score minus the trailing-window mean (excluding today), or null. */
  trendDelta: number | null;
  /** Distinct days with a score in the window — drives the trend confidence. */
  daysInWindow: number;
  /** ISO timestamp of the latest score's `measuredAt`. */
  asOf: string;
  /**
   * Trailing score series (oldest → newest), capped to the last
   * `SPARKLINE_MAX_POINTS`. Reuses the window rows already read — no extra
   * query.
   */
  series: number[];
  /**
   * STRAIN only — which anchor produced THIS score: `personal` once the user
   * has enough training history to be judged against their own typical effort,
   * `population` during cold start. Read from the latest `strain_trimp_cache`
   * row for the scored day so the UI can show the framing line that actually
   * applies, not a generic both-regimes blurb. `null` for RECOVERY / STRESS
   * (no anchor concept) or when no cache row exists yet (additive — iOS
   * non-breaking).
   */
  anchor?: StrainAnchor | null;
}

/** The three persisted score types this engine serves. */
export const WELLNESS_SCORE_TYPES = {
  RECOVERY_SCORE: "RECOVERY_SCORE",
  STRESS_SCORE: "STRESS_SCORE",
  STRAIN_SCORE: "STRAIN_SCORE",
} as const;

export type WellnessScoreType = keyof typeof WELLNESS_SCORE_TYPES;

/** `true` when a higher score is the healthier direction. Stress + strain
 *  invert (more = worse / harder), so the band flips for them. */
const HIGHER_IS_BETTER: Record<WellnessScoreType, boolean> = {
  RECOVERY_SCORE: true,
  STRESS_SCORE: false,
  STRAIN_SCORE: false,
};

/** Band a 0–100 score honouring the metric's direction. */
export function bandWellnessScore(
  type: WellnessScoreType,
  score: number,
): WellnessScoreBand {
  const good = HIGHER_IS_BETTER[type]
    ? score
    : // Invert for stress/strain so 80 stress reads red, not green.
      100 - score;
  if (good >= 70) return "green";
  if (good >= 40) return "yellow";
  return "red";
}

export interface WellnessScoreOpts {
  /** Trailing window for the trend mean (days). Defaults to 14. */
  windowDays?: number;
  now?: Date;
}

/**
 * Read the latest persisted wellness score + a trailing trend. Returns
 * `insufficient` with `reason: "no_score_in_window"` when the nightly job
 * has not yet written one (e.g. a brand-new account, or no underlying
 * signals) — never a fabricated value.
 */
export async function computeWellnessScore(
  type: WellnessScoreType,
  userId: string,
  _profile: BaselineProfile,
  opts: WellnessScoreOpts = {},
): Promise<Derived<WellnessScoreValue>> {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 14;
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const computedAt = nowProvenanceTimestamp(now);
  const measurementType = WELLNESS_SCORE_TYPES[type] as MeasurementType;

  // RECOVERY_SCORE is written by TWO sources for the same day — the WHOOP
  // native percentage and the COMPUTED proxy. The native row is canonical when
  // present, so the read must NOT hard-filter to COMPUTED (that silently drops
  // every ingested native row); read both sources and resolve per day below.
  // STRESS / STRAIN are COMPUTED-only, so they keep the source filter.
  const isRecovery = type === "RECOVERY_SCORE";
  const rawRows = await prisma.measurement.findMany({
    where: {
      userId,
      type: measurementType,
      ...(isRecovery ? {} : { source: "COMPUTED" as MeasurementSource }),
      deletedAt: null,
      measuredAt: { gte: cutoff, lte: now },
    },
    select: { value: true, measuredAt: true, source: true },
    orderBy: { measuredAt: "desc" },
  });

  // Collapse a mixed-source recovery set to ONE canonical row per day (WHOOP
  // wins over COMPUTED). Non-recovery sets are already single-source, so the
  // resolver is recovery-only — the tile, doctor PDF, and iOS feed all read the
  // SAME canonical value.
  const rows = isRecovery
    ? resolveCanonicalRecovery(
        rawRows.map((r) => ({
          value: r.value,
          measuredAt: r.measuredAt,
          source: r.source,
        })),
      )
    : rawRows;

  if (rows.length === 0) {
    return buildInsufficient<WellnessScoreValue>({
      coverage: {
        requiredInputs: 1,
        presentInputs: 0,
        historyDays: 0,
        missing: [type],
      },
      provenance: { inputs: [type], source: "none", windowDays, computedAt },
      reason: "no_score_in_window",
    });
  }

  const latest = rows[0];
  const score = Math.round(latest.value);
  // Trend = latest vs the mean of the prior rows in the window.
  const prior = rows.slice(1);
  const trendDelta =
    prior.length > 0
      ? Math.round(
          score - prior.reduce((s, r) => s + r.value, 0) / prior.length,
        )
      : null;

  // STRAIN carries the active anchor for the scored day so the UI shows the
  // framing line that actually produced THIS score (personal-relative vs the
  // cold-start population reference). The `strain_trimp_cache` row is keyed by
  // the same day stamp the score row carries (`scoreDayKey` → noon-UTC
  // `measuredAt`), so the latest score's day key is the cache key. Source of
  // truth is the cache row, not a re-derivation here.
  let anchor: StrainAnchor | null = null;
  if (type === "STRAIN_SCORE") {
    const day = latest.measuredAt.toISOString().slice(0, 10);
    const cache = await prisma.strainTrimpCache.findUnique({
      where: { userId_day: { userId, day } },
      select: { anchor: true },
    });
    if (cache?.anchor === "personal" || cache?.anchor === "population") {
      anchor = cache.anchor;
    }
  }

  return buildOk<WellnessScoreValue>({
    value: {
      score,
      band: bandWellnessScore(type, score),
      trendDelta,
      daysInWindow: rows.length,
      asOf: latest.measuredAt.toISOString(),
      // rows are newest-first; the sparkline wants oldest → newest, capped.
      series: rows
        .slice(0, SPARKLINE_MAX_POINTS)
        .map((r) => r.value)
        .reverse(),
      anchor,
    },
    coverage: {
      requiredInputs: 1,
      presentInputs: 1,
      historyDays: rows.length,
      missing: [],
    },
    // The score is a persisted, already-computed composite — high
    // confidence by construction; the trailing-day count carries the
    // trend's strength via the coverage meter rather than the band.
    confidence: { score: 90, band: "high" },
    provenance: {
      inputs: [type],
      source: "DAY",
      windowDays,
      computedAt,
    },
  });
}
