/**
 * v1.18.6 — dashboard first-paint / skeleton-reservation gates.
 *
 * Extracted verbatim from `src/app/page.tsx` so the page component reads
 * as a thinner orchestrator and these pure helpers (already unit-tested)
 * live in one cohesive module. `page.tsx` re-exports them so the existing
 * `../page` test imports stay valid.
 */
import type { DashboardLayout } from "@/lib/dashboard-layout";

/**
 * v1.7.0 — first-paint gate for the dashboard tile strip.
 *
 * `primaryLoading` must come from whichever query actually drives the
 * tiles: the snapshot cell by default, the slim analytics cell when
 * `NEXT_PUBLIC_DASHBOARD_SNAPSHOT=false`. A disabled TanStack query reports
 * `isLoading: false` (idle fetch status), so keying off the wrong
 * source flashes the empty state for the whole fetch. Pure + exported
 * so the gate has direct unit coverage without mounting the page.
 */
export function resolveDashboardFirstPaintGate(input: {
  trendCardCount: number;
  chartCount: number;
  configuredTileCount: number;
  primaryLoading: boolean;
}): { showTileStripSkeleton: boolean; showEmptyState: boolean } {
  const showTileStripSkeleton =
    input.trendCardCount === 0 &&
    input.primaryLoading &&
    input.configuredTileCount > 0;
  const showEmptyState =
    input.trendCardCount === 0 &&
    input.chartCount === 0 &&
    !showTileStripSkeleton &&
    !input.primaryLoading;
  return { showTileStripSkeleton, showEmptyState };
}

/**
 * v1.16.8 — widget ids that actually paint a tile in the strip on the
 * web dashboard, mirrored from the per-id render blocks below.
 * `medications` / `recentWorkouts` / `achievements` carry NO strip tile
 * (chart-row cards only), and the iOS-pin-only ids have no web render
 * path at all — counting any of them over-reserved the loading
 * silhouette and made the strip reshuffle when the data landed.
 */
const TILE_CAPABLE_WIDGET_IDS = new Set<string>([
  "weight",
  "bp",
  "pulse",
  "bodyFat",
  "mood",
  "sleep",
  "steps",
  "glucose",
  "bpInTarget",
  "vo2Max",
  // v1.28.52 — vitals + body-composition strip tiles: each paints one
  // strip card and self-gates on having a sample of its MeasurementType.
  "hrv",
  "oxygenSaturation",
  "respiratoryRate",
  "wristTemperature",
  "muscleMass",
  "totalBodyWater",
  "boneMass",
]);

/**
 * v1.16.8 — silhouette count for the tile-strip skeleton: one card per
 * tile-capable, tile-visible widget. `bp` paints TWO tiles (sys + dia,
 * see the render block below) so it counts double; `glucose` can fan
 * out to one tile per logged context, but the contexts are unknown
 * until the snapshot lands, so it reserves one card (the sane floor).
 * Pure + exported for direct unit coverage.
 */
export function resolveConfiguredTileCount(layout: DashboardLayout): number {
  let count = 0;
  for (const widget of layout.widgets) {
    if (!TILE_CAPABLE_WIDGET_IDS.has(widget.id)) continue;
    if (!(widget.tileVisible ?? widget.visible)) continue;
    count += widget.id === "bp" ? 2 : 1;
  }
  return count;
}

/**
 * v1.16.8 — widget ids with a chart-row surface on the web dashboard,
 * mirrored from the `charts[]` entries below. The achievements +
 * recent-workouts cards stay out: they self-skeleton, carry no
 * chart-shaped footprint, and gate on `layoutResolved`.
 */
const CHART_CAPABLE_WIDGET_IDS = new Set<string>([
  "weight",
  "bp",
  "pulse",
  "bodyFat",
  "mood",
  "sleep",
  "steps",
  "medications",
  // v1.18.2 — Vorsorge preventive-care summary card (chart-row only).
  "vorsorge",
]);

/**
 * v1.16.8 — expected chart-row card count while the snapshot is still
 * in flight. Every chart gate below needs `count > 0` from snapshot
 * data, so the cold page used to render NO chart row at all and then
 * grow ~1000 px when the snapshot landed. The best available signal
 * before data arrives is the layout config (the user's saved layout
 * when cached, the default otherwise): one card per chart-visible
 * widget, plus the BMI card that rides the weight gate when the
 * profile carries a height. Pure + exported for direct unit coverage.
 */
export function resolveChartRowPlaceholderCount(
  layout: DashboardLayout,
  opts?: { hasHeightCm?: boolean },
): number {
  let count = 0;
  for (const widget of layout.widgets) {
    if (!CHART_CAPABLE_WIDGET_IDS.has(widget.id)) continue;
    if (!widget.visible) continue;
    count += 1;
    if (widget.id === "weight" && opts?.hasHeightCm) count += 1;
  }
  return count;
}
