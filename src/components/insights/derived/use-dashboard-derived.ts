"use client";

import { useMemo } from "react";

import {
  useDerivedBatch,
  type DerivedBatchToken,
} from "./use-derived-metric";
// Type-only — keeps the derived registry's server graph out of the bundle.
import type { DerivedMetricId } from "@/lib/insights/derived/registry";

/**
 * v1.12.6 — the shared derived-metric batch for the Insights overview.
 *
 * The overview paints the wellness-score strip and the vitals grid as two
 * separate, full-width sections (wellness lifted above the daily briefing,
 * vitals below it). Both surfaces read the same already-computed derived
 * values, so this hook owns the ONE batched `/api/insights/derived/batch`
 * request and hands its `read`/`isLoading`/`isError`/`refetch` handle to
 * both. A single cache entry, one network round-trip — never a per-section
 * fan-out (the v1.9.1 "hangs then recovers" symptom).
 *
 * The page mounts this once and passes the handle down, so the wellness
 * strip and the vitals dashboard share the same query instance.
 */

/** The per-vital baseline tiles the dashboard renders (HRV has its own tile). */
export const SECTION_VITALS: string[] = [
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
  "RESPIRATORY_RATE",
  "OXYGEN_SATURATION",
  "BODY_TEMPERATURE",
  "BLOOD_GLUCOSE",
  "WEIGHT",
];

/**
 * The any-user HealthKit baseline bands (Mobility section). The `metric` is
 * the batch token + provenance key; `type` drives icon/label/unit.
 */
export const SECTION_MOBILITY: { metric: DerivedMetricId; type: string }[] = [
  { metric: "STAIR_ASCENT_SPEED_BASELINE", type: "STAIR_ASCENT_SPEED" },
  { metric: "STAIR_DESCENT_SPEED_BASELINE", type: "STAIR_DESCENT_SPEED" },
  { metric: "WRIST_TEMPERATURE_BASELINE", type: "WRIST_TEMPERATURE" },
];

/**
 * The full set of tokens the overview reads in one batch — the five wellness
 * scores + the four derived re-frames + one baseline per vital (minus HRV,
 * which has its own balance tile) + the mobility/body metrics. The
 * coincident-deviation flag is read by the dedicated "Today's signal" card,
 * not here.
 */
export function dashboardTokens(): DerivedBatchToken[] {
  const tokens: DerivedBatchToken[] = [
    { metric: "READINESS" },
    { metric: "SLEEP_SCORE" },
    { metric: "RECOVERY_SCORE" },
    { metric: "STRESS_SCORE" },
    { metric: "STRAIN_SCORE" },
    { metric: "FITNESS_AGE" },
    { metric: "VASCULAR_AGE_DELTA" },
    { metric: "HRV_BALANCE" },
    { metric: "BMI" },
    { metric: "SIX_MINUTE_WALK_BAND" },
  ];
  for (const type of SECTION_VITALS) {
    if (type === "HEART_RATE_VARIABILITY") continue;
    tokens.push({ metric: "VITALS_BASELINE", type });
  }
  for (const { metric } of SECTION_MOBILITY) {
    tokens.push({ metric });
  }
  return tokens;
}

/** The shared batch handle both the wellness strip and the vitals grid read. */
export type DashboardDerived = ReturnType<typeof useDerivedBatch>;

/**
 * Mount the one overview-wide derived batch. `enabled` gates the fetch on the
 * page's auth state; the hook itself also gates on the session internally.
 */
export function useDashboardDerived(enabled: boolean): DashboardDerived {
  const tokens = useMemo(() => dashboardTokens(), []);
  return useDerivedBatch(tokens, { enabled });
}
