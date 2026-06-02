/**
 * v1.10.0 — derived-metrics block for the Coach prompt.
 *
 * Folds the v1.10 derived wellness layer into the Coach snapshot as
 * COMPACT summaries — one small object per metric carrying value + band +
 * coverage, never the raw series. The Coach narrates the same numbers the
 * dashboard rings render (single source of truth) without ballooning the
 * ~6k-token snapshot budget: a fully-populated block is ~8 tiny objects.
 *
 * Every entry reads the one `computeDerivedMetric` contract — no recompute.
 * A metric whose value is `insufficient` is OMITTED entirely (we never feed
 * the model "no data" noise; the snapshot's compactSections pass would drop
 * an empty key anyway).
 *
 * Server-only — calls the derived dispatcher, which reads `@/lib/db`.
 */
import {
  computeDerivedMetric,
  isDerivedOk,
  type DerivedMetricId,
  type BaselineProfile,
} from "@/lib/insights/derived";

/** The high-signal derived metrics worth a Coach prompt slot. The vitals
 *  baseline is omitted — the per-vital aggregate block already carries those
 *  numbers; here we add the composites + scores the aggregates can't express. */
const SNAPSHOT_METRICS: DerivedMetricId[] = [
  "READINESS",
  "RECOVERY_SCORE",
  "STRESS_SCORE",
  "STRAIN_SCORE",
  "SLEEP_SCORE",
  "HRV_BALANCE",
  "FITNESS_AGE",
  "VASCULAR_AGE_DELTA",
];

/** One compact line per derived metric the model can ground a reply in. */
interface DerivedSnapshotEntry {
  /** 0–100 score, the recent average, or the re-framed device value. */
  value: number;
  /** The metric's band/category in plain words (green/yellow/red, etc.). */
  band?: string;
  /** Confidence 0–100 from the coverage model. */
  confidence?: number;
  /** Days of history backing the value. */
  historyDays: number;
}

/** Pull the headline number + band off each metric's value shape. */
function summariseValue(
  metric: DerivedMetricId,
  value: unknown,
): { value: number; band?: string } | null {
  const v = value as Record<string, unknown>;
  switch (metric) {
    case "READINESS":
    case "SLEEP_SCORE":
    case "RECOVERY_SCORE":
    case "STRESS_SCORE":
    case "STRAIN_SCORE":
      return typeof v.score === "number"
        ? { value: v.score, band: typeof v.band === "string" ? v.band : undefined }
        : null;
    case "HRV_BALANCE":
      return typeof v.recentAvg === "number"
        ? { value: Math.round(v.recentAvg), band: typeof v.band === "string" ? v.band : undefined }
        : null;
    case "FITNESS_AGE":
      return typeof v.vo2Max === "number"
        ? {
            value: Math.round(v.vo2Max * 10) / 10,
            band:
              typeof v.fitnessAgeDeltaYears === "number"
                ? `${v.fitnessAgeDeltaYears >= 0 ? "+" : ""}${v.fitnessAgeDeltaYears}yr vs age`
                : undefined,
          }
        : null;
    case "VASCULAR_AGE_DELTA":
      return typeof v.vascularAge === "number"
        ? {
            value: Math.round(v.vascularAge),
            band:
              typeof v.deltaYears === "number"
                ? `${v.deltaYears >= 0 ? "+" : ""}${Math.round(v.deltaYears)}yr vs age`
                : undefined,
          }
        : null;
    default:
      return null;
  }
}

/**
 * Build the compact derived block, or `null` when no derived metric resolved
 * to `ok`. Each entry is value + band + confidence + historyDays — the model
 * never sees the underlying series. Computes the metrics sequentially off the
 * one shared profile (no per-metric profile re-read).
 */
export async function buildDerivedSnapshotBlock(
  userId: string,
  profile: BaselineProfile,
  now: Date,
): Promise<Record<string, DerivedSnapshotEntry> | null> {
  const block: Record<string, DerivedSnapshotEntry> = {};

  for (const metric of SNAPSHOT_METRICS) {
    // Per-metric fault isolation: a transient compute failure on one metric
    // must never sink the whole Coach turn — drop it and carry on.
    let derived;
    try {
      derived = await computeDerivedMetric({ metric, userId, profile, now });
    } catch {
      continue;
    }
    if (!isDerivedOk(derived)) continue; // omit insufficient — no noise
    const summary = summariseValue(metric, derived.value);
    if (!summary) continue;
    block[metric] = {
      value: summary.value,
      band: summary.band,
      confidence: derived.confidence.score,
      historyDays: derived.coverage.historyDays,
    };
  }

  return Object.keys(block).length > 0 ? block : null;
}
