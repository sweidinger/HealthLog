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
 * imports), so this file stays browser-bundle-safe.
 */
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
  // v1.29 — fluid-intake strip tile, nutrients-store-backed (see
  // `SUMMARY_TYPE_MODULE.NUTRIENT_WATER` below).
  waterIntake: "nutrients",
};

/**
 * Slim-summary keys that belong to a toggleable module. When the module
 * is off the key is stripped from `tiles.summaries` /
 * `tiles.lastSeenByType` (so `metricStates` and the client data-floor
 * gates also drop it) before the snapshot leaves the server. Core vital
 * types are absent here and always pass through.
 *
 * v1.29 — widened from `Partial<Record<MeasurementType, ModuleKey>>` to
 * `Partial<Record<string, ModuleKey>>` so the synthetic `NUTRIENT_WATER`
 * key (a `NutrientIntakeDay`-derived summary, not a real
 * `MeasurementType` — the abandoned `feat/water` branch's parallel
 * `WATER_INTAKE` enum value is deliberately NOT added) can ride the same
 * gate without widening the `MeasurementType` enum itself.
 */
export const SUMMARY_TYPE_MODULE: Partial<Record<string, ModuleKey>> = {
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
  // v1.29 — fluid-intake dashboard tile summary, derived server-side from
  // `NutrientIntakeDay` (nutrient="water", summed across sources). Gated
  // on the `nutrients` module like the rest of that store's surfaces.
  NUTRIENT_WATER: "nutrients",
};
