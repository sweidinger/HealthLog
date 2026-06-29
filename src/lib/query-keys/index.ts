/**
 * Centralized TanStack Query key factory.
 *
 * Every useQuery/invalidateQueries call should go through this factory so that
 * mutations invalidate the right consumers. Hard-coded string arrays drifted in
 * the past (e.g. ["measurements"] didn't invalidate ["analytics"] on the
 * dashboard), so treat this module as the single source of truth.
 *
 * The factory is split into per-feature files under this directory; this
 * index assembles them into the one `queryKeys` object every call site
 * imports (`@/lib/query-keys` resolves here). The dependent-key bundles
 * live here too because they fan out across feature boundaries.
 */

import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { adminKeys } from "./admin";
import { allergyKeys } from "./allergies";
import { authKeys } from "./auth";
import { coachKeys } from "./coach";
import { familyHistoryKeys } from "./family-history";
import { customMetrics } from "./custom-metrics";
import { cycleKeys } from "./cycle";
import { dashboardKeys } from "./dashboard";
import { environmentKeys } from "./environment";
import { documentKeys } from "./documents";
import { illnessKeys } from "./illness";
import { insightsKeys } from "./insights";
import { integrationKeys } from "./integrations";
import { labKeys } from "./labs";
import { measurementKeys } from "./measurements";
import { measurementReminderKeys } from "./measurement-reminders";
import { medicationKeys } from "./medications";
import { mentalHealthKeys } from "./mental-health";
import { moodKeys } from "./mood";
import { settingsKeys } from "./settings";
import { workoutKeys } from "./workouts";

export const queryKeys = {
  ...authKeys,
  ...measurementKeys,
  ...moodKeys,
  ...dashboardKeys,
  ...insightsKeys,
  ...medicationKeys,
  ...coachKeys,
  ...adminKeys,
  ...integrationKeys,
  ...workoutKeys,
  ...settingsKeys,
  ...cycleKeys,
  ...measurementReminderKeys,
  ...labKeys,
  ...illnessKeys,
  ...mentalHealthKeys,
  ...allergyKeys,
  ...familyHistoryKeys,
  ...environmentKeys,
  ...documentKeys,
  ...customMetrics,
};

/**
 * Keys that should be invalidated when a measurement is created, updated or
 * deleted. Kept here so dashboards, insights, and targets always stay in sync.
 *
 * v1.4.40 W-RSC — `["chart-data"]` prefix now lives in the bundle so a
 * fresh measurement evicts every per-chart daily-aggregate cache. The
 * prefix matches every key returned from `queryKeys.chartData(…)` via
 * TanStack's hierarchical-prefix semantics — adding a measurement now
 * refreshes the tile strip *and* the chart row in lockstep instead of
 * leaving the chart row 60 s stale (audit C2).
 *
 * v1.18.9 — `dashboardSnapshot` joins the bundle, mirroring the
 * v1.16.11 medication fix. The dashboard hero band, score ring, and
 * tile strip all read ONE snapshot query configured with
 * refetchOnMount/WindowFocus off and a 120 s poll; without the key here
 * a blood-pressure (or any) reading added in-app stayed invisible on the
 * Startseite until the poll ticked or a hard reload — the reported #38
 * stale-read. The manual create / update / delete routes already
 * hard-evict the server snapshot bucket (`{ evict: true }`), so the
 * refetch this invalidation triggers returns post-write data at once.
 */
export const measurementDependentKeys = [
  queryKeys.measurements(),
  queryKeys.analytics(),
  queryKeys.insightsRoot(),
  queryKeys.insightsTargets(),
  queryKeys.gamificationAchievements(),
  queryKeys.dashboardSnapshot(),
  ["chart-data"] as const,
  // v1.8.5 — re-run the diversity-nudge clustering when readings change.
  ["measurement-diversity"] as const,
  // v1.11.4 item J — refresh the Trends-row deterministic caption series
  // when a reading changes, in lockstep with the chart row above it.
  ["trend-series"] as const,
  // v1.11.5 — refresh the last-night hypnogram when sleep rows change.
  ["sleep-night"] as const,
  // v1.17.0 — refresh the sleep-debt + chronotype read when sleep rows change.
  ["sleep-rhythm"] as const,
];

/**
 * Keys that should be invalidated when a mood entry is created, updated or
 * deleted.
 */
export const moodDependentKeys = [
  queryKeys.moodEntries(),
  queryKeys.moodAnalytics(),
  queryKeys.moodInsights(),
  queryKeys.insightsRoot(),
  queryKeys.insightsTargets(),
  queryKeys.gamificationAchievements(),
];

/**
 * Keys invalidated when medications change (CRUD or intake).
 *
 * v1.4.40 W-RSC — the dashboard's aggregate compliance chart now
 * rides the factory under `dashboardMedicationCompliance`. The prefix
 * `["dashboard-medication-compliance"]` lands in the bundle so an
 * intake POST refreshes the chart immediately rather than waiting for
 * `staleTime` (audit L4).
 *
 * v1.5.5 D-3 §10 invariant 20 (was C-E2-1 / H-cluster-G) — the
 * per-medication inline compliance chart used to mount under
 * `queryKeys.medicationComplianceChart(medicationId)` which expands to
 * `["compliance-chart-inline", id]`. The prefix `["compliance-chart-inline"]`
 * lands in the bundle so every detail-page mutation (today's-dose,
 * Pausieren, end, purge, edit) evicts the inline compliance tile in
 * one tick. The TanStack hierarchical-prefix semantics catch every
 * per-medication slot under that prefix.
 *
 * `queryKeys.medicationDetail(id)` rides under the
 * `["medications"]` prefix already so a single medication invalidation
 * also evicts its detail-page read.
 *
 * v1.16.11 — `dashboardSnapshot` joins the bundle. The hero band, dose
 * tally, verdict and checklist all read ONE snapshot query configured
 * with refetchOnMount/WindowFocus off and a 120 s poll; without the key
 * here a dose taken from the dashboard stayed visibly due for up to two
 * minutes. The intake routes already hard-evict the server-side
 * snapshot bucket, so the refetch this triggers returns post-write data
 * immediately.
 */
export const medicationDependentKeys = [
  queryKeys.medications(),
  queryKeys.analytics(),
  queryKeys.insightsRoot(),
  queryKeys.insightsTargets(),
  queryKeys.gamificationAchievements(),
  queryKeys.dashboardSnapshot(),
  ["dashboard-medication-compliance"] as const,
  ["compliance-chart-inline"] as const,
];

/**
 * Keys invalidated when cycle data changes (a day-log capture, a period
 * boundary, a day-log delete). The `["cycle"]` prefix catches the calendar
 * windows, the history stats, and the profile read in one tick so the
 * calendar/wheel and predictions panel never read stale rows after a quick
 * log. `insightsRoot()` rides along because phase-correlation cards depend
 * on the same rows.
 */
export const cycleDependentKeys = [queryKeys.cycle(), queryKeys.insightsRoot()];

/**
 * Invalidate every key in the bundle in parallel. Use this from mutation
 * `onSuccess` handlers so the call site stays a one-liner instead of repeating
 * `Promise.all(keys.map(...))` everywhere.
 *
 * Uses `allSettled` so one transient network failure doesn't abort subsequent
 * invalidations (cache would otherwise be left half-stale) and so the `void
 * invalidateKeys(...)` fire-and-forget pattern in delete handlers never
 * surfaces an unhandled rejection.
 */
export function invalidateKeys(
  queryClient: QueryClient,
  keys: readonly QueryKey[],
): Promise<PromiseSettledResult<unknown>[]> {
  return Promise.allSettled(
    keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}
