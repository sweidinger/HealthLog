/**
 * Correlation analysis between health metrics.
 * Pure functions — no DB access.
 */

import type { DataPoint } from "./trends";
import { pearson, MAX_P_VALUE } from "@/lib/insights/correlations";

export interface PairedPoint {
  a: number;
  b: number;
  date: Date;
}

export interface CorrelationResult {
  r: number;
  strength: "stark" | "moderat" | "schwach" | "keine";
  n: number;
}

/**
 * Pair two time-series by matching timestamps within a maximum gap.
 * Each point is used at most once (greedy nearest-match).
 *
 * NOTE: This is a greedy heuristic, not the bipartite-minimum-weight
 * optimum. For sparse health data the difference is negligible — well
 * under 1% in the v1.4 charts auditor's stress sample — but adversarial
 * inputs (alternating 1ms-apart points) can produce sub-optimal
 * pairings. If exact pairing matters, swap in a Hungarian-style match.
 */
export function pairByTimestamp(
  seriesA: DataPoint[],
  seriesB: DataPoint[],
  maxGapMs: number = 24 * 60 * 60 * 1000, // default 1 day
): PairedPoint[] {
  if (seriesA.length === 0 || seriesB.length === 0) return [];

  const sortedA = [...seriesA].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
  const sortedB = [...seriesB].sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );

  const usedB = new Set<number>();
  const pairs: PairedPoint[] = [];

  for (const a of sortedA) {
    let bestIdx = -1;
    let bestGap = Infinity;

    for (let i = 0; i < sortedB.length; i++) {
      if (usedB.has(i)) continue;
      const gap = Math.abs(a.date.getTime() - sortedB[i].date.getTime());
      if (gap <= maxGapMs && gap < bestGap) {
        bestGap = gap;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      usedB.add(bestIdx);
      pairs.push({
        a: a.value,
        b: sortedB[bestIdx].value,
        date: a.date,
      });
    }
  }

  return pairs.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * Pearson correlation coefficient.
 * Returns null if fewer than minPairs data points.
 */
export function pearsonCorrelation(
  pairs: PairedPoint[],
  minPairs: number = 5,
): CorrelationResult | null {
  if (pairs.length < minPairs) return null;

  const n = pairs.length;
  const sumA = pairs.reduce((s, p) => s + p.a, 0);
  const sumB = pairs.reduce((s, p) => s + p.b, 0);
  const sumAB = pairs.reduce((s, p) => s + p.a * p.b, 0);
  const sumAA = pairs.reduce((s, p) => s + p.a * p.a, 0);
  const sumBB = pairs.reduce((s, p) => s + p.b * p.b, 0);

  const denominator = Math.sqrt(
    (n * sumAA - sumA * sumA) * (n * sumBB - sumB * sumB),
  );

  if (denominator === 0) return { r: 0, strength: "keine", n };

  const r = Math.round(((n * sumAB - sumA * sumB) / denominator) * 1000) / 1000;
  const absR = Math.abs(r);

  let strength: CorrelationResult["strength"];
  if (absR >= 0.7) strength = "stark";
  else if (absR >= 0.4) strength = "moderat";
  else if (absR >= 0.2) strength = "schwach";
  else strength = "keine";

  return { r, strength, n };
}

/**
 * v1.2.5 (M-CS3) — significance-gated Pearson for USER-FACING surfaces.
 *
 * The plain `pearsonCorrelation` above assigns a strength band from |r|
 * alone with no significance test and a default floor of only 5 pairs —
 * so a 5-point r ≈ 0.7 fluke surfaces as a "stark" correlation. Every
 * surfaced insight-card / status-snapshot correlation must instead clear
 * the same rigorous bar the `/insights` correlation engine enforces:
 *
 *   - n >= 20 paired points (the engine's `MIN_PAIRED_N`), AND
 *   - a two-sided Student-t p-value < 0.05 (`MAX_P_VALUE`).
 *
 * Below either bar this returns `null` so the caller suppresses the
 * correlation exactly as it already does for the < minPairs case — no
 * call-site shape change. The returned `{ r, strength, n }` keeps the
 * legacy shape (German strength band) so the snapshot byte-shape is
 * unchanged on the happy path.
 *
 * This routes through the engine's `pearson` (exact regularised-
 * incomplete-beta p-value) rather than re-deriving the t-test, so the
 * surface decision shares ONE definition with the dedicated cards.
 */
export function significantPearsonCorrelation(
  pairs: PairedPoint[],
): CorrelationResult | null {
  const result = pearson({
    xs: pairs.map((p) => p.a),
    ys: pairs.map((p) => p.b),
  });
  // `pearson` defaults `minPairs` to MIN_PAIRED_N (20); below it (or with
  // zero variance) it reports `insufficient` and we suppress the card.
  if (result.status !== "ok") return null;
  // Significance gate — a non-significant coefficient never surfaces.
  if (result.pValue >= MAX_P_VALUE) return null;

  const r = Math.round(result.r * 1000) / 1000;
  const absR = Math.abs(r);
  let strength: CorrelationResult["strength"];
  if (absR >= 0.7) strength = "stark";
  else if (absR >= 0.4) strength = "moderat";
  else if (absR >= 0.2) strength = "schwach";
  else strength = "keine";

  return { r, strength, n: result.n };
}
