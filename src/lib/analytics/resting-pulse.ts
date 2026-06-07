/**
 * v1.15.12 A2 — resting-pulse estimation.
 *
 * Apple Health maps two distinct signals onto two distinct measurement
 * types:
 *   - `HKQuantityTypeIdentifierHeartRate`        → `PULSE`   (every HR
 *     sample, including workout / activity HR — intentionally high)
 *   - `HKQuantityTypeIdentifierRestingHeartRate` → `RESTING_HEART_RATE`
 *     (one clean daily resting figure)
 *
 * Up to v1.15.11 every surface that applied a RESTING pulse target (the
 * "Resting pulse" tile + its consistency strip, the pulse in-target %,
 * the dashboard resting classification) scored the raw `PULSE` series
 * against a resting band. For an Apple-Health user a single workout
 * emits ~500 high samples, so the resting-target evaluation read ~32 %
 * "over target" even though the user's clean `RESTING_HEART_RATE`
 * averages a healthy ~72 bpm. That is wrong: workout HR is expected-high,
 * not a resting excursion.
 *
 * The fix: judge a RESTING band against a RESTING series.
 *
 *   1. **Prefer `RESTING_HEART_RATE`** when the user has it (Apple
 *      already separated the clean signal for us).
 *   2. **Fallback proxy from `PULSE`** when no `RESTING_HEART_RATE`
 *      exists (manual-only users, older imports): take a robust
 *      low-percentile of each calendar day's PULSE samples — the resting
 *      heart rate is the floor of the day, not its average, so the daily
 *      20th percentile estimates resting while excluding the workout
 *      burst that sits in the upper tail. A single high-density workout
 *      cannot drag the estimate up because it lives above the 20th
 *      percentile of the day.
 *
 * The raw `PULSE` series, where it is merely charted as "heart rate",
 * must NOT be judged against the resting band — callers chart it with a
 * contextual band or no resting overlay.
 *
 * Pure & deterministic — unit-tested in `__tests__/resting-pulse.test.ts`.
 */
import { percentile } from "@/lib/insights/strain-score";
import { toBerlinDayKey } from "@/lib/tz/resolver";

/** A timestamped heart-rate sample. */
export interface PulseSample {
  measuredAt: Date;
  value: number;
}

/**
 * The percentile of each day's PULSE samples used as that day's resting
 * estimate. The 20th percentile sits comfortably in the day's low band
 * (above the rare sleeping-bradycardia outlier, below the bulk of waking
 * + workout HR), so it tracks resting HR without being pulled up by a
 * dense workout burst.
 */
export const RESTING_PROXY_DAILY_PERCENTILE = 20;

/**
 * Collapse raw `PULSE` samples into a per-Berlin-day resting-proxy
 * series: one `{ measuredAt, value }` per day where `value` is the day's
 * low-percentile PULSE. The `measuredAt` anchors on the day's first
 * sample so downstream day-bucketing keys it back to the same day.
 *
 * Exported for direct testing; production callers use
 * `resolveRestingPulseSeries`.
 */
export function deriveRestingProxyFromPulse(
  pulseSamples: ReadonlyArray<PulseSample>,
  /**
   * Day-key function used to bucket samples. Defaults to Berlin-day so
   * direct callers / tests stay zero-config; the targets route passes
   * its own `userDayKey(d, userTz)` so the proxy buckets align with the
   * route's consistency-strip day buckets for non-Berlin users.
   */
  dayKeyOf: (d: Date) => string = toBerlinDayKey,
): PulseSample[] {
  if (pulseSamples.length === 0) return [];
  const byDay = new Map<string, { firstAt: Date; values: number[] }>();
  for (const s of pulseSamples) {
    const key = dayKeyOf(s.measuredAt);
    const bucket = byDay.get(key);
    if (bucket) {
      bucket.values.push(s.value);
      if (s.measuredAt < bucket.firstAt) bucket.firstAt = s.measuredAt;
    } else {
      byDay.set(key, { firstAt: s.measuredAt, values: [s.value] });
    }
  }
  const out: PulseSample[] = [];
  for (const { firstAt, values } of byDay.values()) {
    out.push({
      measuredAt: firstAt,
      value: Math.round(percentile(values, RESTING_PROXY_DAILY_PERCENTILE)),
    });
  }
  out.sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
  return out;
}

/**
 * Resolve the resting-pulse series a resting-target surface should
 * score. Prefers the clean `RESTING_HEART_RATE` rows; falls back to the
 * low-percentile PULSE proxy when the user has no resting rows.
 *
 * `which` reports the branch taken so callers can annotate / label
 * honestly ("resting heart rate" vs "estimated from heart rate").
 */
export function resolveRestingPulseSeries(input: {
  restingSamples: ReadonlyArray<PulseSample>;
  pulseSamples: ReadonlyArray<PulseSample>;
  /** Optional day-key for the proxy buckets (defaults to Berlin-day). */
  dayKeyOf?: (d: Date) => string;
}): { series: PulseSample[]; which: "resting" | "proxy" | "none" } {
  if (input.restingSamples.length > 0) {
    const series = [...input.restingSamples].sort(
      (a, b) => a.measuredAt.getTime() - b.measuredAt.getTime(),
    );
    return { series, which: "resting" };
  }
  const proxy = deriveRestingProxyFromPulse(
    input.pulseSamples,
    input.dayKeyOf,
  );
  if (proxy.length > 0) return { series: proxy, which: "proxy" };
  return { series: [], which: "none" };
}
