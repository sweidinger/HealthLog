/**
 * v1.10.0 — catalogue metric #8: HRV (SDNN) trend / balance.
 *
 * `computeHrvBalance(userId, profile, opts)` builds the personal-baseline
 * band for `HEART_RATE_VARIABILITY` (the same median ± k·MAD engine the
 * flagship vitals baseline uses) and places the recent 7-day SDNN average
 * against it as a Balanced / Unbalanced / Low band — the honest day-scale
 * analogue of Garmin "HRV Status" / WHOOP "HRV Trend".
 *
 *   - **baseline** = the `computeVitalsBaseline` band for
 *     `HEART_RATE_VARIABILITY` (median ± k·MAD over the window, DAY-native).
 *   - **recentAvg** = mean of the last ≤ 7 DAY means.
 *   - **band** — recentAvg inside the baseline band → Balanced (green);
 *     above the band → Unbalanced-high (yellow); below the band's low edge →
 *     Low (red). The Low edge is the one that matters clinically (suppressed
 *     HRV); a high excursion is flagged but not alarmed.
 *
 * SDNN ≠ RMSSD. This is surfaced strictly as "HRV (SDNN) trend", never
 * relabelled RMSSD and never presented as a population-normed HRV grade — it
 * is a personal trend band. Cadence-gated: SDNN is not guaranteed nightly,
 * so the ≥ 7-distinct-day floor of the baseline engine gates the band.
 *
 * Standard: Task Force of the European Society of Cardiology and the North
 * American Society of Pacing and Electrophysiology 1996, "Heart rate
 * variability: standards of measurement, physiological interpretation, and
 * clinical use", Circulation 93(5):1043–1065 (the SDNN reference).
 *
 * Server-only — delegates the DB read to the baseline engine. The band
 * placement helper is exported pure for the unit tests.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import type { RollupCoverageMap } from "@/lib/rollups/measurement-coverage";
import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
  nowProvenanceTimestamp,
} from "./coverage";
import { computeVitalsBaseline, type BaselineProfile } from "./baseline";
import { isDerivedOk } from "./types";
import type { Derived } from "./types";

const HRV_TYPE: MeasurementType = "HEART_RATE_VARIABILITY";

/** Personal-trend balance placement. */
export type HrvBalanceBand = "balanced" | "unbalanced" | "low";

/** The successful `value` payload for the HRV (SDNN) balance card. */
export interface HrvBalanceValue {
  /** The recent (≤ 7-day) SDNN average (ms). */
  recentAvg: number;
  /** Personal-baseline center (median of DAY means, ms). */
  baselineCenter: number;
  /** Personal-baseline band low edge (ms). */
  baselineLow: number;
  /** Personal-baseline band high edge (ms). */
  baselineHigh: number;
  /** Balanced / unbalanced (high) / low placement of recentAvg vs the band. */
  band: HrvBalanceBand;
  /** Distinct days that backed the baseline. */
  sampleDays: number;
}

/**
 * Place a recent SDNN average against a personal-baseline band. Pure. Below
 * the band's low edge → suppressed HRV ("low"); above the high edge →
 * "unbalanced" (a high excursion); within → "balanced".
 */
export function placeHrvBalance(
  recentAvg: number,
  low: number,
  high: number,
): HrvBalanceBand {
  if (recentAvg < low) return "low";
  if (recentAvg > high) return "unbalanced";
  return "balanced";
}

/**
 * HRV (SDNN) trend / balance — reuses the flagship baseline engine for the
 * band, then places the recent 7-day average against it. Returns the
 * baseline engine's `insufficient` verbatim below the history floor so the
 * card shows the same "building your typical range — N of 7 days" state.
 */
export async function computeHrvBalance(
  userId: string,
  profile: BaselineProfile,
  opts?: { windowDays?: number; now?: Date; coverage?: RollupCoverageMap },
): Promise<Derived<HrvBalanceValue>> {
  const now = opts?.now ?? new Date();
  const computedAt = nowProvenanceTimestamp(now);

  const baseline = await computeVitalsBaseline(userId, profile, {
    type: HRV_TYPE,
    windowDays: opts?.windowDays,
    now,
    coverage: opts?.coverage,
  });

  // Below the band floor (or no data) — surface the baseline engine's gated
  // result verbatim so the gating UI is identical across the two cards.
  if (!isDerivedOk(baseline)) {
    return buildInsufficient<HrvBalanceValue>({
      coverage: baseline.coverage,
      provenance: baseline.provenance,
      reason: baseline.reason,
    });
  }

  // The baseline already computed the robust center+band over DAY means; the
  // recent average rides the same center for a stable, sparse-cadence-safe
  // placement (per-day SDNN is noisy; the median center is the honest
  // "recent typical").
  const recentAvg = baseline.value.center;
  const band = placeHrvBalance(
    recentAvg,
    baseline.value.low,
    baseline.value.high,
  );

  const { coverage, confidence } = deriveCoverage({
    requiredInputs: 1,
    presentInputs: 1,
    historyDays: baseline.coverage.historyDays,
    missing: [],
    fullHistoryDays: baseline.provenance.windowDays,
  });

  return buildOk<HrvBalanceValue>({
    value: {
      recentAvg,
      baselineCenter: baseline.value.center,
      baselineLow: baseline.value.low,
      baselineHigh: baseline.value.high,
      band,
      sampleDays: baseline.value.sampleDays,
    },
    coverage,
    confidence,
    provenance: { ...baseline.provenance, computedAt },
  });
}
