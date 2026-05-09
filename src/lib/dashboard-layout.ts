/**
 * Dashboard widget layout — persisted in User.dashboardWidgetsJson.
 *
 * Single source of truth for which widgets show on /, what order, and
 * what the default layout is for new users. Null / missing = default.
 */

export type DashboardWidgetId =
  | "weight"
  | "bp"
  | "pulse"
  | "bodyFat"
  | "mood"
  | "medications"
  | "sleep"
  | "steps"
  | "glucose"
  | "totalBodyWater"
  | "boneMass"
  | "bpInTarget"
  | "oxygenSaturation"
  | "achievements";

export interface DashboardWidgetConfig {
  id: DashboardWidgetId;
  /**
   * Whether the widget shows up in the *charts* row (the lower section
   * of the dashboard with the line graphs). The legacy single-toggle
   * field — kept on the wire for back-compat with users who saved a
   * layout pre-v1.4.15.
   */
  visible: boolean;
  /**
   * v1.4.15 Fix 5 — independent visibility for the *strip tile* (the
   * upper row of trend cards). When omitted, the resolver mirrors
   * `visible` so existing saved layouts keep their previous behaviour
   * (one toggle controls both surfaces). When set explicitly the user
   * can show the chart but hide the tile, or show the tile but hide
   * the chart, which is what Marc asked for in the v1.4.15 follow-up
   * (memory `feedback_dashboard_top_tiles_selectable.md`).
   */
  tileVisible?: boolean;
  order: number;
}

export interface DashboardLayout {
  version: number;
  widgets: DashboardWidgetConfig[];
}

export const DASHBOARD_LAYOUT_VERSION = 1;

/**
 * Default layout mirrors v1.1 behavior: core vitals always on, mood +
 * body-fat show if data exists (see dashboard page for the data-conditional
 * rendering). Ordering matches the visual order on / today.
 */
export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayout = {
  version: DASHBOARD_LAYOUT_VERSION,
  widgets: [
    { id: "weight", visible: true, tileVisible: true, order: 0 },
    { id: "bp", visible: true, tileVisible: true, order: 1 },
    { id: "pulse", visible: true, tileVisible: true, order: 2 },
    { id: "bodyFat", visible: true, tileVisible: true, order: 3 },
    { id: "mood", visible: true, tileVisible: true, order: 4 },
    { id: "bpInTarget", visible: true, tileVisible: true, order: 5 },
    { id: "medications", visible: true, tileVisible: true, order: 6 },
    { id: "sleep", visible: false, tileVisible: false, order: 7 },
    { id: "steps", visible: false, tileVisible: false, order: 8 },
    { id: "glucose", visible: false, tileVisible: false, order: 9 },
    { id: "totalBodyWater", visible: false, tileVisible: false, order: 10 },
    { id: "boneMass", visible: false, tileVisible: false, order: 11 },
    { id: "oxygenSaturation", visible: false, tileVisible: false, order: 12 },
    // v1.4.15 phase-B4 — recent-unlocks card (dashboard surface for the
    // gamification feature). Visible by default — the card is small,
    // self-gates on having any achievements (otherwise it shows a brief
    // "no achievements yet" + link), and Marc-asked-for-it explicitly.
    // `tileVisible` is forced false because there is no tile surface
    // for this widget; only the chart-row card.
    { id: "achievements", visible: true, tileVisible: false, order: 13 },
  ],
};

export function resolveDashboardLayout(raw: unknown): DashboardLayout {
  if (!raw || typeof raw !== "object") return DEFAULT_DASHBOARD_LAYOUT;
  const candidate = raw as Partial<DashboardLayout>;
  if (
    typeof candidate.version !== "number" ||
    !Array.isArray(candidate.widgets)
  ) {
    return DEFAULT_DASHBOARD_LAYOUT;
  }

  // Merge with defaults so new widgets introduced in later versions show up
  // automatically (invisible by default, users opt-in).
  const savedIds = new Set(candidate.widgets.map((w) => w.id));
  const missing = DEFAULT_DASHBOARD_LAYOUT.widgets.filter(
    (w) => !savedIds.has(w.id),
  );
  const maxOrder = Math.max(0, ...candidate.widgets.map((w) => w.order));
  const appended = missing.map((w, i) => ({
    ...w,
    visible: false, // default-invisible on auto-upgrade
    tileVisible: false,
    order: maxOrder + 1 + i,
  }));

  // Default `tileVisible` to mirror `visible` for legacy entries that
  // never had the field (the v1.4.15 schema upgrade). Users who saved
  // a layout before this release see no behavioural change until they
  // explicitly toggle the new strip switch.
  const normalized = candidate.widgets.map((w) => ({
    ...w,
    tileVisible: typeof w.tileVisible === "boolean" ? w.tileVisible : w.visible,
  }));

  return {
    version: DASHBOARD_LAYOUT_VERSION,
    widgets: [...normalized, ...appended].sort((a, b) => a.order - b.order),
  };
}

export function serializeDashboardLayout(
  layout: DashboardLayout,
): DashboardLayout {
  return {
    version: DASHBOARD_LAYOUT_VERSION,
    widgets: layout.widgets
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((w, i) => ({
        ...w,
        // Persist tileVisible explicitly so a follow-up read of the
        // saved layout doesn't have to re-mirror from `visible` and
        // discard the user's actual choice.
        tileVisible:
          typeof w.tileVisible === "boolean" ? w.tileVisible : w.visible,
        order: i, // normalize to 0-based dense order
      })),
  };
}
