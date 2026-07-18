/**
 * Effort zones for the workout-detail page. Descriptive, never
 * prescriptive — a distribution of time-in-zone, not a training
 * verdict or a cardiac interpretation (non-diagnostic standard).
 *
 * Display model: five %HRmax zones (Z1 50–60 %, Z2 60–70 %, Z3 70–80 %,
 * Z4 80–90 %, Z5 90 %+), HRmax from the grounded `tanakaHrMax()`
 * (profile age). %HRmax over Karvonen because it needs only age and
 * matches every consumer device's zone labelling — the strain engine
 * owns the HRR/TRIMP math internally; the detail page merely describes.
 *
 * Resolution order:
 *   1. WHOOP `metadata.zoneDurations` — device-authoritative time in
 *      zone, parsed through a narrow slice (JSON is never duck-typed).
 *   2. Computed time-in-zone from the HR series, when profile age
 *      exists.
 *   3. Neither → `null`, and the caller hides the zones card.
 */
import { z } from "zod/v4";

import { tanakaHrMax } from "@/lib/insights/strain-score";
import type { HrSeriesPoint } from "@/lib/workouts/hr-series";

export type ZonesModel = "whoop" | "tanaka";

export interface ZoneBand {
  /** 1–5. */
  zone: number;
  /** Lower bpm bound (null when HRmax is unknown — WHOOP-only path). */
  lowBpm: number | null;
  /** Upper bpm bound; null for the open-ended top zone. */
  highBpm: number | null;
  /** Time spent in the zone, seconds. */
  seconds: number;
}

export interface WorkoutZones {
  model: ZonesModel;
  hrMax: number | null;
  zones: ZoneBand[];
}

/** %HRmax band edges. The top zone is open-ended (highPct = null). */
const ZONE_EDGES: Array<{
  zone: number;
  lowPct: number;
  highPct: number | null;
}> = [
  { zone: 1, lowPct: 0.5, highPct: 0.6 },
  { zone: 2, lowPct: 0.6, highPct: 0.7 },
  { zone: 3, lowPct: 0.7, highPct: 0.8 },
  { zone: 4, lowPct: 0.8, highPct: 0.9 },
  { zone: 5, lowPct: 0.9, highPct: null },
];

function bandBounds(hrMax: number | null) {
  return ZONE_EDGES.map((e) => ({
    zone: e.zone,
    lowBpm: hrMax != null ? Math.round(hrMax * e.lowPct) : null,
    highBpm:
      hrMax != null && e.highPct != null ? Math.round(hrMax * e.highPct) : null,
  }));
}

/**
 * Narrow slice of WHOOP's `zone_durations` (milliseconds per zone). The
 * API ships `zone_zero_milli` (below Z1, recovery) through
 * `zone_five_milli`; we map zones one–five onto our Z1–Z5 and drop
 * zone-zero from the five-zone display, mirroring the device's own
 * five-zone labelling.
 */
const whoopZoneDurationsSchema = z
  .object({
    zone_zero_milli: z.number().nonnegative().optional(),
    zone_one_milli: z.number().nonnegative().optional(),
    zone_two_milli: z.number().nonnegative().optional(),
    zone_three_milli: z.number().nonnegative().optional(),
    zone_four_milli: z.number().nonnegative().optional(),
    zone_five_milli: z.number().nonnegative().optional(),
  })
  .transform((v) => [
    v.zone_one_milli ?? 0,
    v.zone_two_milli ?? 0,
    v.zone_three_milli ?? 0,
    v.zone_four_milli ?? 0,
    v.zone_five_milli ?? 0,
  ]);

/**
 * Pull WHOOP zone durations (seconds per Z1–Z5) out of a workout's
 * metadata blob, or `null` when absent / malformed / all-zero.
 */
export function parseWhoopZoneDurations(metadata: unknown): number[] | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>).zoneDurations;
  if (!raw || typeof raw !== "object") return null;
  const parsed = whoopZoneDurationsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const seconds = parsed.data.map((ms) => ms / 1000);
  return seconds.some((s) => s > 0) ? seconds : null;
}

/** %HRmax zone index (1–5) for a heart rate, or 0 for below-Z1 (rest). */
function zoneForHr(hr: number, hrMax: number): number {
  const pct = hr / hrMax;
  for (const e of ZONE_EDGES) {
    if (e.highPct == null) return e.zone; // top zone catches everything ≥ Z5 low
    if (pct < e.highPct) return pct >= e.lowPct ? e.zone : 0;
  }
  return 0;
}

export interface ComputeZonesInput {
  hrMax: number | null;
  series: readonly HrSeriesPoint[];
  bucketSec: number;
  whoopZoneDurations: number[] | null;
}

/**
 * Resolve the effort-zone distribution. WHOOP's device-reported
 * durations win when present; otherwise time-in-zone is folded from the
 * HR series (each non-empty bucket contributes `bucketSec` seconds at
 * its mean HR). Below-Z1 (rest) time is excluded from the five-zone
 * display. Returns `null` when neither source is available.
 */
export function computeZones(input: ComputeZonesInput): WorkoutZones | null {
  const { hrMax, series, bucketSec, whoopZoneDurations } = input;

  if (whoopZoneDurations) {
    const bounds = bandBounds(hrMax);
    return {
      model: "whoop",
      hrMax,
      zones: bounds.map((b, i) => ({
        ...b,
        seconds: Math.round(whoopZoneDurations[i] ?? 0),
      })),
    };
  }

  if (hrMax == null || series.length === 0) return null;

  const seconds = [0, 0, 0, 0, 0];
  for (const p of series) {
    const zone = zoneForHr(p.mean, hrMax);
    if (zone >= 1 && zone <= 5) seconds[zone - 1] += bucketSec;
  }
  if (seconds.every((s) => s === 0)) return null;

  const bounds = bandBounds(hrMax);
  return {
    model: "tanaka",
    hrMax,
    zones: bounds.map((b, i) => ({ ...b, seconds: seconds[i] })),
  };
}

/** Convenience: HRmax from profile age (Tanaka), or null when no age. */
export function hrMaxFromAge(ageYears: number | null): number | null {
  return ageYears != null ? Math.round(tanakaHrMax(ageYears)) : null;
}
