/**
 * v1.28.50 — min/max decimation for the ECG display waveform.
 *
 * A Withings ScanWatch strip is ~9000 micro-volt samples (30 s at 300 Hz).
 * A fit-to-width overview does not need every raw sample to reach the
 * client, but a NAIVE stride-decimation (keep every Nth sample) silently
 * drops the R-wave peaks that sit between the kept indices and would
 * misrepresent the trace — the one thing an ECG must never do.
 *
 * Min/max decimation avoids that: the sample range is split into buckets,
 * and each bucket emits BOTH its minimum and its maximum sample, in the
 * order the two extremes actually occur within the bucket. The global
 * extreme of every bucket therefore always survives, so the tall, narrow
 * QRS spikes are preserved even at a heavy reduction ratio. The output is
 * ~`targetPoints` values (2 per bucket); the x-position of each point is
 * implied by its index, so the renderer maps it evenly across the strip
 * width — the display is an overview, not a calibrated-time axis (the
 * `?full=1` raw path serves the true-calibration view).
 *
 * Pure + side-effect-free so the reduction ratio and peak-preservation are
 * unit-testable without a route.
 */

/**
 * Default output-point budget for the decimated overview waveform
 * (~2 points per bucket, so ~1250 buckets). Chosen per the ECG display
 * design: dense enough that the compressed strip reads as a continuous
 * trace, small enough that the JSON payload stays ~15–25 KB.
 */
export const ECG_DISPLAY_TARGET_POINTS = 2500;

/**
 * Reduce a raw sample array to at most ~`targetPoints` values using
 * min/max decimation. Returns a copy of the input unchanged when it is
 * already at or below the target (or the target is non-positive) — the
 * caller then reports `decimated: false`.
 */
export function decimateMinMax(
  samples: number[],
  targetPoints: number,
): number[] {
  const n = samples.length;
  if (n === 0) return [];
  // Nothing to gain from bucketing — hand back the raw trace.
  if (targetPoints <= 0 || targetPoints >= n) return samples.slice();

  // Two output points per bucket (a min and a max), so the bucket count is
  // half the point budget. Guard the degenerate case where bucketing would
  // not actually shrink the array.
  const buckets = Math.max(1, Math.floor(targetPoints / 2));
  if (buckets * 2 >= n) return samples.slice();

  const out: number[] = [];
  const bucketSize = n / buckets;

  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * bucketSize);
    // The last bucket always runs to the end so no tail sample is dropped.
    const end = b === buckets - 1 ? n : Math.floor((b + 1) * bucketSize);

    let minIdx = start;
    let maxIdx = start;
    for (let i = start + 1; i < end; i++) {
      if (samples[i] < samples[minIdx]) minIdx = i;
      if (samples[i] > samples[maxIdx]) maxIdx = i;
    }

    // Emit the two extremes in the order they occur so the trace keeps its
    // shape (an up-then-down bucket reads up-then-down). A flat bucket
    // where min === max emits a single point.
    if (minIdx === maxIdx) {
      out.push(samples[minIdx]);
    } else if (minIdx < maxIdx) {
      out.push(samples[minIdx]);
      out.push(samples[maxIdx]);
    } else {
      out.push(samples[maxIdx]);
      out.push(samples[minIdx]);
    }
  }

  return out;
}
