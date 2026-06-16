/**
 * v1.18.0 — client-safe module maps for dashboard widgets / summary types.
 *
 * These two maps are pure data (string → ModuleKey) with no runtime
 * dependency on the DB, Prisma, or the server-only module gate. They are
 * factored out of `@/lib/dashboard/snapshot` so the settings client
 * component (`dashboard-layout-section.tsx`) can import them without
 * dragging the whole server snapshot builder — and its transitive
 * `pg` / `dns` chain — into the browser bundle. `snapshot.ts` re-exports
 * both for the server call sites and the existing tests.
 *
 * `ModuleKey` comes from `@/lib/modules/registry` (pure constants, no
 * imports) and `MeasurementType` is a type-only import from the generated
 * Prisma client, so this file stays browser-bundle-safe.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import type { ModuleKey } from "@/lib/modules/registry";

/**
 * Dashboard widget id → toggleable module key. When the user disables the
 * module, the matching widget is forced invisible on both the web `layout`
 * and the iOS `layoutCatalogue`, so the tile/chart never paints. Only the
 * toggleable surfaces appear here; CORE widgets (weight / bp / pulse /
 * bodyFat / bpInTarget and the vital-derived HealthKit metrics) carry NO
 * entry and are never hidden.
 *
 * v1.18.1 (D3) — `medications` graduated from CORE to a toggleable module,
 * so the medication tile now gates off it like the other toggleable widgets.
 */
export const WIDGET_MODULE_BY_ID: Partial<Record<string, ModuleKey>> = {
  mood: "mood",
  sleep: "sleep",
  glucose: "glucose",
  achievements: "achievements",
  recentWorkouts: "workouts",
  medications: "medications",
  // v1.18.0 B1 — recovery-domain HealthKit widgets belong to the recovery
  // module; the per-night breathing-disturbance widget belongs to sleep.
  cardioRecovery: "recovery",
  sixMinuteWalk: "recovery",
  stairAscentSpeed: "recovery",
  stairDescentSpeed: "recovery",
  breathingDisturbances: "sleep",
};

/**
 * `MeasurementType` slim-summary keys that belong to a toggleable module.
 * When the module is off the key is stripped from `tiles.summaries` /
 * `tiles.lastSeenByType` (so `metricStates` and the client data-floor
 * gates also drop it) before the snapshot leaves the server. Core vital
 * types are absent here and always pass through.
 */
export const SUMMARY_TYPE_MODULE: Partial<Record<MeasurementType, ModuleKey>> = {
  SLEEP_DURATION: "sleep",
  BLOOD_GLUCOSE: "glucose",
  // v1.18.0 B1 — recovery-domain HealthKit metrics. The recovery page +
  // its tiles are the recovery module's surface; when it is off these
  // device-native signals must drop from the dashboard snapshot too.
  CARDIO_RECOVERY: "recovery",
  SIX_MINUTE_WALK_DISTANCE: "recovery",
  STAIR_ASCENT_SPEED: "recovery",
  STAIR_DESCENT_SPEED: "recovery",
  // Per-night breathing-disturbance index is a sleep-page signal.
  BREATHING_DISTURBANCES: "sleep",
};
