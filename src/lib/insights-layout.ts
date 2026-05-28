/**
 * Insights tile layout — persisted in `User.insightsLayoutJson`.
 *
 * Single source of truth for which insights pills show on `/insights`,
 * what order they render in, and what the default layout is for new
 * users. Null / missing column = default layout below; the GET endpoint
 * never lazy-writes a row, so the column only carries data once the
 * user has explicitly saved a layout.
 *
 * Mirrors `dashboard-layout.ts` for the dashboard widget surface — same
 * resolver / serializer semantics, same auto-merge of new tile IDs
 * introduced in later releases. Keeping the two modules structurally
 * identical means the iOS client + the Settings UI can share rendering
 * code paths against either surface.
 */

/**
 * Every insights tile the layout knows about. Each entry maps to a
 * routed sub-page under `/insights/<slug>` (the mother-page overview
 * is keyed `"overview"`). The order of entries here is irrelevant —
 * `DEFAULT_INSIGHTS_LAYOUT.tiles[].order` drives the visual order.
 * Exported so the API Zod `tileIdEnum` can be built from a single
 * source of truth.
 */
export const INSIGHTS_TILE_IDS = [
  "overview",
  // ── vitals ──
  "blutdruck",
  "puls",
  "sauerstoff",
  "koerpertemperatur",
  // ── body composition ──
  "gewicht",
  "bmi",
  // ── activity ──
  "aktive-energie",
  "workouts",
  // ── sleep ──
  "schlaf",
  // ── cardiovascular ──
  "ruhepuls",
  "hrv",
  // ── mood ──
  "stimmung",
  // ── events ──
  "medikamente",
] as const;

export type InsightsTileId = (typeof INSIGHTS_TILE_IDS)[number];

export interface InsightsTileConfig {
  id: InsightsTileId;
  visible: boolean;
  order: number;
}

export interface InsightsLayout {
  version: number;
  tiles: InsightsTileConfig[];
}

const INSIGHTS_LAYOUT_VERSION = 1;

/**
 * Default layout mirrors the routed tab-strip order — vitals first,
 * then body composition, activity, sleep, cardiovascular, mood, then
 * events. Core surfaces are default-visible; the long-tail HealthKit
 * pills (oxygen saturation, body temperature, active energy, sleep,
 * resting HR, HRV) stay default-invisible and the user opts in once
 * the matching data starts to flow. Adding a new tile lands as an
 * additional `{ id, visible: false, order: N }` row here and the
 * resolver auto-merges it onto existing users' saved layouts.
 */
export const DEFAULT_INSIGHTS_LAYOUT: InsightsLayout = {
  version: INSIGHTS_LAYOUT_VERSION,
  tiles: [
    { id: "overview", visible: true, order: 0 },
    { id: "blutdruck", visible: true, order: 1 },
    { id: "puls", visible: true, order: 2 },
    { id: "sauerstoff", visible: false, order: 3 },
    { id: "koerpertemperatur", visible: false, order: 4 },
    { id: "gewicht", visible: true, order: 5 },
    { id: "bmi", visible: true, order: 6 },
    { id: "aktive-energie", visible: false, order: 7 },
    { id: "workouts", visible: true, order: 8 },
    { id: "schlaf", visible: false, order: 9 },
    { id: "ruhepuls", visible: false, order: 10 },
    { id: "hrv", visible: false, order: 11 },
    { id: "stimmung", visible: true, order: 12 },
    { id: "medikamente", visible: true, order: 13 },
  ],
};

export function resolveInsightsLayout(raw: unknown): InsightsLayout {
  if (!raw || typeof raw !== "object") return DEFAULT_INSIGHTS_LAYOUT;
  const candidate = raw as Partial<InsightsLayout>;
  if (
    typeof candidate.version !== "number" ||
    !Array.isArray(candidate.tiles)
  ) {
    return DEFAULT_INSIGHTS_LAYOUT;
  }

  // Drop tile ids the current build does not know about so a future
  // retirement (mirroring the dashboard's v1.4.28 `glp1` drop) doesn't
  // wedge the PUT round-trip on the next save. Filtering on read keeps
  // the GET shape current-build-safe and lets the Settings UI re-PUT
  // a clean array.
  const knownIds = new Set<string>(INSIGHTS_TILE_IDS);
  const filtered = candidate.tiles.filter((t) => knownIds.has(t.id));

  // Merge with defaults so new tiles introduced in later versions show
  // up automatically (invisible by default, the user opts in).
  const savedIds = new Set(filtered.map((t) => t.id));
  const missing = DEFAULT_INSIGHTS_LAYOUT.tiles.filter(
    (t) => !savedIds.has(t.id),
  );
  const maxOrder = Math.max(0, ...filtered.map((t) => t.order));
  const appended = missing.map((t, i) => ({
    ...t,
    visible: false, // default-invisible on auto-upgrade
    order: maxOrder + 1 + i,
  }));

  return {
    version: INSIGHTS_LAYOUT_VERSION,
    tiles: [...filtered, ...appended].sort((a, b) => a.order - b.order),
  };
}

export function serializeInsightsLayout(
  layout: InsightsLayout,
): InsightsLayout {
  return {
    version: INSIGHTS_LAYOUT_VERSION,
    tiles: layout.tiles
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((t, i) => ({
        id: t.id,
        visible: t.visible,
        order: i, // normalize to 0-based dense order
      })),
  };
}
