/**
 * v1.4.15 Phase B5 — onboarding tour state model.
 *
 * Pure data + state-machine helpers for the spotlight tour overlaid on
 * the dashboard for first-time users. Kept DOM-free so vitest (Node
 * environment, no jsdom) can exercise the navigation logic directly,
 * matching the project test-style elsewhere.
 *
 * The UI layer (`src/components/onboarding/tour.tsx`) builds the
 * step list once on mount and then drives navigation through these
 * helpers.
 *
 * Tour stops are anchored to UI targets via `data-tour-id` attributes
 * (NOT class-name selectors — class names change too often during
 * Tailwind tweaks; `data-tour-id` is a stable contract). Every stop
 * declares its `targetId`; the spotlight component looks up the live
 * element via `document.querySelector('[data-tour-id="<id>"]')`.
 *
 * If a target element is missing at runtime (e.g. user is on a
 * resized layout that hides it), the spotlight falls back to a
 * centred-screen tooltip so the tour never blocks indefinitely.
 */

/** Stable IDs for every stop in the tour. */
export type TourStopId =
  | "tile-strip"
  | "quick-add"
  | "insights"
  | "integrations"
  | "achievements";

/**
 * One step in the tour. The `targetId` matches a `data-tour-id` on a
 * live element somewhere in the app; the title/body i18n keys live
 * under `onboarding.tour.steps.<id>.*`.
 */
export interface TourStop {
  id: TourStopId;
  /**
   * The `data-tour-id` value of the element to anchor the spotlight
   * to. May be `null` if the stop is purely informational and should
   * render in a centred-screen tooltip without a spotlight cutout.
   */
  targetId: string | null;
  /**
   * Preferred placement of the tooltip relative to the target. The UI
   * layer is allowed to flip this if the target is too close to a
   * viewport edge.
   */
  placement: "top" | "bottom" | "left" | "right" | "center";
  /** i18n key for the step title. */
  titleKey: string;
  /** i18n key for the step body. */
  bodyKey: string;
}

/**
 * Build the canonical tour-step list. Caller may inject a feature
 * flag — e.g. `includeAchievements: false` if B4 hasn't shipped yet
 * — and we omit that stop without renumbering.
 */
export function buildTourStops(opts?: {
  includeAchievements?: boolean;
}): TourStop[] {
  const includeAchievements = opts?.includeAchievements ?? true;

  const stops: TourStop[] = [
    {
      id: "tile-strip",
      targetId: "dashboard-tile-strip",
      placement: "bottom",
      titleKey: "onboarding.tour.steps.tileStrip.title",
      bodyKey: "onboarding.tour.steps.tileStrip.body",
    },
    {
      id: "quick-add",
      targetId: "dashboard-quick-add",
      placement: "bottom",
      titleKey: "onboarding.tour.steps.quickAdd.title",
      bodyKey: "onboarding.tour.steps.quickAdd.body",
    },
    {
      id: "insights",
      targetId: "nav-insights",
      placement: "right",
      titleKey: "onboarding.tour.steps.insights.title",
      bodyKey: "onboarding.tour.steps.insights.body",
    },
    {
      id: "integrations",
      // The integrations link sits behind the Settings sub-menu on
      // some viewports — we anchor to the Settings nav item instead
      // so the spotlight is always visible without forcing a hover.
      targetId: "nav-settings",
      placement: "right",
      titleKey: "onboarding.tour.steps.integrations.title",
      bodyKey: "onboarding.tour.steps.integrations.body",
    },
  ];

  if (includeAchievements) {
    stops.push({
      id: "achievements",
      targetId: "nav-achievements",
      placement: "right",
      titleKey: "onboarding.tour.steps.achievements.title",
      bodyKey: "onboarding.tour.steps.achievements.body",
    });
  }

  return stops;
}

/**
 * Tour navigation state. Pure value, immutable per transition — every
 * helper returns a fresh state instead of mutating in place.
 */
export interface TourState {
  /** Index into the steps array. May equal `steps.length` to indicate the tour is complete. */
  index: number;
  /** Cached step list — handy for the renderer. */
  steps: TourStop[];
  /**
   * `null` while the tour is still running, `"completed"` once the
   * user reached the end and clicked Done, `"skipped"` if they hit
   * Skip on any step. Both terminal states cause the same DB write
   * (`onboardingTourCompleted = true`); we keep them distinct purely
   * so analytics can tell them apart in audit logs.
   */
  outcome: "completed" | "skipped" | null;
}

/** Initial state at the first step. */
export function initTourState(steps: TourStop[]): TourState {
  return { index: 0, steps, outcome: null };
}

/**
 * Advance to the next step. If we're already on the last step, mark
 * the tour `completed`. Calling on a terminal state is a no-op so
 * the renderer can fire-and-forget on rapid double-clicks.
 */
export function nextStep(state: TourState): TourState {
  if (state.outcome !== null) return state;
  const lastIndex = state.steps.length - 1;
  if (state.index >= lastIndex) {
    return { ...state, index: state.steps.length, outcome: "completed" };
  }
  return { ...state, index: state.index + 1 };
}

/**
 * Step backwards. Pinned at index 0 — the first step has no Back
 * button visually; this helper just no-ops to keep the keyboard
 * shortcut (LeftArrow) safe.
 */
export function prevStep(state: TourState): TourState {
  if (state.outcome !== null) return state;
  if (state.index <= 0) return state;
  return { ...state, index: state.index - 1 };
}

/** User explicitly dismissed the tour from any step. */
export function skipTour(state: TourState): TourState {
  if (state.outcome !== null) return state;
  return { ...state, index: state.steps.length, outcome: "skipped" };
}

/** Whether the tour has reached a terminal state. */
export function isTourFinished(state: TourState): boolean {
  return state.outcome !== null;
}

/** The current stop, or null if the tour is finished. */
export function currentStop(state: TourState): TourStop | null {
  if (state.outcome !== null) return null;
  return state.steps[state.index] ?? null;
}

/** 1-based step counter for "{n}/{total}" displays. */
export function stepCounter(state: TourState): {
  current: number;
  total: number;
} {
  return {
    current: Math.min(state.index + 1, state.steps.length),
    total: state.steps.length,
  };
}
